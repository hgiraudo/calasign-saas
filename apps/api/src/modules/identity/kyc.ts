// Verificación de identidad del firmante (KYC). Se exige después del código (OTP) y antes de ver los documentos:
//   1. el remitente pide `idVerification: {provider, level}` en el destinatario
//   2. el firmante inicia la verificación (POST …/identity/start): flujo integrado (mock) o página del proveedor
//   3. el resultado normalizado se contrasta con lo declarado (nombre y número de documento) y queda en la evidencia
// Las imágenes del flujo integrado se cifran (AES-256-GCM) antes de guardarlas y siguen la política de retención.
import { envelopeBaseUrl } from "../white-label/brand";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  IDV_CAPTURE_KINDS,
  IDV_LEVELS,
  IDV_PROVIDERS,
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
import { z } from "zod";
import { encrypt, encryptBytes, iso, sha256Hex, uuidv7 } from "../../lib/util";
import { authenticate, type Services } from "../context";
import { lockEnvelope, pastExpiry } from "../envelopes";
import { assertLinkCurrent, recipientActor, resolveToken } from "../signing";
import { resolveSignerReturn, returnTokenEncToStore, sendNeutralReturn, setSignerReturnCookie, signerReturnUrl } from "../signer-return";
import { matchIdentity } from "./namematch";
import { stripImageMetadata } from "./image-meta";
import {
  WebhookSignatureError,
  getAdapter,
  levelUnsupportedReason,
  integrationLevelToStore,
  listProviders,
  mockDecide,
  withIntegrationCapabilities,
} from "./providers";
import type { CertificateIdentity } from "@calasign/pdf";
import { tenantBaseUrl } from "../custom-domains";
import { requireFeature, tenantPlan } from "../billing/plans";
import { discardBlobsOnFailure } from "../file-cleanup";

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

/**
 * ¿El proveedor está disponible (y, con `level`, puede hacer ese nivel)? Con nivel: Truora necesita un flujo para el
 * nivel y Veriff una integración que llegue al nivel (VERIFF_INTEGRATION_LEVEL). Ver levelUnsupportedReason.
 */
export function providerReady(p: IdvProvider, level?: IdvLevel) {
  return providerUnavailableReason(p, level) === null;
}

/** Por qué el proveedor no está disponible para el nivel (mensaje para el remitente), o null si lo está. */
export function providerUnavailableReason(p: IdvProvider, level?: IdvLevel): string | null {
  const configured = p === "mock" ? mockEnabled() : getAdapter(p).configured();
  if (!configured) return `El proveedor de verificación ${p} no está configurado`;
  return level ? levelUnsupportedReason(p, level) : null;
}

// ───────────────────────────── Destinatarios ─────────────────────────────

/** Aplica `idVerification` de PUT /recipients: undefined = sin cambios, null = quitar, objeto = exigir. */
export async function applyIdentityFlags(
  db: Db,
  envelopeId: string,
  list: { id: string; role?: string; idVerification?: { provider: IdvProvider; level?: IdvLevel } | null }[],
) {
  // Exigir la verificación es una funcionalidad del plan (cada verificación de Truora o Veriff se paga). Solo se
  // controla al pedirla: un sobre ya enviado no se traba si después se baja de plan.
  if (list.some((r) => r.idVerification)) {
    const env = await db.one<{ tenant_id: string }>(`SELECT tenant_id FROM envelopes WHERE id = $1`, [envelopeId]);
    if (env) requireFeature((await tenantPlan(db, env.tenant_id)).plan, "kyc", "La verificación de identidad");
  }
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
    // Con el nivel: un nivel sin flujo de Truora (o por encima de la integración de Veriff) se rechaza al enviar, no
    // cuando el firmante intenta verificarse (antes, un 500 en /identity/start).
    const unavailable = providerUnavailableReason(provider, level);
    if (unavailable) throw badRequest("identity_provider_unavailable", unavailable);
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
  await db.query(`UPDATE recipients SET id_verification_provider = $2, id_verification_level = $3, identity_status = 'pending' WHERE id = $1`, [
    newRecipientId,
    oldRecipient.id_verification_provider,
    oldRecipient.id_verification_level,
  ]);
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

/** El sobre en curso (y no vencido) y el destinatario todavía de turno: si no, no se suben fotos ni se evalúan. */
function assertSignable(e: any, r: any) {
  if (e.status !== "sent" || pastExpiry(e)) throw new AppError(410, "envelope_closed", "El sobre ya no está disponible");
  if (!["sent", "viewed"].includes(r?.status)) throw conflict("not_signable", "Ya no podés firmar este sobre");
}

/** assertSignable con el sobre bloqueado y releído (dentro de la transacción), y el link del destinatario vigente. */
async function lockedSignable(t: Db, e: any, r: any) {
  const cur = await lockEnvelope(t, e.tenant_id, e.id);
  const rNow = await t.one<any>(`SELECT status, access_token_hash FROM recipients WHERE id = $1`, [r.id]);
  assertLinkCurrent(rNow, r);
  assertSignable(cur, rNow);
}

// ───────────────────────────── Sesión del firmante ─────────────────────────────

async function latestVerification(db: Db, recipientId: string) {
  return db.one<any>(`SELECT * FROM identity_verifications WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 1`, [recipientId]);
}

/**
 * Intentos consumidos: las verificaciones fallidas, salvo level_not_met (el proveedor aprobó pero el resultado no trajo
 * la coincidencia facial o la prueba de vida que pide el nivel: es un problema de configuración, no del firmante).
 */
const ATTEMPT_USED_SQL = `status = 'failed' AND failure_reason IS DISTINCT FROM 'level_not_met'`;

async function attemptsUsed(db: Db, recipientId: string): Promise<number> {
  const r = await db.one<any>(`SELECT count(*)::int AS n FROM identity_verifications WHERE recipient_id = $1 AND ${ATTEMPT_USED_SQL}`, [recipientId]);
  return Number(r?.n ?? 0);
}

/** Para el firmante: neutro (el motivo concreto, para el remitente, va en el detalle del destinatario y al enviar). */
const SIGNER_UNAVAILABLE_MESSAGE = "La verificación de identidad no está disponible por ahora: avisale al remitente";

/**
 * La verificación quedó atada a la sesión de firma integrada que la inició (session_token_hash, signer-token.ts): si se
 * retoma, recibe fotos, se envía o se consulta desde otro token (el link del destinatario u otra sesión), deja de estarlo
 * y su aprobación ya no mantiene viva esa sesión.
 */
async function unbindOtherSession(db: Db, verificationId: string, sessionHash: string | null) {
  await db.query(
    `UPDATE identity_verifications SET session_token_hash = NULL WHERE id = $1 AND session_token_hash IS NOT NULL AND session_token_hash IS DISTINCT FROM $2`,
    [verificationId, sessionHash],
  );
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
    verificationId: opts.revealSession ? (active?.id ?? null) : null,
    redirectUrl: opts.revealSession ? (active?.redirect_url ?? null) : null,
    requiredCaptures: getAdapter(provider).mode === "builtin" ? requiredCaptures(level) : [],
    capturedKinds: opts.revealSession ? caps : [],
    attemptsLeft: Math.max(0, settings.maxAttempts - used),
    failureReason: r.identity_failure_reason ?? null,
  };
}

// ───────────────────────────── Certificado ─────────────────────────────

export type { CertificateIdentity };

/** El proveedor no respondió a tiempo: se corta (la reserva se cancela y se puede reintentar). */
function withTimeout<T>(ms: number, p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("el proveedor de identidad no respondió a tiempo")), ms).unref?.()),
  ]);
}

export function maskDocNumber(n: string | null): string | null {
  return maskDoc(n);
}

function maskDoc(n: string | null): string | null {
  if (!n) return null;
  const s = n.replace(/\s+/g, "");
  return s.length <= 4 ? "****" : `${"*".repeat(Math.min(6, s.length - 4))}${s.slice(-4)}`;
}

/**
 * Lo que se guarda en identity_verifications.result: el número de documento enmascarado y de la fecha de nacimiento
 * solo el año. La comparación con lo declarado (matchIdentity) se hace antes, con el resultado completo del proveedor,
 * y queda en name_match; nada lee después el número completo ni la fecha.
 */
export function storedIdvResult(result: IdvResult): IdvResult {
  const birth = result.person?.birthDate ?? null;
  return {
    ...result,
    document: { ...result.document, number: maskDoc(result.document?.number ?? null) },
    person: { ...result.person, birthDate: birth ? (/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(birth)?.[1] ?? null) : null },
  };
}

const PROVIDER_NAMES: Record<string, string> = { mock: "CalaSign (prueba)", truora: "Truora", veriff: "Veriff" };

/**
 * Referencia del proveedor para la evidencia, el certificado y el detalle del remitente. En Truora provider_ref es el
 * id de nuestra verificación (account_id): la referencia que sirve para buscar el caso en Truora es el process_id.
 */
export function providerReference(
  v: { provider: string; provider_ref?: string | null; provider_process_id?: string | null },
  res?: IdvResult | null,
): string | null {
  if (v.provider === "truora") return v.provider_process_id ?? res?.reference ?? v.provider_ref ?? null;
  return v.provider_ref ?? res?.reference ?? null;
}

/**
 * Lo que exige el nivel pedido, más allá de que el proveedor apruebe: el flujo o la integración configurados en el
 * proveedor pueden no incluir la selfie o la prueba de vida (y aprobar solo con el documento). Sin coincidencia facial
 * (puntaje sobre el umbral o decisión explícita) o sin prueba de vida, la verificación no cumple el nivel.
 */
export function levelSatisfied(level: IdvLevel, result: IdvResult, faceThreshold = config.identity.faceMatchThreshold): boolean {
  return levelFailure(level, result, faceThreshold) === null;
}

/**
 * Por qué una aprobación no cumple el nivel, o null si lo cumple:
 *   face_mismatch / liveness_failed → dato contrario explícito (puntaje bajo el umbral, faceMatched o liveness en
 *                                     false): falla del firmante, consume un intento
 *   level_not_met                   → el resultado no trae el dato (la integración no hace ese control): problema de
 *                                     configuración, no consume un intento
 */
export function levelFailure(
  level: IdvLevel,
  result: IdvResult,
  faceThreshold = config.identity.faceMatchThreshold,
): "face_mismatch" | "liveness_failed" | "level_not_met" | null {
  if (level === "document") return null;
  const score = typeof result.faceMatchScore === "number" ? result.faceMatchScore : null;
  const faceOk = result.faceMatched === false ? false : (score !== null && score >= faceThreshold) || result.faceMatched === true;
  if (!faceOk) return result.faceMatched === false || score !== null ? "face_mismatch" : "level_not_met";
  if (level === "document_selfie_liveness" && result.liveness !== true) return result.liveness === false ? "liveness_failed" : "level_not_met";
  return null;
}

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
      faceMatched: res.faceMatched ?? null,
      liveness: res.liveness ?? null,
      inferred: Array.isArray(res.inferredFromIntegration) ? res.inferredFromIntegration : [],
      reference: providerReference(v, res),
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
    const e = await lockEnvelope(t, v0.tenant_id, v0.envelope_id);
    const v = await t.one<any>(`SELECT * FROM identity_verifications WHERE id = $1 FOR UPDATE`, [verificationId]);
    const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1`, [v.recipient_id]);
    // Resultado tardío de una verificación que el barrido dio por vencida (provider_timeout) sin que el firmante haya
    // empezado otra: se registra normalmente (antes se descartaba una aprobación que llegó pasado el plazo). Solo una
    // decisión final, con el sobre en curso, el destinatario de turno y todavía sin verificar.
    const lateAfterTimeout =
      v.status === "expired" &&
      v.failure_reason === "provider_timeout" &&
      (result.status === "approved" || result.status === "declined") &&
      e.status === "sent" &&
      !pastExpiry(e) &&
      ["sent", "viewed"].includes(r?.status) &&
      r?.identity_status !== "verified" &&
      (await latestVerification(t, v.recipient_id))?.id === v.id;
    if (!["created", "pending"].includes(v.status) && !lateAfterTimeout) return v.status as string;
    // El resultado llega tarde (webhook o consulta minutos después): si el sobre ya se anuló, rechazó o venció, o el
    // destinatario fue reemplazado (delegó, lo reasignaron), la verificación se cancela sin sumar
    // recipient.identity_verified / identity_failed a la evidencia de un sobre cerrado o de alguien que ya no firma.
    // Vencido aunque el barrido todavía no lo haya marcado: tampoco suma eventos.
    if (e.status !== "sent" || pastExpiry(e) || !["sent", "viewed"].includes(r?.status)) {
      await t.query(`UPDATE identity_verifications SET status = 'canceled', updated_at = now() WHERE id = $1`, [v.id]);
      // Sin verificación en curso, el destinatario no queda "in_progress" (la sesión mostraba una verificación en curso
      // sin verificationId y la página esperaba un resultado que ya no iba a llegar).
      if (r) await t.query(`UPDATE recipients SET identity_status = 'pending' WHERE id = $1 AND identity_status = 'in_progress'`, [r.id]);
      return "canceled";
    }
    const settings = await getIdentitySettings(t, v.tenant_id);

    if (result.status === "pending" || result.status === "review") {
      await t.query(`UPDATE identity_verifications SET status = 'pending', result = $2, updated_at = now() WHERE id = $1`, [
        v.id,
        JSON.stringify(storedIdvResult(result)),
      ]);
      return "pending";
    }

    const nameMatch = matchIdentity(
      { name: r.name, documentNumber: r.id_document_number ?? null },
      {
        fullName: result.person.fullName,
        firstName: result.person.firstName,
        lastName: result.person.lastName,
        documentNumber: result.document.number,
      },
      settings.nameMatchThreshold,
    );
    // Lo que la integración declara hacer (VERIFF_INTEGRATION_LEVEL, flujo de Truora por nivel) completa la aprobación
    // cuando la decisión no trae el puntaje facial o la prueba de vida.
    // Con el nivel guardado al iniciar (integration_level), no el de la configuración actual.
    const caps = withIntegrationCapabilities(v.provider as IdvProvider, v.level as IdvLevel, result, undefined, v.integration_level);
    // Lo inferido queda guardado con el resultado: el certificado lo muestra como informado por la integración, no
    // como un control con puntaje.
    result = caps.inferred.length ? { ...caps.result, inferredFromIntegration: caps.inferred } : caps.result;
    // Aprobado por el proveedor pero sin la coincidencia facial o la prueba de vida que pide el nivel: levelFailure.
    let reason: string | null = result.status !== "approved" ? (result.declineReason ?? "declined") : levelFailure(v.level as IdvLevel, result);
    if (!reason && !nameMatch.matched) reason = "name_mismatch";
    else if (!reason && nameMatch.documentNumberMatched === false) reason = "document_number_mismatch";
    const ok = reason === null;
    // level_not_met es de configuración (la integración no hace el control que pide el nivel): no consume un intento
    // (attemptsUsed) y el inicio queda bloqueado hasta que el remitente revise la configuración y reinicie.
    const configurationIssue = reason === "level_not_met";

    await t.query(
      `UPDATE identity_verifications SET status = $2, result = $3, name_match = $4, failure_reason = $5, completed_at = now(), updated_at = now() WHERE id = $1`,
      [v.id, ok ? "verified" : "failed", JSON.stringify(storedIdvResult(result)), JSON.stringify(nameMatch), reason],
    );
    const summary = {
      verificationId: v.id,
      provider: v.provider,
      level: v.level,
      attempt: v.attempt,
      reference: providerReference(v, result),
      document: { type: result.document.type, country: result.document.country, number: maskDoc(result.document.number) },
      nameMatch: { score: nameMatch.score, threshold: nameMatch.threshold },
      documentNumberMatched: nameMatch.documentNumberMatched,
      faceMatchScore: result.faceMatchScore,
      faceMatched: result.faceMatched ?? null,
      liveness: result.liveness,
      riskFlags: result.riskFlags,
      // Controles que no vinieron en la decisión y se dan por hechos porque la integración los declara.
      ...(caps.inferred.length ? { inferredFromIntegration: caps.inferred } : {}),
      ...(lateAfterTimeout ? { lateAfterTimeout: true } : {}),
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
      await t.query(`UPDATE recipients SET identity_status = $2, identity_failure_reason = $3 WHERE id = $1`, [
        r.id,
        left > 0 ? "pending" : "failed",
        reason,
      ]);
      await appendEvent(t, {
        tenantId: v.tenant_id,
        envelopeId: v.envelope_id,
        type: "recipient.identity_failed",
        actor,
        data: {
          ...summary,
          reason,
          attemptsLeft: left,
          // Para el remitente: no es una falla del firmante; hay que revisar VERIFF_INTEGRATION_LEVEL o el flujo de Truora.
          ...(configurationIssue
            ? {
                configurationIssue: true,
                detail:
                  "El proveedor aprobó, pero el resultado no incluyó la coincidencia facial o la prueba de vida que pide el nivel: revisar la configuración de la integración",
              }
            : {}),
        },
      });
    }
    return ok ? "verified" : "failed";
  });
}

/**
 * Verificaciones de un proveedor externo sin actividad del proveedor hace más de IDV_PENDING_TIMEOUT_HOURS (24 h): el
 * webhook no llegó nunca (o el firmante abandonó la página del proveedor). El plazo corre desde la última actividad
 * (updated_at: inicio, webhooks, resultados en revisión), no desde created_at —una revisión manual larga vencía aunque
 * el proveedor siguiera trabajando—; la consulta periódica del firmante (cada 5 s) usa polled_at y no lo corre. Un
 * resultado que llega después del vencimiento igual se registra (finalizeVerification). Se dan por vencidas (status 'expired',
 * provider_timeout) sin consumir un intento —no hubo una decisión— y el firmante puede volver a empezar. Antes quedaban
 * "en curso" para siempre y bloqueaban todo nuevo inicio. De a 200 por pasada.
 */
export async function expireStaleVerifications(db: Db, hours = config.identity.pendingTimeoutHours): Promise<number> {
  const stale = await db.query<{ id: string; tenant_id: string; envelope_id: string }>(
    `SELECT id, tenant_id, envelope_id FROM identity_verifications
      WHERE status = 'pending' AND provider <> 'mock' AND updated_at < now() - make_interval(hours => $1::int)
      ORDER BY updated_at LIMIT 200`,
    [hours],
  );
  let n = 0;
  for (const s of stale) {
    const done = await db.tx(async (t) => {
      const e = await lockEnvelope(t, s.tenant_id, s.envelope_id);
      const v = await t.one<any>(`SELECT * FROM identity_verifications WHERE id = $1 FOR UPDATE`, [s.id]);
      if (v?.status !== "pending") return false;
      await t.query(
        `UPDATE identity_verifications SET status = 'expired', failure_reason = 'provider_timeout', completed_at = now(), updated_at = now() WHERE id = $1`,
        [v.id],
      );
      const open = e.status === "sent" && !pastExpiry(e);
      await t.query(
        `UPDATE recipients SET identity_status = 'pending', identity_failure_reason = CASE WHEN $2 THEN 'provider_timeout' ELSE identity_failure_reason END
          WHERE id = $1 AND identity_status = 'in_progress'`,
        [v.recipient_id, open],
      );
      if (open) {
        await appendEvent(t, {
          tenantId: v.tenant_id,
          envelopeId: v.envelope_id,
          type: "recipient.identity_expired",
          actor: { type: "system", label: PROVIDER_NAMES[v.provider] ?? v.provider },
          data: {
            verificationId: v.id,
            provider: v.provider,
            level: v.level,
            attempt: v.attempt,
            reference: providerReference(v),
            reason: "provider_timeout",
            hours,
          },
        });
      }
      return true;
    });
    if (done) n++;
  }
  return n;
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
    const { recipient: r, envelope: e, sessionToken } = await resolveToken(s.db, req.params.token);
    if (!identityRequired(r)) throw conflict("identity_not_required", "Este link no requiere verificación de identidad");
    // Hash del token de sesión del canje embebido con que se entró (null con el link permanente).
    return { r, e, sessionToken, sessionHash: sessionToken ? sha256Hex(req.params.token) : null };
  }

  async function sessionOut(token: string) {
    const { recipient, envelope } = await resolveToken(s.db, token);
    return { identity: await signingIdentityFor(s.db, recipient, envelope, { revealSession: true }) };
  }

  app.get<P>("/v1/signing/:token/identity", rl, async (req) => {
    const { r, sessionHash } = await context(req);
    // Flujos "redirect": si el webhook todavía no llegó, se consulta al proveedor (como máximo cada 5 s).
    const v = await latestVerification(s.db, r.id);
    // La respuesta revela la sesión del proveedor (redirectUrl): consultada desde otro token, deja de estar atada a la
    // sesión de firma integrada que la inició.
    if (v && ["created", "pending"].includes(v.status)) await unbindOtherSession(s.db, v.id, sessionHash);
    const adapter = getAdapter(r.id_verification_provider);
    if (v && v.status === "pending" && adapter.fetchResult && (!v.polled_at || Date.now() - new Date(v.polled_at).getTime() > 5000)) {
      try {
        // Solo un pedido consulta al proveedor cada 5 s (antes, consultas simultáneas llamaban todas).
        const turn = await s.db.query(
          `UPDATE identity_verifications SET polled_at = now() WHERE id = $1 AND (polled_at IS NULL OR polled_at < now() - interval '5 seconds') RETURNING id`,
          [v.id],
        );
        if (!turn.length) return sessionOut(req.params.token);
        const res = await adapter.fetchResult(v.provider_ref, v.provider_process_id);
        if (res.status !== "pending") await finalizeVerification(s.db, v.id, res, { type: "system", label: adapter.name });
      } catch (err) {
        req.log.warn({ err: String(err), verificationId: v.id }, "no se pudo consultar el resultado de identidad");
      }
    }
    return sessionOut(req.params.token);
  });

  app.post<P>("/v1/signing/:token/identity/start", rl, async (req, reply) => {
    const { r, e, sessionToken, sessionHash } = await context(req);
    // Vencido (aunque el barrido todavía no lo marcó): no se abre una sesión paga en el proveedor.
    if (e.status !== "sent" || pastExpiry(e)) throw new AppError(410, "envelope_closed", "El sobre ya no está disponible");
    if (!["sent", "viewed"].includes(r.status)) throw conflict("not_signable", "Ya no podés firmar este sobre");
    if (r.identity_status === "verified") return sessionOut(req.params.token);
    const settings = await getIdentitySettings(s.db, e.tenant_id);
    const provider = r.id_verification_provider as IdvProvider;
    // Proveedor sin configurar: 503 (mensaje neutro para el firmante).
    if (!providerReady(provider)) throw new AppError(503, "identity_provider_unavailable", SIGNER_UNAVAILABLE_MESSAGE);
    // Con el nivel: Truora sin flujo para el nivel (o una integración de Veriff que no llega) es un 503, no un 500 de
    // createSession después de reservar. Mensaje neutro para el firmante: el motivo lo ve el remitente (detalle del
    // destinatario: unavailableReason) y lo arregla con identity/reset cambiando el nivel o el proveedor. Solo bloquea
    // verificaciones nuevas: una ya en curso se retoma igual (abajo), porque lo que se infiere de ella lo decide el nivel
    // de integración guardado al iniciarla (integration_level; "none" no infiere nada), no la configuración actual.
    const levelReady = providerReady(provider, r.id_verification_level);

    // Una reserva de modo redirect que quedó sin sesión del proveedor (el proceso murió o el proveedor no respondió)
    // se cancela antes de mirar la última verificación: si no, el inicio devolvía la reserva trabada para siempre.
    if (getAdapter(provider).mode === "redirect") {
      const stale = await s.db.query(
        `UPDATE identity_verifications SET status = 'canceled', updated_at = now()
          WHERE recipient_id = $1 AND status = 'created' AND provider_ref IS NULL AND updated_at < now() - interval '2 minutes' RETURNING id`,
        [r.id],
      );
      if (stale.length)
        await s.db.query(`UPDATE recipients SET identity_status = 'pending' WHERE id = $1 AND identity_status = 'in_progress'`, [r.id]);
    }
    const current = await latestVerification(s.db, r.id);
    if (current && ["created", "pending"].includes(current.status)) {
      // Retomada: la vuelta del proveedor (ruta neutra, signer-return.ts) va al token con que se retoma ahora, no al del
      // primer inicio (un token de sesión del canje embebido ya vencido, o el permanente dentro del iframe).
      setSignerReturnCookie(reply, "identity", current.id, req.params.token);
      // Un token de sesión vigente guardado (iframe embebido) no se pisa con el permanente (returnTokenEncToStore).
      const returnEnc = await returnTokenEncToStore(s.db, {
        token: req.params.token,
        sessionToken,
        storedTokenEnc: current.return_token_enc,
        recipientId: r.id,
      });
      await s.db.query(`UPDATE identity_verifications SET return_token_enc = $2 WHERE id = $1 AND recipient_id = $3`, [current.id, returnEnc, r.id]);
      await unbindOtherSession(s.db, current.id, sessionHash);
      return sessionOut(req.params.token);
    }
    if (!levelReady) throw new AppError(503, "identity_provider_unavailable", SIGNER_UNAVAILABLE_MESSAGE);
    // La última terminó en level_not_met (el proveedor aprobó sin el control facial o la prueba de vida que pide el
    // nivel): no consumió un intento, pero repetirla daría lo mismo y abriría otra sesión paga. Queda bloqueada hasta que
    // el remitente revise la configuración y reinicie la verificación (identity/reset). Código propio
    // (identity_level_not_supported), distinto del proveedor no disponible.
    if (current?.status === "failed" && current.failure_reason === "level_not_met") {
      throw new AppError(
        409,
        "identity_level_not_supported",
        "La verificación no se puede completar con la configuración actual del proveedor: avisale al remitente",
      );
    }
    const used = await attemptsUsed(s.db, r.id);
    if (used >= settings.maxAttempts) throw new AppError(429, "identity_attempts_exhausted", "Se agotaron los intentos de verificación");

    const id = uuidv7();
    const adapter = getAdapter(provider);
    const actor = recipientActor(req, r);
    // Primero se reserva la verificación (con el sobre bloqueado) y recién quien la ganó crea la sesión en el proveedor:
    // antes se creaba antes de la transacción y, con dos inicios simultáneos, la del perdedor quedaba en el proveedor
    // (algunos cobran por sesión) sin registrar.
    const won = await s.db.tx(async (t) => {
      // El sobre y el destinatario se vuelven a mirar con el bloqueo: un sobre anulado o un destinatario reasignado
      // mientras tanto no suma recipient.identity_started a la evidencia de un sobre cerrado o de alguien que ya no firma.
      const cur = await lockEnvelope(t, e.tenant_id, e.id);
      if (cur.status !== "sent" || pastExpiry(cur)) throw new AppError(410, "envelope_closed", "El sobre ya no está disponible");
      const rNow = await t.one<any>(`SELECT status, access_token_hash FROM recipients WHERE id = $1`, [r.id]);
      // Una corrección del contacto (link nuevo, verificaciones anuladas) confirmada mientras tanto: la verificación de
      // quien tenía el link anterior no queda en curso a nombre del contacto corregido.
      assertLinkCurrent(rNow, r);
      if (!["sent", "viewed"].includes(rNow?.status)) throw conflict("not_signable", "Ya no podés firmar este sobre");
      // Dos inicios simultáneos no crean dos verificaciones en curso ni consumen dos intentos (el índice único de 0019
      // lo garantiza también a nivel base).
      // Una reserva de modo redirect que quedó sin sesión del proveedor (el proceso murió o el proveedor no respondió)
      // se cancela: si no, bloqueaba todo nuevo inicio para siempre.
      if (adapter.mode === "redirect") {
        await t.query(
          `UPDATE identity_verifications SET status = 'canceled', updated_at = now()
            WHERE recipient_id = $1 AND status = 'created' AND provider_ref IS NULL AND updated_at < now() - interval '2 minutes'`,
          [r.id],
        );
      }
      const active = await t.one<any>(`SELECT id FROM identity_verifications WHERE recipient_id = $1 AND status IN ('created','pending') LIMIT 1`, [
        r.id,
      ]);
      if (active) return false;
      const usedNow = await attemptsUsed(t, r.id);
      if (usedNow >= settings.maxAttempts) throw new AppError(429, "identity_attempts_exhausted", "Se agotaron los intentos de verificación");
      await t.query(
        `INSERT INTO identity_verifications (id, tenant_id, envelope_id, recipient_id, provider, level, status, attempt, provider_ref, redirect_url, return_token_enc, session_token_hash, integration_level)
         VALUES ($1,$2,$3,$4,$5,$6,'created',$7,NULL,NULL,$8,$9,$10)`,
        [
          id,
          e.tenant_id,
          e.id,
          r.id,
          provider,
          r.id_verification_level,
          usedNow + 1,
          encrypt(req.params.token),
          sessionHash,
          integrationLevelToStore(provider as IdvProvider, r.id_verification_level as IdvLevel),
        ],
      );
      await t.query(`UPDATE recipients SET identity_status = 'in_progress' WHERE id = $1`, [r.id]);
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.identity_started",
        actor,
        data: { verificationId: id, provider, level: r.id_verification_level, attempt: usedNow + 1 },
      });
      return true;
    });
    if (won && adapter.mode === "redirect") {
      setSignerReturnCookie(reply, "identity", id, req.params.token);
      try {
        const created = await withTimeout(
          30_000,
          adapter.createSession!({
            verificationId: id,
            level: r.id_verification_level,
            person: { fullName: r.name, documentNumber: r.id_document_number ?? null, email: r.email, phone: r.phone },
            // El dominio del sobre (sub-marca): ahí vive la sesión del código del firmante. Vuelta neutra (signer-return.ts):
            // lleva al token con que se está verificando en este navegador (cookie) o al último con que se inició o retomó.
            returnUrl: signerReturnUrl(await envelopeBaseUrl(s.db, e.tenant_id, e.id), "identity", id, r),
            callbackUrl: `${config.appUrl}/v1/integrations/identity/${provider}/webhook`,
            locale: r.locale ?? e.locale,
          }),
        );
        // Si la reserva se canceló mientras tanto (el sobre se cerró, una corrección del contacto), la sesión ya existe en
        // el proveedor: provider_ref se guarda igual (sin reabrirla) para que el uso del plan y la auditoría la cuenten.
        await s.db.query(
          `UPDATE identity_verifications
              SET provider_ref = $2,
                  redirect_url = CASE WHEN status = 'created' THEN $3 ELSE redirect_url END,
                  status = CASE WHEN status = 'created' THEN 'pending' ELSE status END,
                  updated_at = now()
            WHERE id = $1 AND (status = 'created' OR provider_ref IS NULL)`,
          [id, created.providerRef, created.redirectUrl],
        );
      } catch (err) {
        // El proveedor no respondió: la reserva se cancela (no consume un intento) y se puede volver a iniciar.
        await s.db
          .query(`UPDATE identity_verifications SET status = 'canceled', updated_at = now() WHERE id = $1 AND status = 'created'`, [id])
          .catch(() => {});
        // Vuelve al estado que tenía antes de este intento (p. ej. "failed" de uno anterior), no siempre a "pending".
        await s.db
          .query(`UPDATE recipients SET identity_status = $2 WHERE id = $1 AND identity_status = 'in_progress'`, [
            r.id,
            r.identity_status && r.identity_status !== "in_progress" ? r.identity_status : "pending",
          ])
          .catch(() => {});
        throw err;
      }
    }
    return sessionOut(req.params.token);
  });

  // Vuelta del proveedor de verificación (modo redirect): al link con que se está firmando, o una página neutra.
  type RV = { Params: { id: string }; Querystring: { k?: string } };
  app.get<RV>("/v1/identity/return/:id", rl, async (req, reply) => {
    const v = /^[0-9a-f-]{36}$/i.test(req.params.id)
      ? await s.db.one<any>(`SELECT id, tenant_id, envelope_id, recipient_id, return_token_enc FROM identity_verifications WHERE id = $1`, [
          req.params.id,
        ])
      : null;
    const token = v
      ? await resolveSignerReturn(s.db, req, {
          kind: "identity",
          id: v.id,
          recipientId: v.recipient_id,
          envelopeId: v.envelope_id,
          storedTokenEnc: v.return_token_enc,
          key: typeof req.query.k === "string" ? req.query.k : undefined,
        })
      : null;
    if (!token) return sendNeutralReturn(s.db, req, reply, "identity", v ?? null);
    const base = await envelopeBaseUrl(s.db, v.tenant_id, v.envelope_id);
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    return reply.redirect(`${base}/s/${token}?identity=return`, 303);
  });

  app.post<P>("/v1/signing/:token/identity/captures/:kind", { ...rl, bodyLimit: MAX_IMAGE_BYTES + 1024 * 1024 }, async (req) => {
    const { r, e, sessionHash } = await context(req);
    const kind = req.params.kind as IdvCaptureKind;
    if (!(IDV_CAPTURE_KINDS as readonly string[]).includes(kind)) throw badRequest("invalid_capture", "Tipo de captura inválido");
    if (!requiredCaptures(r.id_verification_level).includes(kind)) throw badRequest("invalid_capture", "Esta captura no corresponde al nivel pedido");
    assertSignable(e, r);
    const v = await latestVerification(s.db, r.id);
    if (!v || v.status !== "created" || getAdapter(v.provider).mode !== "builtin")
      throw conflict("no_active_capture", "Primero iniciá la verificación");
    // El proveedor de prueba deshabilitado (producción sin IDV_MOCK_ENABLED) no recibe fotos de documentos.
    if (!providerReady(v.provider)) throw new AppError(503, "identity_provider_unavailable", SIGNER_UNAVAILABLE_MESSAGE);
    await unbindOtherSession(s.db, v.id, sessionHash);

    const file = await req.file({ limits: { fileSize: MAX_IMAGE_BYTES } });
    if (!file) throw badRequest("file_required", "Falta la imagen (campo 'file')");
    const bytes = new Uint8Array(await file.toBuffer());
    if (file.file.truncated) throw new AppError(413, "file_too_large", "La imagen supera 8 MB", { limit: "file" });
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isPng = Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isJpeg && !isPng) throw badRequest("invalid_image", "Se esperaba una foto JPG o PNG");
    if (bytes.length < MIN_IMAGE_BYTES) throw badRequest("invalid_image", "La imagen es demasiado chica");

    // Sin metadatos (EXIF con la ubicación GPS, modelo del equipo, XMP, comentarios): se guarda y se cifra solo la imagen.
    let clean: Uint8Array;
    try {
      clean = stripImageMetadata(bytes);
    } catch {
      throw badRequest("invalid_image", "No se pudo leer la imagen: probá con otra foto");
    }
    const plainHash = sha256Hex(clean);
    const enc = encryptBytes(clean);
    const fileId = uuidv7();
    const key = `tenants/${e.tenant_id}/envelopes/${e.id}/identity/${fileId}.bin`;
    await s.blobs.put(key, enc, "application/octet-stream");
    // Si la transacción falla (la verificación ya se envió, o dos subidas simultáneas de la misma foto), la imagen
    // cifrada recién subida no la referencia nada y quedaría para siempre.
    const replaced = await discardBlobsOnFailure(s.blobs, [key], () =>
      s.db.tx(async (t) => {
        // Con el sobre bloqueado: una foto que llega con el sobre ya anulado, rechazado, vencido o purgado (o el
        // destinatario reemplazado) no queda guardada; la purga del sobre ya no la vería y quedaba para siempre.
        await lockedSignable(t, e, r);
        // Con la verificación bloqueada: una captura que llega después del envío no reemplaza la foto ya evaluada, y dos
        // subidas simultáneas del mismo tipo no chocan con UNIQUE (verification_id, kind).
        const cur = await t.one<any>(`SELECT status FROM identity_verifications WHERE id = $1 FOR UPDATE`, [v.id]);
        if (cur?.status !== "created") throw conflict("no_active_capture", "Primero iniciá la verificación");
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
      }),
    );
    if (replaced) await s.blobs.delete(replaced.storage_key).catch(() => {});
    return sessionOut(req.params.token);
  });

  app.post<P>("/v1/signing/:token/identity/submit", rl, async (req) => {
    const { r, e, sessionHash } = await context(req);
    assertSignable(e, r);
    const v = await latestVerification(s.db, r.id);
    if (!v || !["created", "pending"].includes(v.status)) throw conflict("no_active_verification", "No hay una verificación en curso");
    const adapter = getAdapter(v.provider);
    if (!providerReady(v.provider)) throw new AppError(503, "identity_provider_unavailable", SIGNER_UNAVAILABLE_MESSAGE);
    await unbindOtherSession(s.db, v.id, sessionHash);
    const actor = recipientActor(req, r);
    let outcome: string | null = null;
    if (adapter.mode === "builtin") {
      // Las fotos se leen con el sobre bloqueado (lockedSignable): no se evalúa con el sobre ya cerrado.
      const caps = await s.db.tx(async (t) => {
        await lockedSignable(t, e, r);
        return t.query<any>(`SELECT kind, sha256 FROM identity_captures WHERE verification_id = $1`, [v.id]);
      });
      const missing = requiredCaptures(v.level).filter((k) => !caps.some((c) => c.kind === k));
      if (missing.length) throw new AppError(422, "captures_incomplete", `Faltan fotos: ${missing.join(", ")}`, { missing });
      const settings = await getIdentitySettings(s.db, e.tenant_id);
      const result = mockDecide(v.level, caps, settings.mock, { name: r.name, documentNumber: r.id_document_number ?? null }, v.id);
      outcome = await finalizeVerification(s.db, v.id, result, { ...actor, label: `${actor.label} · ${adapter.name}` });
    } else if (adapter.fetchResult) {
      // Sin sesión en el proveedor (la reserva todavía no la creó o falló) no hay nada que consultar.
      if (!v.provider_ref) throw conflict("verification_not_started", "La verificación todavía no empezó en el proveedor");
      // Como la consulta del GET: como máximo una cada 5 s por verificación (el botón no dispara una consulta paga por clic).
      const turn = await s.db.query(
        `UPDATE identity_verifications SET polled_at = now() WHERE id = $1 AND (polled_at IS NULL OR polled_at < now() - interval '5 seconds') RETURNING id`,
        [v.id],
      );
      if (!turn.length) return sessionOut(req.params.token);
      const res = await adapter.fetchResult(v.provider_ref, v.provider_process_id);
      if (res.status !== "pending") outcome = await finalizeVerification(s.db, v.id, res, { type: "system", label: adapter.name });
    }
    // El sobre se cerró (o el destinatario fue reemplazado) entre el control de arriba y el resultado.
    if (outcome === "canceled") throw new AppError(410, "envelope_closed", "El sobre ya no está disponible");
    return sessionOut(req.params.token);
  });

  // ───────── Webhooks de proveedores (cuerpo crudo para verificar la firma) ─────────

  await app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    sub.post<{ Params: { provider: string } }>(
      "/v1/integrations/identity/:provider/webhook",
      { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const provider = req.params.provider as IdvProvider;
        if (provider !== "veriff" && provider !== "truora")
          return reply.code(404).send({ error: { code: "not_found", message: "Proveedor desconocido" } });
        const adapter = getAdapter(provider);
        if (!adapter.configured() || !adapter.parseWebhook)
          return reply.code(503).send({ error: { code: "not_configured", message: "Proveedor no configurado" } });
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""));
        let events;
        try {
          events = adapter.parseWebhook(raw, req.headers);
        } catch (err) {
          if (err instanceof WebhookSignatureError) return reply.code(401).send({ error: { code: "invalid_signature", message: err.message } });
          return reply.code(400).send({ error: { code: "invalid_payload", message: String((err as Error).message ?? err) } });
        }
        // Todos los eventos del lote (Truora agrupa varios, de distintas verificaciones): antes solo se miraba el primero.
        let processed = 0;
        for (const parsed of events) {
          const v = await s.db.one<any>(`SELECT * FROM identity_verifications WHERE provider = $1 AND provider_ref = $2`, [
            provider,
            parsed.providerRef,
          ]);
          if (!v) continue;
          processed++;
          // Todo webhook es actividad del proveedor (corre el plazo de provider_timeout, expireStaleVerifications).
          if (parsed.processId && parsed.processId !== v.provider_process_id) {
            await s.db.query(`UPDATE identity_verifications SET provider_process_id = $2, updated_at = now() WHERE id = $1`, [
              v.id,
              parsed.processId,
            ]);
          } else if (["created", "pending"].includes(v.status)) {
            await s.db.query(`UPDATE identity_verifications SET updated_at = now() WHERE id = $1 AND status IN ('created','pending')`, [v.id]);
          }
          let result = parsed.result;
          if (!result && adapter.fetchResult) result = await adapter.fetchResult(v.provider_ref, parsed.processId ?? v.provider_process_id);
          if (result && result.status !== "pending")
            await finalizeVerification(s.db, v.id, result, { type: "system", label: `${adapter.name} (webhook)` });
        }
        if (!processed) return { ok: true, ignored: "unknown_reference" };
        return { ok: true };
      },
    );
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

  // El remitente vuelve a empezar la verificación de un destinatario: anula las anteriores (aprobadas, fallidas y la que
  // esté en curso) y le devuelve todos los intentos. P. ej. agotó los intentos por fotos malas, o el proveedor quedó
  // trabado sin resultado. Con {provider, level} cambia además el proveedor o el nivel (con las mismas reglas que al
  // armar el sobre, applyIdentityFlags): un sobre enviado con un nivel que el proveedor no puede hacer (de antes de esas
  // reglas, o porque cambió VERIFF_INTEGRATION_LEVEL o el flujo de Truora) no queda trabado. Sin cambio, si el proveedor
  // sigue sin poder hacer el nivel, 409 identity_level_not_supported (reiniciar no lo arreglaría).
  const ResetInput = z.object({ provider: z.enum(IDV_PROVIDERS).optional(), level: z.enum(IDV_LEVELS).optional() });
  app.post<{ Params: { id: string; recipientId: string } }>(
    "/v1/envelopes/:id/recipients/:recipientId/identity/reset",
    { preHandler: auth },
    async (req) => {
      const a = req.auth!;
      const input = ResetInput.parse(req.body ?? {});
      await s.db.tx(async (t) => {
        const e = await lockEnvelope(t, a.tenantId, req.params.id);
        if (e.status !== "sent" || pastExpiry(e)) throw conflict("not_in_progress", "Solo se reinicia la verificación en un sobre en curso");
        const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1 AND envelope_id = $2 FOR UPDATE`, [req.params.recipientId, e.id]);
        if (!r) throw notFound("Destinatario");
        if (!identityRequired(r)) throw conflict("identity_not_required", "Este destinatario no tiene verificación de identidad");
        if (!["created", "sent", "viewed"].includes(r.status))
          throw conflict("recipient_immutable", `${r.name} ya firmó o terminó su participación: no se puede modificar`);
        const previous = { provider: r.id_verification_provider as IdvProvider, level: r.id_verification_level as IdvLevel };
        const next = { provider: input.provider ?? previous.provider, level: input.level ?? previous.level };
        const changed = next.provider !== previous.provider || next.level !== previous.level;
        if (changed) {
          // Plan, rol y disponibilidad del proveedor para el nivel (400 identity_provider_unavailable con el motivo).
          await applyIdentityFlags(t, e.id, [{ id: r.id, role: r.role, idVerification: next }]);
        } else {
          const unavailable = providerUnavailableReason(next.provider, next.level);
          if (unavailable)
            throw conflict(
              "identity_level_not_supported",
              `${unavailable}. Reiniciar no lo resuelve: elegí otro nivel o proveedor (provider/level en el pedido) o corregí la configuración`,
              { provider: next.provider, level: next.level },
            );
        }
        const canceled = await t.query<{ id: string; status: string }>(
          `UPDATE identity_verifications SET status = 'canceled', updated_at = now()
          WHERE recipient_id = $1 AND status IN ('created','pending','verified','failed','expired') RETURNING id, status`,
          [r.id],
        );
        await t.query(
          `UPDATE recipients SET identity_status = 'pending', identity_verified_at = NULL, identity_failure_reason = NULL WHERE id = $1`,
          [r.id],
        );
        await appendEvent(t, {
          tenantId: e.tenant_id,
          envelopeId: e.id,
          type: "recipient.identity_reset",
          actor: a.actor,
          data: {
            recipientId: r.id,
            previousStatus: r.identity_status ?? "pending",
            canceledVerifications: canceled.length,
            ...(changed ? { previous, provider: next.provider, level: next.level } : {}),
          },
        });
      });
      return getRecipientIdentityDetail(req.params.id, req.params.recipientId, a.tenantId);
    },
  );

  app.get<{ Params: { id: string; recipientId: string } }>("/v1/envelopes/:id/recipients/:recipientId/identity", { preHandler: auth }, async (req) =>
    getRecipientIdentityDetail(req.params.id, req.params.recipientId, req.auth!.tenantId),
  );

  async function getRecipientIdentityDetail(envelopeId: string, recipientId: string, tenantId: string) {
    const r = await s.db.one<any>(`SELECT * FROM recipients WHERE id = $1 AND envelope_id = $2 AND tenant_id = $3`, [
      recipientId,
      envelopeId,
      tenantId,
    ]);
    if (!r) throw notFound("Destinatario");
    const rows = await s.db.query<any>(`SELECT * FROM identity_verifications WHERE recipient_id = $1 ORDER BY created_at`, [r.id]);
    return {
      identity: toRecipientIdentity(r),
      // Para el remitente: por qué el proveedor no puede hacer el nivel pedido (el firmante ve un mensaje neutro). Se
      // resuelve con identity/reset eligiendo otro nivel o proveedor, o corrigiendo la configuración.
      unavailableReason: r.id_verification_provider ? providerUnavailableReason(r.id_verification_provider, r.id_verification_level) : null,
      attempts: rows.map((v) => {
        const res = (v.result ?? null) as IdvResult | null;
        return {
          id: v.id,
          attempt: v.attempt,
          provider: v.provider,
          level: v.level,
          status: v.status,
          reference: providerReference(v, res),
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
  }
}
