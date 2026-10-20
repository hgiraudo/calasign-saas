// Tokens de la URL del firmante: el link permanente del destinatario (recipients.access_token_hash) o un token de sesión
// derivado del canje de la URL embebida (signer_session_tokens, migración 0083; lo emite embed.ts). Módulo sin
// dependencias de rutas para que lo usen los hooks (marca, dominio propio, celdas, retención) sin ciclos.
import type { Db } from "../infra/db";
import { randomToken, sha256Hex } from "../lib/util";

export const SIGNER_TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
/** Token de sesión del canje embebido: 2 h desde el último uso, nunca más de 8 h desde el canje (embed.ts). */
export const SIGNER_SESSION_TOKEN_HOURS = 2;
export const SIGNER_SESSION_TOKEN_MAX_HOURS = 8;

/** Usos más seguidos que esto no vuelven a escribir el vencimiento (deslizante con resolución de 1 minuto). */
const SLIDE_EVERY = "1 minute";

/**
 * Token de sesión vigente (tabla signer_session_tokens, migración 0083): sin vencer ni revocar y con el link del
 * destinatario sin rotar desde el canje. El cierre del sobre (completado, rechazado, anulado, vencido) lo revoca con 15
 * minutos de gracia (disparador de la 0083): la página embebida muestra el cierre y el puente avisa `closed` como antes.
 * Cada uso lo estira (deslizante) hasta su tope, pero solo escribe si el último registrado tiene más de un minuto: los
 * hooks resuelven el token varias veces por pedido. Devuelve el destinatario y el hash de su link permanente, o null.
 */
export async function resolveSessionToken(db: Db, hash: string): Promise<{ recipient_id: string; access_token_hash: string } | null> {
  const st = await db.one<{ recipient_id: string; access_token_hash: string; stale: boolean }>(
    `SELECT st.recipient_id, st.access_token_hash, (st.last_used_at IS NULL OR st.last_used_at < now() - interval '${SLIDE_EVERY}') AS stale
       FROM signer_session_tokens st
       JOIN recipients r ON r.id = st.recipient_id AND r.access_token_hash = st.access_token_hash
       JOIN envelopes e ON e.id = st.envelope_id AND e.status <> 'draft'
      WHERE st.token_hash = $1 AND st.expires_at > now() AND (st.revoked_at IS NULL OR st.revoked_at > now())`,
    [hash],
  );
  if (!st) return null;
  if (st.stale) {
    await db.query(
      `UPDATE signer_session_tokens SET expires_at = LEAST(now() + make_interval(hours => $2), max_expires_at), last_used_at = now()
        WHERE token_hash = $1 AND expires_at > now() AND (last_used_at IS NULL OR last_used_at < now() - interval '${SLIDE_EVERY}')`,
      [hash, SIGNER_SESSION_TOKEN_HOURS],
    );
  }
  return { recipient_id: st.recipient_id, access_token_hash: st.access_token_hash };
}

/**
 * Emite un token de sesión para una sesión embebida ya registrada (canje de /embed/:code, formulario web embebido),
 * dentro de la transacción del llamador. Devuelve el token (solo se guarda su hash).
 */
export async function issueSignerSessionToken(
  t: Db,
  o: { recipientId: string; envelopeId: string; tenantId: string; embedSessionId: string; accessTokenHash: string },
): Promise<string> {
  const token = randomToken();
  await t.query(
    `INSERT INTO signer_session_tokens (token_hash, recipient_id, envelope_id, tenant_id, embed_session_id, access_token_hash, last_used_at, expires_at, max_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now(), now() + make_interval(hours => $7), now() + make_interval(hours => $8))`,
    [sha256Hex(token), o.recipientId, o.envelopeId, o.tenantId, o.embedSessionId, o.accessTokenHash, SIGNER_SESSION_TOKEN_HOURS, SIGNER_SESSION_TOKEN_MAX_HOURS],
  );
  return token;
}

/**
 * Hash del link permanente (recipients.access_token_hash) que corresponde a un token de la URL del firmante: el propio
 * link permanente o un token de sesión vigente. null si no es ninguno. Para las búsquedas por token fuera de
 * resolveToken (marca de la página, dominio propio, celda, retención, CSP del modo embebido).
 */
export async function signerTokenHash(db: Db, token: string): Promise<string | null> {
  if (!SIGNER_TOKEN_RE.test(token)) return null;
  const hash = sha256Hex(token);
  const r = await db.one<any>(`SELECT 1 FROM recipients WHERE access_token_hash = $1`, [hash]);
  if (r) return hash;
  return (await resolveSessionToken(db, hash))?.access_token_hash ?? null;
}

