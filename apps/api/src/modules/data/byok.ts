// BYOK: la organización trae su propia clave de AWS KMS (puede estar en otra cuenta). Con la clave activa:
//   - cada archivo nuevo en S3 se cifra con SSE-KMS usando esa clave (en disco: clave de datos de esa clave);
//   - las claves privadas de los certificados en custodia se envuelven con ella.
// Si la clave deja de funcionar, los guardados y lecturas fallan cerrados (503 byok_key_unavailable), la
// clave queda «failing» y se avisa a los administradores. Un chequeo periódico la vuelve a probar.
import type { FastifyInstance } from "fastify";
import { SetByokInput, type ByokSettings, type ByokStatus, type ByokTestResult } from "@calasign/shared";
import type { Db } from "../../infra/db";
import { cellById } from "../../infra/cells";
import { isKeyError, kmsForKey, kmsMockEnabled, regionOfArn, setMockKeyDisabled } from "../../infra/kms";
import { config } from "../../config";
import type { TenantStorage, TenantStorageResolver } from "../../infra/storage";
import { AppError } from "../../lib/errors";
import { iso } from "../../lib/util";
import { deliver } from "../../notifications/channels";
import { auditFromRequest, recordAudit } from "../audit";
import { authenticate, type Services } from "../context";

export const CUSTODY_PURPOSE = "calasign-tenant-certificate";
const TEST_PURPOSE = "calasign-byok-test";
const BLOB_PURPOSE = "calasign-blob";

/** Rol de la plataforma que la clave del cliente tiene que autorizar (el rol de la app en la celda). */
export const platformPrincipal = () => process.env.BYOK_PLATFORM_PRINCIPAL || "arn:aws:iam::<CUENTA-DE-CALASIGN>:role/<ROL-DE-LA-APP>";

// ───────────── Resolver de almacenamiento ─────────────

const cache = new Map<string, { v: TenantStorage; at: number }>();
const CACHE_MS = 15_000;
export const invalidateTenantStorage = (tenantId?: string) => (tenantId ? cache.delete(tenantId) : cache.clear());

export async function tenantStorage(db: Db, tenantId: string): Promise<TenantStorage> {
  const c = cache.get(tenantId);
  if (c && Date.now() - c.at < CACHE_MS) return c.v;
  const r = await db.one<any>(
    `SELECT t.byok_key_arn, t.byok_status, COALESCE(d.cell, t.cell) AS cell FROM tenants t LEFT JOIN tenant_directory d ON d.tenant_id = t.id WHERE t.id = $1`,
    [tenantId],
  );
  const v: TenantStorage = {
    cell: cellById(r?.cell).id,
    byokKeyArn: r?.byok_key_arn ?? null,
    byokStatus: (r?.byok_status ?? "none") as TenantStorage["byokStatus"],
  };
  cache.set(tenantId, { v, at: Date.now() });
  return v;
}

/** Clave BYOK para envolver claves de certificados en custodia (null: la de la plataforma). */
export async function byokForCustody(db: Db, tenantId: string): Promise<{ tenantId: string; keyArn: string } | null> {
  const ts = await tenantStorage(db, tenantId);
  return ts.byokStatus !== "none" && ts.byokKeyArn ? { tenantId, keyArn: ts.byokKeyArn } : null;
}

const ALERT_EVERY_MS = 6 * 3600_000;

/** Marca la clave como fallida y avisa a propietarios y administradores (como mucho cada 6 h). */
export async function markKeyFailing(db: Db, tenantId: string, keyArn: string, error: string) {
  const prev = await db.one<any>(`SELECT byok_status, byok_alerted_at, name FROM tenants WHERE id = $1`, [tenantId]);
  await db.query(`UPDATE tenants SET byok_status = 'failing', byok_error = $2, byok_checked_at = now() WHERE id = $1 AND byok_key_arn = $3`, [
    tenantId,
    error.slice(0, 500),
    keyArn,
  ]);
  invalidateTenantStorage(tenantId);
  const recent = prev?.byok_alerted_at && Date.now() - new Date(prev.byok_alerted_at).getTime() < ALERT_EVERY_MS;
  if (prev?.byok_status === "failing" && recent) return;
  await db.query(`UPDATE tenants SET byok_alerted_at = now() WHERE id = $1`, [tenantId]);
  await recordAudit(db, { tenantId, action: "byok.key_failing", actor: { type: "system", label: "CalaSign" }, data: { keyArn, error: error.slice(0, 300) } });
  const admins = await db.query<any>(
    `SELECT u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.role IN ('owner','admin')`,
    [tenantId],
  );
  for (const a of admins) {
    await deliver({
      channel: "email",
      to: a.email,
      tenantId,
      subject: "CalaSign: la clave de cifrado de tu organización (BYOK) no responde",
      text:
        `Hola ${a.name}:\n\nCalaSign no puede usar la clave de AWS KMS de ${prev?.name ?? "tu organización"} (${keyArn}).\n` +
        `Mientras no se restablezca el acceso, no se pueden guardar ni leer documentos (los envíos y firmas fallan).\n\n` +
        `Error: ${error.slice(0, 300)}\n\nRevisá en AWS que la clave esté habilitada y que su política siga autorizando a CalaSign, y después ` +
        `usá «Probar clave» en Ajustes → Cifrado con tu clave.\n\n— CalaSign`,
    }).catch(() => {});
  }
}

export async function markKeyHealthy(db: Db, tenantId: string) {
  await db.query(`UPDATE tenants SET byok_status = 'active', byok_error = NULL, byok_checked_at = now() WHERE id = $1 AND byok_status = 'failing'`, [tenantId]);
  invalidateTenantStorage(tenantId);
  await recordAudit(db, { tenantId, action: "byok.key_recovered", actor: { type: "system", label: "CalaSign" } }).catch(() => {});
}

export function createTenantStorageResolver(db: Db): TenantStorageResolver {
  return {
    resolve: (tenantId) => tenantStorage(db, tenantId),
    onKeyFailure: (tenantId, keyArn, error) => markKeyFailing(db, tenantId, keyArn, error),
    onKeySuccess: (tenantId) => markKeyHealthy(db, tenantId),
  };
}

// ───────────── Prueba de la clave ─────────────

export async function testKey(keyArn: string, tenantId: string, cellId: string): Promise<{ ok: boolean; checks: ByokTestResult["checks"]; error: string | null }> {
  const checks: ByokTestResult["checks"] = [];
  const kms = kmsForKey(keyArn);
  const cell = cellById(cellId);
  const fail = (name: string, e: unknown) => {
    const detail = String((e as Error)?.message ?? e).slice(0, 300);
    checks.push({ name, ok: false, detail });
    return { ok: false, checks, error: `${name}: ${detail}` };
  };
  if (cell.storage.driver === "s3") {
    const keyRegion = regionOfArn(keyArn);
    const dataRegion = cell.storage.region ?? cell.region;
    if (dataRegion && keyRegion !== dataRegion) return fail("region", `La clave está en ${keyRegion} y los datos de la organización en ${dataRegion}: tienen que estar en la misma región`);
    checks.push({ name: "region", ok: true });
  }
  try {
    const d = await kms.describeKey({ KeyId: keyArn });
    const m = d.KeyMetadata ?? {};
    if (m.Enabled === false || (m.KeyState && m.KeyState !== "Enabled")) return fail("describe", `La clave no está habilitada (${m.KeyState ?? "deshabilitada"})`);
    if (m.KeyUsage && m.KeyUsage !== "ENCRYPT_DECRYPT") return fail("describe", "La clave no es de cifrado (KeyUsage ENCRYPT_DECRYPT)");
    if (m.KeySpec && m.KeySpec !== "SYMMETRIC_DEFAULT") return fail("describe", "La clave tiene que ser simétrica (SYMMETRIC_DEFAULT)");
    checks.push({ name: "describe", ok: true });
  } catch (e) {
    return fail("describe", e);
  }
  const ctx = { purpose: TEST_PURPOSE, tenant: tenantId };
  try {
    const probe = new Uint8Array(Buffer.from(`calasign-byok-${Date.now()}`));
    const enc = await kms.encrypt({ KeyId: keyArn, Plaintext: probe, EncryptionContext: ctx });
    const dec = await kms.decrypt({ CiphertextBlob: enc.CiphertextBlob, KeyId: keyArn, EncryptionContext: ctx });
    if (!Buffer.from(dec.Plaintext).equals(Buffer.from(probe))) return fail("encrypt_decrypt", "El texto descifrado no coincide");
    checks.push({ name: "encrypt_decrypt", ok: true });
  } catch (e) {
    return fail("encrypt_decrypt", e);
  }
  try {
    await kms.generateDataKey({ KeyId: keyArn, KeySpec: "AES_256", EncryptionContext: { purpose: BLOB_PURPOSE, tenant: tenantId } });
    checks.push({ name: "generate_data_key", ok: true });
  } catch (e) {
    return fail("generate_data_key", e);
  }
  return { ok: true, checks, error: null };
}

// ───────────── Política sugerida ─────────────

export function keyPolicyFor(tenantId: string, cellId: string): Record<string, unknown> {
  const cell = cellById(cellId);
  const principal = { AWS: platformPrincipal() };
  const statements: Record<string, unknown>[] = [
    { Sid: "CalaSignDescribe", Effect: "Allow", Principal: principal, Action: "kms:DescribeKey", Resource: "*" },
    {
      Sid: "CalaSignDirect",
      Effect: "Allow",
      Principal: principal,
      Action: ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      Resource: "*",
      Condition: { StringEquals: { "kms:EncryptionContext:tenant": tenantId, "kms:EncryptionContext:purpose": [CUSTODY_PURPOSE, TEST_PURPOSE, BLOB_PURPOSE] } },
    },
  ];
  if (cell.storage.driver === "s3" && cell.storage.bucket) {
    statements.push({
      Sid: "CalaSignS3",
      Effect: "Allow",
      Principal: principal,
      Action: ["kms:GenerateDataKey", "kms:Decrypt"],
      Resource: "*",
      Condition: {
        StringEquals: {
          "kms:ViaService": `s3.${cell.storage.region ?? cell.region}.amazonaws.com`,
          // S3 Bucket Keys: el contexto de cifrado es el ARN del bucket.
          "kms:EncryptionContext:aws:s3:arn": `arn:aws:s3:::${cell.storage.bucket}`,
        },
      },
    });
  }
  return { Version: "2012-10-17", Statement: statements };
}

// ───────────── Rutas ─────────────

async function settingsFor(db: Db, tenantId: string): Promise<ByokSettings> {
  const t = await db.one<any>(
    `SELECT t.byok_key_arn, t.byok_status, t.byok_checked_at, t.byok_enabled_at, t.byok_error, COALESCE(d.cell, t.cell) AS cell
     FROM tenants t LEFT JOIN tenant_directory d ON d.tenant_id = t.id WHERE t.id = $1`,
    [tenantId],
  );
  const cell = cellById(t?.cell);
  return {
    status: (t?.byok_status ?? "none") as ByokStatus,
    keyArn: t?.byok_key_arn ?? null,
    checkedAt: iso(t?.byok_checked_at),
    enabledAt: iso(t?.byok_enabled_at),
    error: t?.byok_error ?? null,
    platformPrincipal: platformPrincipal(),
    keyPolicy: keyPolicyFor(tenantId, cell.id),
    region: cell.storage.region ?? cell.region ?? "",
  };
}

/** Chequeo periódico de las claves activas (cada 6 h) y reintento de las fallidas (cada hora). */
export async function byokSweep(db: Db) {
  const rows = await db.query<any>(
    `SELECT t.id, t.byok_key_arn, t.byok_status, COALESCE(d.cell, t.cell) AS cell FROM tenants t LEFT JOIN tenant_directory d ON d.tenant_id = t.id
     WHERE t.byok_status <> 'none' AND t.byok_key_arn IS NOT NULL
       AND (t.byok_checked_at IS NULL OR (t.byok_status = 'active' AND t.byok_checked_at < now() - interval '6 hours')
            OR (t.byok_status = 'failing' AND t.byok_checked_at < now() - interval '1 hour'))
     LIMIT 50`,
  );
  for (const r of rows) {
    const res = await testKey(r.byok_key_arn, r.id, r.cell).catch((e) => ({ ok: false, checks: [], error: String(e) }));
    if (res.ok) {
      if (r.byok_status === "failing") await markKeyHealthy(db, r.id);
      else await db.query(`UPDATE tenants SET byok_checked_at = now() WHERE id = $1`, [r.id]);
    } else {
      await markKeyFailing(db, r.id, r.byok_key_arn, res.error ?? "error");
    }
  }
}

export async function byokRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  app.get("/v1/settings/byok", { preHandler: auth }, async (req) => settingsFor(s.db, req.auth!.tenantId));

  // Activa (o cambia) la clave: solo si la prueba completa pasa.
  app.put("/v1/settings/byok", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const input = SetByokInput.parse(req.body);
    const ts = await tenantStorage(s.db, a.tenantId);
    const res = await testKey(input.keyArn, a.tenantId, ts.cell);
    if (!res.ok) throw new AppError(422, "byok_key_test_failed", `La clave no pasó la prueba: ${res.error}`, { checks: res.checks });
    await s.db.query(
      `UPDATE tenants SET byok_key_arn = $2, byok_status = 'active', byok_error = NULL, byok_checked_at = now(), byok_enabled_at = now(), byok_alerted_at = NULL WHERE id = $1`,
      [a.tenantId, input.keyArn],
    );
    invalidateTenantStorage(a.tenantId);
    await auditFromRequest(s.db, req, a, "byok.enabled", { targetType: "kms_key", targetId: input.keyArn, data: { previous: ts.byokKeyArn } });
    return settingsFor(s.db, a.tenantId);
  });

  app.post("/v1/settings/byok/test", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req): Promise<ByokTestResult> => {
    const a = req.auth!;
    const t = await s.db.one<any>(`SELECT byok_key_arn, byok_status FROM tenants WHERE id = $1`, [a.tenantId]);
    if (!t?.byok_key_arn) throw new AppError(409, "byok_not_configured", "No hay una clave configurada");
    const ts = await tenantStorage(s.db, a.tenantId);
    const res = await testKey(t.byok_key_arn, a.tenantId, ts.cell);
    if (res.ok) {
      await s.db.query(`UPDATE tenants SET byok_status = 'active', byok_error = NULL, byok_checked_at = now() WHERE id = $1`, [a.tenantId]);
      invalidateTenantStorage(a.tenantId);
    } else {
      await markKeyFailing(s.db, a.tenantId, t.byok_key_arn, res.error ?? "error");
    }
    const now = await s.db.one<any>(`SELECT byok_status FROM tenants WHERE id = $1`, [a.tenantId]);
    return { ok: res.ok, status: now.byok_status, checks: res.checks, error: res.error };
  });

  // Desactivar: lo nuevo vuelve a la clave de la plataforma. Lo ya cifrado con la clave del cliente la sigue necesitando.
  app.delete("/v1/settings/byok", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const t = await s.db.one<any>(`SELECT byok_key_arn FROM tenants WHERE id = $1`, [a.tenantId]);
    await s.db.query(`UPDATE tenants SET byok_status = 'none', byok_error = NULL WHERE id = $1`, [a.tenantId]);
    invalidateTenantStorage(a.tenantId);
    await auditFromRequest(s.db, req, a, "byok.disabled", { targetType: "kms_key", targetId: t?.byok_key_arn ?? null });
    reply.code(204).send();
  });
}

export { isKeyError };

/** Solo local con KMS simulado: deshabilita/rehabilita una clave para probar la falla cerrada. */
export async function kmsMockRoutes(app: FastifyInstance) {
  if (config.environment !== "local" || !kmsMockEnabled()) return;
  app.post("/dev/kms-mock", async (req) => {
    const b = (req.body ?? {}) as { keyArn?: string; disabled?: boolean };
    if (!b.keyArn) throw new AppError(400, "invalid_request", "keyArn requerido");
    setMockKeyDisabled(b.keyArn, Boolean(b.disabled));
    return { ok: true };
  });
}
