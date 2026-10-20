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
vi.mock("../src/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("../src/notifications/channels")>()),
  deliver: vi.fn(async (m: { channel: string; to: string; text: string }) => {
    if (m.channel === "whatsapp" && failWhatsapp) throw new Error(`WhatsApp API 400: invalid recipient ${m.to}`);
    sent.push({ channel: m.channel, to: m.to, text: m.text });
    return { provider: m.channel, messageId: `id-${sent.length}` };
  }),
}));

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
let db: Db;
let tenant: string;
let handlers: Awaited<ReturnType<typeof import("../src/modules/jobs")["createJobHandlers"]>>;

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

async function recipient(env: string, r: { email?: string; phone?: string; channels?: string[]; embedded?: boolean; selfRegistered?: boolean; status?: string }) {
  const { uuidv7, encrypt, sha256Hex, randomToken } = await import("../src/lib/util");
  const id = uuidv7();
  const token = randomToken();
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, phone, channels, status, sent_at, embedded, self_registered, access_token_hash, access_token_enc)
     VALUES ($1,$2,$3,'signer',1,'Ana',$4,$5,$6,$7, now(), $8, $9, $10, $11)`,
    [id, tenant, env, r.email ?? null, r.phone ?? null, r.channels ?? ["email"], r.status ?? "sent", r.embedded ?? false, r.selfRegistered ?? false, sha256Hex(token), encrypt(token)],
  );
  return id;
}

const job = (id: number, attempts = 1) => ({ id, attempts, maxAttempts: 8 });

describe("avisos a firmantes por varios canales", () => {
  it("si un canal falla se reintenta solo ese, sin repetir el que salió; el error no lleva el destino", async () => {
    sent.length = 0;
    failWhatsapp = true;
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
    expect(rows.filter((r) => r.status === "sent").map((r) => r.channel).sort()).toEqual(["email", "whatsapp"]);
    expect(rows.every((r) => Number(r.job_id) === 101)).toBe(true);

    // Un tercer intento (p. ej. el proceso murió antes de marcar el job): nada se repite.
    await handlers.notify(p, job(101, 3));
    expect(sent).toHaveLength(2);
  }, 60_000);

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

  it("autorregistrado sin correo validado: la copia final llega solo por correo, con el link y una nota; nada más", async () => {
    sent.length = 0;
    const env = await envelope({ status: "completed" });
    const rec = await recipient(env, { email: "form@x.com", phone: "+5491100000000", channels: ["email", "whatsapp"], selfRegistered: true, status: "signed" });
    await handlers.notify({ kind: "completed", envelopeId: env, recipientId: rec, tenantId: tenant }, job(401));
    expect(sent.map((x) => x.channel)).toEqual(["email"]);
    expect(sent[0]!.text).toContain("/s/");
    expect(sent[0]!.text).toContain("Si no fuiste vos");
    await handlers.notify({ kind: "voided", envelopeId: env, recipientId: rec, tenantId: tenant }, job(402));
    expect(sent).toHaveLength(1);
  }, 60_000);
});
