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
 */
export async function revokeMemberAccess(t: Db, tenantId: string, userId: string) {
  const keys = await t.query<{ id: string; name: string }>(
    `UPDATE api_keys SET revoked_at = now() WHERE tenant_id = $1 AND created_by = $2 AND revoked_at IS NULL AND oauth_client_id IS NULL RETURNING id, name`,
    [tenantId, userId],
  );
  const invitations = await t.query<{ id: string }>(
    `UPDATE invitations SET revoked_at = now()
      WHERE tenant_id = $1 AND invited_by = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
    [tenantId, userId],
  );
  await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`, [tenantId, userId]);
  const apps = await t.query<{ id: string; client_id: string }>(
    `UPDATE oauth_clients SET secret_hash = $3, secret_prefix = NULL, updated_at = now()
      WHERE tenant_id = $1 AND created_by = $2 AND service_api_key_id IS NOT NULL AND secret_hash IS NOT NULL AND revoked_at IS NULL
      RETURNING id, client_id`,
    [tenantId, userId, sha256Hex(`unusable:${randomToken(32)}`)],
  );
  if (apps.length) {
    await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = ANY($1::uuid[]) AND revoked_at IS NULL`, [apps.map((a) => a.id)]);
  }
  return { keys, invitations: invitations.length, serviceApps: apps.map((a) => a.client_id) };
}
