// Firma embebida (Fase 3): el integrador pide una URL de un solo uso para un destinatario y la abre
// en un iframe (o redirige). La página del firmante se puede enmarcar solo desde los orígenes que la
// organización autorizó (CSP frame-ancestors) y avisa al padre por postMessage.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CreateSigningUrlInput, EmbedSettingsInput, type EmbedSettings, type SigningEmbedInfo, type SigningUrlResponse } from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { appendEvent } from "../infra/evidence";
import { badRequest, conflict, notFound } from "../lib/errors";
import { decrypt, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { authenticate, clientInfo, type AuthContext, type Services } from "./context";
import { tenantBaseUrl } from "./custom-domains";

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

async function originsForRecipient(db: Db, recipientId: string, tenantId: string): Promise<string[]> {
  const t = await db.one<any>(`SELECT embed_frame_ancestors FROM tenants WHERE id = $1`, [tenantId]);
  const allowed: string[] = t?.embed_frame_ancestors ?? [];
  const last = await db.one<any>(
    `SELECT frame_ancestors FROM embed_sessions WHERE recipient_id = $1 AND used_at IS NOT NULL AND created_at > now() - interval '24 hours'
     ORDER BY created_at DESC LIMIT 1`,
    [recipientId],
  );
  const requested: string[] = last?.frame_ancestors ?? [];
  // Lo pedido para esa sesión, siempre dentro de lo autorizado por la organización.
  return requested.length ? requested.filter((o) => allowed.includes(o)) : allowed;
}

export async function embedRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;

  // ───────── Configuración de la organización ─────────

  app.get("/v1/settings/embed", { preHandler: auth }, async (req): Promise<EmbedSettings> => {
    const t = await s.db.one<any>(`SELECT embed_frame_ancestors FROM tenants WHERE id = $1`, [A(req).tenantId]);
    return { frameAncestors: t?.embed_frame_ancestors ?? [] };
  });

  app.patch("/v1/settings/embed", { preHandler: auth }, async (req): Promise<EmbedSettings> => {
    const input = EmbedSettingsInput.parse(req.body);
    const list = [...new Set(input.frameAncestors.map((o) => o.toLowerCase().replace(/\/$/, "")))];
    if (config.environment !== "local" && list.some((o) => o.startsWith("http://"))) {
      throw badRequest("invalid_origin", "Solo orígenes https fuera del entorno local");
    }
    await s.db.query(`UPDATE tenants SET embed_frame_ancestors = $2 WHERE id = $1`, [A(req).tenantId, list]);
    return { frameAncestors: list };
  });

  // ───────── URL de firma embebida ─────────

  app.post<{ Params: { id: string; recipientId: string } }>(
    "/v1/envelopes/:id/recipients/:recipientId/signing-url",
    { preHandler: auth },
    async (req, reply): Promise<SigningUrlResponse> => {
      const a = A(req);
      const input = CreateSigningUrlInput.parse(req.body ?? {});
      const tenant = await s.db.one<any>(`SELECT embed_frame_ancestors FROM tenants WHERE id = $1`, [a.tenantId]);
      const allowed: string[] = tenant?.embed_frame_ancestors ?? [];
      const requested = (input.frameAncestors ?? []).map((o) => o.toLowerCase().replace(/\/$/, ""));
      const notAllowed = requested.filter((o) => !allowed.includes(o));
      if (notAllowed.length) {
        throw badRequest("frame_ancestor_not_allowed", `Origen no autorizado en la configuración de la organización: ${notAllowed.join(", ")}`);
      }
      const code = randomToken(24);
      const expiresAt = new Date(Date.now() + CODE_TTL_MS);
      await s.db.tx(async (t) => {
        const e = await t.one<any>(`SELECT * FROM envelopes WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [req.params.id, a.tenantId]);
        if (!e) throw notFound("Sobre");
        // awaiting_certificates: un firmante embebido con certificado necesita su link para emparejar el Firmador.
        if (!["sent", "awaiting_certificates", "completed"].includes(e.status)) throw conflict("not_available", "El sobre no está en curso");
        const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1 AND envelope_id = $2`, [req.params.recipientId, e.id]);
        if (!r) throw notFound("Destinatario");
        if (!r.access_token_enc) throw conflict("not_available", "El destinatario todavía no está activo");
        await t.query(
          `INSERT INTO embed_sessions (id, tenant_id, envelope_id, recipient_id, code_hash, return_url, frame_ancestors, created_by_actor, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [uuidv7(), a.tenantId, e.id, r.id, sha256Hex(code), input.returnUrl ?? null, requested, a.actor.label ?? a.actor.type, expiresAt.toISOString()],
        );
        await appendEvent(t, {
          tenantId: a.tenantId,
          envelopeId: e.id,
          type: "recipient.embedded_url_created",
          actor: a.actor,
          data: { recipientId: r.id, returnHost: input.returnUrl ? new URL(input.returnUrl).host : null, frameAncestors: requested },
        });
      });
      reply.code(201);
      return { url: `${await tenantBaseUrl(s.db, a.tenantId)}/embed/${code}`, expiresAt: expiresAt.toISOString() };
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
    // El destinatario pudo ser reemplazado (delegó, lo reasignaron) o quitado después de emitirse el código: su link ya
    // no existe (access_token_enc NULL) y descifrarlo daba un error interno, con un evento de sesión ya registrado.
    const r = sess ? await s.db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [sess.recipient_id]) : null;
    if (!sess || !r?.access_token_enc) {
      return reply
        .code(410)
        .type("text/html; charset=utf-8")
        .send(
          `<!doctype html><meta charset="utf-8"><title>CalaSign</title><body style="font-family:sans-serif;padding:32px;color:#0b1f3a">` +
            `<h1>Link vencido</h1><p>Este link de firma ya se usó o venció. Volvé a la aplicación para obtener uno nuevo.</p>` +
            `<p>Link expirado · Link expired</p>`,
        );
    }
    await s.db.tx(async (t) => {
      const cur = await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR UPDATE`, [sess.envelope_id]);
      // El código vale 5 minutos: si el sobre se anuló, rechazó o venció mientras tanto, el firmante ve el sobre cerrado
      // pero no se suma el inicio de sesión a su evidencia.
      if (["voided", "declined", "expired"].includes(cur?.status)) return;
      await appendEvent(t, {
        tenantId: sess.tenant_id,
        envelopeId: sess.envelope_id,
        type: "recipient.embedded_session_started",
        actor: { type: "recipient", id: r.id, label: r.email ? `${r.name} <${r.email}>` : r.name, ip, userAgent },
        data: { embedSessionId: sess.id, authentication: "embedded", authenticatedBy: sess.created_by_actor },
      });
    });
    setFrameAncestors(reply, await originsForRecipient(s.db, r.id, sess.tenant_id));
    return reply.redirect(`/s/${decrypt(r.access_token_enc)}?embed=1`, 302);
  });

  // ───────── Página del firmante en modo embebido: frame-ancestors dinámico ─────────

  app.addHook("onSend", async (req, reply, payload) => {
    if (req.method !== "GET") return payload;
    const m = /^\/s\/([A-Za-z0-9_-]{20,100})\?(?:.*&)?embed=1(?:&|$)/.exec(req.url);
    if (!m) return payload;
    const r = await s.db.one<any>(`SELECT id, tenant_id FROM recipients WHERE access_token_hash = $1`, [sha256Hex(m[1])]);
    if (r) setFrameAncestors(reply, await originsForRecipient(s.db, r.id, r.tenant_id));
    return payload;
  });

  app.get<{ Params: { token: string } }>("/v1/signing/:token/embed", async (req): Promise<SigningEmbedInfo> => {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(req.params.token)) throw notFound("Link");
    const r = await s.db.one<any>(`SELECT id, embedded FROM recipients WHERE access_token_hash = $1`, [sha256Hex(req.params.token)]);
    if (!r) throw notFound("Link");
    const last = await s.db.one<any>(
      `SELECT return_url FROM embed_sessions WHERE recipient_id = $1 AND used_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [r.id],
    );
    return { embedded: Boolean(r.embedded) || Boolean(last), returnUrl: last?.return_url ?? null };
  });
}
