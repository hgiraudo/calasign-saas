// Verificación de identidad del firmante: nivel exigido (coincidencia facial y prueba de vida) también con Veriff y
// Truora, reenvío de Veriff como revisión, lotes de webhooks de Truora, vencimiento sin resultado del proveedor,
// reinicio por el remitente, fotos y envío con el sobre cerrado o vencido, verificaciones canceladas al cerrarse el
// sobre, corrección del número de documento, referencia de Truora y uso del plan. App real sobre PGlite.
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-idv-enforcement-"));
delete process.env.DATABASE_URL;
process.env.VERIFF_API_KEY = "veriff_test_key";
process.env.VERIFF_SHARED_SECRET = "veriff_test_secret";
process.env.VERIFF_BASE_URL = "https://veriff.test";
process.env.TRUORA_API_KEY = "truora_test_key";
process.env.TRUORA_FLOW_ID = "IPFtest";
process.env.TRUORA_WEBHOOK_SECRET = "truora_whsec";

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
type Blobs = ReturnType<typeof import("../src/infra/storage")["createBlobStore"]>;
let db: Db;
let app: App;
let blobs: Blobs;
let tenant = "";
let util: typeof import("../src/lib/util");
const KEY = "cs_test_idv_enforcement_key";
const auth = { authorization: `Bearer ${KEY}` };
const real = globalThis.fetch;
let fetchCalls: string[] = [];

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = util.uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name, retention_days) VALUES ($1, $2, 'T', 30)`, [tenant, `t-${tenant.slice(-8)}`]);
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [util.uuidv7(), tenant, util.sha256Hex(KEY)]);
  blobs = createBlobStore();
  app = await buildApp({ db, blobs, logger: false });
  await app.ready();
  // Proveedores falsos: Veriff crea sesiones vf_<n>; cualquier otra llamada a un proveedor se cuenta y responde vacío.
  let n = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith("https://veriff.test/") || url.includes("truora.com")) {
      fetchCalls.push(url);
      if (url === "https://veriff.test/v1/sessions") {
        const id = `vf_${++n}_${Date.now()}`;
        return new Response(JSON.stringify({ verification: { id, url: `https://veriff.test/go/${id}` } }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ verification: null }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return real(input, init);
  }) as typeof fetch;
}, 120_000);
afterAll(async () => {
  globalThis.fetch = real;
  await app?.close();
  await db?.close();
});

type Opts = { provider?: string; level?: string; name?: string; idDoc?: string | null; expiresAt?: string | null; authMethod?: string; status?: string };

async function setup(o: Opts = {}) {
  const envelope = util.uuidv7();
  const recipient = util.uuidv7();
  const token = util.randomToken();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, expires_at) VALUES ($1, $2, 'Contrato', 'sent', now(), $3)`, [
    envelope,
    tenant,
    o.expiresAt ?? null,
  ]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, access_token_hash, access_token_enc, auth_method,
       id_verification_provider, id_verification_level, identity_status, id_document_number)
     VALUES ($1,$2,$3,'signer',$4,'ana@x.test',$5,$6,$7,$8,$9,$10,'pending',$11)`,
    [
      recipient,
      tenant,
      envelope,
      o.name ?? "Ana Pérez",
      o.status ?? "sent",
      util.sha256Hex(token),
      util.encrypt(token),
      o.authMethod ?? "link",
      o.provider ?? "mock",
      o.level ?? "document",
      o.idDoc ?? null,
    ],
  );
  return { envelope, recipient, token };
}

const signing = (token: string, path = "", method: "GET" | "POST" = "GET", payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url: `/v1/signing/${token}${path}`, payload: payload as any, headers });

async function veriffHook(verification: Record<string, unknown>) {
  const { veriffSignature } = await import("../src/modules/identity/providers");
  const raw = JSON.stringify({ status: "success", verification });
  return app.inject({
    method: "POST",
    url: "/v1/integrations/identity/veriff/webhook",
    payload: raw,
    headers: { "content-type": "application/json", "x-hmac-signature": veriffSignature(raw, "veriff_test_secret") },
  });
}

function truoraJwt(payload: unknown) {
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const s = createHmac("sha256", "truora_whsec").update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

const truoraProcess = (accountId: string, processId: string, o: { face?: boolean } = {}) => ({
  process_id: processId,
  account_id: accountId,
  status: "success",
  validations: [
    {
      validation_type: "document-validation",
      validation_status: "success",
      details: { document_details: { name: "Ana", last_name: "Pérez", document_number: "123", document_type: "national-id", country: "AR" } },
    },
    ...(o.face
      ? [{ validation_type: "face-recognition", validation_status: "success", details: { face_recognition_validations: { confidence_score: 0.95, similarity_status: "success" } } }]
      : []),
  ],
});

async function pendingVerification(
  recipient: string,
  envelope: string,
  provider: string,
  ref: string | null,
  o: { status?: string; createdAgo?: string; level?: string; integrationLevel?: string | null } = {},
) {
  const id = util.uuidv7();
  // integration_level como lo guarda /identity/start (la integración en ese momento); null = fila anterior a la columna.
  const { integrationLevelToStore } = await import("../src/modules/identity/providers");
  const integration = o.integrationLevel !== undefined ? o.integrationLevel : integrationLevelToStore(provider as any, (o.level ?? "document") as any);
  await db.query(
    `INSERT INTO identity_verifications (id, tenant_id, envelope_id, recipient_id, provider, level, status, attempt, provider_ref, created_at, updated_at, integration_level)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8, now() - $9::interval, now() - $9::interval, $10)`,
    [id, tenant, envelope, recipient, provider, o.level ?? "document", o.status ?? "pending", ref, o.createdAgo ?? "1 minute", integration],
  );
  await db.query(`UPDATE recipients SET identity_status = 'in_progress' WHERE id = $1`, [recipient]);
  return id;
}

const verification = (id: string) => db.one<any>(`SELECT * FROM identity_verifications WHERE id = $1`, [id]);
const recipientRow = (id: string) => db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [id]);

/** PNG chico pero válido para el recorrido de chunks (stripImageMetadata). */
function png(seed: number) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(32, 0);
  ihdr.writeUInt32BE(32, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const idat = Buffer.alloc(3000, seed);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function upload(token: string, kind: string, seed: number) {
  const b = "----calasignidv";
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
    png(seed),
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return app.inject({ method: "POST", url: `/v1/signing/${token}/identity/captures/${kind}`, payload, headers: { "content-type": `multipart/form-data; boundary=${b}` } });
}

describe("nivel exigido con proveedores externos", () => {
  it("Veriff: sin VERIFF_INTEGRATION_LEVEL solo se ofrece document: la selfie no se pide, no se envía ni se inicia", async () => {
    const { config } = await import("../src/config");
    expect(config.identity.veriffIntegrationLevel).toBe(null);
    // Arranque: avisa que conviene definirla explícitamente.
    const { warnIdentityConfig } = await import("../src/modules/identity/providers");
    const warns: string[] = [];
    warnIdentityConfig({ warn: (m) => warns.push(m) });
    expect(warns.join("\n")).toContain("VERIFF_INTEGRATION_LEVEL");
    const { applyIdentityFlags } = await import("../src/modules/identity/kyc");
    const x = await setup({ provider: "veriff", level: "document_selfie_liveness" });
    const err = await applyIdentityFlags(db, x.envelope, [{ id: x.recipient, role: "signer", idVerification: { provider: "veriff", level: "document_selfie_liveness" } }]).catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: "identity_provider_unavailable" });
    expect(String(err.message)).toContain("VERIFF_INTEGRATION_LEVEL=document_selfie_liveness");
    expect(String(err.message)).toContain("no está definida");
    // document_selfie (el flujo estándar) tampoco: sin la variable no se infiere la coincidencia facial.
    const err2 = await applyIdentityFlags(db, x.envelope, [{ id: x.recipient, role: "signer", idVerification: { provider: "veriff", level: "document_selfie" } }]).catch((e) => e);
    expect(err2).toMatchObject({ status: 400, code: "identity_provider_unavailable" });
    expect(String(err2.message)).toContain("VERIFF_INTEGRATION_LEVEL=document_selfie");
    // document sí.
    const y = await setup({ provider: "veriff", level: "document" });
    await applyIdentityFlags(db, y.envelope, [{ id: y.recipient, role: "signer", idVerification: { provider: "veriff", level: "document" } }]);
    // Al enviar un borrador armado antes: problema identity_provider_unavailable con la variable.
    const { sendEnvelope } = await import("../src/modules/envelopes");
    const { SYSTEM } = await import("../src/infra/evidence");
    const draft = util.uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Borrador', 'draft')`, [draft, tenant]);
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, id_verification_provider, id_verification_level, identity_status)
       VALUES ($1,$2,$3,'signer','Ana Pérez','ana@x.test','created','veriff','document_selfie','pending')`,
      [util.uuidv7(), tenant, draft],
    );
    const sendErr = await db.tx((t) => sendEnvelope(t, tenant, draft, SYSTEM)).catch((e) => e);
    expect(sendErr.code).toBe("envelope_incomplete");
    const issue = sendErr.details.issues.find((p: any) => p.code === "identity_provider_unavailable");
    expect(issue.message).toContain("VERIFF_INTEGRATION_LEVEL");
    // Para el firmante, un mensaje neutro (sin variables del servidor).
    const st = await signing(x.token, "/identity/start", "POST");
    expect(st.statusCode).toBe(503);
    expect(st.json().error.code).toBe("identity_provider_unavailable");
    expect(st.json().error.message).not.toMatch(/VERIFF|Veriff/);
    // Para el remitente, el motivo en el detalle del destinatario.
    const det = await app.inject({ method: "GET", url: `/v1/envelopes/${x.envelope}/recipients/${x.recipient}/identity`, headers: auth });
    expect(det.json().unavailableReason).toContain("VERIFF_INTEGRATION_LEVEL");
  });

  it("Veriff sin VERIFF_INTEGRATION_LEVEL: una verificación ya en curso se retoma (sin 503) y su nivel guardado decide la inferencia", async () => {
    const { config } = await import("../src/config");
    expect(config.identity.veriffIntegrationLevel).toBe(null);
    // Iniciada cuando la variable estaba definida (document_selfie) y otra iniciada sin ella ("none").
    for (const integrationLevel of ["document_selfie", "none"]) {
      const x = await setup({ provider: "veriff", level: "document_selfie" });
      const ref = `vf-resume-${integrationLevel}-${x.recipient}`;
      const v = await pendingVerification(x.recipient, x.envelope, "veriff", ref, { level: "document_selfie", integrationLevel });
      await db.query(`UPDATE identity_verifications SET redirect_url = $2 WHERE id = $1`, [v, `https://veriff.test/go/${ref}`]);
      fetchCalls = [];
      const st = await signing(x.token, "/identity/start", "POST");
      expect(st.statusCode).toBe(200);
      expect(fetchCalls).toEqual([]);
      expect((await db.query(`SELECT id FROM identity_verifications WHERE recipient_id = $1`, [x.recipient])).length).toBe(1);
      await veriffHook({ id: ref, status: "approved", person: { firstName: "Ana", lastName: "Pérez" } });
      if (integrationLevel === "none") expect(await verification(v)).toMatchObject({ status: "failed", failure_reason: "level_not_met" });
      else expect((await verification(v)).status).toBe("verified");
    }
    // Una verificación nueva sigue bloqueada (503 neutro para el firmante).
    const y = await setup({ provider: "veriff", level: "document_selfie" });
    const st = await signing(y.token, "/identity/start", "POST");
    expect(st.statusCode).toBe(503);
    expect(st.json().error.code).toBe("identity_provider_unavailable");
  });

  it("Veriff: la aprobación sin datos biométricos cumple lo que declara VERIFF_INTEGRATION_LEVEL; un puntaje bajo gana", async () => {
    const { config } = await import("../src/config");
    const prev = config.identity.veriffIntegrationLevel;
    (config.identity as any).veriffIntegrationLevel = "document_selfie";
    try {
    // Integración document_selfie (declarada): la aprobación sin faceMatch cuenta como coincidencia facial.
    const a = await setup({ provider: "veriff", level: "document_selfie" });
    expect((await signing(a.token, "/identity/start", "POST")).statusCode).toBe(200);
    const va = await db.one<any>(`SELECT * FROM identity_verifications WHERE recipient_id = $1`, [a.recipient]);
    expect(va.integration_level).toBe("document_selfie");
    // Bajar la variable después de iniciar no afecta a la verificación en curso (usa el nivel guardado).
    (config.identity as any).veriffIntegrationLevel = "document";
    const wh = await veriffHook({ id: va.provider_ref, status: "approved", person: { firstName: "Ana", lastName: "Pérez" } });
    expect(wh.statusCode).toBe(200);
    expect((await verification(va.id)).status).toBe("verified");
    const ev = await db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.identity_verified'`, [a.envelope]);
    expect(ev.data.inferredFromIntegration).toEqual(["faceMatched"]);
    // El certificado lo muestra como informado por la integración (sin puntaje).
    const { identityForCertificate } = await import("../src/modules/identity/kyc");
    const cert = (await identityForCertificate(db, [await recipientRow(a.recipient)])).get(a.recipient);
    expect(cert).toMatchObject({ faceMatchScore: null, faceMatched: true, inferred: ["faceMatched"] });
    (config.identity as any).veriffIntegrationLevel = "document_selfie";

    // Puntaje explícito bajo el umbral: falla del firmante (face_mismatch), consume un intento.
    const b = await setup({ provider: "veriff", level: "document_selfie" });
    await signing(b.token, "/identity/start", "POST");
    const vb = await db.one<any>(`SELECT * FROM identity_verifications WHERE recipient_id = $1`, [b.recipient]);
    await veriffHook({ id: vb.provider_ref, status: "approved", person: { firstName: "Ana", lastName: "Pérez" }, faceMatch: { similarity: 0.4 } });
    expect(await verification(vb.id)).toMatchObject({ status: "failed", failure_reason: "face_mismatch" });
    expect((await signing(b.token, "/identity")).json().identity.attemptsLeft).toBe(2);

    // Un nivel por encima de la integración: no se inicia (503, sin abrir una sesión paga) ni se puede pedir al enviar.
    const c = await setup({ provider: "veriff", level: "document_selfie_liveness" });
    fetchCalls = [];
    const st = await signing(c.token, "/identity/start", "POST");
    expect(st.statusCode).toBe(503);
    expect(st.json().error.code).toBe("identity_provider_unavailable");
    expect(fetchCalls).toEqual([]);
    const { applyIdentityFlags } = await import("../src/modules/identity/kyc");
    await expect(applyIdentityFlags(db, c.envelope, [{ id: c.recipient, role: "signer", idVerification: { provider: "veriff", level: "document_selfie_liveness" } }])).rejects.toMatchObject({
      code: "identity_provider_unavailable",
    });

    // Con la integración declarada en document_selfie_liveness, la prueba de vida también se infiere; liveness false gana.
    (config.identity as any).veriffIntegrationLevel = "document_selfie_liveness";
    {
      expect((await signing(c.token, "/identity/start", "POST")).statusCode).toBe(200);
      const vc = await db.one<any>(`SELECT * FROM identity_verifications WHERE recipient_id = $1`, [c.recipient]);
      await veriffHook({ id: vc.provider_ref, status: "approved", person: { firstName: "Ana", lastName: "Pérez" } });
      expect((await verification(vc.id)).status).toBe("verified");
      const d = await setup({ provider: "veriff", level: "document_selfie_liveness" });
      await signing(d.token, "/identity/start", "POST");
      const vd = await db.one<any>(`SELECT * FROM identity_verifications WHERE recipient_id = $1`, [d.recipient]);
      await veriffHook({ id: vd.provider_ref, status: "approved", person: { firstName: "Ana", lastName: "Pérez" }, liveness: false });
      expect(await verification(vd.id)).toMatchObject({ status: "failed", failure_reason: "liveness_failed" });
    }
    } finally {
      (config.identity as any).veriffIntegrationLevel = prev;
    }
  });

  it("Truora con el flujo genérico exige la prueba de vida en el resultado (level_not_met no consume un intento y bloquea el reinicio)", async () => {
    const { recipient, envelope, token } = await setup({ provider: "truora", level: "document_selfie_liveness" });
    const v = await pendingVerification(recipient, envelope, "truora", `acc-live-${recipient}`, { level: "document_selfie_liveness" });
    const body = truoraJwt({ events: [{ object: truoraProcess(`acc-live-${recipient}`, "IDPlive", { face: true }) }] });
    expect((await app.inject({ method: "POST", url: "/v1/integrations/identity/truora/webhook", payload: body, headers: { "content-type": "text/plain" } })).statusCode).toBe(200);
    expect(await verification(v)).toMatchObject({ status: "failed", failure_reason: "level_not_met" });
    const ses = (await signing(token, "/identity")).json().identity;
    expect(ses.attemptsLeft).toBe(3);
    expect(ses.failureReason).toBe("level_not_met");
    const ev = await db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.identity_failed'`, [envelope]);
    expect(ev.data).toMatchObject({ reason: "level_not_met", configurationIssue: true, attemptsLeft: 3 });
    // Repetirla daría lo mismo (y abriría otra sesión paga): queda bloqueada hasta que el remitente reinicie.
    const again = await signing(token, "/identity/start", "POST");
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("identity_level_not_supported");
    expect((await app.inject({ method: "POST", url: `/v1/envelopes/${envelope}/recipients/${recipient}/identity/reset`, headers: auth })).statusCode).toBe(200);
  });

  it("Truora con un flujo propio del nivel: la aprobación cumple el nivel salvo un dato contrario explícito", async () => {
    process.env.TRUORA_FLOW_ID_DOCUMENT_SELFIE_LIVENESS = "IPFlive";
    try {
      const a = await setup({ provider: "truora", level: "document_selfie_liveness" });
      const va = await pendingVerification(a.recipient, a.envelope, "truora", `acc-flow-${a.recipient}`, { level: "document_selfie_liveness" });
      const okBody = truoraJwt({ events: [{ object: truoraProcess(`acc-flow-${a.recipient}`, "IDPflow", { face: true }) }] });
      await app.inject({ method: "POST", url: "/v1/integrations/identity/truora/webhook", payload: okBody, headers: { "content-type": "text/plain" } });
      expect((await verification(va)).status).toBe("verified");

      const b = await setup({ provider: "truora", level: "document_selfie_liveness" });
      const vb = await pendingVerification(b.recipient, b.envelope, "truora", `acc-flow-${b.recipient}`, { level: "document_selfie_liveness" });
      const proc = truoraProcess(`acc-flow-${b.recipient}`, "IDPflow2", { face: true });
      (proc.validations[1] as any).details.face_recognition_validations.passive_liveness_status = "failure";
      const badBody = truoraJwt({ events: [{ object: proc }] });
      await app.inject({ method: "POST", url: "/v1/integrations/identity/truora/webhook", payload: badBody, headers: { "content-type": "text/plain" } });
      expect(await verification(vb)).toMatchObject({ status: "failed", failure_reason: "liveness_failed" });
    } finally {
      delete process.env.TRUORA_FLOW_ID_DOCUMENT_SELFIE_LIVENESS;
    }
  });

  it("Truora sin flujo para el nivel: no se puede pedir al enviar (400) ni iniciar (503 en lugar de 500)", async () => {
    const prevFlow = process.env.TRUORA_FLOW_ID;
    delete process.env.TRUORA_FLOW_ID;
    process.env.TRUORA_FLOW_ID_DOCUMENT = "IPFdoc";
    try {
      const { applyIdentityFlags, providerReady } = await import("../src/modules/identity/kyc");
      expect(providerReady("truora")).toBe(true);
      expect(providerReady("truora", "document")).toBe(true);
      expect(providerReady("truora", "document_selfie")).toBe(false);
      const { recipient, envelope, token } = await setup({ provider: "truora", level: "document_selfie" });
      const err = await applyIdentityFlags(db, envelope, [{ id: recipient, role: "signer", idVerification: { provider: "truora", level: "document_selfie" } }]).catch((e) => e);
      expect(err).toMatchObject({ status: 400, code: "identity_provider_unavailable" });
      expect(String(err.message)).toMatch(/TRUORA_FLOW_ID_DOCUMENT_SELFIE/);
      const st = await signing(token, "/identity/start", "POST");
      expect(st.statusCode).toBe(503);
      expect(st.json().error.code).toBe("identity_provider_unavailable");
      expect(await db.one(`SELECT 1 FROM identity_verifications WHERE recipient_id = $1`, [recipient])).toBeFalsy();
    } finally {
      process.env.TRUORA_FLOW_ID = prevFlow;
      delete process.env.TRUORA_FLOW_ID_DOCUMENT;
    }
  });
});

describe("Veriff: reenvío pedido", () => {
  it("resubmission_requested queda en curso y la decisión posterior de la misma sesión la reemplaza", async () => {
    const { token, recipient } = await setup({ provider: "veriff", level: "document" });
    await signing(token, "/identity/start", "POST");
    const v = await db.one<any>(`SELECT * FROM identity_verifications WHERE recipient_id = $1`, [recipient]);
    await veriffHook({ id: v.provider_ref, status: "resubmission_requested", reason: "Photo blurry" });
    expect((await verification(v.id)).status).toBe("pending");
    expect((await recipientRow(recipient)).identity_status).toBe("in_progress");
    expect((await signing(token, "/identity")).json().identity.attemptsLeft).toBe(3);
    await veriffHook({ id: v.provider_ref, status: "approved", person: { firstName: "Ana", lastName: "Pérez" } });
    expect((await verification(v.id)).status).toBe("verified");
    expect((await recipientRow(recipient)).identity_status).toBe("verified");
  });
});

describe("Truora", () => {
  it("procesa todos los eventos del lote y la evidencia usa el process_id como referencia", async () => {
    const a = await setup({ provider: "truora" });
    const b = await setup({ provider: "truora" });
    const va = await pendingVerification(a.recipient, a.envelope, "truora", `acc-a-${a.recipient}`);
    const vb = await pendingVerification(b.recipient, b.envelope, "truora", `acc-b-${b.recipient}`);
    const body = truoraJwt({
      events: [{ object: truoraProcess(`acc-a-${a.recipient}`, "IDPaaa") }, { object: truoraProcess(`acc-b-${b.recipient}`, "IDPbbb") }],
    });
    const wh = await app.inject({ method: "POST", url: "/v1/integrations/identity/truora/webhook", payload: body, headers: { "content-type": "text/plain" } });
    expect(wh.statusCode).toBe(200);
    expect((await verification(va)).status).toBe("verified");
    expect((await verification(vb)).status).toBe("verified");
    const ev = await db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.identity_verified'`, [b.envelope]);
    expect(ev.data.reference).toBe("IDPbbb");
    const detail = await app.inject({ method: "GET", url: `/v1/envelopes/${b.envelope}/recipients/${b.recipient}/identity`, headers: auth });
    expect(detail.json().attempts[0].reference).toBe("IDPbbb");
  });

  it("una verificación sin resultado pasado el plazo vence (provider_timeout) sin consumir un intento", async () => {
    const { expireStaleVerifications } = await import("../src/modules/identity/kyc");
    const { recipient, envelope, token } = await setup({ provider: "truora" });
    const old = await pendingVerification(recipient, envelope, "truora", `acc-old-${recipient}`, { createdAgo: "25 hours" });
    const other = await setup({ provider: "truora" });
    const fresh = await pendingVerification(other.recipient, other.envelope, "truora", `acc-new-${other.recipient}`, { createdAgo: "1 hour" });
    expect(await expireStaleVerifications(db, 24)).toBeGreaterThanOrEqual(1);
    expect(await verification(old)).toMatchObject({ status: "expired", failure_reason: "provider_timeout" });
    expect((await verification(fresh)).status).toBe("pending");
    const r = await recipientRow(recipient);
    expect(r).toMatchObject({ identity_status: "pending", identity_failure_reason: "provider_timeout" });
    const ses = (await signing(token, "/identity")).json().identity;
    expect(ses.attemptsLeft).toBe(3);
    expect(ses.failureReason).toBe("provider_timeout");
    expect(await db.one(`SELECT 1 FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.identity_expired'`, [envelope])).toBeTruthy();
  });

  it("el plazo corre desde la última actividad del proveedor (no la consulta del firmante) y un resultado tardío se registra", async () => {
    const { expireStaleVerifications } = await import("../src/modules/identity/kyc");
    // Creada hace 30 h pero con un webhook hace 1 h (revisión manual larga): no vence.
    const a = await setup({ provider: "veriff" });
    const va = await pendingVerification(a.recipient, a.envelope, "veriff", `vf_act_${a.recipient}`, { createdAgo: "30 hours" });
    await db.query(`UPDATE identity_verifications SET updated_at = now() - interval '1 hour' WHERE id = $1`, [va]);
    // Sin actividad del proveedor hace 25 h, aunque el firmante consulte: vence (la consulta no corre el plazo).
    const b = await setup({ provider: "veriff" });
    const vb = await pendingVerification(b.recipient, b.envelope, "veriff", `vf_late_${b.recipient}`, { createdAgo: "25 hours" });
    expect((await signing(b.token, "/identity")).statusCode).toBe(200);
    expect((await verification(vb)).polled_at).toBeTruthy();
    await expireStaleVerifications(db, 24);
    expect((await verification(va)).status).toBe("pending");
    expect(await verification(vb)).toMatchObject({ status: "expired", failure_reason: "provider_timeout" });
    // La aprobación llega tarde: se registra (era la última verificación y el sobre sigue en curso).
    await veriffHook({ id: `vf_late_${b.recipient}`, status: "approved", person: { firstName: "Ana", lastName: "Pérez" } });
    expect((await verification(vb)).status).toBe("verified");
    expect((await recipientRow(b.recipient)).identity_status).toBe("verified");
    const ev = await db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.identity_verified'`, [b.envelope]);
    expect(ev.data.lateAfterTimeout).toBe(true);
    // Con otra verificación empezada después, el resultado tardío de la vencida se ignora.
    const c = await setup({ provider: "veriff" });
    const vc = await pendingVerification(c.recipient, c.envelope, "veriff", `vf_old_${c.recipient}`, { status: "expired", createdAgo: "26 hours" });
    await db.query(`UPDATE identity_verifications SET failure_reason = 'provider_timeout' WHERE id = $1`, [vc]);
    await pendingVerification(c.recipient, c.envelope, "veriff", `vf_new_${c.recipient}`);
    await veriffHook({ id: `vf_old_${c.recipient}`, status: "approved", person: { firstName: "Ana", lastName: "Pérez" } });
    expect((await verification(vc)).status).toBe("expired");
  });
});

describe("reinicio por el remitente", () => {
  it("anula las verificaciones y devuelve los intentos; no en un sobre cerrado", async () => {
    const { recipient, envelope, token } = await setup({ provider: "mock" });
    for (let i = 0; i < 3; i++) {
      await db.query(
        `INSERT INTO identity_verifications (id, tenant_id, envelope_id, recipient_id, provider, level, status, attempt, failure_reason) VALUES ($1,$2,$3,$4,'mock','document','failed',$5,'name_mismatch')`,
        [util.uuidv7(), tenant, envelope, recipient, i + 1],
      );
    }
    await db.query(`UPDATE recipients SET identity_status = 'failed', identity_failure_reason = 'name_mismatch' WHERE id = $1`, [recipient]);
    expect((await signing(token, "/identity")).json().identity.attemptsLeft).toBe(0);
    const res = await app.inject({ method: "POST", url: `/v1/envelopes/${envelope}/recipients/${recipient}/identity/reset`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().identity.status).toBe("pending");
    expect(res.json().attempts.every((x: any) => x.status === "canceled")).toBe(true);
    expect((await signing(token, "/identity")).json().identity).toMatchObject({ attemptsLeft: 3, failureReason: null, status: "pending" });
    expect(await db.one(`SELECT 1 FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.identity_reset'`, [envelope])).toBeTruthy();

    await db.query(`UPDATE envelopes SET status = 'voided' WHERE id = $1`, [envelope]);
    const closed = await app.inject({ method: "POST", url: `/v1/envelopes/${envelope}/recipients/${recipient}/identity/reset`, headers: auth });
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe("not_in_progress");
  });
});

describe("sobre cerrado o vencido", () => {
  it("no se suben fotos ni se envía con el sobre vencido aunque el barrido no lo haya marcado", async () => {
    const { token, envelope } = await setup({ provider: "mock" });
    expect((await signing(token, "/identity/start", "POST")).statusCode).toBe(200);
    expect((await upload(token, "document_front", 1)).statusCode).toBe(200);
    await db.query(`UPDATE envelopes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [envelope]);
    const up = await upload(token, "document_back", 2);
    expect(up.statusCode).toBe(410);
    const sub = await signing(token, "/identity/submit", "POST");
    expect(sub.statusCode).toBe(410);
  });

  it("al anular, rechazar, vencer o completar el sobre se cancelan las verificaciones en curso", async () => {
    for (const status of ["voided", "declined", "expired", "completed"]) {
      const { token, envelope, recipient } = await setup({ provider: "mock" });
      expect((await signing(token, "/identity/start", "POST")).statusCode).toBe(200);
      expect((await recipientRow(recipient)).identity_status).toBe("in_progress");
      await db.query(`UPDATE envelopes SET status = $2 WHERE id = $1`, [envelope, status]);
      expect((await db.one<any>(`SELECT status FROM identity_verifications WHERE recipient_id = $1`, [recipient])).status).toBe("canceled");
      expect((await recipientRow(recipient)).identity_status).toBe("pending");
    }
    // Anulado por la API: la foto que llega después no se guarda.
    const { token, envelope } = await setup({ provider: "mock" });
    await signing(token, "/identity/start", "POST");
    const voided = await app.inject({ method: "POST", url: `/v1/envelopes/${envelope}/void`, headers: auth, payload: { reason: "error" } });
    expect(voided.statusCode).toBe(200);
    const up = await upload(token, "document_front", 3);
    expect([409, 410]).toContain(up.statusCode);
    expect(await db.one(`SELECT 1 FROM identity_captures ic JOIN identity_verifications iv ON iv.id = ic.verification_id WHERE iv.envelope_id = $1`, [envelope])).toBeNull();
  });

  it("un resultado que llega con el sobre vencido (sin marcar) se cancela sin sumar eventos", async () => {
    const { recipient, envelope } = await setup({ provider: "veriff" });
    const v = await pendingVerification(recipient, envelope, "veriff", `vf_late_${recipient}`);
    await db.query(`UPDATE envelopes SET expires_at = now() - interval '1 minute' WHERE id = $1`, [envelope]);
    await veriffHook({ id: `vf_late_${recipient}`, status: "approved", person: { firstName: "Ana", lastName: "Pérez" } });
    expect((await verification(v)).status).toBe("canceled");
    expect(await db.one(`SELECT 1 FROM envelope_events WHERE envelope_id = $1 AND type LIKE 'recipient.identity_%'`, [envelope])).toBeNull();
  });

  it("la retención borra las fotos de identidad que quedaron en un sobre ya purgado", async () => {
    const { purgeExpiredEnvelopes } = await import("../src/modules/retention");
    const { recipient, envelope } = await setup({ provider: "mock" });
    const v = await pendingVerification(recipient, envelope, "mock", null, { status: "canceled" });
    const fileId = util.uuidv7();
    const key = `tenants/${tenant}/envelopes/${envelope}/identity/${fileId}.bin`;
    await blobs.put(key, new Uint8Array([1, 2, 3]), "application/octet-stream");
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'identity',$3,'image/png+aesgcm',3,'x')`, [
      fileId,
      tenant,
      key,
    ]);
    await db.query(`INSERT INTO identity_captures (id, tenant_id, verification_id, kind, file_id, sha256) VALUES ($1,$2,$3,'document_front',$4,'h')`, [util.uuidv7(), tenant, v, fileId]);
    await db.query(`UPDATE envelopes SET status = 'voided', voided_at = now(), purged_at = now() WHERE id = $1`, [envelope]);
    await purgeExpiredEnvelopes({ db, blobs, log: { info() {}, warn() {}, error() {} } } as any, { tenantId: tenant, ignoreAge: true });
    expect((await db.one<any>(`SELECT purged_at FROM files WHERE id = $1`, [fileId])).purged_at).not.toBeNull();
    await expect(blobs.get(key)).rejects.toBeTruthy();
  });
});

describe("envío y fotos: controles", () => {
  it("sin sesión en el proveedor el envío responde 409 verification_not_started; con sesión respeta los 5 s", async () => {
    const a = await setup({ provider: "veriff" });
    await pendingVerification(a.recipient, a.envelope, "veriff", null, { status: "created" });
    const r1 = await signing(a.token, "/identity/submit", "POST");
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe("verification_not_started");

    const b = await setup({ provider: "veriff" });
    const v = await pendingVerification(b.recipient, b.envelope, "veriff", `vf_thr_${b.recipient}`);
    await db.query(`UPDATE identity_verifications SET polled_at = now() WHERE id = $1`, [v]);
    fetchCalls = [];
    expect((await signing(b.token, "/identity/submit", "POST")).statusCode).toBe(200);
    expect(fetchCalls.filter((u) => u.includes(`vf_thr_${b.recipient}`))).toEqual([]);
    await db.query(`UPDATE identity_verifications SET polled_at = now() - interval '10 seconds' WHERE id = $1`, [v]);
    expect((await signing(b.token, "/identity/submit", "POST")).statusCode).toBe(200);
    expect((await signing(b.token, "/identity/submit", "POST")).statusCode).toBe(200);
    expect(fetchCalls.filter((u) => u.includes(`vf_thr_${b.recipient}`)).length).toBe(1);
  });

  it("con el proveedor deshabilitado no se suben fotos ni se envía", async () => {
    const { config } = await import("../src/config");
    const { token } = await setup({ provider: "mock" });
    expect((await signing(token, "/identity/start", "POST")).statusCode).toBe(200);
    const prev = config.environment;
    const prevFlag = process.env.IDV_MOCK_ENABLED;
    delete process.env.IDV_MOCK_ENABLED;
    (config as any).environment = "prod";
    try {
      const up = await upload(token, "document_front", 4);
      expect(up.statusCode).toBe(503);
      expect(up.json().error.code).toBe("identity_provider_unavailable");
      expect((await signing(token, "/identity/submit", "POST")).statusCode).toBe(503);
    } finally {
      (config as any).environment = prev;
      if (prevFlag !== undefined) process.env.IDV_MOCK_ENABLED = prevFlag;
    }
  });
});

describe("corrección del número de documento", () => {
  it("acepta idDocumentNumber y, si cambia, la verificación empieza de nuevo (no si solo cambia el formato)", async () => {
    const { envelope, recipient } = await setup({ provider: "mock", idDoc: "20.123.456" });
    // Un sobre completo (documento y campo de firma): la corrección lo controla.
    const file = util.uuidv7();
    const doc = util.uuidv7();
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original',$3,'application/pdf',1,'x')`, [file, tenant, `k/${file}`]);
    await db.query(`INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,1,'c.pdf',$4,1,$5)`, [
      doc,
      tenant,
      envelope,
      file,
      JSON.stringify([{ width: 612, height: 792 }]),
    ]);
    await db.query(`INSERT INTO fields (id, tenant_id, envelope_id, document_id, recipient_id, type, page, x, y, width, height) VALUES ($1,$2,$3,$4,$5,'signature',1,0.1,0.1,0.2,0.05)`, [
      util.uuidv7(),
      tenant,
      envelope,
      doc,
      recipient,
    ]);
    const v = await pendingVerification(recipient, envelope, "mock", null, { status: "verified" });
    await db.query(`UPDATE recipients SET identity_status = 'verified', identity_verified_at = now() WHERE id = $1`, [recipient]);
    const same = await app.inject({
      method: "POST",
      url: `/v1/envelopes/${envelope}/corrections`,
      headers: auth,
      payload: { updateRecipients: [{ id: recipient, idDocumentNumber: "20123456" }] },
    });
    // Mismo número con otro formato: no es un cambio.
    expect(same.statusCode).toBe(400);
    expect(same.json().error.code).toBe("no_changes");
    expect((await verification(v)).status).toBe("verified");
    const changed = await app.inject({
      method: "POST",
      url: `/v1/envelopes/${envelope}/corrections`,
      headers: auth,
      payload: { updateRecipients: [{ id: recipient, idDocumentNumber: "30999888" }] },
    });
    expect(changed.statusCode).toBe(200);
    expect((await verification(v)).status).toBe("canceled");
    expect(await recipientRow(recipient)).toMatchObject({ identity_status: "pending", id_document_number: "30999888" });
  });
});

describe("confirmación en persona", () => {
  it("compara el número de documento normalizado (mayúsculas y separadores)", async () => {
    const { recipient, envelope, token } = await setup({ provider: "mock", authMethod: "in_person", idDoc: "AB123456" });
    await db.query(`UPDATE recipients SET id_verification_provider = NULL, id_verification_level = NULL, identity_status = NULL WHERE id = $1`, [recipient]);
    const cookie = util.randomToken();
    await db.query(`INSERT INTO signer_sessions (token_hash, recipient_id, method, ip, expires_at) VALUES ($1,$2,'in_person','127.0.0.1', now() + interval '1 hour')`, [
      util.sha256Hex(cookie),
      recipient,
    ]);
    const res = await signing(token, "/in-person/confirm", "POST", { confirmed: true, idDocumentNumber: "ab-123.456" }, { cookie: `cs_signer=${cookie}` });
    expect(res.statusCode).toBe(200);
    const ev = await db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.identity_confirmed'`, [envelope]);
    expect(ev.data.idDocumentMatches).toBe(true);
  });
});

describe("uso del plan", () => {
  it("no cuenta las reservas canceladas que nunca abrieron una sesión en el proveedor", async () => {
    const { usageThisMonth } = await import("../src/modules/billing/plans");
    const before = (await usageThisMonth(db, tenant)).kycChecks;
    const { recipient, envelope } = await setup({ provider: "veriff" });
    await pendingVerification(recipient, envelope, "veriff", null, { status: "canceled" });
    await pendingVerification(recipient, envelope, "veriff", `vf_paid_${recipient}`, { status: "canceled" });
    await pendingVerification(recipient, envelope, "veriff", `vf_paid2_${recipient}`, { status: "failed" });
    expect((await usageThisMonth(db, tenant)).kycChecks - before).toBe(2);
  });

  it("la sesión creada en el proveedor después de cancelarse la reserva guarda provider_ref (cuenta en el uso)", async () => {
    const { usageThisMonth } = await import("../src/modules/billing/plans");
    const { recipient, token } = await setup({ provider: "veriff" });
    const before = (await usageThisMonth(db, tenant)).kycChecks;
    // El proveedor responde después de que la reserva se canceló (p. ej. el sobre se cerró mientras tanto).
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input?.url ?? input) === "https://veriff.test/v1/sessions") {
        await db.query(`UPDATE identity_verifications SET status = 'canceled' WHERE recipient_id = $1 AND status = 'created'`, [recipient]);
      }
      return prevFetch(input, init);
    }) as typeof fetch;
    try {
      await signing(token, "/identity/start", "POST");
    } finally {
      globalThis.fetch = prevFetch;
    }
    const v = await db.one<any>(`SELECT * FROM identity_verifications WHERE recipient_id = $1`, [recipient]);
    expect(v.status).toBe("canceled");
    expect(v.provider_ref).toMatch(/^vf_/);
    expect(v.redirect_url).toBeNull();
    expect((await usageThisMonth(db, tenant)).kycChecks - before).toBe(1);
  });
});

describe("sobres con un nivel que el proveedor no puede hacer (de antes de las reglas por nivel)", () => {
  // Integración de Veriff declarada en document (sin selfie): los niveles con selfie no los puede hacer.
  let prevLevel: string | null;
  beforeAll(async () => {
    const { config } = await import("../src/config");
    prevLevel = config.identity.veriffIntegrationLevel;
    (config.identity as any).veriffIntegrationLevel = "document";
  });
  afterAll(async () => {
    const { config } = await import("../src/config");
    (config.identity as any).veriffIntegrationLevel = prevLevel;
  });
  it("al enviar: problema identity_provider_unavailable con el motivo para el remitente", async () => {
    const { sendEnvelope } = await import("../src/modules/envelopes");
    const { SYSTEM } = await import("../src/infra/evidence");
    const envelope = util.uuidv7();
    const recipient = util.uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Borrador', 'draft')`, [envelope, tenant]);
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, name, email, status, id_verification_provider, id_verification_level, identity_status)
       VALUES ($1,$2,$3,'signer','Ana Pérez','ana@x.test','created','veriff','document_selfie','pending')`,
      [recipient, tenant, envelope],
    );
    const err = await db.tx((t) => sendEnvelope(t, tenant, envelope, SYSTEM)).catch((e) => e);
    expect(err.code).toBe("envelope_incomplete");
    const issue = err.details.issues.find((p: any) => p.code === "identity_provider_unavailable");
    expect(issue).toMatchObject({ params: { name: "Ana Pérez", provider: "veriff", level: "document_selfie" } });
    expect(issue.message).toContain("VERIFF_INTEGRATION_LEVEL");
  });

  it("reinicio: sin cambio, 409 identity_level_not_supported; con un nivel posible, cambia el nivel y se puede iniciar", async () => {
    const x = await setup({ provider: "veriff", level: "document_selfie" });
    const reset = (payload?: unknown) =>
      app.inject({ method: "POST", url: `/v1/envelopes/${x.envelope}/recipients/${x.recipient}/identity/reset`, headers: auth, ...(payload ? { payload: payload as any } : {}) });
    const same = await reset();
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe("identity_level_not_supported");
    expect(same.json().error.message).toContain("VERIFF_INTEGRATION_LEVEL");
    // Un nivel que tampoco puede: 400 con el motivo (mismas reglas que al armar el sobre).
    const worse = await reset({ level: "document_selfie_liveness" });
    expect(worse.statusCode).toBe(400);
    expect(worse.json().error.code).toBe("identity_provider_unavailable");
    expect((await recipientRow(x.recipient)).id_verification_level).toBe("document_selfie");
    // Nivel posible: se cambia, queda en la evidencia y el firmante puede iniciar.
    const ok = await reset({ level: "document" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().unavailableReason).toBeNull();
    expect(await recipientRow(x.recipient)).toMatchObject({ id_verification_provider: "veriff", id_verification_level: "document", identity_status: "pending" });
    const ev = await db.one<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.identity_reset'`, [x.envelope]);
    expect(ev.data).toMatchObject({ previous: { provider: "veriff", level: "document_selfie" }, provider: "veriff", level: "document" });
    expect((await signing(x.token, "/identity/start", "POST")).statusCode).toBe(200);
    // Cambio de proveedor también (al de prueba).
    const mock = await reset({ provider: "mock" });
    expect(mock.statusCode).toBe(200);
    expect((await recipientRow(x.recipient)).id_verification_provider).toBe("mock");
    expect((await db.query<any>(`SELECT status FROM identity_verifications WHERE recipient_id = $1`, [x.recipient])).map((v) => v.status)).toEqual(["canceled"]);
  });
});
