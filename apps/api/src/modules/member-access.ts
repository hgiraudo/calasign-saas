import type { Db } from "../infra/db";
import { randomToken, sha256Hex } from "../lib/util";

/**
 * Corta el acceso que una persona conserva en la organización después de dejar de ser miembro (baja desde la consola
 * o desactivación por SCIM). Corre dentro de la transacción de la baja.
 * - Sus API keys: si no, sigue entrando con el rol de la key.
 * - Las invitaciones pendientes que mandó: el enlace (acceptUrl) lo vio ella y le permitiría volver a entrar.
 * - Los tokens OAuth emitidos a su nombre en esta organización.
 * - Las apps de servicio (client_credentials) que creó: conoce el secreto. El secreto queda inutilizable (un
 *   administrador lo rota para seguir usando la app) y se revocan los tokens ya emitidos.
 * - Sus tokens SCIM (con ellos podía volver a darse de alta o desactivar a otros).
 * - Las invitaciones pendientes dirigidas a su correo (si no, el link original la volvía a sumar después de una baja).
 * - Sus desafíos de 2FA pendientes en esta organización.
 * opts.removal = false (cambio de rol a uno con menos permisos): solo las credenciales que creó; no lo que le
 * corresponde como persona (sus tokens OAuth ya se limitan a los permisos del rol nuevo).
 */
export async function revokeMemberAccess(t: Db, tenantId: string, userId: string, opts: { removal?: boolean } = {}) {
  const removal = opts.removal !== false;
  const keys = await t.query<{ id: string; name: string }>(
    `UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND created_by = $2 AND revoked_at IS NULL AND oauth_client_id IS NULL RETURNING id, name`,
    [tenantId, userId],
  );
  const invitations = await t.query<{ id: string }>(
    `UPDATE invitations SET revoked_at = now()
      WHERE tenant_id = $1 AND invited_by = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
    [tenantId, userId],
  );
  if (removal) {
    await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`, [tenantId, userId]);
    await t.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE tenant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND lower(email) = (SELECT lower(email) FROM users WHERE id = $2)`,
      [tenantId, userId],
    );
    await t.query(`DELETE FROM login_challenges WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  }
  const scimTokens = await t.query<{ id: string }>(
    `UPDATE scim_tokens SET revoked_at = now() WHERE tenant_id = $1 AND created_by = $2 AND revoked_at IS NULL RETURNING id`,
    [tenantId, userId],
  );
  const apps = await t.query<{ id: string; client_id: string }>(
    `UPDATE oauth_clients SET secret_hash = $3, secret_prefix = NULL, updated_at = now()
      WHERE tenant_id = $1 AND created_by = $2 AND service_api_key_id IS NOT NULL AND secret_hash IS NOT NULL AND revoked_at IS NULL
      RETURNING id, client_id`,
    [tenantId, userId, sha256Hex(`unusable:${randomToken(32)}`)],
  );
  if (apps.length) {
    await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = ANY($1::uuid[]) AND revoked_at IS NULL`, [apps.map((a) => a.id)]);
  }
  return { keys, invitations: invitations.length, serviceApps: apps.map((a) => a.client_id), scimTokens: scimTokens.length };
}

/**
 * La persona detrás de quien llama: con una API key, quien creó la key. Lo que crea una key (otras keys, apps OAuth,
 * tokens SCIM, invitaciones) queda a nombre de esa persona; si no, quedaba sin dueño y sobrevivía a su baja.
 */
export async function actingPerson(db: Db, a: { userId?: string | null; apiKeyId?: string | null; tenantId: string }): Promise<string | null> {
  if (a.userId) return a.userId;
  if (!a.apiKeyId) return null;
  const k = await db.one<{ created_by: string | null }>(`SELECT created_by FROM api_keys WHERE id = $1 AND tenant_id = $2`, [a.apiKeyId, a.tenantId]);
  return k?.created_by ?? null;
}
