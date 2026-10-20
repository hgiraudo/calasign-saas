// Firma embebida (Fase 3): el integrador pide una URL de un solo uso para un destinatario y la abre
// en un iframe (o redirige). La página del firmante se puede enmarcar solo desde los orígenes que la
// organización autorizó (CSP frame-ancestors) y avisa al padre por postMessage.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CreateSigningUrlInput,
  EmbedSettingsInput,
  wildcardOriginOk,
  type EmbedSettings,
  type SigningEmbedInfo,
  type SigningUrlResponse,
} from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { appendEvent } from "../infra/evidence";
import { badRequest, conflict, notFound } from "../lib/errors";
import { randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { authenticate, clientInfo, type AuthContext, type Services } from "./context";
import { envelopeBaseUrl } from "./white-label/brand";
import { issueSignerSessionToken, signerTokenHash } from "./signer-token";

const CODE_TTL_MS = 5 * 60_000;

/** Marca/desmarca destinatarios embebidos (solo si el pedido trae el flag: ausente = sin cambios). */
export async function setEmbeddedFlags(db: Db, envelopeId: string, list: { id: string; embedded?: boolean }[]) {
  for (const r of list) {
    if (r.embedded === undefined) continue;
    await db.query(`UPDATE recipients SET embedded = $3 WHERE id = $1 AND envelope_id = $2`, [r.id, envelopeId, r.embedded]);
  }
}

const AUTH_LABEL: Record<string, string> = {
  es: "Sesión embebida en la aplicación del integrador (autenticada por el integrador)",
  "pt-BR": "Sessão incorporada na aplicação do integrador (autenticada pelo integrador)",
  en: "Embedded session in the integrator's application (authenticated by the integrator)",
};

export function embeddedAuthLabel(locale: string) {
  return AUTH_LABEL[locale] ?? AUTH_LABEL.es;
}

/** Marca en embed_sessions.frame_ancestors de una URL que no se puede embeber (firmante con OTP). */
const TAB_ONLY = "'none'";

function cspFrameAncestors(origins: string[]) {
  return origins.length ? `'self' ${origins.join(" ")}` : "'none'";
}

/** Reemplaza la directiva frame-ancestors del CSP que puso helmet. */
export function setFrameAncestors(reply: FastifyReply, origins: string[]) {
  const csp = String(reply.getHeader("content-security-policy") ?? "");
  const value = cspFrameAncestors(origins);
  const next = /frame-ancestors [^;]*/.test(csp) ? csp.replace(/frame-ancestors [^;]*/, `frame-ancestors ${value}`) : `${csp};frame-ancestors ${value}`;
  reply.header("content-security-policy", next);
  if (origins.length) reply.removeHeader("x-frame-options");
}

/**
 * Sesión embebida usada en las últimas 24 h (la que fija los orígenes del iframe), o null. También decide si el
 * firmante cuenta como embebido para delegar (otp.ts isEmbeddedSigner): misma ventana.
 */
export async function lastEmbedSession(db: Db, recipientId: string): Promise<{ frame_ancestors: string[] | null } | null> {
  return db.one<any>(
    `SELECT frame_ancestors FROM embed_sessions WHERE recipient_id = $1 AND used_at IS NOT NULL AND created_at > now() - interval '24 hours'
     ORDER BY created_at DESC LIMIT 1`,
    [recipientId],
  );
}

/**
 * Orígenes autorizados de la organización, sin los comodines demasiado amplios (https://*.com.ar…) guardados antes de
 * que el esquema los rechazara (la 0082 los borró; esto cubre cualquier fila que quede). Lo usan el CSP de la página
 * del firmante y de los formularios, /v1/signing/:token/embed y la configuración.
 */
export async function tenantFrameAncestors(db: Db, tenantId: string): Promise<string[]> {
  const t = await db.one<any>(`SELECT embed_frame_ancestors FROM tenants WHERE id = $1`, [tenantId]);
  return ((t?.embed_frame_ancestors ?? []) as string[]).filter(wildcardOriginOk);
}

async function originsForRecipient(db: Db, recipientId: string, tenantId: string, last?: { frame_ancestors: string[] | null } | null): Promise<string[]> {
  const allowed = await tenantFrameAncestors(db, tenantId);
  if (last === undefined) last = await lastEmbedSession(db, recipientId);
  const requested: string[] = last?.frame_ancestors ?? [];
  // Lo pedido para esa sesión, siempre dentro de lo autorizado por la organización.
  return requested.length ? requested.filter((o) => allowed.includes(o)) : allowed;
}

/**
 * La página de firma le sigue exigiendo al destinatario una autenticación propia aunque llegue por la URL del integrador:
 * código OTP (cada navegador lo vuelve a pedir), firma presencial (sesión del anfitrión) o verificación de identidad
 * todavía no superada (una vez verificada, la página ya no la vuelve a pedir).
 */
export function pageStillAuthenticates(r: { auth_method?: string | null; id_verification_provider?: string | null; identity_status?: string | null; role?: string | null }): boolean {
  const m = String(r.auth_method ?? "");
  if (m.startsWith("otp_") || m === "in_person") return true;
  // Igual que identityBlocking (identity/kyc.ts): solo firmantes y aprobadores la tienen que superar.
  return Boolean(r.id_verification_provider) && (r.role === "signer" || r.role === "approver") && r.identity_status !== "verified";
}

/**
 * Crea una URL de firma embebida de un solo uso para un destinatario activo, dentro de la transacción del llamador.
 * La usan POST …/signing-url y POST /v1/envelopes cuando envía un sobre con firmantes embebidos.
 */
export async function issueSigningUrl(t: Db, a: AuthContext, envelopeId: string, recipientId: string, input: CreateSigningUrlInput): Promise<SigningUrlResponse> {
  const allowed = await tenantFrameAncestors(t, a.tenantId);
  const requested = (input.frameAncestors ?? []).map((o) => o.toLowerCase().replace(/\/$/, ""));
  const notAllowed = requested.filter((o) => !allowed.includes(o));
  if (notAllowed.length) {
    throw badRequest("frame_ancestor_not_allowed", `Origen no autorizado en la configuración de la organización: ${notAllowed.join(", ")}`);
  }
  const code = randomToken(24);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);
  const e = await t.one<any>(`SELECT * FROM envelopes WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [envelopeId, a.tenantId]);
  if (!e) throw notFound("Sobre");
  // awaiting_certificates: un firmante embebido con certificado necesita su link para emparejar el Firmador.
  if (!["sent", "awaiting_certificates", "completed"].includes(e.status)) throw conflict("not_available", "El sobre no está en curso");
  const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1 AND envelope_id = $2`, [recipientId, e.id]);
  if (!r) throw notFound("Destinatario");
  if (!r.access_token_enc) throw conflict("not_available", "El destinatario todavía no está activo");
  // Dentro del iframe de otro sitio la cookie de la sesión del código no se guarda: un firmante con OTP quedaba pidiendo
  // el código sin fin. Para mostrarlo en un iframe tiene que autenticarlo la app (sin OTP); abierto en una pestaña sí sirve.
  // Un firmante con OTP no se puede mostrar en un iframe (la cookie de la sesión del código no se guarda ahí): si se
  // piden frameAncestors, 409; si no, la URL sale "para pestaña" (TAB_ONLY: la página no se deja embeber, ni siquiera
  // en los orígenes de la organización, y se abre sin el modo embebido).
  const otp = String(r.auth_method ?? "").startsWith("otp_");
  // Un destinatario NO embebido recibe su link por correo/SMS y nadie más debería poder abrir su ceremonia: la URL
  // (que no pide nada más que el código de un solo uso) solo se entrega si la página igual le exige autenticarse
  // (pageStillAuthenticates). Si no, cualquiera con una API key podía firmar por él.
  if (!r.embedded && !pageStillAuthenticates(r)) {
    throw conflict(
      "not_embedded",
      "El destinatario no es embebido y no tiene otra autenticación: creá el destinatario con embedded: true (lo autentica tu aplicación) o exigí un código (OTP) o verificación de identidad",
    );
  }
  if (requested.length && otp) {
    throw conflict("otp_not_embeddable", "Un firmante con código OTP no se puede mostrar dentro de un iframe: quitale el OTP (lo autentica tu aplicación) o abrí la URL en una pestaña");
  }
  await t.query(
    `INSERT INTO embed_sessions (id, tenant_id, envelope_id, recipient_id, code_hash, return_url, frame_ancestors, created_by_actor, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [uuidv7(), a.tenantId, e.id, r.id, sha256Hex(code), input.returnUrl ?? null, otp ? [TAB_ONLY] : requested, a.actor.label ?? a.actor.type, expiresAt.toISOString()],
  );
  await appendEvent(t, {
    tenantId: a.tenantId,
    envelopeId: e.id,
    type: "recipient.embedded_url_created",
    actor: a.actor,
    data: { recipientId: r.id, returnHost: input.returnUrl ? new URL(input.returnUrl).host : null, frameAncestors: requested, ...(otp ? { tabOnly: true } : {}) },
  });
  return { url: `${await envelopeBaseUrl(t, a.tenantId, e.id)}/embed/${code}`, expiresAt: expiresAt.toISOString(), ...(otp ? { tabOnly: true } : {}) };
}

export async function embedRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;

  // ───────── Configuración de la organización ─────────

  app.get("/v1/settings/embed", { preHandler: auth }, async (req): Promise<EmbedSettings> => ({ frameAncestors: await tenantFrameAncestors(s.db, A(req).tenantId) }));

  app.patch("/v1/settings/embed", { preHandler: auth }, async (req): Promise<EmbedSettings> => {
    const prev = await s.db.one<any>(`SELECT embed_frame_ancestors FROM tenants WHERE id = $1`, [A(req).tenantId]);
    const prevList: string[] = prev?.embed_frame_ancestors ?? [];
    (req as FastifyRequest & { auditBefore?: Record<string, unknown> }).auditBefore = { frameAncestors: prevList };
    // Un comodín demasiado amplio que YA estaba guardado (de antes de la validación) y vuelve tal cual en la lista
    // completa se descarta con aviso (discarded) en vez de dar 400: si no, la organización no podía guardar nada. Uno
    // nuevo sigue rechazándose.
    const norm = (o: string) => o.trim().toLowerCase().replace(/\/$/, "");
    const raw = z.object({ frameAncestors: z.array(z.string()).max(20) }).passthrough().parse(req.body);
    const legacy = new Set(prevList.map(norm));
    const discarded = [...new Set(raw.frameAncestors.map(norm).filter((o) => legacy.has(o) && !wildcardOriginOk(o)))];
    const input = EmbedSettingsInput.parse({ ...raw, frameAncestors: raw.frameAncestors.filter((o) => !discarded.includes(norm(o))) });
    const list = [...new Set(input.frameAncestors.map(norm))];
    if (config.environment !== "local" && list.some((o) => o.startsWith("http://"))) {
      throw badRequest("invalid_origin", "Solo orígenes https fuera del entorno local");
    }
    await s.db.query(`UPDATE tenants SET embed_frame_ancestors = $2 WHERE id = $1`, [A(req).tenantId, list]);
    return { frameAncestors: list, ...(discarded.length ? { discarded } : {}) };
  });

  // ───────── URL de firma embebida ─────────

  app.post<{ Params: { id: string; recipientId: string } }>(
    "/v1/envelopes/:id/recipients/:recipientId/signing-url",
    { preHandler: auth },
    async (req, reply): Promise<SigningUrlResponse> => {
      const a = A(req);
      const input = CreateSigningUrlInput.parse(req.body ?? {});
      const r = await s.db.tx((t) => issueSigningUrl(t, a, req.params.id, req.params.recipientId, input));
      reply.code(201);
      return r;
    },
  );

  // ───────── Intercambio del código (público, un solo uso) ─────────

  app.get<{ Params: { code: string } }>("/embed/:code", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req, reply) => {
    const code = req.params.code;
    const { ip, userAgent } = clientInfo(req);
    const sess = /^[A-Za-z0-9_-]{20,64}$/.test(code)
      ? await s.db.one<any>(
          `UPDATE embed_sessions SET used_at = now(), used_ip = $2 WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING *`,
          [sha256Hex(code), ip],
        )
      : null;
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    const gone = () =>
      reply
        .code(410)
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><meta charset="utf-8"><title>Link vencido · Link expired</title><body style="font-family:sans-serif;padding:32px;color:#0b1f3a">` +
            `<h1>Link vencido</h1><p>Este link de firma ya se usó o venció, o el sobre ya no está disponible. Volvé a la aplicación para obtener uno nuevo.</p>` +
            `<p>Link expirado · Link expired</p>`,
        );
    // El destinatario pudo ser reemplazado (delegó, lo reasignaron) o quitado después de emitirse el código: su link ya
    // no existe (access_token_hash NULL).
    const r = sess ? await s.db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [sess.recipient_id]) : null;
    if (!sess || !r?.access_token_hash) return gone();
    // El canje entrega un token de sesión derivado (signer-token.ts, migración 0083), no el link permanente del
    // destinatario: la URL de la página queda en el historial del iframe o la pestaña, en los logs y proxies del
    // integrador y en equipos compartidos. Vence a las 2 h sin uso (deslizante, tope de 8 h desde el canje) y se revoca al
    // cerrarse el sobre o rotar el link del destinatario.
    const sessionToken = await s.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT status, expires_at FROM envelopes WHERE id = $1 FOR UPDATE`, [sess.envelope_id]);
      // El código vale 5 minutos: si el sobre se anuló, rechazó o venció mientras tanto, no se abre una sesión nueva ni se
      // suma el inicio de sesión a su evidencia.
      if (["voided", "declined", "expired"].includes(cur?.status) || (cur?.status === "sent" && cur.expires_at != null && new Date(cur.expires_at).getTime() <= Date.now())) return null;
      // Ni para un destinatario reemplazado (delegó, lo reasignaron) o con el link rotado después de leerlo arriba.
      const rNow = await t.one<any>(`SELECT access_token_hash FROM recipients WHERE id = $1`, [r.id]);
      if (!rNow?.access_token_hash || rNow.access_token_hash !== r.access_token_hash) return null;
      const issued = await issueSignerSessionToken(t, {
        recipientId: r.id,
        envelopeId: sess.envelope_id,
        tenantId: sess.tenant_id,
        embedSessionId: sess.id,
        accessTokenHash: r.access_token_hash,
      });
      await appendEvent(t, {
        tenantId: sess.tenant_id,
        envelopeId: sess.envelope_id,
        type: "recipient.embedded_session_started",
        actor: { type: "recipient", id: r.id, label: r.email ? `${r.name} <${r.email}>` : r.name, ip, userAgent },
        // Para pestaña (firmante con OTP): la app no lo autentica, lo hace el código.
        data: (sess.frame_ancestors ?? []).includes(TAB_ONLY)
          ? { embedSessionId: sess.id, authentication: "link", tabOnly: true, openedBy: sess.created_by_actor }
          : { embedSessionId: sess.id, authentication: "embedded", authenticatedBy: sess.created_by_actor },
      });
      return issued;
    });
    if (!sessionToken) return gone();
    setFrameAncestors(reply, await originsForRecipient(s.db, r.id, sess.tenant_id));
    // También "para pestaña": el modo embebido de la página es el que vuelve al returnUrl del integrador al terminar
    // (el CSP 'none' ya impide mostrarla en un iframe).
    const tabOnly = (sess.frame_ancestors ?? []).includes(TAB_ONLY);
    // "tab=1": la página muestra su marco completo (marca, idioma) y abre los proveedores en la misma pestaña.
    return reply.redirect(`/s/${sessionToken}?embed=1${tabOnly ? "&tab=1" : ""}`, 302);
  });

  // ───────── Página del firmante en modo embebido: frame-ancestors dinámico ─────────

  // Con embed=1 (la página abierta desde /embed/:code). Sin él, la misma página vuelve al iframe desde un proveedor de
  // pago o identidad (?payment=success, ?identity=return): si no, el CSP 'none' de helmet la dejaba en blanco. En los
  // dos casos solo se relaja para un destinatario con una sesión embebida usada (no para cualquiera marcado embebido ni
  // con los orígenes de la organización por defecto si no la abrió nunca un integrador).
  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method !== "GET") return payload;
    const m = /^\/s\/([A-Za-z0-9_-]{20,100})(?:\?(.*))?$/.exec(req.url);
    if (!m) return payload;
    const embedParam = /(?:^|&)embed=1(?:&|$)/.test(m[2] ?? "");
    // El link permanente o un token de sesión del canje (signer-token.ts).
    const hash = await signerTokenHash(s.db, m[1]);
    const r = hash ? await s.db.one<any>(`SELECT id, tenant_id FROM recipients WHERE access_token_hash = $1`, [hash]) : null;
    if (!r) return payload;
    // Con o sin embed=1, solo para un destinatario con una sesión embebida usada (canjeada en /embed/:code): con solo
    // agregar ?embed=1 al link del correo, la página se dejaba enmarcar en los orígenes de la organización.
    const last = await lastEmbedSession(s.db, r.id);
    if (!last) return payload;
    if (embedParam) {
      setFrameAncestors(reply, await originsForRecipient(s.db, r.id, r.tenant_id, last));
      return payload;
    }
    const origins = await originsForRecipient(s.db, r.id, r.tenant_id, last);
    // Sin orígenes (p. ej. sesión "para pestaña") queda el 'none' de helmet.
    if (origins.length) setFrameAncestors(reply, origins);
    return payload;
  });

  app.get<{ Params: { token: string } }>("/v1/signing/:token/embed", async (req): Promise<SigningEmbedInfo> => {
    const hash = await signerTokenHash(s.db, req.params.token);
    if (!hash) throw notFound("Link");
    const r = await s.db.one<any>(`SELECT id, tenant_id, embedded FROM recipients WHERE access_token_hash = $1`, [hash]);
    if (!r) throw notFound("Link");
    // Misma ventana de 24 h que lastEmbedSession (y que isEmbeddedSigner para delegar): pasado ese plazo la página
    // abierta desde el correo ya no queda en modo embebido.
    const last = await s.db.one<any>(
      `SELECT return_url, frame_ancestors FROM embed_sessions WHERE recipient_id = $1 AND used_at IS NOT NULL AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 1`,
      [r.id],
    );
    // Los orígenes (los mismos que ya publica el CSP de la página) para que la página no avise por postMessage a "*".
    const origins = last ? await originsForRecipient(s.db, r.id, r.tenant_id, last) : [];
    return { embedded: Boolean(r.embedded) || Boolean(last), returnUrl: last?.return_url ?? null, origins };
  });
}
