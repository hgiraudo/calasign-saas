// Canales de terceros por organización (migración 0128, SEG-30): SMS, WhatsApp y Telegram se apagan en
// PATCH /v1/settings/organization (settings:manage, con auditoría y por organización). Apagados: 400 channel_disabled
// en cada punto de entrada que elige canal o código de verificación; al enviar, el aviso no sale por ese canal (queda
// omitido y en la evidencia) y cae al correo si era el único; el código por SMS/WhatsApp cae al otro canal al mismo
// teléfono o da 409 otp_channel_disabled (nunca al correo); el link del celular y la vinculación de Telegram no se
// ofrecen. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-org-channels-"));
delete process.env.DATABASE_URL;
// Bot de Telegram de mentira: con esto la página de firma ofrece el link de vinculación y el webhook acepta pedidos.
process.env.TELEGRAM_BOT_USERNAME = "calasign_prueba_bot";
process.env.TELEGRAM_BOT_TOKEN = "123:prueba";
process.env.TELEGRAM_WEBHOOK_SECRET = "secreto-del-webhook-de-prueba";

const sent: { channel: string; to: string }[] = [];
const telegramSent: { to: string; text: string }[] = [];
vi.mock("../src/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("../src/notifications/channels")>()),
  deliver: vi.fn(async (m: { channel: string; to: string }) => {
    sent.push({ channel: m.channel, to: m.to });
    return { provider: m.channel, messageId: `id-${sent.length}` };
  }),
  sendTelegram: vi.fn(async (m: { to: string; text: string }) => {
    telegramSent.push({ to: m.to, text: m.text });
    return { provider: "telegram-bot", messageId: "1" };
  }),
}));

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
let util: typeof import("../src/lib/util");
let handlers: Awaited<ReturnType<(typeof import("../src/modules/jobs"))["createJobHandlers"]>>;
let tenant = "";
let ownerCookie = "";
let otherCookie = "";
let tpl = "";
let roleCliente = "";
let roleVendedor = "";
const KEY = "cs_test_org_channels_key";
const key = { authorization: `Bearer ${KEY}` };
const H = (session: string) => ({ cookie: `cs_session=${session}`, origin: "http://localhost:5173" });
const PHONE = "+5491155550000";

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { createJobHandlers } = await import("../src/modules/jobs");
  util = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
  handlers = createJobHandlers({ db, blobs: createBlobStore(), log: { info() {}, warn() {}, error() {} } });
  const signup = async (email: string, organization: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/auth/signup",
      payload: { email, password: "una-clave-larga-123", name: "Dueña", organization },
    });
    expect(res.statusCode).toBe(201);
    return { cookie: res.cookies.find((x) => x.name === "cs_session")!.value, tenant: res.json().tenant.id as string };
  };
  const a = await signup("duena@canales.test", "Org Canales");
  ownerCookie = a.cookie;
  tenant = a.tenant;
  otherCookie = (await signup("otra@canales.test", "Otra Org")).cookie;
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash) VALUES ($1, $2, 'k', 'cs_test', $3)`, [
    util.uuidv7(),
    tenant,
    util.sha256Hex(KEY),
  ]);
  // Plantilla: un documento y dos roles firmantes (Cliente completa el formulario web; Vendedor es fijo), con firma.
  tpl = util.uuidv7();
  const file = util.uuidv7();
  const doc = util.uuidv7();
  roleCliente = util.uuidv7();
  roleVendedor = util.uuidv7();
  await db.query(`INSERT INTO templates (id, tenant_id, name) VALUES ($1, $2, 'Alta')`, [tpl, tenant]);
  await db.query(
    `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1, $2, 'original', 'x', 'application/pdf', 10, 'abc')`,
    [file, tenant],
  );
  await db.query(
    `INSERT INTO template_documents (id, tenant_id, template_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,0,'doc',$4,1,$5)`,
    [doc, tenant, tpl, file, JSON.stringify([{ width: 595, height: 842 }])],
  );
  for (const [id, name] of [
    [roleCliente, "Cliente"],
    [roleVendedor, "Vendedor"],
  ]) {
    await db.query(`INSERT INTO template_roles (id, tenant_id, template_id, name, role, routing_order) VALUES ($1,$2,$3,$4,'signer',1)`, [
      id,
      tenant,
      tpl,
      name,
    ]);
    await db.query(
      `INSERT INTO template_fields (id, tenant_id, template_id, document_id, role_id, type, page, x, y, width, height, required) VALUES ($1,$2,$3,$4,$5,'signature',1,0.1,0.1,0.2,0.05,true)`,
      [util.uuidv7(), tenant, tpl, doc, id],
    );
  }
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

const setChannels = (channels: Record<string, boolean>) =>
  db.query(`UPDATE tenants SET channel_sms_enabled = $2, channel_whatsapp_enabled = $3, channel_telegram_enabled = $4 WHERE id = $1`, [
    tenant,
    channels.sms ?? true,
    channels.whatsapp ?? true,
    channels.telegram ?? true,
  ]);
const allOn = () => setChannels({});
const expectDisabled = (res: { statusCode: number; body: string; json(): any }, channel: string, via = "channel") => {
  expect(res.statusCode, res.body).toBe(400);
  expect(res.json().error.code).toBe("channel_disabled");
  expect(res.json().error.details).toMatchObject({ channel, via });
};

async function newMember(email: string, role: string) {
  const id = util.uuidv7();
  await db.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,'scrypt$x')`, [id, email, email.split("@")[0]]);
  await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,$3)`, [tenant, id, role]);
  const token = util.randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, tenant_id, expires_at, auth_method) VALUES ($1,$2,$3, now() + interval '14 days', 'password')`,
    [util.sha256Hex(token), id, tenant],
  );
  return token;
}

/** Sobre enviado con un destinatario insertado a mano (canales y método a elección). */
async function sentEnvelope(r: { email?: string | null; phone?: string | null; channels?: string[]; authMethod?: string; consented?: boolean }) {
  const env = util.uuidv7();
  const rec = util.uuidv7();
  const token = util.randomToken();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at) VALUES ($1, $2, 'Contrato', 'sent', now())`, [env, tenant]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, phone, channels, status, sent_at, auth_method,
       access_token_hash, access_token_enc, consented_at)
     VALUES ($1,$2,$3,'signer',1,'Ana',$4,$5,$6,'viewed', now(), $7, $8, $9, $10)`,
    [
      rec,
      tenant,
      env,
      r.email === undefined ? "ana@x.test" : r.email,
      r.phone === undefined ? PHONE : r.phone,
      r.channels ?? ["email"],
      r.authMethod ?? "link",
      util.sha256Hex(token),
      util.encrypt(token),
      r.consented ? new Date() : null,
    ],
  );
  // Un documento y su campo de firma: sin él, una corrección rechaza el sobre (envelope_incomplete).
  const file = util.uuidv7();
  const doc = util.uuidv7();
  await db.query(
    `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1, $2, 'original', 'x', 'application/pdf', 10, 'abc')`,
    [file, tenant],
  );
  await db.query(`INSERT INTO documents (id, tenant_id, envelope_id, position, name, file_id, page_count, pages) VALUES ($1,$2,$3,1,'doc',$4,1,$5)`, [
    doc,
    tenant,
    env,
    file,
    JSON.stringify([{ width: 595, height: 842 }]),
  ]);
  await db.query(
    `INSERT INTO fields (id, tenant_id, envelope_id, document_id, recipient_id, type, page, x, y, width, height) VALUES ($1,$2,$3,$4,$5,'signature',0,0.1,0.1,0.2,0.05)`,
    [util.uuidv7(), tenant, env, doc, rec],
  );
  return { env, rec, token };
}
const events = (env: string, type: string) =>
  db.query<any>(`SELECT data FROM envelope_events WHERE envelope_id = $1 AND type = $2 ORDER BY seq`, [env, type]);

beforeEach(async () => {
  sent.length = 0;
  telegramSent.length = 0;
  await allOn();
});

describe("ajuste por organización", () => {
  it("por defecto los tres encendidos; un miembro sin settings:manage no lo cambia (403); el dueño sí, parcial y auditado", async () => {
    const get = await app.inject({ method: "GET", url: "/v1/settings/organization", headers: H(ownerCookie) });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ timeZone: expect.any(String), channels: { sms: true, whatsapp: true, telegram: true } });

    const member = await newMember("miembro@canales.test", "member");
    // El miembro lo lee (la consola lo usa para no ofrecer los canales apagados) pero no lo cambia.
    expect((await app.inject({ method: "GET", url: "/v1/settings/organization", headers: H(member) })).json().channels.whatsapp).toBe(true);
    const denied = await app.inject({
      method: "PATCH",
      url: "/v1/settings/organization",
      headers: H(member),
      payload: { channels: { whatsapp: false } },
    });
    expect(denied.statusCode).toBe(403);
    expect((await db.one<any>(`SELECT channel_whatsapp_enabled FROM tenants WHERE id = $1`, [tenant])).channel_whatsapp_enabled).toBe(true);

    const tzBefore = get.json().timeZone;
    const ok = await app.inject({
      method: "PATCH",
      url: "/v1/settings/organization",
      headers: H(ownerCookie),
      payload: { channels: { whatsapp: false } },
    });
    expect(ok.statusCode).toBe(200);
    // Parcial: solo cambia WhatsApp; el huso y los otros canales quedan.
    expect(ok.json()).toEqual({ timeZone: tzBefore, channels: { sms: true, whatsapp: false, telegram: true } });
    // Otro PATCH parcial conserva lo guardado (WhatsApp sigue apagado), y cambiar el huso no toca los canales.
    const tg = await app.inject({
      method: "PATCH",
      url: "/v1/settings/organization",
      headers: H(ownerCookie),
      payload: { channels: { telegram: false } },
    });
    expect(tg.json().channels).toEqual({ sms: true, whatsapp: false, telegram: false });
    const tz = await app.inject({ method: "PATCH", url: "/v1/settings/organization", headers: H(ownerCookie), payload: { timeZone: tzBefore } });
    expect(tz.json().channels).toEqual({ sms: true, whatsapp: false, telegram: false });
    await app.inject({ method: "PATCH", url: "/v1/settings/organization", headers: H(ownerCookie), payload: { channels: { telegram: true } } });
    expect((await app.inject({ method: "PATCH", url: "/v1/settings/organization", headers: H(ownerCookie), payload: {} })).statusCode).toBe(400);
    expect(
      (await app.inject({ method: "PATCH", url: "/v1/settings/organization", headers: H(ownerCookie), payload: { channels: { email: false } } }))
        .statusCode,
    ).toBe(400);

    const audit = await db.query<any>(
      `SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'settings.organization_updated' ORDER BY id`,
      [tenant],
    );
    expect(audit[0].data).toEqual({ from: { "channels.whatsapp": true }, to: { "channels.whatsapp": false }, changed: ["channels.whatsapp"] });
    expect(audit[1].data.changed).toEqual(["channels.telegram"]);

    // Otra organización no lo ve ni lo hereda: sigue con todo encendido, y su PATCH no toca esta.
    const other = await app.inject({ method: "GET", url: "/v1/settings/organization", headers: H(otherCookie) });
    expect(other.json().channels).toEqual({ sms: true, whatsapp: true, telegram: true });
    await app.inject({
      method: "PATCH",
      url: "/v1/settings/organization",
      headers: H(otherCookie),
      payload: { channels: { whatsapp: true, sms: false } },
    });
    expect((await app.inject({ method: "GET", url: "/v1/settings/organization", headers: H(ownerCookie) })).json().channels).toEqual({
      sms: true,
      whatsapp: false,
      telegram: true,
    });
  });
});

describe("400 channel_disabled en los puntos de entrada", () => {
  it("POST /v1/envelopes y PUT recipients: canal de aviso o código de verificación apagado", async () => {
    await setChannels({ whatsapp: false, sms: false, telegram: false });
    const wa = await app.inject({
      method: "POST",
      url: "/v1/envelopes",
      headers: key,
      payload: { subject: "S", recipients: [{ name: "Ana", email: "ana@x.test", phone: PHONE, channels: ["email", "whatsapp"] }] },
    });
    expectDisabled(wa, "whatsapp");
    expect(wa.json().error.details.path).toBe("recipients.0");
    expect(wa.json().error.message).toContain("Ana");
    expectDisabled(
      await app.inject({
        method: "POST",
        url: "/v1/envelopes",
        headers: key,
        payload: { subject: "S", recipients: [{ name: "Ana", email: "ana@x.test", channels: ["email", "telegram"] }] },
      }),
      "telegram",
    );
    expectDisabled(
      await app.inject({
        method: "POST",
        url: "/v1/envelopes",
        headers: key,
        payload: { subject: "S", recipients: [{ name: "Ana", email: "ana@x.test", phone: PHONE, authMethod: "otp_sms" }] },
      }),
      "sms",
      "auth_method",
    );
    // Con canales permitidos, el sobre se crea; después el PUT tampoco deja pedir el código por WhatsApp.
    const okEnv = await app.inject({
      method: "POST",
      url: "/v1/envelopes",
      headers: key,
      payload: { subject: "S", recipients: [{ name: "Ana", email: "ana@x.test", authMethod: "otp_email" }] },
    });
    expect(okEnv.statusCode).toBe(201);
    const put = await app.inject({
      method: "PUT",
      url: `/v1/envelopes/${okEnv.json().envelope.id}/recipients`,
      headers: key,
      payload: { recipients: [{ name: "Ana", email: "ana@x.test", phone: PHONE, authMethod: "otp_whatsapp" }] },
    });
    expectDisabled(put, "whatsapp", "auth_method");
    // El 400 deshace todo: el destinatario sigue como estaba.
    expect((await db.one<any>(`SELECT auth_method FROM recipients WHERE envelope_id = $1`, [okEnv.json().envelope.id])).auth_method).toBe(
      "otp_email",
    );
    // Encendido, lo mismo pasa (la regla es de la organización, no del pedido).
    await allOn();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/v1/envelopes/${okEnv.json().envelope.id}/recipients`,
          headers: key,
          payload: { recipients: [{ name: "Ana", email: "ana@x.test", phone: PHONE, authMethod: "otp_whatsapp", channels: ["email", "whatsapp"] }] },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("desde plantilla, formulario web y envío masivo (fila con error), incluido el WhatsApp por defecto de quien solo trae teléfono", async () => {
    await setChannels({ whatsapp: false });
    const fromTpl = await app.inject({
      method: "POST",
      url: "/v1/envelopes/from-template",
      headers: key,
      payload: {
        templateId: tpl,
        recipients: [
          { roleId: roleCliente, name: "Ana", email: "ana@x.test" },
          { roleId: roleVendedor, name: "Beto", email: "beto@x.test", phone: PHONE, channels: ["email", "whatsapp"] },
        ],
      },
    });
    expectDisabled(fromTpl, "whatsapp");
    expect(fromTpl.json().error.details.recipient).toBe("Beto");

    const form = await app.inject({
      method: "POST",
      url: "/v1/web-forms",
      headers: key,
      payload: {
        templateId: tpl,
        name: "Alta",
        signerRoleId: roleCliente,
        fixedRecipients: [{ roleId: roleVendedor, name: "Beto", phone: PHONE, channels: ["whatsapp"] }],
      },
    });
    expectDisabled(form, "whatsapp");
    expect(form.json().error.details.path).toBe("fixedRecipients.0");

    // Envío masivo: el CSV con solo teléfono queda con WhatsApp por defecto; esa fila tiene error, la otra no.
    const bulk = await app.inject({
      method: "POST",
      url: "/v1/bulk-sends/validate",
      headers: key,
      payload: {
        templateId: tpl,
        rows: [
          {
            recipients: [
              { role: "Cliente", name: "Ana", email: "ana@x.test" },
              { role: "Vendedor", name: "Beto", email: "beto@x.test" },
            ],
          },
          {
            recipients: [
              { role: "Cliente", name: "Ana", email: "ana@x.test" },
              { role: "Vendedor", name: "Beto", phone: PHONE },
            ],
          },
        ],
      },
    });
    expect(bulk.statusCode).toBe(200);
    expect(bulk.json()).toMatchObject({ total: 2, valid: 1, invalid: 1 });
    expect(bulk.json().errors[0]).toMatchObject({ row: 2 });
    expect(bulk.json().errors[0].errors[0]).toMatch(/Beto: la organización apagó WhatsApp/);
  });

  it("correcciones, reasignación y clonado de un sobre que ya tenía el canal", async () => {
    // Con WhatsApp encendido se crea y envía un sobre con un destinatario por WhatsApp; después se apaga.
    const s = await sentEnvelope({ channels: ["email", "whatsapp"] });
    await setChannels({ whatsapp: false });
    const add = await app.inject({
      method: "POST",
      url: `/v1/envelopes/${s.env}/corrections`,
      headers: key,
      payload: { addRecipients: [{ role: "cc", name: "Carla", phone: PHONE, channels: ["whatsapp"] }] },
    });
    expectDisabled(add, "whatsapp");
    expect(add.json().error.details.path).toBe("addRecipients.0");
    // Corregir el nombre no falla por el WhatsApp que ya tenía (al enviar se saltea); sumarlo de nuevo, sí.
    const rename = await app.inject({
      method: "POST",
      url: `/v1/envelopes/${s.env}/corrections`,
      headers: key,
      payload: { updateRecipients: [{ id: s.rec, name: "Ana María" }] },
    });
    expect(rename.statusCode, rename.body).toBe(200);
    const s2 = await sentEnvelope({ channels: ["email"] });
    expectDisabled(
      await app.inject({
        method: "POST",
        url: `/v1/envelopes/${s2.env}/corrections`,
        headers: key,
        payload: { updateRecipients: [{ id: s2.rec, channels: ["email", "whatsapp"] }] },
      }),
      "whatsapp",
    );
    expectDisabled(
      await app.inject({
        method: "POST",
        url: `/v1/envelopes/${s2.env}/recipients/${s2.rec}/reassign`,
        headers: key,
        payload: { name: "Dora", phone: PHONE, channels: ["whatsapp"] },
      }),
      "whatsapp",
    );
    // Sin canales y solo con teléfono: antes caía a WhatsApp; ahora pide el correo.
    const noMail = await app.inject({
      method: "POST",
      url: `/v1/envelopes/${s2.env}/recipients/${s2.rec}/reassign`,
      headers: key,
      payload: { name: "Dora", phone: PHONE },
    });
    expect(noMail.statusCode).toBe(409);
    expect(noMail.json().error.code).toBe("invalid_channels");
    expectDisabled(await app.inject({ method: "POST", url: `/v1/envelopes/${s.env}/clone`, headers: key, payload: {} }), "whatsapp");
  });
});

describe("al enviar, con el canal apagado después", () => {
  it("el aviso no sale por WhatsApp (queda omitido y en la evidencia) y el correo sigue saliendo", async () => {
    const s = await sentEnvelope({ channels: ["email", "whatsapp"] });
    await setChannels({ whatsapp: false });
    await handlers.notify({ kind: "invite", envelopeId: s.env, recipientId: s.rec, tenantId: tenant }, { id: 9001, attempts: 1, maxAttempts: 8 });
    expect(sent.map((x) => x.channel)).toEqual(["email"]);
    const rows = await db.query<any>(`SELECT channel, status, error FROM notifications WHERE recipient_id = $1 ORDER BY channel`, [s.rec]);
    expect(rows).toEqual([
      expect.objectContaining({ channel: "email", status: "sent" }),
      expect.objectContaining({ channel: "whatsapp", status: "suppressed", error: expect.stringContaining("apagado por la organización") }),
    ]);
    expect((await events(s.env, "notification.suppressed"))[0].data).toMatchObject({ channel: "whatsapp", reason: "channel_disabled" });
    // El reintento del job no lo vuelve a intentar.
    await handlers.notify({ kind: "invite", envelopeId: s.env, recipientId: s.rec, tenantId: tenant }, { id: 9001, attempts: 2, maxAttempts: 8 });
    expect(sent.map((x) => x.channel)).toEqual(["email"]);
  });

  it("si WhatsApp era su único canal, el aviso sale por correo (si tiene); sin correo no sale nada", async () => {
    const s = await sentEnvelope({ channels: ["whatsapp"] });
    await setChannels({ whatsapp: false });
    await handlers.notify({ kind: "invite", envelopeId: s.env, recipientId: s.rec, tenantId: tenant }, { id: 9002, attempts: 1, maxAttempts: 8 });
    expect(sent).toEqual([{ channel: "email", to: "ana@x.test" }]);
    const s2 = await sentEnvelope({ channels: ["whatsapp"], email: null });
    await handlers.notify({ kind: "invite", envelopeId: s2.env, recipientId: s2.rec, tenantId: tenant }, { id: 9003, attempts: 1, maxAttempts: 8 });
    expect(sent).toHaveLength(1);
  });

  it("código por SMS apagado: sale por WhatsApp al mismo teléfono; con los dos apagados, 409 otp_channel_disabled (nunca al correo)", async () => {
    await setChannels({ sms: false });
    const s = await sentEnvelope({ authMethod: "otp_sms" });
    const r = await app.inject({ method: "POST", url: `/v1/signing/${s.token}/otp/send` });
    expect(r.statusCode, r.body).toBe(200);
    expect(sent).toEqual([{ channel: "whatsapp", to: PHONE }]);
    expect((await events(s.env, "recipient.otp_sent"))[0].data).toMatchObject({ method: "otp_sms", channel: "whatsapp", fallbackFrom: "sms" });

    await setChannels({ sms: false, whatsapp: false });
    const s2 = await sentEnvelope({ authMethod: "otp_whatsapp" });
    const r2 = await app.inject({ method: "POST", url: `/v1/signing/${s2.token}/otp/send` });
    expect(r2.statusCode).toBe(409);
    expect(r2.json().error).toMatchObject({ code: "otp_channel_disabled", details: { channel: "whatsapp" } });
    expect(sent).toHaveLength(1);
    expect(await db.query(`SELECT 1 FROM otp_challenges WHERE recipient_id = $1`, [s2.rec])).toHaveLength(0);
  });

  it("el link del celular no se ofrece ni se manda por un canal apagado", async () => {
    await setChannels({ sms: false });
    const s = await sentEnvelope({ consented: true });
    const h = await app.inject({ method: "POST", url: `/v1/signing/${s.token}/signature-handoffs`, payload: { purpose: "signature" } });
    expect(h.statusCode, h.body).toBe(201);
    expect(h.json().channels).not.toContain("sms");
    expect(h.json().channels).toContain("whatsapp");
    const send = await app.inject({
      method: "POST",
      url: `/v1/signing/${s.token}/signature-handoffs/${h.json().id}/send`,
      payload: { channel: "sms", phone: PHONE },
    });
    expect(send.statusCode).toBe(409);
    expect(send.json().error).toMatchObject({ code: "handoff_channel_unavailable", details: { reason: "channel_disabled" } });
    expect(sent).toHaveLength(0);
  });

  it("Telegram apagado: la página de firma no ofrece vincularlo y el bot no vincula el chat", async () => {
    const s = await sentEnvelope({ channels: ["email", "telegram"] });
    const on = await app.inject({ method: "GET", url: `/v1/signing/${s.token}` });
    expect(on.json().recipient.telegramLink).toMatch(/^https:\/\/t\.me\/calasign_prueba_bot\?start=/);
    const linkToken = on.json().recipient.telegramLink.split("start=")[1];
    await setChannels({ telegram: false });
    expect((await app.inject({ method: "GET", url: `/v1/signing/${s.token}` })).json().recipient.telegramLink).toBeNull();
    const hook = await app.inject({
      method: "POST",
      url: "/v1/integrations/telegram/webhook",
      headers: { "x-telegram-bot-api-secret-token": "secreto-del-webhook-de-prueba" },
      payload: { message: { text: `/start ${linkToken}`, chat: { id: 777 } } },
    });
    expect(hook.statusCode).toBe(200);
    expect((await db.one<any>(`SELECT telegram_chat_id FROM recipients WHERE id = $1`, [s.rec])).telegram_chat_id).toBeNull();
    expect(telegramSent).toHaveLength(1);
    expect(telegramSent[0]!.text).toMatch(/no envía avisos por Telegram/);
    expect(await events(s.env, "recipient.telegram_linked")).toHaveLength(0);
  });
});
