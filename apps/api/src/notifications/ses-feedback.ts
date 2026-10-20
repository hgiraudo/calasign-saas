// Rebotes y quejas de Amazon SES, publicados por un configuration set en un tema SNS que llama a
// POST /v1/integrations/ses/sns. Ver docs/CORREO-REBOTES.md.
//
// - Firma SNS verificada (SignatureVersion 1 = SHA1withRSA, 2 = SHA256withRSA) con el certificado de SigningCertURL,
//   que tiene que ser https://sns.<región>.amazonaws.com/… (la región del TopicArn).
// - TopicArn en la lista blanca SES_SNS_TOPIC_ARNS.
// - SubscriptionConfirmation: se visita SubscribeURL solo si el mensaje pasó la verificación.
// - Rebote permanente y queja: supresión global de la dirección; el aviso (por provider_message_id) queda
//   'bounced'/'complained' y, si es de un sobre, se registra en su actividad.
import { createVerify, X509Certificate } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import type { Db } from "../infra/db";
import { SYSTEM, appendEvent } from "../infra/evidence";
import { readCappedText } from "../lib/http-body";
import { maskDestination } from "../lib/util";
import { normAddress, scrubPii } from "./outbound";

export interface SnsDeps {
  /** Descarga el certificado PEM (inyectable en pruebas). */
  fetchCert?: (url: string) => Promise<string>;
  /** Visita la SubscribeURL (inyectable en pruebas). */
  confirmSubscription?: (url: string) => Promise<void>;
  /** Temas aceptados (por defecto, SES_SNS_TOPIC_ARNS). */
  topicArns?: string[];
  log?: { info(o: object, m?: string): void; warn(o: object, m?: string): void };
}

const SNS_HOST_RE = /^sns\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/;
const ARN_RE = /^arn:aws(?:-[a-z]+)?:sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]{1,256}$/;

/** URL https en sns.<región>.amazonaws.com (la región del tema). */
function snsUrlOk(raw: unknown, region: string): URL | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  const m = SNS_HOST_RE.exec(u.hostname.toLowerCase());
  return m && m[1] === region ? u : null;
}

const SIGNED_FIELDS: Record<string, string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
  UnsubscribeConfirmation: ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
};

/** Texto que firma SNS: "Clave\nValor\n" por cada campo (Subject solo si viene). */
export function snsStringToSign(m: Record<string, unknown>): string | null {
  const fields = SIGNED_FIELDS[String(m.Type)];
  if (!fields) return null;
  let out = "";
  for (const k of fields) {
    if (m[k] === undefined || m[k] === null) {
      if (k === "Subject") continue;
      return null;
    }
    if (typeof m[k] !== "string") return null;
    out += `${k}\n${m[k]}\n`;
  }
  return out;
}

const certCache = new Map<string, string>();

async function defaultFetchCert(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`certificado SNS: HTTP ${res.status}`);
  return readCappedText(res, 64 * 1024);
}

async function defaultConfirm(url: string): Promise<void> {
  const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  await res.body?.cancel().catch(() => {});
  if (!res.ok) throw new Error(`confirmación SNS: HTTP ${res.status}`);
}

export type SnsVerification = { ok: true; region: string } | { ok: false; reason: string };

/** Verifica tema, URL del certificado y firma de un mensaje SNS. */
export async function verifySnsMessage(m: Record<string, unknown>, deps: SnsDeps = {}): Promise<SnsVerification> {
  const topics = deps.topicArns ?? config.mail.sesSnsTopicArns;
  const arn = typeof m.TopicArn === "string" ? m.TopicArn : "";
  const am = ARN_RE.exec(arn);
  if (!am) return { ok: false, reason: "topic_invalid" };
  if (!topics.includes(arn)) return { ok: false, reason: "topic_not_allowed" };
  const region = am[1]!;
  const version = String(m.SignatureVersion ?? "");
  if (version !== "1" && version !== "2") return { ok: false, reason: "signature_version" };
  const certUrl = snsUrlOk(m.SigningCertURL, region);
  if (!certUrl || !certUrl.pathname.endsWith(".pem")) return { ok: false, reason: "cert_url" };
  const toSign = snsStringToSign(m);
  if (!toSign || typeof m.Signature !== "string") return { ok: false, reason: "malformed" };
  let pem = certCache.get(certUrl.href);
  if (!pem) {
    try {
      pem = await (deps.fetchCert ?? defaultFetchCert)(certUrl.href);
    } catch {
      return { ok: false, reason: "cert_fetch" };
    }
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch {
      return { ok: false, reason: "cert_invalid" };
    }
    const now = Date.now();
    if (new Date(cert.validFrom).getTime() > now || new Date(cert.validTo).getTime() < now) return { ok: false, reason: "cert_expired" };
    if (certCache.size > 50) certCache.clear();
    certCache.set(certUrl.href, pem);
  }
  try {
    const ok = createVerify(version === "1" ? "RSA-SHA1" : "RSA-SHA256")
      .update(toSign, "utf8")
      .verify(pem, m.Signature, "base64");
    return ok ? { ok: true, region } : { ok: false, reason: "signature" };
  } catch {
    return { ok: false, reason: "signature" };
  }
}

/** Para pruebas: vacía el caché de certificados. */
export function clearSnsCertCache() {
  certCache.clear();
}

export type SnsOutcome = { status: number; result: string };

/** Procesa un mensaje SNS ya parseado (JSON). */
export async function handleSnsMessage(db: Db, m: Record<string, unknown>, deps: SnsDeps = {}): Promise<SnsOutcome> {
  const v = await verifySnsMessage(m, deps);
  if (!v.ok) {
    deps.log?.warn({ reason: v.reason, topic: typeof m.TopicArn === "string" ? m.TopicArn : null }, "mensaje SNS rechazado");
    return { status: 403, result: v.reason };
  }
  if (m.Type === "SubscriptionConfirmation") {
    const url = snsUrlOk(m.SubscribeURL, v.region);
    if (!url) return { status: 400, result: "subscribe_url" };
    await (deps.confirmSubscription ?? defaultConfirm)(url.href);
    deps.log?.info({ topic: m.TopicArn }, "suscripción SNS confirmada");
    return { status: 200, result: "subscribed" };
  }
  if (m.Type === "UnsubscribeConfirmation") return { status: 200, result: "ignored" };
  let event: any;
  try {
    event = JSON.parse(String(m.Message));
  } catch {
    return { status: 400, result: "message_json" };
  }
  return { status: 200, result: await applySesEvent(db, event) };
}

/**
 * Aplica un evento de SES (notificación de identidad: notificationType; configuration set: eventType).
 * Idempotente: SNS puede entregar el mismo mensaje más de una vez.
 */
export async function applySesEvent(db: Db, ev: any): Promise<string> {
  const type = String(ev?.notificationType ?? ev?.eventType ?? "");
  const messageId = typeof ev?.mail?.messageId === "string" ? ev.mail.messageId : null;
  if (type === "Bounce") {
    const permanent = ev.bounce?.bounceType === "Permanent";
    const list: any[] = Array.isArray(ev.bounce?.bouncedRecipients) ? ev.bounce.bouncedRecipients : [];
    for (const r of list) {
      const address = typeof r?.emailAddress === "string" ? normAddress(r.emailAddress) : "";
      if (!address) continue;
      const detail = scrubPii(`${ev.bounce?.bounceType ?? ""}/${ev.bounce?.bounceSubType ?? ""}${r.diagnosticCode ? `: ${r.diagnosticCode}` : ""}`).slice(0, 500);
      if (permanent) await suppress(db, address, "bounce", detail, messageId);
      await markNotifications(db, messageId, address, permanent ? "bounced" : null, detail);
    }
    return permanent ? "bounce_permanent" : "bounce_transient";
  }
  if (type === "Complaint") {
    const list: any[] = Array.isArray(ev.complaint?.complainedRecipients) ? ev.complaint.complainedRecipients : [];
    for (const r of list) {
      const address = typeof r?.emailAddress === "string" ? normAddress(r.emailAddress) : "";
      if (!address) continue;
      const detail = `complaint${ev.complaint?.complaintFeedbackType ? `/${ev.complaint.complaintFeedbackType}` : ""}`.slice(0, 200);
      await suppress(db, address, "complaint", detail, messageId);
      await markNotifications(db, messageId, address, "complained", detail);
    }
    return "complaint";
  }
  return "ignored";
}

async function suppress(db: Db, address: string, reason: "bounce" | "complaint", detail: string, messageId: string | null) {
  // Una queja pisa un rebote (es más fuerte); un rebote no pisa una queja.
  await db.query(
    `INSERT INTO email_suppressions (address, reason, detail, provider_message_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (address) DO UPDATE SET
       reason = CASE WHEN email_suppressions.reason = 'complaint' THEN 'complaint' ELSE EXCLUDED.reason END,
       detail = EXCLUDED.detail, provider_message_id = EXCLUDED.provider_message_id, updated_at = now()`,
    [address, reason, detail, messageId],
  );
}

/** Marca los avisos de ese envío a esa dirección y deja constancia en la actividad del sobre (una sola vez). */
async function markNotifications(db: Db, messageId: string | null, address: string, status: "bounced" | "complained" | null, detail: string) {
  if (!messageId) return;
  if (!status) {
    await db.query(
      `UPDATE notifications SET feedback_at = now(), feedback_detail = $3 WHERE provider_message_id = $1 AND channel = 'email' AND lower(destination) = $2`,
      [messageId, address, detail],
    );
    return;
  }
  const rows = await db.query<any>(
    `UPDATE notifications SET status = $3, feedback_at = now(), feedback_detail = $4
      WHERE provider_message_id = $1 AND channel = 'email' AND lower(destination) = $2 AND status IN ('sent','bounced')
        AND status <> $3
      RETURNING tenant_id, envelope_id, recipient_id, template`,
    [messageId, address, status, detail],
  );
  for (const n of rows) {
    if (!n.envelope_id) continue;
    await db
      .tx(async (t) => {
        const e = await t.one(`SELECT id FROM envelopes WHERE id = $1 FOR UPDATE`, [n.envelope_id]);
        if (!e) return;
        await appendEvent(t, {
          tenantId: n.tenant_id,
          envelopeId: n.envelope_id,
          type: status === "bounced" ? "notification.bounced" : "notification.complained",
          actor: SYSTEM,
          data: { recipientId: n.recipient_id, channel: "email", template: n.template, destination: maskDestination(address) },
        });
      })
      .catch(() => undefined);
  }
}

export async function sesFeedbackRoutes(app: FastifyInstance, s: { db: Db }) {
  // SNS manda el JSON con Content-Type text/plain.
  app.post("/v1/integrations/ses/sns", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (req, reply) => {
    let m: Record<string, unknown>;
    try {
      m = typeof req.body === "string" ? JSON.parse(req.body) : (req.body as Record<string, unknown>);
    } catch {
      return reply.code(400).send({ error: { code: "invalid_json", message: "JSON inválido" } });
    }
    if (!m || typeof m !== "object") return reply.code(400).send({ error: { code: "invalid_json", message: "JSON inválido" } });
    const out = await handleSnsMessage(s.db, m, { log: req.log });
    return reply.code(out.status).send({ result: out.result });
  });
}
