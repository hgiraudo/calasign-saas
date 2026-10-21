// BYOK: la organización trae su propia clave de AWS KMS (puede estar en otra cuenta). Con la clave activa:
//   - cada archivo nuevo en S3 se cifra con SSE-KMS usando esa clave (en disco: clave de datos de esa clave);
//   - las claves privadas de los certificados en custodia se envuelven con ella.
// Si la clave deja de funcionar, los guardados y lecturas fallan cerrados (503 byok_key_unavailable), la
// clave queda «failing» y se avisa a los administradores. Un chequeo periódico la vuelve a probar.
import type { FastifyInstance } from "fastify";
import { SetByokInput, type ByokSettings, type ByokStatus, type ByokTestResult } from "@calasign/shared";
import type { Db } from "../../infra/db";
import { cellById, effectiveCellId, servedCellsSql } from "../../infra/cells";
import { isKeyError, kmsForKey, kmsMockEnabled, regionOfArn, setMockKeyDisabled } from "../../infra/kms";
import { config } from "../../config";
import type { TenantStorage, TenantStorageResolver } from "../../infra/storage";
import { AppError } from "../../lib/errors";
import { iso } from "../../lib/util";
import { sendTracked } from "../../notifications/outbound";
import { normLocale } from "../../notifications/templates";
import { productLabel, resolveBrand, senderFor } from "../white-label/brand";
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

/**
 * Celda y clave BYOK de la organización. Caché de 15 s por proceso para lecturas; `fresh` (escrituras de archivos)
 * va siempre a la base (una fila por PK): un cambio o desactivación de la clave hecho en otro proceso (API ↔ worker)
 * no puede seguir cifrando lo nuevo con la clave anterior durante la vida de la caché.
 */
export async function tenantStorage(db: Db, tenantId: string, opts?: { fresh?: boolean }): Promise<TenantStorage> {
  const c = cache.get(tenantId);
  if (!opts?.fresh && c && Date.now() - c.at < CACHE_MS) return c.v;
  const r = await db.one<any>(
    `SELECT t.byok_key_arn, t.byok_status, COALESCE(d.cell, t.cell) AS cell FROM tenants t LEFT JOIN tenant_directory d ON d.tenant_id = t.id WHERE t.id = $1`,
    [tenantId],
  );
  const v: TenantStorage = {
    cell: effectiveCellId(r?.cell),
    byokKeyArn: r?.byok_key_arn ?? null,
    byokStatus: (r?.byok_status ?? "none") as TenantStorage["byokStatus"],
  };
  cache.set(tenantId, { v, at: Date.now() });
  return v;
}

/** Clave BYOK para envolver claves de certificados en custodia (null: la de la plataforma). */
export async function byokForCustody(db: Db, tenantId: string): Promise<{ tenantId: string; keyArn: string } | null> {
  // Se usa al envolver una clave nueva (escritura): sin caché, como las escrituras de archivos.
  const ts = await tenantStorage(db, tenantId, { fresh: true });
  return ts.byokStatus !== "none" && ts.byokKeyArn ? { tenantId, keyArn: ts.byokKeyArn } : null;
}

const ALERT_EVERY_MS = 6 * 3600_000;

/** Marca la clave como fallida y avisa a propietarios y administradores (como mucho cada 6 h). */
export async function markKeyFailing(db: Db, tenantId: string, keyArn: string, error: string) {
  // Una clave desactivada (status 'none') no vuelve a usarse por un chequeo fallido: lo nuevo sigue con la de la plataforma.
  // El paso a 'failing' es un UPDATE condicional: entre varios pedidos concurrentes que detectan la falla, solo el que
  // cambia el estado alerta (antes todos leían el estado anterior y cada uno mandaba su alerta).
  const turned = await db.query<{ name: string }>(
    `UPDATE tenants SET byok_status = 'failing', byok_error = $2, byok_checked_at = now(), byok_alerted_at = now()
      WHERE id = $1 AND byok_key_arn = $3 AND byok_status NOT IN ('none','failing') RETURNING name`,
    [tenantId, error.slice(0, 500), keyArn],
  );
  invalidateTenantStorage(tenantId);
  let name = turned[0]?.name;
  if (!turned.length) {
    // Ya estaba fallando: se actualiza el error y, si pasaron 6 h desde la última alerta, se reclama la siguiente (también
    // con un UPDATE condicional, así dos pedidos simultáneos no la duplican).
    const again = await db.query<{ name: string }>(
      `UPDATE tenants SET byok_error = $2, byok_checked_at = now() WHERE id = $1 AND byok_key_arn = $3 AND byok_status = 'failing' RETURNING name`,
      [tenantId, error.slice(0, 500), keyArn],
    );
    if (!again.length) return;
    const claim = await db.query(
      `UPDATE tenants SET byok_alerted_at = now()
        WHERE id = $1 AND byok_status = 'failing' AND (byok_alerted_at IS NULL OR byok_alerted_at < now() - make_interval(secs => $2)) RETURNING id`,
      [tenantId, ALERT_EVERY_MS / 1000],
    );
    if (!claim.length) return;
    name = again[0].name;
  }
  const prev = { name };
  await recordAudit(db, { tenantId, action: "byok.key_failing", actor: { type: "system", label: "CalaSign" }, data: { keyArn, error: error.slice(0, 300) } });
  const admins = await db.query<any>(
    `SELECT u.email, u.name, u.locale FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 AND m.role IN ('owner','admin')`,
    [tenantId],
  );
  if (!admins.length) return;
  // Con la marca de la organización (nombre del producto en marca blanca y su remitente) y en el idioma de cada persona.
  const wl = await resolveBrand(db, tenantId, null);
  const sendAs = await senderFor(db, wl);
  const product = productLabel(wl);
  const org = prev?.name ?? null;
  const err = error.slice(0, 300);
  for (const a of admins) {
    const L = BYOK_ALERT[normLocale(a.locale)];
    // Registrado en notifications: un rebote o una queja de la alerta se atribuye a la organización.
    const out = await sendTracked(
      db,
      { tenantId, template: "byok_key_failing", log: console },
      {
        channel: "email",
        to: a.email,
        tenantId,
        locale: normLocale(a.locale),
        subject: L.subject(product),
        text: L.text(a.name ?? "", product, org, keyArn, err),
        from: sendAs.from,
        replyTo: sendAs.replyTo,
        dkim: sendAs.dkim,
        fallbackFrom: sendAs.fallbackFrom,
      },
    ).catch((e) => ({ status: "failed" as const, error: String(e), transient: true }));
    if (out.status === "failed") console.warn(`[byok] alerta de clave fallida no enviada (organización ${tenantId}): ${out.error.slice(0, 300)}`);
  }
}

const BYOK_ALERT = {
  es: {
    subject: (p: string) => `${p}: la clave de cifrado de tu organización (BYOK) no responde`,
    text: (name: string, p: string, org: string | null, arn: string, err: string) =>
      `Hola ${name}:\n\n${p} no puede usar la clave de AWS KMS de ${org ?? "tu organización"} (${arn}).\n` +
      `Mientras no se restablezca el acceso, no se pueden guardar ni leer documentos (los envíos y firmas fallan).\n\n` +
      `Error: ${err}\n\nRevisá en AWS que la clave esté habilitada y que su política siga autorizando a ${p}, y después ` +
      `usá «Probar clave» en Ajustes → Cifrado con tu clave (BYOK).\n\n— ${p}`,
  },
  "pt-BR": {
    subject: (p: string) => `${p}: a chave de criptografia da sua organização (BYOK) não responde`,
    text: (name: string, p: string, org: string | null, arn: string, err: string) =>
      `Olá ${name},\n\n${p} não consegue usar a chave do AWS KMS de ${org ?? "sua organização"} (${arn}).\n` +
      `Enquanto o acesso não for restabelecido, não é possível salvar nem ler documentos (envios e assinaturas falham).\n\n` +
      `Erro: ${err}\n\nVerifique na AWS se a chave está habilitada e se a política dela continua autorizando ${p}; depois, ` +
      `use «Testar chave» em Configurações → Criptografia com sua chave (BYOK).\n\n— ${p}`,
  },
  en: {
    subject: (p: string) => `${p}: your organization's encryption key (BYOK) is not responding`,
    text: (name: string, p: string, org: string | null, arn: string, err: string) =>
      `Hi ${name},\n\n${p} can't use the AWS KMS key of ${org ?? "your organization"} (${arn}).\n` +
      `Until access is restored, documents can't be stored or read (sending and signing fail).\n\n` +
      `Error: ${err}\n\nCheck in AWS that the key is enabled and that its policy still authorizes ${p}, then ` +
      `use "Test key" in Settings → Encryption with your key (BYOK).\n\n— ${p}`,
  },
} as const;

export async function markKeyHealthy(db: Db, tenantId: string) {
  // Varios pedidos concurrentes pueden detectar la recuperación: solo el que cambia el estado deja constancia.
  const upd = await db.query(
    `UPDATE tenants SET byok_status = 'active', byok_error = NULL, byok_checked_at = now() WHERE id = $1 AND byok_status = 'failing' RETURNING id`,
    [tenantId],
  );
  invalidateTenantStorage(tenantId);
  if (!upd.length) return;
  await recordAudit(db, { tenantId, action: "byok.key_recovered", actor: { type: "system", label: "CalaSign" } }).catch(() => {});
}

/** La clave es o fue BYOK de la organización (historial; la actual también, por si es anterior a la migración 0078). */
export async function isTenantByokKey(db: Db, tenantId: string, keyArn: string): Promise<boolean> {
  const r = await db.one<any>(
    `SELECT EXISTS (SELECT 1 FROM tenant_byok_keys WHERE tenant_id = $1 AND key_arn = $2)
         OR EXISTS (SELECT 1 FROM tenants WHERE id = $1 AND byok_key_arn = $2) AS known`,
    [tenantId, keyArn],
  );
  return Boolean(r?.known);
}

/**
 * Historial: cierra la clave vigente (si es otra) y abre la nueva. Al INICIO de la transacción del cambio: bloquea la
 * organización (un PUT y un DELETE concurrentes se serializan y no dejan dos claves abiertas, o ninguna, en el
 * historial) y devuelve la clave y el estado anteriores leídos bajo ese bloqueo (para el aviso y la auditoría).
 */
async function recordKeyChange(db: Db, tenantId: string, newArn: string | null): Promise<{ byok_key_arn: string | null; byok_status: string } | null> {
  const before = await db.one<{ byok_key_arn: string | null; byok_status: string }>(`SELECT byok_key_arn, byok_status FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
  await db.query(`UPDATE tenant_byok_keys SET deactivated_at = now() WHERE tenant_id = $1 AND deactivated_at IS NULL AND key_arn IS DISTINCT FROM $2`, [tenantId, newArn]);
  if (newArn) {
    await db.query(
      `INSERT INTO tenant_byok_keys (tenant_id, key_arn) SELECT $1, $2
        WHERE NOT EXISTS (SELECT 1 FROM tenant_byok_keys WHERE tenant_id = $1 AND key_arn = $2 AND deactivated_at IS NULL)`,
      [tenantId, newArn],
    );
  }
  return before;
}

const PREVIOUS_KEY_NOTICE = (arn: string) =>
  `Los documentos guardados antes de este cambio siguen cifrados con la clave anterior (${arn}): no la deshabilites ni le quites el permiso a CalaSign mientras tengas que poder leerlos (no se re-cifran).`;

export function createTenantStorageResolver(db: Db): TenantStorageResolver {
  return {
    resolve: (tenantId, opts) => tenantStorage(db, tenantId, opts),
    isTenantKey: (tenantId, keyArn) => isTenantByokKey(db, tenantId, keyArn),
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
     WHERE t.byok_status <> 'none' AND t.byok_key_arn IS NOT NULL AND ${servedCellsSql("t.id")}
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
  app.put("/v1/settings/byok", { preHandler: auth }, async (req): Promise<ByokSettings> => {
    const a = req.auth!;
    const input = SetByokInput.parse(req.body);
    const ts = await tenantStorage(s.db, a.tenantId, { fresh: true });
    const res = await testKey(input.keyArn, a.tenantId, ts.cell);
    if (!res.ok) throw new AppError(422, "byok_key_test_failed", `La clave no pasó la prueba: ${res.error}`, { checks: res.checks });
    const before = await s.db.tx(async (t) => {
      const b = await recordKeyChange(t, a.tenantId, input.keyArn);
      await t.query(
        `UPDATE tenants SET byok_key_arn = $2, byok_status = 'active', byok_error = NULL, byok_checked_at = now(), byok_enabled_at = now(), byok_alerted_at = NULL WHERE id = $1`,
        [a.tenantId, input.keyArn],
      );
      return b;
    });
    invalidateTenantStorage(a.tenantId);
    const previous = before?.byok_key_arn ?? null;
    await auditFromRequest(s.db, req, a, "byok.enabled", { targetType: "kms_key", targetId: input.keyArn, data: { previous } });
    // Cambio de clave (o reactivación con otra): lo ya guardado sigue dependiendo de las claves anteriores.
    const prev = previous && previous !== input.keyArn ? previous : null;
    return { ...(await settingsFor(s.db, a.tenantId)), notice: prev ? PREVIOUS_KEY_NOTICE(prev) : null };
  });

  app.post("/v1/settings/byok/test", { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: "1 minute" }, rateLimitByCredential: true } }, async (req): Promise<ByokTestResult> => {
    const a = req.auth!;
    const t = await s.db.one<any>(`SELECT byok_key_arn, byok_status FROM tenants WHERE id = $1`, [a.tenantId]);
    if (!t?.byok_key_arn) throw new AppError(409, "byok_not_configured", "No hay una clave configurada");
    const ts = await tenantStorage(s.db, a.tenantId);
    const res = await testKey(t.byok_key_arn, a.tenantId, ts.cell);
    if (res.ok) {
      // Probar no reactiva una clave desactivada: para eso está PUT /v1/settings/byok.
      // De 'failing' a 'active' con un UPDATE condicional: la recuperación queda en la auditoría (como markKeyHealthy),
      // una sola vez aunque haya pruebas concurrentes, y con quién la probó.
      // Solo si la clave sigue siendo la probada: si entretanto se cambió (PUT) o desactivó y volvió a activar otra, el OK de
      // esta prueba no puede marcar sana a la nueva (ni borrar su error).
      const recovered = await s.db.query(
        `UPDATE tenants SET byok_status = 'active', byok_error = NULL, byok_checked_at = now() WHERE id = $1 AND byok_status = 'failing' AND byok_key_arn = $2 RETURNING id`,
        [a.tenantId, t.byok_key_arn],
      );
      await s.db.query(`UPDATE tenants SET byok_status = 'active', byok_error = NULL, byok_checked_at = now() WHERE id = $1 AND byok_status <> 'none' AND byok_key_arn = $2`, [
        a.tenantId,
        t.byok_key_arn,
      ]);
      invalidateTenantStorage(a.tenantId);
      if (recovered.length) await auditFromRequest(s.db, req, a, "byok.key_recovered", { targetType: "kms_key", targetId: t.byok_key_arn, data: { via: "test" } });
    } else {
      await markKeyFailing(s.db, a.tenantId, t.byok_key_arn, res.error ?? "error");
    }
    const now = await s.db.one<any>(`SELECT byok_status FROM tenants WHERE id = $1`, [a.tenantId]);
    return { ok: res.ok, status: now.byok_status, checks: res.checks, error: res.error };
  });

  // Desactivar: lo nuevo vuelve a la clave de la plataforma. Lo ya cifrado con la clave del cliente la sigue necesitando
  // (no se re-cifra): la respuesta lo avisa. Antes respondía 204 sin cuerpo.
  app.delete("/v1/settings/byok", { preHandler: auth }, async (req): Promise<ByokSettings> => {
    const a = req.auth!;
    const t = await s.db.tx(async (tx) => {
      const b = await recordKeyChange(tx, a.tenantId, null);
      await tx.query(`UPDATE tenants SET byok_status = 'none', byok_error = NULL WHERE id = $1`, [a.tenantId]);
      return b;
    });
    invalidateTenantStorage(a.tenantId);
    await auditFromRequest(s.db, req, a, "byok.disabled", { targetType: "kms_key", targetId: t?.byok_key_arn ?? null });
    const was = t?.byok_key_arn && t.byok_status !== "none" ? (t.byok_key_arn as string) : null;
    return { ...(await settingsFor(s.db, a.tenantId)), notice: was ? PREVIOUS_KEY_NOTICE(was) : null };
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
