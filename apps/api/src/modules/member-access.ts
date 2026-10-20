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
  // Si era el último token SCIM activo, las bajas del IdP dejan de bloquear el JIT (ver releaseScimJitBlocks).
  if (scimTokens.length) await releaseScimJitBlocks(t, tenantId);
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

export interface CreatedCredentials {
  tenantId: string;
  tenantName: string | null;
  /** Activas (después de la revocación, si se pidió). */
  apiKeys: number;
  scimTokens: number;
  serviceApps: number;
  invitations: number;
  /** Lo revocado en esta organización (solo con revoke = true): IDs de API keys y cantidad de invitaciones. */
  revoked?: { apiKeys: string[]; invitations: number };
}

/**
 * Credenciales activas que la persona creó, por organización (solo las que tienen alguna), para el restablecimiento de
 * contraseña: quien tenía la contraseña vieja pudo crearlas para seguir entrando después del cambio, pero también pueden
 * ser integraciones productivas, así que por defecto NO se revocan: la respuesta las lista para que la persona decida.
 * Con revoke = true se revocan solo sus API keys y las invitaciones pendientes que mandó. Los tokens SCIM y las apps de
 * servicio son de la organización (los usa el IdP o una integración de todos): nunca se tocan acá; un administrador los
 * revisa y rota desde la configuración.
 */
export async function credentialsCreatedBy(t: Db, userId: string, opts: { revoke?: boolean } = {}): Promise<CreatedCredentials[]> {
  const revokedByTenant = new Map<string, { apiKeys: string[]; invitations: number }>();
  if (opts.revoke) {
    const keys = await t.query<{ id: string; tenant_id: string }>(
      `UPDATE api_keys SET revoked_at = now() WHERE created_by = $1 AND revoked_at IS NULL AND oauth_client_id IS NULL RETURNING id, tenant_id`,
      [userId],
    );
    const invs = await t.query<{ tenant_id: string }>(
      `UPDATE invitations SET revoked_at = now() WHERE invited_by = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING tenant_id`,
      [userId],
    );
    const slot = (id: string) => revokedByTenant.get(id) ?? revokedByTenant.set(id, { apiKeys: [], invitations: 0 }).get(id)!;
    for (const k of keys) slot(k.tenant_id).apiKeys.push(k.id);
    for (const i of invs) slot(i.tenant_id).invitations++;
  }
  const rows = await t.query<any>(
    `WITH c AS (
       SELECT tenant_id, 'api_key' AS kind FROM api_keys WHERE created_by = $1 AND revoked_at IS NULL AND oauth_client_id IS NULL
       UNION ALL SELECT tenant_id, 'scim_token' FROM scim_tokens WHERE created_by = $1 AND revoked_at IS NULL
       UNION ALL SELECT tenant_id, 'service_app' FROM oauth_clients
                  WHERE created_by = $1 AND service_api_key_id IS NOT NULL AND secret_hash IS NOT NULL AND revoked_at IS NULL
       UNION ALL SELECT tenant_id, 'invitation' FROM invitations
                  WHERE invited_by = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
     )
     SELECT c.tenant_id, t.name AS tenant_name,
            count(*) FILTER (WHERE kind = 'api_key')::int AS api_keys,
            count(*) FILTER (WHERE kind = 'scim_token')::int AS scim_tokens,
            count(*) FILTER (WHERE kind = 'service_app')::int AS service_apps,
            count(*) FILTER (WHERE kind = 'invitation')::int AS invitations
       FROM c JOIN tenants t ON t.id = c.tenant_id
      GROUP BY c.tenant_id, t.name ORDER BY t.name`,
    [userId],
  );
  const out = new Map<string, CreatedCredentials>();
  for (const r of rows) {
    out.set(r.tenant_id, {
      tenantId: r.tenant_id,
      tenantName: r.tenant_name ?? null,
      apiKeys: Number(r.api_keys),
      scimTokens: Number(r.scim_tokens),
      serviceApps: Number(r.service_apps),
      invitations: Number(r.invitations),
    });
  }
  for (const [tenantId, revoked] of revokedByTenant) {
    let e = out.get(tenantId);
    if (!e) {
      const tn = await t.one<{ name: string }>(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
      e = { tenantId, tenantName: tn?.name ?? null, apiKeys: 0, scimTokens: 0, serviceApps: 0, invitations: 0 };
      out.set(tenantId, e);
    }
    e.revoked = revoked;
  }
  return [...out.values()];
}

/** Borra la verificación en dos pasos de la cuenta (secreto, alta pendiente y códigos de recuperación). */
export async function clearTotp(t: Db, userId: string): Promise<boolean> {
  const r = await t.query(
    `UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled_at = NULL, totp_recovery_hashes = '{}', totp_last_step = NULL
      WHERE id = $1 AND (totp_secret_enc IS NOT NULL OR totp_pending_enc IS NOT NULL OR totp_enabled_at IS NOT NULL) RETURNING id`,
    [userId],
  );
  return r.length > 0;
}

/**
 * ¿La cuenta probó alguna vez que controla su correo? Hoy la única prueba es haber restablecido la contraseña
 * (users.password_reset_at: el link llega al correo). El registro no verifica el correo y el link de una invitación
 * también lo ve quien invita, así que no cuentan.
 */
export async function emailControlProven(t: Db, userId: string): Promise<boolean> {
  const u = await t.one<{ password_reset_at: string | null }>(`SELECT password_reset_at FROM users WHERE id = $1`, [userId]);
  return Boolean(u?.password_reset_at);
}

/**
 * Antes de vincular por SSO (JIT) o SCIM a la organización `tenantId` una cuenta YA existente que nunca probó el control
 * del correo: quien la registró pudo ser otra persona (el registro no verifica el correo), y su segundo factor y sus
 * sesiones (y tokens OAuth) quedarían en sus manos. Pero la 2FA y las sesiones son de la cuenta global: borrarlas por
 * decisión de un administrador de un dominio afecta también a las otras organizaciones de la persona. Por eso se limpia
 * SOLO si la cuenta es "huérfana":
 *  - no fue creada por SSO o SCIM (password_hash 'sso-only' / 'scim-provisioned': nadie la registró con contraseña);
 *  - nunca probó el control del correo (emailControlProven);
 *  - no tiene fila en scim_users de esta organización (el IdP ya la administraba: no es una vinculación nueva);
 *  - no es miembro de ninguna otra organización (si lo es, esas organizaciones la conocen y su 2FA o sus sesiones no se
 *    tocan: el riesgo queda acotado a que la contraseña no vale en esta organización, password_allowed = false).
 * En ese único caso (cuenta registrada con contraseña, sin otras membresías ni prueba del correo) se borran la 2FA, todas
 * sus sesiones, tokens OAuth, códigos sin canjear y desafíos pendientes. Devuelve null si no se tocó nada.
 * El llamador no lo aplica cuando SCIM crea al usuario inactivo (active = false): no hay vinculación todavía.
 */
export async function secureUnprovenAccount(
  t: Db,
  userId: string,
  tenantId: string,
): Promise<{ totpCleared: boolean; sessionsClosed: number } | null> {
  const u = await t.one<{ password_hash: string | null; password_reset_at: string | null }>(`SELECT password_hash, password_reset_at FROM users WHERE id = $1`, [userId]);
  if (!u || u.password_reset_at) return null;
  if (u.password_hash === "sso-only" || u.password_hash === "scim-provisioned") return null;
  if (await t.one(`SELECT 1 FROM scim_users WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId])) return null;
  if (await t.one(`SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id <> $2 LIMIT 1`, [userId, tenantId])) return null;
  const totpCleared = await clearTotp(t, userId);
  const sessions = await t.query(`DELETE FROM sessions WHERE user_id = $1 RETURNING user_id`, [userId]);
  await t.query(`UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await t.query(`UPDATE oauth_authorization_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  await t.query(`DELETE FROM login_challenges WHERE user_id = $1`, [userId]);
  return { totpCleared, sessionsClosed: sessions.length };
}

/**
 * Sin tokens SCIM activos, la organización ya no tiene IdP que administre altas y bajas: las filas de scim_users
 * desactivadas o borradas dejan de tener sentido y bloquearían para siempre el alta JIT por SSO de esas personas
 * (scimBlocksJit). Se borran al revocar el último token. Devuelve cuántas.
 */
export async function releaseScimJitBlocks(t: Db, tenantId: string): Promise<number> {
  if (await t.one(`SELECT 1 FROM scim_tokens WHERE tenant_id = $1 AND revoked_at IS NULL LIMIT 1`, [tenantId])) return 0;
  const r = await t.query(`DELETE FROM scim_users WHERE tenant_id = $1 AND (active = false OR deleted_at IS NOT NULL) RETURNING user_id`, [tenantId]);
  return r.length;
}
