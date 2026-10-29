// Sesiones web del personal: apertura (con o sin "recordarme"), re-autenticación de acciones sensibles, listado y
// cierre de sesiones propias y "cerrar todas las sesiones".
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../infra/db";
import { AppError, notFound } from "../lib/errors";
import { ipNetworkKey } from "../lib/ip";
import { iso, randomToken, sha256Hex, verifyPassword } from "../lib/util";
import {
  authenticate,
  clearSessionCookie,
  clientInfo,
  sessionAliveSql,
  sessionCookieToken,
  SESSION_DAYS,
  setSessionCookie,
  type Services,
} from "./context";
import { requireUserSession } from "./oauth-tokens";
import { clearLoginAttempts, takeLoginAttempt } from "./login-attempts";
import { recordAudit } from "./audit";

/** Minutos desde el último ingreso con credenciales en que una acción sensible no vuelve a pedir la contraseña. */
export const REAUTH_MINUTES = 10;

/**
 * Abre una sesión con contraseña (login, segundo paso, aceptar una invitación, alta). Sin "recordarme", la cookie es de
 * sesión del navegador y la sesión se cierra tras config.sessionIdleHours sin actividad; con "recordarme", cookie
 * persistente y sesión de SESSION_DAYS días.
 */
export async function openPasswordSession(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  tenantId: string,
  opts: { rememberMe?: boolean } = {},
) {
  const token = randomToken();
  const { ip, userAgent } = clientInfo(req);
  const remember = opts.rememberMe === true;
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, ip, user_agent, expires_at, remember, authenticated_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '${SESSION_DAYS} days', $6, now(), now())`,
    [sha256Hex(token), userId, tenantId, ip, userAgent, remember],
  );
  setSessionCookie(reply, token, remember ? SESSION_DAYS * 86400 : null);
}

const hasScryptPassword = (h: unknown): h is string => typeof h === "string" && h.startsWith("scrypt$");

/**
 * Re-autenticación para acciones sensibles de la cuenta (activar la 2FA, regenerar códigos de recuperación): con una
 * cookie robada (o una sesión olvidada abierta) no se puede tomar la cuenta. Vale la contraseña actual en el cuerpo
 * (cuentas con contraseña; cuenta para el bloqueo de intentos como un ingreso) o un ingreso con credenciales en los
 * últimos REAUTH_MINUTES minutos (la única opción de las cuentas sin contraseña, p. ej. solo SSO).
 */
export async function assertRecentAuth(db: Db, req: FastifyRequest, userId: string, password: string | undefined | null) {
  const u = await db.one<{ password_hash: unknown; email: string }>(`SELECT password_hash, email FROM users WHERE id = $1`, [userId]);
  const withPassword = hasScryptPassword(u?.password_hash);
  if (password && withPassword) {
    const { ip, userAgent } = clientInfo(req);
    await takeLoginAttempt(db, userId, ip);
    if (await verifyPassword(password, u!.password_hash as string)) {
      await clearLoginAttempts(db, userId, ip);
      return;
    }
    const tenants = await db.query<{ tenant_id: string }>(`SELECT tenant_id FROM memberships WHERE user_id = $1`, [userId]);
    for (const m of tenants) {
      await recordAudit(db, {
        tenantId: m.tenant_id,
        action: "auth.login_failed",
        actor: { type: "user", id: userId, label: u!.email },
        ip,
        userAgent,
        data: { reason: "bad_password_reauth" },
      }).catch(() => {});
    }
    throw new AppError(403, "invalid_password", "La contraseña no es correcta");
  }
  const cookie = sessionCookieToken(req);
  const fresh = cookie
    ? await db.one(
        `SELECT 1 FROM sessions WHERE token_hash = $1 AND user_id = $2 AND authenticated_at > now() - interval '${REAUTH_MINUTES} minutes'`,
        [sha256Hex(cookie), userId],
      )
    : null;
  if (fresh) return;
  throw new AppError(
    403,
    "reauth_required",
    withPassword
      ? "Confirmá tu contraseña para continuar"
      : `Volvé a ingresar (cerrá la sesión y entrá de nuevo) y repetí la acción dentro de los ${REAUTH_MINUTES} minutos`,
    { password: withPassword },
  );
}

/** Agente de usuario corto para mostrar ("Firefox en Windows"). */
export function shortUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /curl\//i.test(ua)
              ? "curl"
              : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iOS/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os ?? ua.slice(0, 40);
}

/** Cierra todas las sesiones de la cuenta y revoca sus tokens OAuth, códigos sin canjear y desafíos de 2FA. */
export async function closeAllSessions(db: Db, userId: string): Promise<number> {
  return db.tx(async (t) => {
    const closed = await t.query(`DELETE FROM sessions WHERE user_id = $1 RETURNING user_id`, [userId]);
    await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await t.query(`UPDATE oauth_authorization_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    await t.query(`DELETE FROM login_challenges WHERE user_id = $1`, [userId]);
    return closed.length;
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function sessionRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  /** Sesiones abiertas de la cuenta (todas sus organizaciones), la actual marcada. */
  app.get("/v1/me/sessions", { preHandler: auth }, async (req) => {
    const a = req.auth;
    requireUserSession(a);
    const cookie = sessionCookieToken(req);
    const rows = await s.db.query<any>(
      `SELECT s.id, s.token_hash, s.created_at, s.last_seen_at, s.authenticated_at, s.user_agent, s.ip, s.auth_method, s.remember
         FROM sessions s WHERE s.user_id = $1 AND ${sessionAliveSql("s")} ORDER BY s.last_seen_at DESC LIMIT 200`,
      [a.userId],
    );
    const current = cookie ? sha256Hex(cookie) : null;
    return {
      items: rows.map((r) => ({
        id: r.id as string,
        createdAt: iso(r.created_at)!,
        lastSeenAt: iso(r.last_seen_at)!,
        userAgent: shortUserAgent(r.user_agent),
        ip: r.ip ? ipNetworkKey(r.ip) : null,
        method: r.auth_method as "password" | "sso",
        rememberMe: Boolean(r.remember),
        current: r.token_hash === current,
      })),
    };
  });

  /** Cierra una sesión propia (otro dispositivo o la actual). */
  app.delete<{ Params: { id: string } }>("/v1/me/sessions/:id", { preHandler: auth }, async (req, reply) => {
    const a = req.auth;
    requireUserSession(a);
    if (!UUID_RE.test(req.params.id)) throw notFound("Sesión");
    const r = await s.db.query<{ token_hash: string }>(`DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING token_hash`, [
      req.params.id,
      a.userId,
    ]);
    if (!r.length) throw notFound("Sesión");
    const cookie = sessionCookieToken(req);
    if (cookie && r[0].token_hash === sha256Hex(cookie)) clearSessionCookie(reply);
    return reply.code(204).send();
  });

  /**
   * Cerrar todas las sesiones (todos los dispositivos, también la actual) y revocar los tokens de las apps OAuth que
   * autorizó: para cuando se perdió un dispositivo o se sospecha que alguien usó la cuenta.
   */
  app.post("/v1/auth/logout-all", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const a = req.auth;
    requireUserSession(a);
    const closed = await closeAllSessions(s.db, a.userId);
    const tenants = await s.db.query<{ tenant_id: string }>(`SELECT tenant_id FROM memberships WHERE user_id = $1`, [a.userId]);
    const { ip, userAgent } = clientInfo(req);
    for (const tenantId of new Set([a.tenantId, ...tenants.map((m) => m.tenant_id)])) {
      await recordAudit(s.db, {
        tenantId,
        action: "auth.logout_all",
        actor: { type: "user", id: a.userId, label: a.actor.label },
        targetType: "user",
        targetId: a.userId,
        ip,
        userAgent,
        data: { sessionsClosed: closed },
      }).catch((err) => req.log.error({ err }, "no se pudo registrar la auditoría"));
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
}
