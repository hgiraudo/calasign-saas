// Rebotes y quejas de SES vía SNS: verificación de la firma (v1 y v2) con un certificado de prueba inyectado, lista
// blanca de temas, URL del certificado, confirmación de la suscripción, supresión y marca de los avisos.
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import forge from "node-forge";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-ses-sns-"));
delete process.env.DATABASE_URL;

const TOPIC = "arn:aws:sns:us-east-1:123456789012:calasign-ses-feedback";
const CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function selfSigned(): string {
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }).toString());
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400_000);
  cert.validity.notAfter = new Date(Date.now() + 86400_000);
  const attrs = [{ name: "commonName", value: "sns.amazonaws.com" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs8", format: "pem" }).toString()), forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}
const PEM = selfSigned();

type Msg = Record<string, string>;
async function sign(m: Msg, version: "1" | "2" = "2"): Promise<Msg> {
  const { snsStringToSign } = await import("../src/notifications/ses-feedback");
  const out = { ...m, SignatureVersion: version, SigningCertURL: m.SigningCertURL ?? CERT_URL };
  const s = createSign(version === "1" ? "RSA-SHA1" : "RSA-SHA256");
  s.update(snsStringToSign(out)!);
  return { ...out, Signature: s.sign(privateKey, "base64") };
}

const notification = (message: object): Msg => ({
  Type: "Notification",
  MessageId: "m-1",
  TopicArn: TOPIC,
  Message: JSON.stringify(message),
  Timestamp: new Date().toISOString(),
});

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
let db: Db;
let tenant: string;
const fetchCert = vi.fn(async () => PEM);
const confirmSubscription = vi.fn(async () => undefined);
const deps = () => ({ fetchCert, confirmSubscription, topicArns: [TOPIC] });

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  tenant = uuidv7();
  await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Org')`, [tenant, `t-${tenant.slice(-8)}`]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("SNS: verificación", () => {
  it("acepta firmas v1 y v2 válidas y rechaza alteraciones, temas fuera de la lista y certificados fuera de AWS", async () => {
    const { verifySnsMessage, clearSnsCertCache } = await import("../src/notifications/ses-feedback");
    clearSnsCertCache();
    const base = notification({ notificationType: "Delivery" });
    expect(await verifySnsMessage(await sign(base, "1"), deps())).toEqual({ ok: true, region: "us-east-1" });
    expect(await verifySnsMessage(await sign(base, "2"), deps())).toEqual({ ok: true, region: "us-east-1" });
    // Mensaje alterado después de firmar.
    const signed = await sign(base);
    expect((await verifySnsMessage({ ...signed, Message: "{}" }, deps())).ok).toBe(false);
    // Tema que no está en la lista blanca (aunque la firma sea válida).
    expect(await verifySnsMessage(await sign({ ...base, TopicArn: "arn:aws:sns:us-east-1:123456789012:otro" }), deps())).toEqual({ ok: false, reason: "topic_not_allowed" });
    // Certificado fuera de sns.<región>.amazonaws.com, o de otra región que la del tema.
    for (const url of [
      "https://evil.example.com/cert.pem",
      "https://sns.us-east-1.amazonaws.com.evil.com/cert.pem",
      "http://sns.us-east-1.amazonaws.com/cert.pem",
      "https://sns.eu-west-1.amazonaws.com/cert.pem",
    ]) {
      expect(await verifySnsMessage(await sign({ ...base, SigningCertURL: url }), deps())).toEqual({ ok: false, reason: "cert_url" });
    }
    // Versión de firma desconocida.
    expect((await verifySnsMessage({ ...signed, SignatureVersion: "3" }, deps())).ok).toBe(false);
  });

  it("rechaza mensajes de más de 1 hora (o del futuro) y revalida el certificado vencido del caché", async () => {
    const { verifySnsMessage, clearSnsCertCache } = await import("../src/notifications/ses-feedback");
    clearSnsCertCache();
    const old = { ...notification({ notificationType: "Delivery" }), Timestamp: new Date(Date.now() - 2 * 3600_000).toISOString() };
    expect(await verifySnsMessage(await sign(old), deps())).toEqual({ ok: false, reason: "stale" });
    const future = { ...notification({ notificationType: "Delivery" }), Timestamp: new Date(Date.now() + 3600_000).toISOString() };
    expect(await verifySnsMessage(await sign(future), deps())).toEqual({ ok: false, reason: "stale" });
    // Con el certificado en caché, pasado su validTo se vuelve a descargar (y uno vencido se rechaza).
    fetchCert.mockClear();
    const ok = await sign(notification({ notificationType: "Delivery" }));
    expect((await verifySnsMessage(ok, deps())).ok).toBe(true);
    expect((await verifySnsMessage(ok, deps())).ok).toBe(true);
    expect(fetchCert).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 86400_000);
      const later = await sign(notification({ notificationType: "Delivery" }));
      expect(await verifySnsMessage(later, deps())).toEqual({ ok: false, reason: "cert_expired" });
      expect(fetchCert).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirma la suscripción solo si el mensaje pasa la verificación", async () => {
    const { handleSnsMessage } = await import("../src/notifications/ses-feedback");
    const sub: Msg = {
      Type: "SubscriptionConfirmation",
      MessageId: "s-1",
      Token: "tok",
      TopicArn: TOPIC,
      Message: "You have chosen to subscribe",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=x&Token=tok",
      Timestamp: new Date().toISOString(),
    };
    const forged = { ...(await sign(sub)), SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=otro" };
    expect((await handleSnsMessage(db, forged, deps())).status).toBe(403);
    expect(confirmSubscription).not.toHaveBeenCalled();
    expect(await handleSnsMessage(db, await sign(sub), deps())).toEqual({ status: 200, result: "subscribed" });
    expect(confirmSubscription).toHaveBeenCalledWith(sub.SubscribeURL);
  });
});

describe("SES: rebotes y quejas", () => {
  it("rebote permanente (global, con vencimiento) y queja (de la organización): aviso marcado y registrado en la actividad del sobre", async () => {
    const { handleSnsMessage } = await import("../src/notifications/ses-feedback");
    const { sendTracked } = await import("../src/notifications/outbound");
    const { uuidv7 } = await import("../src/lib/util");
    const env = uuidv7();
    await db.query(`INSERT INTO envelopes (id, tenant_id, subject, status) VALUES ($1, $2, 'Contrato', 'sent')`, [env, tenant]);
    const n1 = uuidv7();
    const n2 = uuidv7();
    await db.query(
      `INSERT INTO notifications (id, tenant_id, envelope_id, channel, template, destination, status, provider, provider_message_id, sent_at)
       VALUES ($1,$2,$3,'email','invite','Rebote@X.com','sent','smtp','ses-1', now()), ($4,$2,$3,'email','invite','queja@x.com','sent','smtp','ses-2', now())`,
      [n1, tenant, env, n2],
    );
    const bounce = {
      notificationType: "Bounce",
      mail: { messageId: "ses-1", destination: ["Rebote@X.com"] },
      bounce: { bounceType: "Permanent", bounceSubType: "General", bouncedRecipients: [{ emailAddress: "Rebote@X.com", diagnosticCode: "smtp; 550 5.1.1 user unknown" }] },
    };
    expect(await handleSnsMessage(db, await sign(notification(bounce)), deps())).toEqual({ status: 200, result: "bounce_permanent" });
    // SNS puede entregar dos veces: sin duplicar eventos.
    await handleSnsMessage(db, await sign(notification(bounce)), deps());
    const complaint = { eventType: "Complaint", mail: { messageId: "ses-2" }, complaint: { complainedRecipients: [{ emailAddress: "queja@x.com" }], complaintFeedbackType: "abuse" } };
    expect((await handleSnsMessage(db, await sign(notification(complaint)), deps())).result).toBe("complaint");
    // Rebote transitorio: no suprime.
    const transient = { notificationType: "Bounce", mail: { messageId: "ses-3" }, bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "lleno@x.com" }] } };
    expect((await handleSnsMessage(db, await sign(notification(transient)), deps())).result).toBe("bounce_transient");

    const sup = await db.query<any>(
      `SELECT address, reason, tenant_id, expires_at > now() + interval '59 days' AS long FROM email_suppressions WHERE address IN ('rebote@x.com','queja@x.com','lleno@x.com') ORDER BY address`,
    );
    expect(sup).toEqual([
      { address: "queja@x.com", reason: "complaint", tenant_id: tenant, long: null },
      { address: "rebote@x.com", reason: "bounce", tenant_id: null, long: true },
    ]);
    const rows = await db.query<any>(`SELECT id, status FROM notifications WHERE envelope_id = $1 ORDER BY destination`, [env]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [n1]: "bounced", [n2]: "complained" });
    const ev = await db.query<any>(`SELECT type, data FROM envelope_events WHERE envelope_id = $1 ORDER BY seq`, [env]);
    expect(ev.map((e) => e.type)).toEqual(["notification.bounced", "notification.complained"]);
    expect(JSON.stringify(ev)).not.toContain("rebote@x.com");

    // El próximo envío a esa dirección no sale.
    const out = await sendTracked(db, { tenantId: tenant, template: "invite" }, { channel: "email", to: "REBOTE@x.com", subject: "s", text: "t" });
    expect(out.status).toBe("suppressed");

    // La queja es solo de esta organización: otra le sigue pudiendo escribir.
    const { isSuppressed, clearBounceSuppression } = await import("../src/notifications/outbound");
    const other = uuidv7();
    await db.query(`INSERT INTO tenants (id, slug, name) VALUES ($1, $2, 'Otra')`, [other, `t-${other.slice(-8)}`]);
    expect(await isSuppressed(db, "queja@x.com", tenant)).toBe(true);
    expect(await isSuppressed(db, "queja@x.com", other)).toBe(false);
    // El rebote es de todas, pero vence.
    expect(await isSuppressed(db, "rebote@x.com", other)).toBe(true);
    expect(await isSuppressed(db, "rebote@x.com", other, { ignoreBounce: true })).toBe(false);
    await db.query(`UPDATE email_suppressions SET expires_at = now() - interval '1 minute' WHERE address = 'rebote@x.com'`);
    expect(await isSuppressed(db, "rebote@x.com", other)).toBe(false);
    // Un código validado por correo borra el rebote; no la queja.
    expect(await clearBounceSuppression(db, "Rebote@X.com")).toBe(true);
    expect(await clearBounceSuppression(db, "queja@x.com")).toBe(false);
    // Queja sin aviso asociado (no se sabe de qué organización): no suprime.
    const orphan = { eventType: "Complaint", mail: { messageId: "ses-nadie" }, complaint: { complainedRecipients: [{ emailAddress: "huerfana@x.com" }] } };
    await handleSnsMessage(db, await sign(notification(orphan)), deps());
    expect(await db.one(`SELECT 1 FROM email_suppressions WHERE address = 'huerfana@x.com'`)).toBeFalsy();
  });
});
