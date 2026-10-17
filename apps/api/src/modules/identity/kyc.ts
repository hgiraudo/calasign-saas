// Verificación de identidad del firmante (KYC). Se exige después del código (OTP) y antes de ver los documentos:
//   1. el remitente pide `idVerification: {provider, level}` en el destinatario
//   2. el firmante inicia la verificación (POST …/identity/start): flujo integrado (mock) o página del proveedor
//   3. el resultado normalizado se contrasta con lo declarado (nombre y número de documento) y queda en la evidencia
// Las imágenes del flujo integrado se cifran (AES-256-GCM) antes de guardarlas y siguen la política de retención.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  IDV_CAPTURE_KINDS,
  IdentitySettingsInput,
  requiredCaptures,
  type IdentitySettings,
  type IdvCaptureKind,
  type IdvLevel,
  type IdvProvider,
  type IdvResult,
  type IdvStatus,
  type RecipientIdentity,
  type SigningIdentity,
} from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { appendEvent, type Actor } from "../../infra/evidence";
import { AppError, badRequest, conflict, notFound } from "../../lib/errors";
import { encryptBytes, iso, sha256Hex, uuidv7 } from "../../lib/util";
import { authenticate, type Services } from "../context";
import { lockEnvelope } from "../envelopes";
import { recipientActor, resolveToken } from "../signing";
import { matchIdentity } from "./namematch";
import { WebhookSignatureError, getAdapter, listProviders, mockDecide } from "./providers";
import type { CertificateIdentity } from "@calasign/pdf";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_IMAGE_BYTES = 1024;

// ───────────────────────────── Configuración por organización ─────────────────────────────

const DEFAULTS = { defaultProvider: "mock" as IdvProvider, defaultLevel: "document_selfie" as IdvLevel, nameMatchThreshold: 0.8, maxAttempts: 3 };

export async function getIdentitySettings(db: Db, tenantId: string): Promise<IdentitySettings> {
  const t = await db.one<any>(`SELECT identity_settings FROM tenants WHERE id = $1`, [tenantId]);
  const s = (t?.identity_settings ?? {}) as Record<string, any>;
  return {
    defaultProvider: s.defaultProvider ?? DEFAULTS.defaultProvider,
    defaultLevel: s.defaultLevel ?? DEFAULTS.defaultLevel,
    nameMatchThreshold: typeof s.nameMatchThreshold === "number" ? s.nameMatchThreshold : DEFAULTS.nameMatchThreshold,
    maxAttempts: typeof s.maxAttempts === "number" ? s.maxAttempts : DEFAULTS.maxAttempts,
    mock: {
      decision: s.mock?.decision ?? "approve",
      extractedName: s.mock?.extractedName ?? null,
      extractedDocumentNumber: s.mock?.extractedDocumentNumber ?? null,
    },
    providers: listProviders().map((p) => (p.id === "mock" ? { ...p, configured: mockEnabled() } : p)),
  };
}

/** El proveedor de prueba no se ofrece en producción (aprobaría identidades sin verificarlas). */
function mockEnabled() {
  return config.environment !== "prod" || process.env.IDV_MOCK_ENABLED === "1";
}

function providerReady(p: IdvProvider) {
  return p === "mock" ? mockEnabled() : getAdapter(p).configured();
}

// ───────────────────────────── Destinatarios ─────────────────────────────

/** Aplica `idVerification` de PUT /recipients: undefined = sin cambios, null = quitar, objeto = exigir. */
export async function applyIdentityFlags(
  db: Db,
  envelopeId: string,
  list: { id: string; role?: string; idVerification?: { provider: IdvProvider; level?: IdvLevel } | null }[],
) {
  for (const r of list) {
    if (r.idVerification === undefined) continue;
    if (r.idVerification === null) {
      await db.query(
        `UPDATE recipients SET id_verification_provider = NULL, id_verification_level = NULL, identity_status = NULL, identity_failure_reason = NULL
         WHERE id = $1 AND envelope_id = $2`,
        [r.id, envelopeId],
      );
      continue;
    }
    if (r.role === "cc") throw badRequest("identity_not_applicable", "La verificación de identidad aplica a firmantes y aprobadores");
    const { provider } = r.idVerification;
    const level = r.idVerification.level ?? "document_selfie";
    if (!providerReady(provider)) throw badRequest("identity_provider_unavailable", `El proveedor de verificación ${provider} no está configurado`);
    await db.query(
      `UPDATE recipients SET id_verification_provider = $3, id_verification_level = $4,
         identity_status = CASE WHEN id_verification_provider IS DISTINCT FROM $3 OR id_verification_level IS DISTINCT FROM $4 OR identity_status IS NULL
                                THEN 'pending' ELSE identity_status END
       WHERE id = $1 AND envelope_id = $2`,
      [r.id, envelopeId, provider, level],
    );
  }
}

/** Un reemplazo (delegación / reasignación) hereda la exigencia, pero tiene que verificarse de nuevo. */
export async function inheritIdentityRequirement(db: Db, oldRecipient: any, newRecipientId: string) {
  if (!oldRecipient.id_verification_provider) return;
  await db.query(
    `UPDATE recipients SET id_verification_provider = $2, id_verification_level = $3, identity_status = 'pending' WHERE id = $1`,
    [newRecipientId, oldRecipient.id_verification_provider, oldRecipient.id_verification_level],
  );
}

export function toRecipientIdentity(r: any): RecipientIdentity | null {
  if (!r.id_verification_provider) return null;
  return {
    provider: r.id_verification_provider,
    level: r.id_verification_level,
    status: (r.identity_status ?? "pending") as IdvStatus,
    verifiedAt: iso(r.identity_verified_at),
    failureReason: r.identity_failure_reason ?? null,
  };
}

function identityRequired(r: any): boolean {
  return Boolean(r.id_verification_provider) && (r.role === "signer" || r.role === "approver");
}

export function identityBlocking(r: any): boolean {
  return identityRequired(r) && r.identity_status !== "verified";
}

// ───────────────────────────── Sesión del firmante ─────────────────────────────

async function latestVerification(db: Db, recipientId: string) {
  return db.one<any>(`SELECT * FROM identity_verifications WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 1`, [recipientId]);
}

async function attemptsUsed(db: Db, recipientId: string): Promise<number> {
  const r = await db.one<any>(`SELECT count(*)::int AS n FROM identity_verifications WHERE recipient_id = $1 AND status = 'failed'`, [recipientId]);
  return Number(r?.n ?? 0);
}

export async function signingIdentityFor(db: Db, r: any, e: any, opts: { revealSession: boolean }): Promise<SigningIdentity | null> {
  if (!identityRequired(r)) return null;
  const provider = r.id_verification_provider as IdvProvider;
  const level = r.id_verification_level as IdvLevel;
  const settings = await getIdentitySettings(db, e.tenant_id);
  const v = await latestVerification(db, r.id);
  const active = v && ["created", "pending"].includes(v.status) ? v : null;
  const caps = active
    ? (await db.query<{ kind: IdvCaptureKind }>(`SELECT kind FROM identity_captures WHERE verification_id = $1`, [active.id])).map((c) => c.kind)
    : [];
  const used = await attemptsUsed(db, r.id);
  return {
    required: true,
    provider,
    level,
    status: (r.identity_status ?? "pending") as IdvStatus,
    mode: getAdapter(provider).mode,
    verificationId: opts.revealSession ? active?.id ?? null : null,
    redirectUrl: opts.revealSession ? active?.redirect_url ?? null : null,
    requiredCaptures: getAdapter(provider).mode === "builtin" ? requiredCaptures(level) : [],
    capturedKinds: opts.revealSession ? caps : [],
    attemptsLeft: Math.max(0, settings.maxAttempts - used),
    failureReason: r.identity_failure_reason ?? null,
  };
}

// ───────────────────────────── Certificado ─────────────────────────────

export type { CertificateIdentity };

function maskDoc(n: string | null): string | null {
  if (!n) return null;
  const s = n.replace(/\s+/g, "");
  return s.length <= 4 ? "****" : `${"*".repeat(Math.min(6, s.length - 4))}${s.slice(-4)}`;
}

const PROVIDER_NAMES: Record<string, string> = { mock: "CalaSign (prueba)", truora: "Truora", veriff: "Veriff" };

export async function identityForCertificate(db: Db, recipients: any[]): Promise<Map<string, CertificateIdentity>> {
  const out = new Map<string, CertificateIdentity>();
  for (const r of recipients) {
    if (!r.id_verification_provider) continue;
    const v = await db.one<any>(
      `SELECT * FROM identity_verifications WHERE recipient_id = $1 AND status IN ('verified','failed') ORDER BY (status = 'verified') DESC, created_at DESC LIMIT 1`,
      [r.id],
    );
    if (!v) continue;
    const res = (v.result ?? {}) as IdvResult;
    const nm = v.name_match ?? {};
    out.set(r.id, {
      provider: PROVIDER_NAMES[v.provider] ?? v.provider,
      level: v.level,
      result: v.status as "verified" | "failed",
      document: [res.document?.type, res.document?.country, maskDoc(res.document?.number ?? null)].filter(Boolean).join(" · ") || null,
      nameScore: typeof nm.score === "number" ? nm.score : null,
      documentNumberMatched: nm.documentNumberMatched ?? null,
      faceMatchScore: res.faceMatchScore ?? null,
      liveness: res.liveness ?? null,
      reference: v.provider_ref ?? res.reference ?? null,
      verifiedAt: iso(v.completed_at),
    });
  }
  return out;
}

// ───────────────────────────── Resultado ─────────────────────────────

/** Contrasta el resultado con lo declarado y lo registra (verificación, destinatario y evidencia). */
async function finalizeVerification(db: Db, verificationId: string, result: IdvResult, actor: Actor) {
  return db.tx(async (t) => {
    const v0 = await t.one<any>(`SELECT * FROM identity_verifications WHERE id = $1`, [verificationId]);
    if (!v0) throw notFound("Verificación");
    await lockEnvelope(t, v0.tenant_id, v0.envelope_id);
    const v = await t.one<any>(`SELECT * FROM identity_verifications WHERE id = $1 FOR UPDATE`, [verificationId]);
    if (!["created", "pending"].includes(v.status)) return v.status as string;
    const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1`, [v.recipient_id]);
    const settings = await getIdentitySettings(t, v.tenant_id);

    if (result.status === "pending" || result.status === "review") {
      await t.query(`UPDATE identity_verifications SET status = 'pending', result = $2, updated_at = now() WHERE id = $1`, [v.id, JSON.stringify(result)]);
      return "pending";
    }

    const nameMatch = matchIdentity(
      { name: r.name, documentNumber: r.id_document_number ?? null },
      { fullName: result.person.fullName, firstName: result.person.firstName, lastName: result.person.lastName, documentNumber: result.document.number },
      settings.nameMatchThreshold,
    );
    let reason: string | null = null;
    if (result.status !== "approved") reason = result.declineReason ?? "declined";
    else if (!nameMatch.matched) reason = "name_mismatch";
    else if (nameMatch.documentNumberMatched === false) reason = "document_number_mismatch";
    const ok = reason === null;

    await t.query(
      `UPDATE identity_verifications SET status = $2, result = $3, name_match = $4, failure_reason = $5, completed_at = now(), updated_at = now() WHERE id = $1`,
      [v.id, ok ? "verified" : "failed", JSON.stringify(result), JSON.stringify(nameMatch), reason],
    );
    const summary = {
      verificationId: v.id,
      provider: v.provider,
      level: v.level,
      attempt: v.attempt,
      reference: v.provider_ref ?? result.reference,
      document: { type: result.document.type, country: result.document.country, number: maskDoc(result.document.number) },
      nameMatch: { score: nameMatch.score, threshold: nameMatch.threshold },
      documentNumberMatched: nameMatch.documentNumberMatched,
      faceMatchScore: result.faceMatchScore,
      liveness: result.liveness,
      riskFlags: result.riskFlags,
    };
    if (ok) {
      await t.query(
        `UPDATE recipients SET identity_status = 'verified', identity_verified_at = now(), identity_failure_reason = NULL WHERE id = $1`,
        [r.id],
      );
      await appendEvent(t, { tenantId: v.tenant_id, envelopeId: v.envelope_id, type: "recipient.identity_verified", actor, data: summary });
    } else {
      const used = await attemptsUsed(t, r.id);
      const left = Math.max(0, settings.maxAttempts - used);
      await t.query(`UPDATE recipients SET identity_status = $2, identity_failure_reason = $3 WHERE id = $1`, [r.id, left > 0 ? "pending" : "failed", reason]);
      await appendEvent(t, {
        tenantId: v.tenant_id,
        envelopeId: v.envelope_id,
        type: "recipient.identity_failed",
        actor,
        data: { ...summary, reason, attemptsLeft: left },
      });
    }
    return ok ? "verified" : "failed";
  });
}

// ───────────────────────────── Rutas ─────────────────────────────

/** Rutas del link que no se bloquean mientras falta la verificación. */
const GATE_EXEMPT = [/\/otp\//, /\/identity(\/|$)/, /\/decline$/, /\/in-person\//, /\/embed$/];

export async function identityKycRoutes(app: FastifyInstance, s: Services) {
  type P = { Params: { token: string; kind?: string } };
  const rl = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  const auth = authenticate(s);

  // Bloquea documentos, consentimiento y firma hasta que la identidad esté verificada (va después del hook de OTP).
  app.addHook("preHandler", async (req: FastifyRequest, _reply: FastifyReply) => {
    const url = req.routeOptions?.url ?? "";
    if (!url.startsWith("/v1/signing/:token/") || GATE_EXEMPT.some((re) => re.test(url))) return;
    const token = (req.params as { token?: string }).token ?? "";
    const { recipient } = await resolveToken(s.db, token);
    if (identityBlocking(recipient)) throw new AppError(403, "identity_required", "Hace falta verificar tu identidad para continuar");
  });

  async function context(req: FastifyRequest<P>) {
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    if (!identityRequired(r)) throw conflict("identity_not_required", "Este link no requiere verificación de identidad");
    return { r, e };
  }

  async function sessionOut(token: string) {
    const { recipient, envelope } = await resolveToken(s.db, token);
    return { identity: await signingIdentityFor(s.db, recipient, envelope, { revealSession: true }) };
  }

  app.get<P>("/v1/signing/:token/identity", rl, async (req) => {
    const { r } = await context(req);
    // Flujos "redirect": si el webhook todavía no llegó, se consulta al proveedor (como máximo cada 5 s).
    const v = await latestVerification(s.db, r.id);
    const adapter = getAdapter(r.id_verification_provider);
    if (v && v.status === "pending" && adapter.fetchResult && Date.now() - new Date(v.updated_at).getTime() > 5000) {
      try {
        await s.db.query(`UPDATE identity_verifications SET updated_at = now() WHERE id = $1`, [v.id]);
        const res = await adapter.fetchResult(v.provider_ref, v.provider_process_id);
        if (res.status !== "pending") await finalizeVerification(s.db, v.id, res, { type: "system", label: adapter.name });
      } catch (err) {
        req.log.warn({ err: String(err), verificationId: v.id }, "no se pudo consultar el resultado de identidad");
      }
    }
    return sessionOut(req.params.token);
  });

  app.post<P>("/v1/signing/:token/identity/start", rl, async (req) => {
    const { r, e } = await context(req);
    if (e.status !== "sent") throw new AppError(410, "envelope_closed", "El sobre ya no está disponible");
    if (!["sent", "viewed"].includes(r.status)) throw conflict("not_signable", "Ya no podés firmar este sobre");
    if (r.identity_status === "verified") return sessionOut(req.params.token);
    const settings = await getIdentitySettings(s.db, e.tenant_id);
    const provider = r.id_verification_provider as IdvProvider;
    if (!providerReady(provider)) throw new AppError(503, "identity_provider_unavailable", "El proveedor de verificación no está disponible");

    const current = await latestVerification(s.db, r.id);
    if (current && ["created", "pending"].includes(current.status)) return sessionOut(req.params.token);
    const used = await attemptsUsed(s.db, r.id);
    if (used >= settings.maxAttempts) throw new AppError(429, "identity_attempts_exhausted", "Se agotaron los intentos de verificación");

    const id = uuidv7();
    const adapter = getAdapter(provider);
    let providerRef: string | null = null;
    let redirectUrl: string | null = null;
    if (adapter.mode === "redirect") {
      const created = await adapter.createSession!({
        verificationId: id,
        level: r.id_verification_level,
        person: { fullName: r.name, documentNumber: r.id_document_number ?? null, email: r.email, phone: r.phone },
        returnUrl: `${config.appUrl}/s/${req.params.token}?identity=return`,
        callbackUrl: `${config.appUrl}/v1/integrations/identity/${provider}/webhook`,
        locale: r.locale ?? e.locale,
      });
      providerRef = created.providerRef;
      redirectUrl = created.redirectUrl;
    }
    const actor = recipientActor(req, r);
    await s.db.tx(async (t) => {
      await lockEnvelope(t, e.tenant_id, e.id);
      await t.query(
        `INSERT INTO identity_verifications (id, tenant_id, envelope_id, recipient_id, provider, level, status, attempt, provider_ref, redirect_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, e.tenant_id, e.id, r.id, provider, r.id_verification_level, adapter.mode === "redirect" ? "pending" : "created", used + 1, providerRef, redirectUrl],
      );
      await t.query(`UPDATE recipients SET identity_status = 'in_progress' WHERE id = $1`, [r.id]);
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.identity_started",
        actor,
        data: { verificationId: id, provider, level: r.id_verification_level, attempt: used + 1, reference: providerRef },
      });
    });
    return sessionOut(req.params.token);
  });

  app.post<P>("/v1/signing/:token/identity/captures/:kind", { ...rl, bodyLimit: MAX_IMAGE_BYTES + 1024 * 1024 }, async (req) => {
    const { r, e } = await context(req);
    const kind = req.params.kind as IdvCaptureKind;
    if (!(IDV_CAPTURE_KINDS as readonly string[]).includes(kind)) throw badRequest("invalid_capture", "Tipo de captura inválido");
    if (!requiredCaptures(r.id_verification_level).includes(kind)) throw badRequest("invalid_capture", "Esta captura no corresponde al nivel pedido");
    const v = await latestVerification(s.db, r.id);
    if (!v || v.status !== "created" || getAdapter(v.provider).mode !== "builtin") throw conflict("no_active_capture", "Primero iniciá la verificación");

    const file = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
    if (!file) throw badRequest("file_required", "Falta la imagen (campo 'file')");
    const bytes = new Uint8Array(await file.toBuffer());
    if (file.file.truncated) throw new AppError(413, "file_too_large", "La imagen supera 8 MB");
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isJpeg && !isPng) throw badRequest("invalid_image", "Se esperaba una foto JPG o PNG");
    if (bytes.length < MIN_IMAGE_BYTES) throw badRequest("invalid_image", "La imagen es demasiado chica");

    const plainHash = sha256Hex(bytes);
    const enc = encryptBytes(bytes);
    const fileId = uuidv7();
    const key = `tenants/${e.tenant_id}/envelopes/${e.id}/identity/${fileId}.bin`;
    await s.blobs.put(key, enc, "application/octet-stream");
    const replaced = await s.db.tx(async (t) => {
      await t.query(
        `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'identity',$3,$4,$5,$6)`,
        [fileId, e.tenant_id, key, isJpeg ? "image/jpeg+aesgcm" : "image/png+aesgcm", enc.length, sha256Hex(enc)],
      );
      const prev = await t.one<any>(
        `SELECT ic.id, f.id AS file_id, f.storage_key FROM identity_captures ic JOIN files f ON f.id = ic.file_id WHERE ic.verification_id = $1 AND ic.kind = $2`,
        [v.id, kind],
      );
      if (prev) {
        await t.query(`DELETE FROM identity_captures WHERE id = $1`, [prev.id]);
        await t.query(`UPDATE files SET purged_at = now() WHERE id = $1`, [prev.file_id]);
      }
      await t.query(`INSERT INTO identity_captures (id, tenant_id, verification_id, kind, file_id, sha256) VALUES ($1,$2,$3,$4,$5,$6)`, [
        uuidv7(),
        e.tenant_id,
        v.id,
        kind,
        fileId,
        plainHash,
      ]);
      await t.query(`UPDATE identity_verifications SET updated_at = now() WHERE id = $1`, [v.id]);
      return prev;
    });
    if (replaced) await s.blobs.delete(replaced.storage_key).catch(() => {});
    return sessionOut(req.params.token);
  });

  app.post<P>("/v1/signing/:token/identity/submit", rl, async (req) => {
    const { r, e } = await context(req);
    const v = await latestVerification(s.db, r.id);
    if (!v || !["created", "pending"].includes(v.status)) throw conflict("no_active_verification", "No hay una verificación en curso");
    const adapter = getAdapter(v.provider);
    const actor = recipientActor(req, r);
    if (adapter.mode === "builtin") {
      const caps = await s.db.query<any>(`SELECT kind, sha256 FROM identity_captures WHERE verification_id = $1`, [v.id]);
      const missing = requiredCaptures(v.level).filter((k) => !caps.some((c) => c.kind === k));
      if (missing.length) throw new AppError(422, "captures_incomplete", `Faltan fotos: ${missing.join(", ")}`, { missing });
      const settings = await getIdentitySettings(s.db, e.tenant_id);
      const result = mockDecide(v.level, caps, settings.mock, { name: r.name, documentNumber: r.id_document_number ?? null }, v.id);
      await finalizeVerification(s.db, v.id, result, { ...actor, label: `${actor.label} · ${adapter.name}` });
    } else if (adapter.fetchResult) {
      const res = await adapter.fetchResult(v.provider_ref, v.provider_process_id);
      if (res.status !== "pending") await finalizeVerification(s.db, v.id, res, { type: "system", label: adapter.name });
    }
    return sessionOut(req.params.token);
  });

  // ───────── Webhooks de proveedores (cuerpo crudo para verificar la firma) ─────────

  await app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    sub.post<{ Params: { provider: string } }>("/v1/integrations/identity/:provider/webhook", { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } }, async (req, reply) => {
      const provider = req.params.provider as IdvProvider;
      if (provider !== "veriff" && provider !== "truora") return reply.code(404).send({ error: { code: "not_found", message: "Proveedor desconocido" } });
      const adapter = getAdapter(provider);
      if (!adapter.configured() || !adapter.parseWebhook) return reply.code(503).send({ error: { code: "not_configured", message: "Proveedor no configurado" } });
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));
      let parsed;
      try {
        parsed = adapter.parseWebhook(raw, req.headers);
      } catch (err) {
        if (err instanceof WebhookSignatureError) return reply.code(401).send({ error: { code: "invalid_signature", message: err.message } });
        return reply.code(400).send({ error: { code: "invalid_payload", message: String((err as Error).message ?? err) } });
      }
      const v = await s.db.one<any>(`SELECT * FROM identity_verifications WHERE provider = $1 AND provider_ref = $2`, [provider, parsed.providerRef]);
      if (!v) return { ok: true, ignored: "unknown_reference" };
      if (parsed.processId && parsed.processId !== v.provider_process_id) {
        await s.db.query(`UPDATE identity_verifications SET provider_process_id = $2, updated_at = now() WHERE id = $1`, [v.id, parsed.processId]);
      }
      let result = parsed.result;
      if (!result && adapter.fetchResult) result = await adapter.fetchResult(v.provider_ref, parsed.processId ?? v.provider_process_id);
      if (result && result.status !== "pending") await finalizeVerification(s.db, v.id, result, { type: "system", label: `${adapter.name} (webhook)` });
      return { ok: true };
    });
  });

  // ───────── Remitente ─────────

  app.get("/v1/settings/identity", { preHandler: auth }, async (req) => getIdentitySettings(s.db, req.auth!.tenantId));

  app.patch("/v1/settings/identity", { preHandler: auth }, async (req) => {
    const input = IdentitySettingsInput.parse(req.body);
    if (input.defaultProvider && !providerReady(input.defaultProvider)) {
      throw badRequest("identity_provider_unavailable", `El proveedor ${input.defaultProvider} no está configurado`);
    }
    const cur = await getIdentitySettings(s.db, req.auth!.tenantId);
    const next = {
      defaultProvider: input.defaultProvider ?? cur.defaultProvider,
      defaultLevel: input.defaultLevel ?? cur.defaultLevel,
      nameMatchThreshold: input.nameMatchThreshold ?? cur.nameMatchThreshold,
      maxAttempts: input.maxAttempts ?? cur.maxAttempts,
      mock: { ...cur.mock, ...(input.mock ?? {}) },
    };
    await s.db.query(`UPDATE tenants SET identity_settings = $2 WHERE id = $1`, [req.auth!.tenantId, JSON.stringify(next)]);
    return getIdentitySettings(s.db, req.auth!.tenantId);
  });

  app.get<{ Params: { id: string; recipientId: string } }>("/v1/envelopes/:id/recipients/:recipientId/identity", { preHandler: auth }, async (req) => {
    const r = await s.db.one<any>(`SELECT * FROM recipients WHERE id = $1 AND envelope_id = $2 AND tenant_id = $3`, [
      req.params.recipientId,
      req.params.id,
      req.auth!.tenantId,
    ]);
    if (!r) throw notFound("Destinatario");
    const rows = await s.db.query<any>(`SELECT * FROM identity_verifications WHERE recipient_id = $1 ORDER BY created_at`, [r.id]);
    return {
      identity: toRecipientIdentity(r),
      attempts: rows.map((v) => {
        const res = (v.result ?? null) as IdvResult | null;
        return {
          id: v.id,
          attempt: v.attempt,
          provider: v.provider,
          level: v.level,
          status: v.status,
          reference: v.provider_ref,
          failureReason: v.failure_reason,
          createdAt: iso(v.created_at),
          completedAt: iso(v.completed_at),
          // Sin imágenes ni datos completos del documento.
          result: res
            ? {
                status: res.status,
                documentType: res.document?.type ?? null,
                documentCountry: res.document?.country ?? null,
                documentNumber: maskDoc(res.document?.number ?? null),
                fullName: res.person?.fullName ?? null,
                faceMatchScore: res.faceMatchScore,
                liveness: res.liveness,
                riskFlags: res.riskFlags ?? [],
              }
            : null,
          nameMatch: v.name_match ?? null,
        };
      }),
    };
  });
}

