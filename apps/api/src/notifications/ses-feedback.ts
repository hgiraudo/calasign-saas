// Rebotes y quejas de Amazon SES, publicados por un configuration set en un tema SNS que llama a
// POST /v1/integrations/ses/sns. Ver docs/CORREO-REBOTES.md.
//
// - Firma SNS verificada (SignatureVersion 1 = SHA1withRSA, 2 = SHA256withRSA) con el certificado de SigningCertURL,
//   que tiene que ser https://sns.<región>.amazonaws.com/… (la región del TopicArn).
// - TopicArn en la lista blanca SES_SNS_TOPIC_ARNS.
// - SubscriptionConfirmation: se visita SubscribeURL solo si el mensaje pasó la verificación.
// - Timestamp del mensaje de hace más de 24 horas (o del futuro): rechazado. SNS reintenta una entrega fallida durante
//   horas (más con una política de reintentos propia): con una ventana corta se perdían avisos reales tras una caída de
//   la API. Un mensaje firmado capturado y reenviado dentro de la ventana no hace daño: el procesamiento es idempotente
//   (renueva la misma supresión y no vuelve a marcar el aviso ni a registrar el evento).
// - Rebote permanente: supresión global de la dirección con vencimiento (EMAIL_BOUNCE_SUPPRESSION_DAYS). Queja:
//   supresión solo para la organización del envío (por provider_message_id o, si el correo no dejó fila en
//   notifications, por la etiqueta tenant=<id> que manda channels.ts en X-SES-MESSAGE-TAGS). El aviso queda 'bounced'/'complained' y,
//   si es de un sobre, se registra en su actividad.
// - Quitar una supresión: la organización, sus quejas (GET/DELETE /v1/settings/email-suppressions, settings:manage).
//   Las globales (rebotes) no tienen pantalla (no hay administración de plataforma): vencen solas, se borran cuando la
//   persona valida un código por correo, o por SQL (docs/CORREO-REBOTES.md).
import { createVerify, X509Certificate } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config";
import type { Db } from "../infra/db";
import { SYSTEM, appendEvent } from "../infra/evidence";
import { readCappedText } from "../lib/http-body";
import { notFound } from "../lib/errors";
import { maskDestination } from "../lib/util";
import { auditFromRequest } from "../modules/audit";
import { authenticate, type AuthContext, type Services } from "../modules/context";
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

/** Certificados ya validados, con su vencimiento: pasado validTo se vuelven a descargar y validar. */
const certCache = new Map<string, { pem: string; validTo: number }>();
/**
 * Antigüedad máxima del Timestamp de un mensaje SNS: 24 h, para no perder avisos que SNS reintenta tras una caída. La
 * protección contra un reenvío la da la idempotencia de applySesEvent, no la ventana.
 */
const MAX_MESSAGE_AGE_MS = 24 * 60 * 60_000;

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
  // Mensaje viejo (o del futuro, con un margen por relojes desfasados): una firma válida capturada no se reproduce.
  const ts = Date.parse(String(m.Timestamp));
  if (!Number.isFinite(ts) || Date.now() - ts > MAX_MESSAGE_AGE_MS || ts - Date.now() > 5 * 60_000) return { ok: false, reason: "stale" };
  const cached = certCache.get(certUrl.href);
  let pem = cached && cached.validTo > Date.now() ? cached.pem : undefined;
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
    const validTo = new Date(cert.validTo).getTime();
    if (new Date(cert.validFrom).getTime() > now || !(validTo >= now)) {
      certCache.delete(certUrl.href);
      return { ok: false, reason: "cert_expired" };
    }
    if (certCache.size > 50) certCache.clear();
    certCache.set(certUrl.href, { pem, validTo });
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
      if (permanent) await suppressBounce(db, address, detail, messageId);
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
      await suppressComplaint(db, address, detail, messageId, tenantTag(ev));
      await markNotifications(db, messageId, address, "complained", detail);
    }
    return "complaint";
  }
  return "ignored";
}

/** Rebote permanente: global (cualquier organización), con vencimiento; un rebote nuevo lo renueva. */
async function suppressBounce(db: Db, address: string, detail: string, messageId: string | null) {
  await db.query(
    `INSERT INTO email_suppressions (address, reason, detail, provider_message_id, expires_at)
     VALUES ($1,'bounce',$2,$3, now() + make_interval(days => $4))
     ON CONFLICT (address) WHERE tenant_id IS NULL DO UPDATE SET
       detail = EXCLUDED.detail, provider_message_id = EXCLUDED.provider_message_id, expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [address, detail, messageId, config.mail.bounceSuppressionDays],
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Etiqueta tenant=<id> del correo (mail.tags del evento de SES; ver channels.ts sesHeaders). */
export function tenantTag(ev: any): string | null {
  const v = ev?.mail?.tags?.tenant;
  const id = Array.isArray(v) ? v[0] : v;
  return typeof id === "string" && UUID_RE.test(id) ? id.toLowerCase() : null;
}

/**
 * Queja: solo para la organización que mandó el correo (la del aviso con ese provider_message_id o, si el correo no
 * dejó fila, la de su etiqueta tenant). La persona se quejó de esa organización; las demás le pueden seguir
 * escribiendo. Sin aviso ni etiqueta no se sabe de quién es (p. ej. restablecer contraseña): no se suprime.
 */
async function suppressComplaint(db: Db, address: string, detail: string, messageId: string | null, tagTenant: string | null) {
  const n = messageId
    ? await db.one<{ tenant_id: string }>(`SELECT tenant_id FROM notifications WHERE provider_message_id = $1 AND channel = 'email' LIMIT 1`, [messageId])
    : null;
  const tenantId = n?.tenant_id ?? tagTenant;
  if (!tenantId) return;
  // Con la etiqueta, la organización puede no existir más (o el id no ser de una): no se inserta nada.
  await db.query(
    `INSERT INTO email_suppressions (address, reason, detail, provider_message_id, tenant_id)
     SELECT $1,'complaint',$2,$3,t.id FROM tenants t WHERE t.id = $4::uuid
     ON CONFLICT (tenant_id, address) WHERE tenant_id IS NOT NULL DO UPDATE SET
       detail = EXCLUDED.detail, provider_message_id = EXCLUDED.provider_message_id, updated_at = now()`,
    [address, detail, messageId, tenantId],
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

export async function sesFeedbackRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;

  // Quejas de la organización (settings:manage, access.ts): quién se quejó de sus correos y desde cuándo no le escribe.
  app.get("/v1/settings/email-suppressions", { preHandler: auth }, async (req) => {
    const a = A(req);
    const rows = await s.db.query<any>(
      `SELECT address, reason, detail, created_at, updated_at FROM email_suppressions WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 500`,
      [a.tenantId],
    );
    return {
      items: rows.map((r) => ({
        address: r.address,
        reason: r.reason,
        detail: r.detail,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    };
  });

  // Volver a escribirle a una dirección que se quejó (p. ej. la persona pidió seguir recibiendo los avisos). Solo las
  // quejas de la propia organización: los rebotes son globales y no los quita una organización (vencen solos). Sin
  // queja propia, 404 siempre: no se revela si la dirección rebota en la plataforma (eso es de otras organizaciones).
  app.delete<{ Params: { address: string } }>("/v1/settings/email-suppressions/:address", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const address = normAddress(req.params.address ?? "");
    const r = await s.db.query<any>(`DELETE FROM email_suppressions WHERE tenant_id = $1 AND address = $2 RETURNING reason`, [a.tenantId, address]);
    if (!r.length) throw notFound("Supresión");
    await auditFromRequest(s.db, req, a, "email_suppression.removed", { targetType: "email_suppression", data: { address, reason: r[0].reason } });
    reply.code(204);
    return null;
  });

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
