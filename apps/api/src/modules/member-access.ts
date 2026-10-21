import type { Db } from "../infra/db";
import { enqueue } from "../infra/queue";
import { randomToken, sha256Hex } from "../lib/util";
import { recordAudit } from "./audit";

/** Motivo de una conexión de almacenamiento desactivada porque quien la conectó dejó la organización. */
export const STORAGE_CREATOR_REMOVED = "creator_removed";

/**
 * Conexiones de almacenamiento OAuth (Drive, Dropbox, OneDrive, SharePoint, Box) que la persona conectó con SU cuenta:
 * se desactivan al sacarla de la organización (si no, los PDF firmados se seguían copiando a su cuenta personal). Quedan
 * marcadas (deactivated_reason) para que no se reactiven sin volver a conectarlas, en la auditoría, y se avisa a
 * propietarios y administradores (job en la misma transacción). Las S3 no: son credenciales del bucket de la
 * organización, no de la persona.
 */
export async function deactivateMemberStorage(t: Db, tenantId: string, userId: string) {
  const rows = await t.query<{ id: string; name: string; provider: string; was_active: boolean }>(
    `WITH c AS (
       SELECT id, active FROM storage_connections
        WHERE tenant_id = $1 AND created_by = $2 AND provider <> 's3' AND deactivated_reason IS NULL FOR UPDATE)
     UPDATE storage_connections s SET active = false, deactivated_reason = $3, updated_at = now()
       FROM c WHERE s.id = c.id RETURNING s.id, s.name, s.provider, c.active AS was_active`,
    [tenantId, userId, STORAGE_CREATOR_REMOVED],
  );
  for (const r of rows) {
    await recordAudit(t, {
      tenantId,
      action: "storage.deactivated_member_removed",
      actor: { type: "system", label: "CalaSign" },
      targetType: "storage_connection",
      targetId: r.id,
      data: { provider: r.provider, name: r.name, createdBy: userId, wasActive: r.was_active },
    });
  }
  if (rows.length) {
    await enqueue(
      t,
      "platform",
      { kind: "storage_member_removed", tenantId, userId, connectionIds: rows.map((r) => r.id) },
      { dedupeKey: `sto-removed:${tenantId}:${userId}:${rows.map((r) => r.id).sort()[0]}`, tenantId, maxAttempts: 5 },
    );
  }
  return rows.map((r) => ({ id: r.id, name: r.name, provider: r.provider }));
}

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
  const storageConnections = removal ? await deactivateMemberStorage(t, tenantId, userId) : [];
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
  return { keys, invitations: invitations.length, serviceApps: apps.map((a) => a.client_id), scimTokens: scimTokens.length, storageConnections };
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

// ───────── Bajas desde la consola y altas por SSO (JIT) o SCIM ─────────

/**
 * Baja desde la consola: queda registrada para que el alta JIT por SSO o una activación por SCIM no vuelvan a sumar a
 * la persona (si no, la baja no se sostenía: el próximo ingreso por SSO o la sincronización del IdP la reincorporaban).
 * La borra aceptar una invitación nueva (clearConsoleRemoval).
 */
export async function recordConsoleRemoval(t: Db, tenantId: string, userId: string, removedBy: string | null) {
  await t.query(
    `INSERT INTO member_removals (tenant_id, user_id, removed_by) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET removed_by = EXCLUDED.removed_by, removed_at = now()`,
    [tenantId, userId, removedBy],
  );
}

export async function clearConsoleRemoval(t: Db, tenantId: string, userId: string) {
  await t.query(`DELETE FROM member_removals WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
}

export async function removedFromConsole(db: Db, tenantId: string, userId: string): Promise<boolean> {
  return Boolean(await db.one(`SELECT 1 FROM member_removals WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]));
}

/** Invitación vigente de la organización para ese correo (bloqueada: la acepta quien la toma primero). */
export async function pendingInvitationFor(t: Db, tenantId: string, email: string) {
  return t.one<{ id: string; role: string; role_id: string | null }>(
    `SELECT id, role, role_id FROM invitations
      WHERE tenant_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [tenantId, email],
  );
}

/**
 * Alta por SSO (JIT) o SCIM, dentro de la transacción y con la organización bloqueada. Si hay una invitación vigente
 * para el correo, se acepta con SU rol (no el rol por defecto del JIT/SCIM; una de propietaria, como administradora) y
 * no cuenta como un lugar más del plan.
 * Una baja desde la consola se respeta salvo que la persona tenga una invitación nueva. Sin membresía previa.
 */
export async function provisionMembership(
  t: Db,
  tenantId: string,
  userId: string,
  email: string,
  defaultRole: string,
): Promise<{ role: string; roleId: string | null; invitationId: string | null }> {
  const inv = await pendingInvitationFor(t, tenantId, email);
  // Una invitación como propietaria no da la propiedad por SSO/SCIM (el IdP no prueba que quien entra sea quien la
  // recibió con la misma fuerza que aceptarla con su cuenta): entra como administradora y la propiedad se transfiere
  // a mano desde la consola.
  const role = inv ? (inv.role === "owner" ? "admin" : inv.role) : defaultRole;
  const roleId = inv ? inv.role_id : null;
  // Sin contraseña en esta organización hasta que la restablezca (ver 0029_r11_identity).
  await t.query(`INSERT INTO memberships (tenant_id, user_id, role, role_id, password_allowed) VALUES ($1,$2,$3,$4,false) ON CONFLICT DO NOTHING`, [
    tenantId,
    userId,
    role,
    roleId,
  ]);
  if (inv) await t.query(`UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`, [inv.id, userId]);
  // Otra invitación pendiente al mismo correo ya no hace falta: si quedara, después de una baja lo volvía a sumar.
  await t.query(`UPDATE invitations SET revoked_at = now() WHERE tenant_id = $1 AND lower(email) = lower($2) AND accepted_at IS NULL AND revoked_at IS NULL`, [
    tenantId,
    email,
  ]);
  await clearConsoleRemoval(t, tenantId, userId);
  return { role, roleId, invitationId: inv?.id ?? null };
}

/** ¿La baja desde la consola impide el alta JIT/SCIM? Sí, salvo que la persona tenga una invitación vigente (nueva). */
export async function blockedByConsoleRemoval(t: Db, tenantId: string, userId: string, email: string): Promise<boolean> {
  if (!(await removedFromConsole(t, tenantId, userId))) return false;
  return !(await pendingInvitationFor(t, tenantId, email));
}
