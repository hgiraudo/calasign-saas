// Avisos salientes: plantilla del código sin {{code}}, remitente alfanumérico de SMS solo autorizado, vinculación de
// Telegram con token propio de un solo uso, topes de recordatorios (manual por día y automáticos sin vencimiento) y
// aviso de vencimiento de acuerdos por la cola (marcado como avisado recién después de enviarse).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-notify-extras-"));
delete process.env.DATABASE_URL;
process.env.TELEGRAM_BOT_TOKEN = "123:test";
process.env.TELEGRAM_BOT_USERNAME = "calasign_test_bot";
process.env.TELEGRAM_WEBHOOK_SECRET = "s3cret";

const mails: { to: string; subject: string; text: string; from?: string | null }[] = [];
let failMail: string | null = null;
/** Código SMTP del fallo simulado: 4xx transitorio (se reintenta), 5xx permanente. */
let failCode = "550";
vi.mock("../src/notifications/channels", async (orig) => ({
  ...(await orig<typeof import("../src/notifications/channels")>()),
  deliver: vi.fn(async (m: { to: string; subject: string; text: string; from?: string | null }) => {
    if (failMail && m.to === failMail) throw new Error(`${failCode} rejected ${m.to}`);
    mails.push(m);
    return { provider: "smtp", messageId: `id-${mails.length}` };
  }),
  sendTelegram: vi.fn(async () => ({ provider: "telegram-bot", messageId: "1" })),
}));

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let tenant: string;
const KEY = "cs_test_notify_extras_key";
const auth = { authorization: `Bearer ${KEY}` };

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
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function envelopeWithSigner(opts: { expiresAt?: string | null; reminderDays?: number | null; sentAt?: string } = {}) {
  const { uuidv7, encrypt, sha256Hex, randomToken } = await import("../src/lib/util");
  const env = uuidv7();
  const rec = uuidv7();
  const token = randomToken();
  const sentAt = opts.sentAt ?? new Date().toISOString();
  await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status, sent_at, expires_at, reminder_every_days) VALUES ($1,$2,'Contrato','sent',$3,$4,$5)`, [
    env,
    tenant,
    sentAt,
    opts.expiresAt ?? null,
    opts.reminderDays ?? null,
  ]);
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, channels, status, sent_at, access_token_hash, access_token_enc)
     VALUES ($1,$2,$3,'signer',1,'Ana','ana@x.com',$4,'sent',$5,$6,$7)`,
    [rec, tenant, env, ["email", "telegram"], sentAt, sha256Hex(token), encrypt(token)],
  );
  return { env, rec, token };
}

describe("plantilla del código de verificación", () => {
  it("rechaza guardar una plantilla sin {{code}} y, en el envío, agrega el código a una vieja", async () => {
    const { validateConfig } = await import("../src/modules/white-label/routes");
    const { OTP_MESSAGES } = await import("../src/modules/white-label/otp-text");
    const { resolveBrand } = await import("../src/modules/white-label/brand");
    await expect(validateConfig(db, tenant, { templates: { otp_code: { es: { body: "Hola, firmá ya" } } } })).rejects.toMatchObject({ code: "otp_template_missing_code" });
    await expect(validateConfig(db, tenant, { templates: { otp_code: { es: { body: "Tu código: {{ code }}" } } } })).resolves.toBeUndefined();

    const b = await resolveBrand(db, tenant, null, { override: { templates: { otp_code: { es: { body: "Hola, firmá ya" } } } } });
    const m = OTP_MESSAGES(b, "es", "123456", "Contrato");
    expect(m.text).toContain("123456");
    const ok = await resolveBrand(db, tenant, null, { override: { templates: { otp_code: { es: { body: "Código {{code}}" } } } } });
    expect(OTP_MESSAGES(ok, "es", "654321", "Contrato").text).toBe("Código 654321");
  });
});

describe("remitente alfanumérico de SMS", () => {
  it("solo para organizaciones en SMS_ALPHANUMERIC_ALLOWED_TENANTS", async () => {
    const { resolveBrand } = await import("../src/modules/white-label/brand");
    const { config } = await import("../src/config");
    const override = { sms: { senderId: "ACME" } };
    expect((await resolveBrand(db, tenant, null, { override })).smsSenderId).toBeNull();
    config.sms.alphanumericAllowedTenants.push(tenant);
    try {
      expect((await resolveBrand(db, tenant, null, { override })).smsSenderId).toBe("ACME");
    } finally {
      config.sms.alphanumericAllowedTenants.length = 0;
    }
  });
});

describe("vinculación de Telegram", () => {
  it("el link t.me lleva un token propio (no el de firma), de un solo uso y que vence", async () => {
    const { env, rec, token } = await envelopeWithSigner();
    const session = (await app.inject({ method: "GET", url: `/v1/signing/${token}` })).json();
    const link: string = session.recipient.telegramLink;
    expect(link).toMatch(/^https:\/\/t\.me\/calasign_test_bot\?start=/);
    expect(link).not.toContain(token);
    const linkToken = link.split("start=")[1]!;
    // Otra carga de la página: el mismo link (no se crea un token por cada GET).
    const again = (await app.inject({ method: "GET", url: `/v1/signing/${token}` })).json();
    expect(again.recipient.telegramLink).toBe(link);
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM telegram_link_tokens WHERE recipient_id = $1`, [rec])).n).toBe(1);

    const hook = (t: string, chat: number) =>
      app.inject({
        method: "POST",
        url: "/v1/integrations/telegram/webhook",
        headers: { "x-telegram-bot-api-secret-token": "s3cret" },
        payload: { message: { text: `/start ${t}`, chat: { id: chat } } },
      });
    // El token de firma ya no vincula.
    await hook(token, 111);
    expect((await db.one<any>(`SELECT telegram_chat_id FROM recipients WHERE id = $1`, [rec])).telegram_chat_id).toBeNull();
    await hook(linkToken, 222);
    expect((await db.one<any>(`SELECT telegram_chat_id FROM recipients WHERE id = $1`, [rec])).telegram_chat_id).toBe("222");
    // Un solo uso.
    await db.query(`UPDATE recipients SET telegram_chat_id = NULL WHERE id = $1`, [rec]);
    await hook(linkToken, 333);
    expect((await db.one<any>(`SELECT telegram_chat_id FROM recipients WHERE id = $1`, [rec])).telegram_chat_id).toBeNull();
    // Vencido.
    const session2 = (await app.inject({ method: "GET", url: `/v1/signing/${token}` })).json();
    const t2 = String(session2.recipient.telegramLink).split("start=")[1]!;
    await db.query(`UPDATE telegram_link_tokens SET expires_at = now() - interval '1 minute' WHERE recipient_id = $1 AND used_at IS NULL`, [rec]);
    await hook(t2, 444);
    expect((await db.one<any>(`SELECT telegram_chat_id FROM recipients WHERE id = $1`, [rec])).telegram_chat_id).toBeNull();
    const stored = await db.query<any>(`SELECT token_hash FROM telegram_link_tokens WHERE recipient_id = $1`, [rec]);
    expect(stored.every((r) => r.token_hash !== linkToken && r.token_hash.length === 64)).toBe(true);
    expect(env).toBeTruthy();
  });
});

describe("supresiones de correo de la organización", () => {
  it("lista y quita las quejas propias; no las de otra organización ni los rebotes globales", async () => {
    const { uuidv7 } = await import("../src/lib/util");
    const other = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Otra')`, [other, `t-${other.slice(-8)}`]);
    await db.query(
      `INSERT INTO email_suppressions (address, reason, tenant_id) VALUES ('queja@x.com','complaint',$1), ('ajena@x.com','complaint',$2)`,
      [tenant, other],
    );
    await db.query(`INSERT INTO email_suppressions (address, reason, expires_at) VALUES ('rebota2@x.com','bounce', now() + interval '1 day')`);
    const list = await app.inject({ method: "GET", url: "/v1/settings/email-suppressions", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((i: any) => i.address)).toEqual(["queja@x.com"]);
    expect((await app.inject({ method: "DELETE", url: "/v1/settings/email-suppressions/ajena%40x.com", headers: auth })).statusCode).toBe(404);
    // Un rebote global no se revela: 404 como cualquier dirección sin queja propia.
    expect((await app.inject({ method: "DELETE", url: "/v1/settings/email-suppressions/rebota2%40x.com", headers: auth })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/v1/settings/email-suppressions/Queja%40X.com", headers: auth })).statusCode).toBe(204);
    expect(await db.one(`SELECT 1 FROM email_suppressions WHERE address = 'queja@x.com'`)).toBeFalsy();
    expect(await db.one(`SELECT 1 FROM email_suppressions WHERE address = 'ajena@x.com'`)).toBeTruthy();
    const audit = await db.one<any>(`SELECT data FROM account_audit_log WHERE tenant_id = $1 AND action = 'email_suppression.removed'`, [tenant]);
    expect(audit.data.address).toBe("queja@x.com");
  });
});

describe("envío registrado", () => {
  it("si no se puede marcar 'failed' tras un error de envío, la fila 'queued' se borra y el reintento vuelve a enviar", async () => {
    const { sendTracked } = await import("../src/notifications/outbound");
    // Base que falla al actualizar el estado del aviso (p. ej. la conexión se cayó justo ahí).
    const flaky = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== "query") return typeof v === "function" ? v.bind(target) : v;
        return (sql: string, params?: unknown[]) =>
          /^\s*UPDATE notifications SET status/.test(sql) ? Promise.reject(new Error("conexión perdida")) : (v as any).call(target, sql, params);
      },
    }) as typeof db;
    failMail = "falla@x.com";
    const msg = { channel: "email" as const, to: "falla@x.com", subject: "s", text: "t" };
    const out = await sendTracked(flaky, { tenantId: tenant, template: "invite", jobId: 987_654 }, msg);
    expect(out).toMatchObject({ status: "failed" });
    expect(await db.one(`SELECT 1 FROM notifications WHERE job_id = 987654`)).toBeFalsy();
    failMail = null;
    const again = await sendTracked(db, { tenantId: tenant, template: "invite", jobId: 987_654 }, msg);
    expect(again.status).toBe("sent");
  });
});

describe("recordatorios", () => {
  it("manuales: además de uno cada 10 minutos, un tope por día", async () => {
    const { config } = await import("../src/config");
    const { env } = await envelopeWithSigner();
    const { appendEvent } = await import("../src/infra/evidence");
    for (let i = 0; i < config.reminders.manualMaxPerDay; i++) {
      await db.tx((t) => appendEvent(t, { tenantId: tenant, envelopeId: env, type: "envelope.reminded", actor: { type: "api_key", id: "k", label: "k" }, data: { recipients: 1 } }));
    }
    // Fuera de la ventana de 10 minutos, dentro de las 24 h.
    // La evidencia es append-only en la base (0072): editarla en una prueba requiere el permiso explícito de mantenimiento.
    await db.tx(async (t) => {
      await t.query(`SELECT set_config('calasign.allow_evidence_write', 'on', true)`);
      await t.query(`UPDATE envelope_events SET occurred_at = now() - interval '2 hours' WHERE envelope_id = $1`, [env]);
    });
    const res = await app.inject({ method: "POST", url: `/v1/envelopes/${env}/remind`, headers: auth });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("reminder_daily_limit");
  });

  it("automáticos sin vencimiento: tope por destinatario", async () => {
    const { runAutomaticReminders } = await import("../src/modules/reminders");
    const { config } = await import("../src/config");
    const start = new Date("2026-01-01T12:00:00Z");
    const { env, rec } = await envelopeWithSigner({ reminderDays: 1, sentAt: start.toISOString() });
    let total = 0;
    for (let day = 1; day <= config.reminders.automaticMaxWithoutExpiry + 3; day++) {
      await runAutomaticReminders(db, new Date(start.getTime() + day * 86400_000 + 1000));
      total = (await db.one<any>(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE $1`, [`auto-reminder:${rec}:%`])).n;
    }
    expect(total).toBe(config.reminders.automaticMaxWithoutExpiry);
    expect(env).toBeTruthy();
  }, 60_000);

  it("con vencimiento no se cuenta para el tope; un recordatorio manual lo pone en 0", async () => {
    const { runAutomaticReminders } = await import("../src/modules/reminders");
    const start = new Date(Date.now() - 3 * 86400_000);
    const { rec } = await envelopeWithSigner({ reminderDays: 1, sentAt: start.toISOString(), expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
    await runAutomaticReminders(db, new Date());
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key LIKE $1`, [`auto-reminder:${rec}:%`])).n).toBe(1);
    expect((await db.one<any>(`SELECT auto_reminders_sent FROM recipients WHERE id = $1`, [rec])).auto_reminders_sent).toBe(0);
    const { env: env2, rec: rec2 } = await envelopeWithSigner();
    await db.query(`UPDATE recipients SET auto_reminders_sent = 7 WHERE id = $1`, [rec2]);
    const res = await app.inject({ method: "POST", url: `/v1/envelopes/${env2}/remind`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect((await db.one<any>(`SELECT auto_reminders_sent FROM recipients WHERE id = $1`, [rec2])).auto_reminders_sent).toBe(0);
  }, 60_000);
});

describe("vencimiento de acuerdos", () => {
  it("se encola una vez, sale con el idioma del destinatario y se marca como avisado recién al enviarse", async () => {
    const { agreementExpirySweep } = await import("../src/modules/agreements/repository");
    const { handleAgreementsJob } = await import("../src/modules/agreements");
    const { createBlobStore } = await import("../src/infra/storage");
    const { uuidv7 } = await import("../src/lib/util");
    const d = { db, blobs: createBlobStore(), log: { info() {}, warn() {}, error() {} } };
    const owners: string[] = [];
    for (const [email, locale] of [
      ["dueno@x.com", "en"],
      ["socia@x.com", "pt-BR"],
    ]) {
      const u = uuidv7();
      owners.push(u);
      await db.query(`INSERT INTO users (id, email, name, password_hash, locale) VALUES ($1,$2,$2,'x',$3)`, [u, email, locale]);
      await db.query(`INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'owner')`, [tenant, u]);
    }
    const file = uuidv7();
    await db.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'original','k','application/pdf',1,'h')`, [file, tenant]);
    const ag = uuidv7();
    await db.query(
      `INSERT INTO agreements (id, tenant_id, source, file_id, file_name, title, status, expiry_date, notice_days) VALUES ($1,$2,'external',$3,'a.pdf','Locación','active', current_date + 5, 30)`,
      [ag, tenant, file],
    );
    expect(await agreementExpirySweep(d)).toBe(1);
    expect(await agreementExpirySweep(d)).toBe(0); // ya encolado
    const job = await db.one<any>(`SELECT id, payload FROM jobs WHERE dedupe_key LIKE $1`, [`agr:expiry:${ag}:%`]);
    // Un job terminado (fallado) hace más de un día sin que el acuerdo quedara avisado: se vuelve a encolar (uno solo).
    await db.query(`UPDATE jobs SET status = 'failed', finished_at = now() - interval '2 days' WHERE id = $1`, [job.id]);
    expect(await agreementExpirySweep(d)).toBe(1);
    expect(await agreementExpirySweep(d)).toBe(0);
    expect((await db.one<any>(`SELECT count(*)::int AS n FROM jobs WHERE payload->>'agreementId' = $1 AND status = 'pending'`, [ag])).n).toBe(1);
    expect((await db.one<any>(`SELECT dedupe_key FROM jobs WHERE id = $1`, [job.id])).dedupe_key).toBeNull();
    await db.query(`DELETE FROM jobs WHERE payload->>'agreementId' = $1 AND id <> $2`, [ag, job.id]);

    mails.length = 0;
    failMail = "socia@x.com";
    failCode = "451"; // transitorio: el job se reintenta
    await expect(handleAgreementsJob(d, job.payload, job.id)).rejects.toThrow();
    failCode = "550";
    expect((await db.one<any>(`SELECT expiry_notified_for FROM agreements WHERE id = $1`, [ag])).expiry_notified_for).toBeNull();
    expect(mails.map((m) => m.to)).toEqual(["dueno@x.com"]);
    expect(mails[0]!.subject).toMatch(/^Expires on /);

    failMail = null;
    await handleAgreementsJob(d, job.payload, job.id);
    expect(mails.map((m) => m.to)).toEqual(["dueno@x.com", "socia@x.com"]);
    expect(mails[1]!.subject).toMatch(/^Vence em /);
    expect((await db.one<any>(`SELECT expiry_notified_for IS NOT NULL AS ok FROM agreements WHERE id = $1`, [ag])).ok).toBe(true);

    // Error permanente (550) con un destino: el job no falla (no se re-encola cada día) y el acuerdo queda avisado.
    // Un job nuevo del mismo vencimiento (otro id) no repite a quien ya lo recibió.
    await db.query(`UPDATE agreements SET expiry_date = current_date + 6, expiry_notified_for = NULL WHERE id = $1`, [ag]);
    expect(await agreementExpirySweep(d)).toBe(1);
    const job2 = await db.one<any>(`SELECT id, payload FROM jobs WHERE dedupe_key LIKE $1 AND status = 'pending'`, [`agr:expiry:${ag}:%`]);
    mails.length = 0;
    failMail = "socia@x.com";
    await handleAgreementsJob(d, job2.payload, job2.id);
    expect(mails.map((m) => m.to)).toEqual(["dueno@x.com"]);
    expect((await db.one<any>(`SELECT expiry_notified_for IS NOT NULL AS ok FROM agreements WHERE id = $1`, [ag])).ok).toBe(true);
    await db.query(`UPDATE agreements SET expiry_notified_for = NULL WHERE id = $1`, [ag]);
    const again = await db.one<any>(`INSERT INTO jobs (queue, payload) VALUES ('agreements', $1) RETURNING id`, [JSON.stringify(job2.payload)]);
    failMail = null;
    await handleAgreementsJob(d, job2.payload, again.id);
    // dueno ya lo tenía (otro job del mismo aviso); socia rebotó en forma permanente y ahora sí sale.
    expect(mails.map((m) => m.to)).toEqual(["dueno@x.com", "socia@x.com"]);
    await db.query(`DELETE FROM memberships WHERE user_id = ANY($1)`, [owners]);
  });
});
