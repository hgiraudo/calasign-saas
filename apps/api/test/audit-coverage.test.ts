// Cobertura de la auditoría de cuenta: SSO y SCIM con valores anterior/nuevo (sin secretos), tokens SCIM con id, nombre
// y prefijo, targetId real (no el patrón de la ruta), descarga de adjuntos, cambios de conexiones de almacenamiento,
// 2FA en todas las organizaciones del usuario y el conteo de ingresos fallidos sin organización. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-audit-coverage-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let blobs: ReturnType<typeof import("../src/infra/storage")["createBlobStore"]>;

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  blobs = createBlobStore();
  app = await buildApp({ db, blobs, logger: false });
  await app.ready();
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function newTenant() {
  const id = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, billing_plan) VALUES ($1, $2, 'Org', 'enterprise')`, [id, `t-${id.slice(-8)}`]);
  return id;
}
async function newUser(tenantId: string | null, role = "owner") {
  const id = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash, password_reset_at) VALUES ($1,$2,'Ana','scrypt$x', now())`, [id, `u-${id.slice(-10)}@empresa.test`]);
  if (tenantId) await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tenantId, id, role]);
  return id;
}
async function newSession(userId: string, tenantId: string) {
  const token = util.randomToken();
  await db.query(`INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method) VALUES ($1,$2,$3, now() + interval '14 days', 'password')`, [
    util.sha256Hex(token),
    userId,
    tenantId,
  ]);
  return { cs_session: token };
}
const audits = (tenantId: string, action: string) =>
  db.query<any>(`SELECT * FROM account_audit_log WHERE tenant_id = $1 AND action = $2 ORDER BY id`, [tenantId, action]);

/** Certificado X.509 autofirmado de prueba (node-forge). */
async function selfSignedPem() {
  const forge = (await import("node-forge")).default;
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400_000);
  const attrs = [{ name: "commonName", value: "idp.empresa.test" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

describe("PUT /v1/settings/sso", () => {
  it("audita valores anterior y nuevo de lo que cambió, sin secretos", async () => {
    const t = await newTenant();
    const owner = await newUser(t);
    const cookies = await newSession(owner, t);
    const put = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/v1/settings/sso", cookies, payload });
    const r1 = await put({ enabled: false, protocol: "oidc", jitRole: "member", oidc: { issuer: "https://idp.empresa.test", clientId: "abc", clientSecret: "super-secreto-1" } });
    expect(r1.statusCode).toBe(200);
    const r2 = await put({ enabled: false, protocol: "oidc", jitRole: "admin", sessionTtlHours: 8, domains: ["empresa.test"], oidc: { issuer: "https://idp.empresa.test", clientId: "xyz" } });
    expect(r2.statusCode).toBe(200);

    const rows = await audits(t, "settings.sso_updated");
    expect(rows).toHaveLength(2);
    // El hook genérico no lo duplica como settings.changed.
    expect(await audits(t, "settings.changed")).toHaveLength(0);
    expect(rows[0].data.secretChanged).toBe(true);
    expect(rows[0].data.to).toMatchObject({ issuer: "https://idp.empresa.test", clientId: "abc" });
    const d = rows[1].data;
    expect(d.secretChanged).toBe(false);
    expect(d.from).toEqual({ clientId: "abc", jitRole: "member", sessionTtlHours: 24, domains: [] });
    expect(d.to).toEqual({ clientId: "xyz", jitRole: "admin", sessionTtlHours: 8, domains: ["empresa.test"] });
    expect(d.changed.sort()).toEqual(["clientId", "domains", "jitRole", "sessionTtlHours"]);
    expect(rows[1].target_id).toBe("sso");
    for (const r of rows) expect(JSON.stringify(r.data)).not.toContain("super-secreto");
  });

  it("del certificado SAML registra solo la huella SHA-256", async () => {
    const { X509Certificate } = await import("node:crypto");
    const t = await newTenant();
    const owner = await newUser(t);
    const cookies = await newSession(owner, t);
    const pem = await selfSignedPem();
    const r = await app.inject({
      method: "PUT",
      url: "/v1/settings/sso",
      cookies,
      payload: { enabled: false, protocol: "saml", saml: { entryPoint: "https://idp.empresa.test/sso", idpIssuer: "idp", idpCert: pem } },
    });
    expect(r.statusCode).toBe(200);
    const [row] = await audits(t, "settings.sso_updated");
    expect(row.data.to).toMatchObject({ protocol: "saml", entryPoint: "https://idp.empresa.test/sso", idpIssuer: "idp" });
    expect(row.data.to.certFingerprint).toBe(new X509Certificate(pem).fingerprint256);
    expect(JSON.stringify(row.data)).not.toContain("BEGIN CERTIFICATE");
  });
});

describe("SCIM", () => {
  it("PATCH /v1/settings/scim audita el rol por defecto anterior y el nuevo", async () => {
    const t = await newTenant();
    const owner = await newUser(t);
    const cookies = await newSession(owner, t);
    const r = await app.inject({ method: "PATCH", url: "/v1/settings/scim", cookies, payload: { defaultRole: "admin" } });
    expect(r.statusCode).toBe(200);
    const [row] = await audits(t, "settings.scim_updated");
    expect(row.data).toEqual({ changed: ["defaultRole"], from: { defaultRole: "member" }, to: { defaultRole: "admin" } });
    expect(await audits(t, "settings.changed")).toHaveLength(0);
  });

  it("crear y revocar un token: scim.token_created / scim.token_revoked con id, nombre y prefijo (sin el secreto)", async () => {
    const t = await newTenant();
    const owner = await newUser(t);
    const cookies = await newSession(owner, t);
    const c = await app.inject({ method: "POST", url: "/v1/settings/scim/tokens", cookies, payload: { name: "Okta" } });
    expect(c.statusCode).toBe(201);
    const { token, secret } = c.json();
    const [created] = await audits(t, "scim.token_created");
    expect(created.target_type).toBe("scim_token");
    expect(created.target_id).toBe(token.id);
    expect(created.data).toEqual({ name: "Okta", prefix: token.prefix });
    expect(JSON.stringify(created)).not.toContain(secret);

    const d = await app.inject({ method: "DELETE", url: `/v1/settings/scim/tokens/${token.id}`, cookies });
    expect(d.statusCode).toBe(204);
    const [revoked] = await audits(t, "scim.token_revoked");
    expect(revoked.target_id).toBe(token.id);
    expect(revoked.data).toEqual({ name: "Okta", prefix: token.prefix });
    // Ni el patrón de la ruta como objetivo, ni un settings.changed duplicado.
    expect(await audits(t, "settings.changed")).toHaveLength(0);
  });

  it("el registro genérico de ajustes usa la ruta real como objetivo (no el patrón con :id)", async () => {
    const { realPath } = await import("../src/modules/audit");
    expect(realPath("/v1/settings/brands/:id/assets/:kind", { id: "b1", kind: "logo" })).toBe("/v1/settings/brands/b1/assets/logo");
    expect(realPath("/v1/settings/evidence", {})).toBe("/v1/settings/evidence");
  });
});

describe("adjuntos", () => {
  it("descargar un adjunto queda auditado (envelope.attachment_downloaded, deduplicado 10 min)", async () => {
    const { uuidv7 } = util;
    const t = await newTenant();
    const owner = await newUser(t);
    const cookies = await newSession(owner, t);
    const env = uuidv7();
    const doc = uuidv7();
    const rec = uuidv7();
    const docFile = uuidv7();
    const attFile = uuidv7();
    const field = uuidv7();
    await blobs.put(`test/${attFile}.pdf`, Buffer.from("%PDF-1.4\n%%EOF\n"), "application/pdf");
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, sha256, size_bytes, content_type) VALUES ($1,$2,'original','x','x',1,'application/pdf')`, [docFile, t]);
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, sha256, size_bytes, content_type) VALUES ($1,$2,'attachment',$3,'x',15,'application/pdf')`, [
      attFile,
      t,
      `test/${attFile}.pdf`,
    ]);
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1,$2,'Con adjunto','completed')`, [env, t]);
    await db.query(`INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,1,'c.pdf',$4,1,$5)`, [
      doc,
      t,
      env,
      docFile,
      JSON.stringify([{ width: 600, height: 800 }]),
    ]);
    await db.query(`INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email) VALUES ($1,$2,$3,'signer','Ana','ana@x.test')`, [rec, t, env]);
    await db.query(
      `INSERT INTO fields (id, tenant_id, envelope_id, document_id, recipient_id, type, page, x, y, width, height, value, attachment_file_id)
       VALUES ($1,$2,$3,$4,$5,'attachment',0,0.1,0.1,0.1,0.1,'dni.pdf',$6)`,
      [field, t, env, doc, rec, attFile],
    );
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({ method: "GET", url: `/v1/envelopes/${env}/attachments/${field}`, cookies });
      expect(r.statusCode).toBe(200);
    }
    const rows = await audits(t, "envelope.attachment_downloaded");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_type: "field", target_id: field, actor_id: owner });
    expect(rows[0].data).toEqual({ envelopeId: env });
  });
});

describe("almacenamiento", () => {
  it("PATCH de una conexión: storage.updated con los campos que cambiaron (anterior y nuevo)", async () => {
    const t = await newTenant();
    const owner = await newUser(t);
    const cookies = await newSession(owner, t);
    const id = util.uuidv7();
    await db.query(`INSERT INTO storage_connections (id, tenant_id, provider, name, config, credentials_enc) VALUES ($1,$2,'s3','Bucket',$3,'x')`, [
      id,
      t,
      JSON.stringify({ bucket: "b", prefix: "firmados/", includeEvidence: true }),
    ]);
    const r = await app.inject({ method: "PATCH", url: `/v1/storage/connections/${id}`, cookies, payload: { active: false, prefix: "otros", includeEvidence: false } });
    expect(r.statusCode).toBe(200);
    const [row] = await audits(t, "storage.updated");
    expect(row.target_id).toBe(id);
    expect(row.data.changed.sort()).toEqual(["active", "includeEvidence", "prefix"]);
    expect(row.data.from).toEqual({ active: true, prefix: "firmados/", includeEvidence: true });
    expect(row.data.to).toEqual({ active: false, prefix: "otros/", includeEvidence: false });
  });
});

describe("2FA", () => {
  it("activar, regenerar códigos y desactivar se audita en todas las organizaciones del usuario", async () => {
    const { totpAt, currentStep } = await import("../src/lib/totp");
    const t1 = await newTenant();
    const t2 = await newTenant();
    const u = await newUser(t1);
    await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'member')`, [t2, u]);
    const cookies = await newSession(u, t1);
    expect((await app.inject({ method: "POST", url: "/v1/me/2fa/setup", cookies })).statusCode).toBe(200);
    const pending = (await db.one<any>(`SELECT totp_pending_enc FROM users WHERE id = $1`, [u]))!.totp_pending_enc;
    const secret = util.decrypt(pending);
    const enable = await app.inject({ method: "POST", url: "/v1/me/2fa/enable", cookies, payload: { code: totpAt(secret, currentStep()) } });
    expect(enable.statusCode).toBe(200);
    // Otro paso (el último usado no se acepta dos veces): el próximo.
    const regen = await app.inject({ method: "POST", url: "/v1/me/2fa/recovery-codes", cookies, payload: { code: totpAt(secret, currentStep() + 1) } });
    expect(regen.statusCode).toBe(200);
    const disable = await app.inject({ method: "POST", url: "/v1/me/2fa/disable", cookies, payload: { code: regen.json().recoveryCodes[0] } });
    expect(disable.statusCode).toBe(200);
    for (const t of [t1, t2]) {
      for (const action of ["user.2fa_enabled", "user.2fa_recovery_regenerated", "user.2fa_disabled"]) {
        const rows = await audits(t, action);
        expect(rows, `${action} en ${t === t1 ? "t1" : "t2"}`).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor_id: u, target_id: u, target_type: "user" });
      }
    }
  });
});

describe("intentos fallidos", () => {
  it("sin organizaciones cuenta los fallos de todas; con organización, solo los de la primera", async () => {
    const { recentFailedLogins } = await import("../src/modules/teams");
    const t1 = await newTenant();
    const t2 = await newTenant();
    const u = await newUser(null);
    await db.query(`UPDATE users SET password_reset_at = NULL WHERE id = $1`, [u]);
    const fail = (t: string, ago = "0 minutes") =>
      db.query(`INSERT INTO account_audit_log (tenant_id, actor_type, actor_id, action, occurred_at) VALUES ($1,'anonymous',$2,'auth.login_failed', now() - $3::interval)`, [t, u, ago]);
    await fail(t1);
    await fail(t2);
    await fail(t2, "20 minutes"); // fuera de la ventana
    expect(await recentFailedLogins(db, u)).toBe(2);
    await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'member')`, [t1, u]);
    expect(await recentFailedLogins(db, u)).toBe(1);
    // Un restablecimiento posterior desbloquea.
    await db.query(`INSERT INTO account_audit_log (tenant_id, actor_type, actor_id, action, target_id, occurred_at) VALUES ($1,'user',$2,'user.password_reset',$2, now() + interval '1 second')`, [t1, u]);
    expect(await recentFailedLogins(db, u)).toBe(0);
  });
});
