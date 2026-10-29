// Avisos a firmantes (jobs.ts notify): reintento solo de los canales que no salieron, supresión de direcciones, errores
// sin datos personales, avisos que no corresponden (embebidos, vencidos) y la copia final a autorregistrados sin correo
// validado (solo correo, con una nota).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-notify-channels-"));
delete process.env.DATABASE_URL;

const sent: { channel: string; to: string; text: string }[] = [];
let failWhatsapp = true;
/** Error de WhatsApp: 503 (del momento, se reintenta) o 400 (número inválido, permanente). */
let waStatus = 503;
vi.mock("../src/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("../src/notifications/channels")>()),
  deliver: vi.fn(async (m: { channel: string; to: string; text: string }) => {
    if (m.channel === "whatsapp" && failWhatsapp) throw new Error(`WhatsApp API ${waStatus}: invalid recipient ${m.to}`);
    sent.push({ channel: m.channel, to: m.to, text: m.text });
    return { provider: m.channel, messageId: `id-${sent.length}` };
  }),
}));

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
let db: Db;
let tenant: string;
let handlers: Awaited<ReturnType<(typeof import("../src/modules/jobs"))["createJobHandlers"]>>;

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createJobHandlers } = await import("../src/modules/jobs");
  const { createBlobStore } = await import("../src/infra/storage");
  const { uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [tenant, `t-${tenant.slice(-8)}`]);
  const log = { info() {}, warn() {}, error() {} };
  handlers = createJobHandlers({ db, blobs: createBlobStore(), log });
}, 120_000);

afterAll(async () => {
  await db?.close();
});

async function envelope(opts: { status?: string; expiresAt?: string | null } = {}) {
  const { uuidv7 } = await import("../src/lib/util");
  const id = uuidv7();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, expires_at) VALUES ($1, $2, 'Contrato', $3, now(), $4)`, [
    id,
    tenant,
    opts.status ?? "sent",
    opts.expiresAt ?? null,
  ]);
  return id;
}

async function recipient(
  env: string,
  r: { email?: string; phone?: string; channels?: string[]; embedded?: boolean; selfRegistered?: boolean; status?: string },
) {
  const { uuidv7, encrypt, sha256Hex, randomToken } = await import("../src/lib/util");
  const id = uuidv7();
  const token = randomToken();
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, phone, channels, status, sent_at, embedded, self_registered, access_token_hash, access_token_enc)
     VALUES ($1,$2,$3,'signer',1,'Ana',$4,$5,$6,$7, now(), $8, $9, $10, $11)`,
    [
      id,
      tenant,
      env,
      r.email ?? null,
      r.phone ?? null,
      r.channels ?? ["email"],
      r.status ?? "sent",
      r.embedded ?? false,
      r.selfRegistered ?? false,
      sha256Hex(token),
      encrypt(token),
    ],
  );
  return id;
}

const job = (id: number, attempts = 1) => ({ id, attempts, maxAttempts: 8 });

describe("avisos a firmantes por varios canales", () => {
  it("si un canal falla se reintenta solo ese, sin repetir el que salió; el error no lleva el destino", async () => {
    sent.length = 0;
    failWhatsapp = true;
    waStatus = 503;
    const env = await envelope();
    const rec = await recipient(env, { email: "ana@x.com", phone: "+5491155550000", channels: ["email", "whatsapp"] });
    const p = { kind: "invite", envelopeId: env, recipientId: rec, tenantId: tenant };

    const err = await handlers.notify(p, job(101)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("whatsapp");
    expect(err!.message).not.toContain("5491155550000");
    expect(sent.map((x) => x.channel)).toEqual(["email"]);
    const failed = await db.one<any>(`SELECT error FROM notifications WHERE recipient_id = $1 AND status = 'failed'`, [rec]);
    expect(failed.error).not.toContain("5491155550000");

    // Reintento del mismo job: solo WhatsApp.
    failWhatsapp = false;
    await handlers.notify(p, job(101, 2));
    expect(sent.map((x) => x.channel)).toEqual(["email", "whatsapp"]);
    const rows = await db.query<any>(`SELECT channel, status, job_id FROM notifications WHERE recipient_id = $1 ORDER BY created_at, channel`, [rec]);
    expect(
      rows
        .filter((r) => r.status === "sent")
        .map((r) => r.channel)
        .sort(),
    ).toEqual(["email", "whatsapp"]);
    expect(rows.every((r) => Number(r.job_id) === 101)).toBe(true);

    // Un tercer intento (p. ej. el proceso murió antes de marcar el job): nada se repite.
    await handlers.notify(p, job(101, 3));
    expect(sent).toHaveLength(2);
  }, 60_000);

  it("un error permanente (4xx del proveedor) no reintenta el job: queda registrado como fallido", async () => {
    sent.length = 0;
    failWhatsapp = true;
    waStatus = 400;
    const env = await envelope();
    const rec = await recipient(env, { email: "perm@x.com", phone: "+5491155551111", channels: ["email", "whatsapp"] });
    // Un canal entregado y otro con error permanente: termina sin throw.
    await handlers.notify({ kind: "invite", envelopeId: env, recipientId: rec, tenantId: tenant }, job(151));
    expect(sent.map((x) => x.channel)).toEqual(["email"]);
    const rows = await db.query<any>(`SELECT channel, status FROM notifications WHERE recipient_id = $1 ORDER BY channel`, [rec]);
    expect(rows).toEqual([
      { channel: "email", status: "sent" },
      { channel: "whatsapp", status: "failed" },
    ]);
    // Solo WhatsApp y permanente: tampoco.
    const rec2 = await recipient(env, { phone: "+5491155552222", channels: ["whatsapp"] });
    await handlers.notify({ kind: "invite", envelopeId: env, recipientId: rec2, tenantId: tenant }, job(152));
    // Uno transitorio (429) sí se reintenta.
    waStatus = 429;
    const rec3 = await recipient(env, { phone: "+5491155553333", channels: ["whatsapp"] });
    await expect(handlers.notify({ kind: "invite", envelopeId: env, recipientId: rec3, tenantId: tenant }, job(153))).rejects.toThrow(/whatsapp/);
    failWhatsapp = false;
  }, 60_000);

  it("clasificación de errores de envío", async () => {
    const { isTransientSendError } = await import("../src/notifications/outbound");
    expect(isTransientSendError(new Error("WhatsApp API 503: x"))).toBe(true);
    expect(isTransientSendError(new Error("Twilio 429: too many"))).toBe(true);
    expect(isTransientSendError(new Error('WhatsApp API 400: {"message":"rate","code":130429}'))).toBe(true);
    expect(isTransientSendError(new Error('WhatsApp API 400: {"message":"template","code":132001}'))).toBe(false);
    expect(isTransientSendError(new Error("Telegram API 403: bot was blocked"))).toBe(false);
    expect(isTransientSendError(Object.assign(new Error("Message failed"), { responseCode: 550 }))).toBe(false);
    expect(isTransientSendError(Object.assign(new Error("Try later"), { responseCode: 451 }))).toBe(true);
    expect(isTransientSendError(Object.assign(new Error("conn"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientSendError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }))).toBe(
      true,
    );
    // Configuración de la plataforma (canal sin configurar, credenciales SMTP rechazadas): se reintenta.
    expect(isTransientSendError(new Error("WhatsApp no configurado"))).toBe(true);
    expect(
      isTransientSendError(Object.assign(new Error("Invalid login: 535 Authentication Credentials Invalid"), { code: "EAUTH", responseCode: 535 })),
    ).toBe(true);
    expect(isTransientSendError(new Error("535 Authentication Credentials Invalid"))).toBe(true);
    expect(isTransientSendError(new Error("550 mailbox unavailable"))).toBe(false);
    expect(isTransientSendError(new Error("algo raro"))).toBe(true);
  });

  it("una dirección suprimida no recibe correo y queda registrada como 'suppressed'", async () => {
    sent.length = 0;
    await db.query(`INSERT INTO email_suppressions (address, reason) VALUES ('rebota@x.com', 'bounce')`);
    const env = await envelope();
    const rec = await recipient(env, { email: "Rebota@X.com" });
    await handlers.notify({ kind: "invite", envelopeId: env, recipientId: rec, tenantId: tenant }, job(201));
    expect(sent).toHaveLength(0);
    const row = await db.one<any>(`SELECT status FROM notifications WHERE recipient_id = $1`, [rec]);
    expect(row.status).toBe("suppressed");
    const ev = await db.query<any>(`SELECT type FROM envelope_events WHERE envelope_id = $1`, [env]);
    expect(ev.map((e) => e.type)).toEqual(["notification.suppressed"]);
  }, 60_000);

  it("embebidos no reciben anulación ni rechazo; un sobre vencido no manda recordatorios", async () => {
    sent.length = 0;
    const env = await envelope({ status: "voided" });
    const emb = await recipient(env, { email: "emb@x.com", embedded: true });
    await handlers.notify({ kind: "voided", envelopeId: env, recipientId: emb, tenantId: tenant }, job(301));
    await handlers.notify({ kind: "declined", envelopeId: env, recipientId: emb, tenantId: tenant }, job(302));
    expect(sent).toHaveLength(0);

    const past = await envelope({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const r = await recipient(past, { email: "tarde@x.com" });
    await handlers.notify({ kind: "reminder", envelopeId: past, recipientId: r, tenantId: tenant }, job(303));
    await handlers.notify({ kind: "expiry_warning", envelopeId: past, recipientId: r, tenantId: tenant }, job(304));
    expect(sent).toHaveLength(0);
  }, 60_000);

  it("autorregistrado sin correo validado: el completado llega solo por correo, sin link ni token y con una nota; nada más", async () => {
    sent.length = 0;
    const env = await envelope({ status: "completed" });
    const rec = await recipient(env, {
      email: "form@x.com",
      phone: "+5491100000000",
      channels: ["email", "whatsapp"],
      selfRegistered: true,
      status: "signed",
    });
    await handlers.notify({ kind: "completed", envelopeId: env, recipientId: rec, tenantId: tenant }, job(401));
    expect(sent.map((x) => x.channel)).toEqual(["email"]);
    expect(sent[0]!.text).not.toContain("/s/");
    const tok = await db.one<any>(`SELECT access_token_enc FROM recipients WHERE id = $1`, [rec]);
    const { decrypt } = await import("../src/lib/util");
    expect(sent[0]!.text).not.toContain(decrypt(tok.access_token_enc));
    expect(sent[0]!.text).toContain("descargalo desde la página donde firmaste");
    expect(sent[0]!.text).toContain("Si no fuiste vos");
    await handlers.notify({ kind: "voided", envelopeId: env, recipientId: rec, tenantId: tenant }, job(402));
    expect(sent).toHaveLength(1);
  }, 60_000);
});
