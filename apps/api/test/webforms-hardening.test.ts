// Formularios web públicos sobre PGlite: tope por organización, deduplicación por correo, captcha opcional (Turnstile),
// prellenado de solo lectura, plan exigido al modificar (salvo desactivar), copia final solo con correo validado, y
// topes de códigos OTP por destino.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-webforms-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant: string;
let formId: string;
let slug: string;
const KEY = "cs_test_webforms_hardening_key";
const auth = { authorization: `Bearer ${KEY}` };
const real = globalThis.fetch;

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7, sha256Hex } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [tenant, `t-${tenant.slice(-8)}`]);
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [uuidv7(), tenant, sha256Hex(KEY)]);
  // Plantilla: un documento, un rol firmante con firma y un texto "Plan" que prellena el formulario.
  const tpl = uuidv7();
  const file = uuidv7();
  const doc = uuidv7();
  const role = uuidv7();
  await db.query(`INSERT INTO templates (id, tenant_id, name) VALUES ($1, $2, 'Alta')`, [tpl, tenant]);
  await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1, $2, 'original', 'x', 'application/pdf', 10, 'abc')`, [
    file,
    tenant,
  ]);
  await db.query(`INSERT INTO template_documents (id, tenant_id, template_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,0,'doc',$4,1,$5)`, [
    doc,
    tenant,
    tpl,
    file,
    JSON.stringify([{ width: 595, height: 842 }]),
  ]);
  await db.query(`INSERT INTO template_roles (id, tenant_id, template_id, name, role, routing_order) VALUES ($1,$2,$3,'Cliente','signer',1)`, [role, tenant, tpl]);
  for (const [type, label] of [
    ["signature", null],
    ["text", "Plan"],
    ["text", "Notas"],
  ]) {
    await db.query(
      `INSERT INTO template_fields (id, tenant_id, template_id, document_id, role_id, type, page, x, y, width, height, required, label) VALUES ($1,$2,$3,$4,$5,$6,1,0.1,0.1,0.2,0.05,false,$7)`,
      [uuidv7(), tenant, tpl, doc, role, type, label],
    );
  }
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/v1/web-forms", headers: auth, payload: { templateId: tpl, name: "Alta de clientes", signerRoleId: role, prefill: { Plan: "Oro" }, lockPrefill: true } });
  expect(res.json().lockPrefill).toBe(true);
  expect(res.statusCode).toBe(201);
  formId = res.json().id;
  slug = res.json().slug;
}, 120_000);

afterAll(async () => {
  globalThis.fetch = real;
  await app?.close();
  await db?.close();
});

/** Envío del formulario con un token ya "viejo" (pasó el tiempo mínimo de llenado). */
async function submit(email: string, extra: Record<string, unknown> = {}, opts: { slug?: string; ip?: string } = {}) {
  const { encrypt } = await import("../src/lib/util");
  const sl = opts.slug ?? slug;
  const formToken = encrypt(JSON.stringify({ s: sl, t: Date.now() - 5000, n: Math.random() }));
  return app.inject({
    method: "POST",
    url: `/v1/public/forms/${sl}/submit`,
    payload: { name: "Ana Pérez", email, formToken, ...extra },
    ...(opts.ip ? { remoteAddress: opts.ip } : {}),
  });
}

describe("formularios web: envíos del público", () => {
  it("prellenado de solo lectura, sin copia final por correo y el mismo correo no crea otro sobre", async () => {
    const r = await submit("ana@x.test");
    expect(r.statusCode).toBe(201);
    const env = r.json().envelopeId;
    const fields = await db.query<any>(`SELECT label, value, read_only FROM fields WHERE envelope_id = $1 AND type = 'text' ORDER BY label`, [env]);
    expect(fields).toEqual([
      { label: "Notas", value: null, read_only: false },
      { label: "Plan", value: "Oro", read_only: true },
    ]);
    // La página de firma le pide guardar el link (el correo no está validado; el aviso de completado le llega igual, con la
    // nota "si no fuiste vos", pero no se ofrece pedir otra copia por mensaje).
    const session = await app.inject({ method: "GET", url: `/v1/signing/${r.json().signingPath.slice(3)}` });
    expect(session.json().finalCopyByMessage).toBe(false);
    // Mismo correo (otra capitalización) en la ventana: 429 y ningún sobre nuevo.
    const again = await submit("ANA@x.test");
    expect(again.statusCode).toBe(429);
    expect(again.json().error.code).toBe("form_recent_submission");
    expect(again.json().error.message).not.toMatch(/correo/);
    const n = await db.one<any>(`SELECT count(*)::int AS n FROM envelopes WHERE metadata->>'webFormId' = $1`, [formId]);
    expect(n.n).toBe(1);
    // La huella de quien completó va en una columna interna, no en los metadatos (API, eventos, webhooks).
    const meta = await db.one<any>(`SELECT metadata, web_form_submitter FROM envelopes WHERE metadata->>'webFormId' = $1`, [formId]);
    expect(meta.metadata.webFormSubmitter).toBeUndefined();
    expect(meta.web_form_submitter).toMatch(/\S{20,}/);
    // Desde otra IP (otro /64), el mismo correo sí crea otro: un tercero no le bloquea el formulario a esa persona.
    const other = await submit("ana@x.test", {}, { ip: "2001:db8:aa:bb::7" });
    expect(other.statusCode).toBe(201);
    // Mismo /64 → duplicado.
    expect((await submit("ana@x.test", {}, { ip: "2001:db8:aa:bb::99" })).statusCode).toBe(429);
    // Un sobre anulado no cuenta: se puede volver a completar.
    await db.query(`UPDATE envelopes SET status = 'voided' WHERE id = $1`, [env]);
    expect((await submit("ana@x.test")).statusCode).toBe(201);
  });

  it("sin lockPrefill (por defecto) el prellenado se puede corregir", async () => {
    const tplId = (await db.one<any>(`SELECT template_id, signer_role_id FROM web_forms WHERE id = $1`, [formId]))!;
    const res = await app.inject({
      method: "POST",
      url: "/v1/web-forms",
      headers: auth,
      payload: { templateId: tplId.template_id, name: "Sin bloqueo", signerRoleId: tplId.signer_role_id, prefill: { Plan: "Plata" } },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().lockPrefill).toBe(false);
    const r = await submit("dani@x.test", {}, { slug: res.json().slug });
    expect(r.statusCode).toBe(201);
    const f = await db.one<any>(`SELECT value, read_only FROM fields WHERE envelope_id = $1 AND label = 'Plan'`, [r.json().envelopeId]);
    expect(f).toEqual({ value: "Plata", read_only: false });
    // Se puede activar después.
    const p = await app.inject({ method: "PATCH", url: `/v1/web-forms/${res.json().id}`, headers: auth, payload: { lockPrefill: true } });
    expect(p.json().lockPrefill).toBe(true);
  });

  it("formulario embebible: la página de firma (?embed=1) se puede enmarcar (sesión embebida registrada al enviar)", async () => {
    const f = (await db.one<any>(`SELECT template_id, signer_role_id FROM web_forms WHERE id = $1`, [formId]))!;
    await db.query(`UPDATE tenants SET embed_frame_ancestors = $2 WHERE id = $1`, [tenant, ["https://app.cliente.test"]]);
    const res = await app.inject({
      method: "POST",
      url: "/v1/web-forms",
      headers: auth,
      payload: { templateId: f.template_id, name: "Embebible", signerRoleId: f.signer_role_id, embeddable: true },
    });
    expect(res.statusCode).toBe(201);
    const r = await submit("emi@x.test", { embed: true }, { slug: res.json().slug });
    expect(r.statusCode).toBe(201);
    expect(r.json().signingPath).toMatch(/\?embed=1$/);
    const page = await app.inject({ method: "GET", url: r.json().signingPath });
    expect(/frame-ancestors ([^;]*)/.exec(String(page.headers["content-security-policy"]))?.[1]?.trim()).toBe("'self' https://app.cliente.test");
    // El link permanente del destinatario (no un token de sesión): quien completa el formulario no recibe la copia
    // final por correo y la descarga desde ese link, también después de cerrarse el sobre. La sesión embebida queda
    // registrada (para el CSP) sin token de sesión asociado.
    const { decrypt } = await import("../src/lib/util");
    const linkToken = String(r.json().signingPath).slice(3).split("?")[0];
    const rc = await db.one<any>(`SELECT id, access_token_enc FROM recipients WHERE envelope_id = $1 AND self_registered`, [r.json().envelopeId]);
    expect(linkToken).toBe(decrypt(rc.access_token_enc));
    const es = await db.one<any>(`SELECT created_by_actor, used_at FROM embed_sessions WHERE recipient_id = $1`, [rc.id]);
    expect(es).toMatchObject({ created_by_actor: expect.stringMatching(/^web_form:/) });
    expect(es.used_at).not.toBeNull();
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM signer_session_tokens WHERE recipient_id = $1`, [rc.id])).n).toBe(0);
    await db.query(`UPDATE tenants SET embed_frame_ancestors = '{}' WHERE id = $1`, [tenant]);
  });

  it("tope por organización sumando todos sus formularios", async () => {
    const { config } = await import("../src/config");
    const prev = config.webForms.maxPerTenantHour;
    config.webForms.maxPerTenantHour = 1;
    try {
      const r = await submit("bea@x.test");
      expect(r.statusCode).toBe(429);
      expect(r.json().error.code).toBe("form_rate_limited");
    } finally {
      config.webForms.maxPerTenantHour = prev;
    }
  });

  it("captcha opcional: con Turnstile configurado se exige y se valida el token", async () => {
    const { config } = await import("../src/config");
    config.webForms.turnstileSiteKey = "site-key";
    config.webForms.turnstileSecretKey = "secret";
    const seen: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: URLSearchParams }) => {
      const tok = init?.body?.get("response") ?? "";
      seen.push(tok);
      if (tok === "down") throw new TypeError("fetch failed");
      if (tok === "elsewhere") return new Response(JSON.stringify({ success: true, hostname: "otro-sitio.example" }), { status: 200 });
      return new Response(JSON.stringify({ success: tok === "good", hostname: "localhost" }), { status: 200 });
    }) as typeof fetch;
    try {
      const pub = await app.inject({ method: "GET", url: `/v1/public/forms/${slug}` });
      expect(pub.json().captchaSiteKey).toBe("site-key");
      expect((await submit("caro@x.test")).json().error.code).toBe("captcha_failed");
      expect((await submit("caro@x.test", { captchaToken: "bad" })).json().error.code).toBe("captcha_failed");
      // Red caída y token resuelto en otro sitio (hostname ajeno): se rechaza igual.
      expect((await submit("caro@x.test", { captchaToken: "down" })).json().error.code).toBe("captcha_failed");
      expect((await submit("caro@x.test", { captchaToken: "elsewhere" })).json().error.code).toBe("captcha_failed");
      expect((await submit("caro@x.test", { captchaToken: "good" })).statusCode).toBe(201);
      expect(seen).toEqual(["bad", "down", "elsewhere", "good"]);
    } finally {
      config.webForms.turnstileSiteKey = null;
      config.webForms.turnstileSecretKey = null;
      globalThis.fetch = real;
    }
    const pub = await app.inject({ method: "GET", url: `/v1/public/forms/${slug}` });
    expect(pub.json().captchaSiteKey).toBeNull();
  });

  it("modificarlo exige formularios web en el plan, salvo desactivarlo", async () => {
    // Starter: tiene API pero no formularios web.
    await db.query(`UPDATE tenants SET billing_plan = 'starter' WHERE id = $1`, [tenant]);
    try {
      const edit = await app.inject({ method: "PATCH", url: `/v1/web-forms/${formId}`, headers: auth, payload: { name: "Otro nombre" } });
      expect(edit.statusCode).toBe(402);
      const on = await app.inject({ method: "PATCH", url: `/v1/web-forms/${formId}`, headers: auth, payload: { active: true } });
      expect(on.statusCode).toBe(402);
      const off = await app.inject({ method: "PATCH", url: `/v1/web-forms/${formId}`, headers: auth, payload: { active: false } });
      expect(off.statusCode).toBe(200);
      expect(off.json().active).toBe(false);
    } finally {
      await db.query(`UPDATE tenants SET billing_plan = NULL WHERE id = $1`, [tenant]);
    }
  });
});

describe("códigos de verificación: tope por destino", () => {
  it("cuenta por organización + destino (sin mayúsculas, solo sin verificar); otra organización no bloquea; tope global alto", async () => {
    const { assertOtpDestinationCapacity } = await import("../src/modules/otp");
    const { config } = await import("../src/config");
    const { uuidv7 } = await import("../src/lib/util");
    const otherTenant = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Otra')`, [otherTenant, `t-${otherTenant.slice(-8)}`]);
    const env = uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'x', 'sent')`, [env, tenant]);
    const add = async (dest: string, n: number, tenantId = tenant, verified = false) => {
      for (let i = 0; i < n; i++) {
        const r = uuidv7();
        await db.query(`INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status) VALUES ($1,$2,$3,'signer','V',$4,'sent')`, [r, tenant, env, dest]);
        await db.query(
          `INSERT INTO otp_challenges (id, tenant_id, recipient_id, method, destination, code_hash, expires_at, verified_at)
           VALUES ($1,$2,$3,'otp_email',$4,'h', now(), ${verified ? "now()" : "NULL"})`,
          [uuidv7(), tenantId, r, dest],
        );
      }
    };
    // Otra organización agota su cupo con la misma dirección: no deja sin códigos a esta.
    await add("Victima@x.test", config.otp.maxPerDestinationHour, otherTenant);
    await expect(assertOtpDestinationCapacity(db, otherTenant, "victima@x.test")).rejects.toMatchObject({ code: "otp_destination_limit", status: 429 });
    await expect(assertOtpDestinationCapacity(db, tenant, "victima@x.test")).resolves.toBeUndefined();
    // Los verificados no cuentan.
    await add("victima@X.test", config.otp.maxPerDestinationHour, tenant, true);
    await expect(assertOtpDestinationCapacity(db, tenant, "victima@x.test")).resolves.toBeUndefined();
    await add("victima@X.test", config.otp.maxPerDestinationHour - 1);
    await expect(assertOtpDestinationCapacity(db, tenant, "victima@x.test")).resolves.toBeUndefined();
    await add("victima@X.test", 1);
    await expect(assertOtpDestinationCapacity(db, tenant, " VICTIMA@x.test ")).rejects.toMatchObject({ code: "otp_destination_limit", status: 429 });
    await expect(assertOtpDestinationCapacity(db, tenant, "otra@x.test")).resolves.toBeUndefined();
    // Tope global (todas las organizaciones): bloquea también a una tercera.
    const prevGlobal = config.otp.maxPerDestinationGlobalHour;
    config.otp.maxPerDestinationGlobalHour = 2 * config.otp.maxPerDestinationHour;
    try {
      await expect(assertOtpDestinationCapacity(db, uuidv7(), "victima@x.test")).rejects.toMatchObject({ code: "otp_destination_limit" });
    } finally {
      config.otp.maxPerDestinationGlobalHour = prevGlobal;
    }
    await expect(assertOtpDestinationCapacity(db, uuidv7(), "victima@x.test")).resolves.toBeUndefined();
    const prev = config.otp.maxPerTenantHour;
    config.otp.maxPerTenantHour = 5;
    try {
      await expect(assertOtpDestinationCapacity(db, tenant, "otra@x.test")).rejects.toMatchObject({ code: "otp_tenant_limit" });
    } finally {
      config.otp.maxPerTenantHour = prev;
    }
  });
});

describe("clave de límite por IP", () => {
  it("IPv6 por /64; IPv4, mapeadas y loopback tal cual", async () => {
    const { rateLimitIpKey } = await import("../src/lib/ip");
    expect(rateLimitIpKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitIpKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(rateLimitIpKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitIpKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(rateLimitIpKey("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(rateLimitIpKey("203.0.113.9")).toBe("203.0.113.9");
    expect(rateLimitIpKey("::1")).toBe("::1");
    // Corchetes y puerto; IPv4 mapeada en notación hexadecimal.
    expect(rateLimitIpKey("[2001:db8:1:2::5]:443")).toBe("2001:db8:1:2::/64");
    expect(rateLimitIpKey("[::1]")).toBe("::1");
    expect(rateLimitIpKey("203.0.113.9:5678")).toBe("203.0.113.9");
    expect(rateLimitIpKey("::ffff:a00:1")).toBe("10.0.0.1");
    expect(rateLimitIpKey("::FFFF:7f00:1")).toBe("127.0.0.1");
    expect(rateLimitIpKey("0:0:0:0:0:ffff:c0a8:0101")).toBe("192.168.1.1");
    expect(rateLimitIpKey("::ffff:127.0.0.1")).toBe("127.0.0.1");
  });
});
