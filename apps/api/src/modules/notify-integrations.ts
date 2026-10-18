// Avisos a canales de Slack y Microsoft Teams (webhooks entrantes) cuando pasa algo con un sobre.
import type { FastifyInstance } from "fastify";
import {
  CreateNotificationIntegrationInput,
  NOTIFICATION_EVENTS,
  UpdateNotificationIntegrationInput,
  type NotificationEvent,
  type NotificationIntegration,
  type NotificationKind,
} from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { badRequest, notFound } from "../lib/errors";
import { decrypt, encrypt, iso, uuidv7 } from "../lib/util";
import { auditFromRequest } from "./audit";
import { authenticate, type Services } from "./context";
import { tenantBaseUrl } from "./custom-domains";
import { postToCustomerUrl } from "./webhooks";

const isLocalEnv = () => config.environment === "local";

/** Evento de evidencia → evento de aviso. */
export const EVIDENCE_TO_NOTIFICATION: Record<string, NotificationEvent> = {
  "envelope.sent": "envelope.sent",
  "envelope.completed": "envelope.completed",
  "recipient.declined": "envelope.declined",
  "envelope.voided": "envelope.voided",
  "envelope.expired": "envelope.expired",
  "recipient.signed": "recipient.signed",
  "recipient.approved": "recipient.approved",
};

export function validateIncomingWebhookUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("invalid_url", "URL inválida");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && isLocalEnv())) throw badRequest("invalid_url", "La URL debe ser https");
  if (local && !isLocalEnv()) throw badRequest("invalid_url", "No se permiten destinos locales");
  if (u.username || u.password) throw badRequest("invalid_url", "La URL no puede llevar credenciales");
  return u.toString();
}

/** Host + final de la URL (la URL completa es un secreto: quien la tiene puede publicar en el canal). */
function hintOf(url: string) {
  const u = new URL(url);
  return `${u.host}/…${u.pathname.slice(-6)}`;
}

const toApi = (r: any): NotificationIntegration => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  urlHint: r.url_hint,
  events: r.events,
  active: r.active,
  createdAt: iso(r.created_at)!,
  lastSentAt: iso(r.last_sent_at),
  lastStatus: r.last_status,
  lastError: r.last_error,
});

// ───────────────────────────── Mensajes ─────────────────────────────

const TXT = {
  es: {
    "envelope.sent": "📨 Sobre enviado",
    "envelope.completed": "✅ Sobre completado",
    "envelope.declined": "⛔ Sobre rechazado",
    "envelope.voided": "🚫 Sobre anulado",
    "envelope.expired": "⌛ Sobre vencido",
    "recipient.signed": "✍️ Firmó",
    "recipient.approved": "👍 Aprobó",
    test: "🔔 Mensaje de prueba de CalaSign: la integración funciona.",
    open: "Ver sobre",
    by: "por",
  },
  "pt-BR": {
    "envelope.sent": "📨 Envelope enviado",
    "envelope.completed": "✅ Envelope concluído",
    "envelope.declined": "⛔ Envelope recusado",
    "envelope.voided": "🚫 Envelope anulado",
    "envelope.expired": "⌛ Envelope expirado",
    "recipient.signed": "✍️ Assinou",
    "recipient.approved": "👍 Aprovou",
    test: "🔔 Mensagem de teste da CalaSign: a integração funciona.",
    open: "Ver envelope",
    by: "por",
  },
  en: {
    "envelope.sent": "📨 Envelope sent",
    "envelope.completed": "✅ Envelope completed",
    "envelope.declined": "⛔ Envelope declined",
    "envelope.voided": "🚫 Envelope voided",
    "envelope.expired": "⌛ Envelope expired",
    "recipient.signed": "✍️ Signed",
    "recipient.approved": "👍 Approved",
    test: "🔔 CalaSign test message: the integration works.",
    open: "View envelope",
    by: "by",
  },
} as const;

interface Message {
  title: string;
  subject?: string;
  detail?: string;
  link?: string;
  linkLabel?: string;
}

function slackPayload(m: Message) {
  const text = [m.title, m.subject ? `*${m.subject}*` : null, m.detail].filter(Boolean).join(" — ");
  return {
    text: text.replace(/\*/g, ""),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: [`*${m.title}*`, m.subject, m.detail].filter(Boolean).join("\n") } },
      ...(m.link ? [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: m.linkLabel ?? "Abrir" }, url: m.link }] }] : []),
    ],
  };
}

/** Tarjeta adaptable: formato de los webhooks de Workflows de Teams (y aceptado por los conectores). */
function teamsPayload(m: Message) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            { type: "TextBlock", text: m.title, weight: "Bolder", size: "Medium", wrap: true },
            ...(m.subject ? [{ type: "TextBlock", text: m.subject, wrap: true }] : []),
            ...(m.detail ? [{ type: "TextBlock", text: m.detail, isSubtle: true, wrap: true }] : []),
          ],
          actions: m.link ? [{ type: "Action.OpenUrl", title: m.linkLabel ?? "Abrir", url: m.link }] : [],
        },
      },
    ],
  };
}

export async function postToChannel(kind: NotificationKind, url: string, m: Message) {
  const res = await postToCustomerUrl(
    url,
    { "content-type": "application/json", "user-agent": "CalaSign-Notifications/1.0" },
    JSON.stringify(kind === "slack" ? slackPayload(m) : teamsPayload(m)),
    10_000,
  );
  return { status: res.status, ok: res.status >= 200 && res.status < 300, text: res.text.slice(0, 300) };
}

async function recordResult(db: Db, id: string, r: { status: number | null; ok: boolean; error: string | null }) {
  await db.query(`UPDATE notification_integrations SET last_sent_at = now(), last_status = $2, last_error = $3 WHERE id = $1`, [
    id,
    r.status,
    r.ok ? null : r.error,
  ]);
}

/** Job: avisa un evento de un sobre a una integración. */
export async function deliverNotificationJob(db: Db, p: { integrationId: string; envelopeId: string; event: NotificationEvent; recipientId?: string | null }) {
  const it = await db.one<any>(`SELECT * FROM notification_integrations WHERE id = $1 AND active`, [p.integrationId]);
  if (!it) return;
  const e = await db.one<any>(`SELECT e.id, e.subject, e.tenant_id, t.name AS org, t.default_locale FROM envelopes e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1`, [p.envelopeId]);
  if (!e) return;
  const r = p.recipientId ? await db.one<any>(`SELECT name FROM recipients WHERE id = $1`, [p.recipientId]) : null;
  const L = TXT[(e.default_locale as keyof typeof TXT) ?? "es"] ?? TXT.es;
  const base = await tenantBaseUrl(db, e.tenant_id);
  const msg: Message = {
    title: L[p.event],
    subject: e.subject,
    detail: [r?.name ? `${L.by} ${r.name}` : null, e.org].filter(Boolean).join(" · "),
    link: `${base}/app/envelopes/${e.id}`,
    linkLabel: L.open,
  };
  let result;
  try {
    result = await postToChannel(it.kind, decrypt(it.url_enc), msg);
  } catch (err) {
    await recordResult(db, it.id, { status: null, ok: false, error: String((err as Error).message ?? err).slice(0, 500) });
    throw err;
  }
  await recordResult(db, it.id, { status: result.status, ok: result.ok, error: result.ok ? null : `HTTP ${result.status}: ${result.text}` });
  if (!result.ok && (result.status >= 500 || result.status === 429)) throw new Error(`canal respondió ${result.status}`);
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function notificationIntegrationRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const load = async (tenantId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Integración");
    const r = await s.db.one<any>(`SELECT * FROM notification_integrations WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (!r) throw notFound("Integración");
    return r;
  };

  app.get("/v1/notification-integrations", { preHandler: auth }, async (req) => {
    const rows = await s.db.query(`SELECT * FROM notification_integrations WHERE tenant_id = $1 ORDER BY created_at DESC`, [req.auth!.tenantId]);
    return { items: rows.map(toApi), events: NOTIFICATION_EVENTS };
  });

  app.post("/v1/notification-integrations", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const input = CreateNotificationIntegrationInput.parse(req.body);
    const url = validateIncomingWebhookUrl(input.url);
    const id = uuidv7();
    await s.db.query(
      `INSERT INTO notification_integrations (id, tenant_id, kind, name, url_enc, url_hint, events, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, a.tenantId, input.kind, input.name, encrypt(url), hintOf(url), input.events, a.userId],
    );
    await auditFromRequest(s.db, req, a, "notification_integration.created", { targetType: "notification_integration", targetId: id, data: { kind: input.kind, name: input.name } });
    reply.code(201);
    return toApi(await load(a.tenantId, id));
  });

  app.patch<{ Params: { id: string } }>("/v1/notification-integrations/:id", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const r = await load(a.tenantId, req.params.id);
    const input = UpdateNotificationIntegrationInput.parse(req.body);
    const url = input.url ? validateIncomingWebhookUrl(input.url) : null;
    await s.db.query(
      `UPDATE notification_integrations SET name = COALESCE($2, name), url_enc = COALESCE($3, url_enc), url_hint = COALESCE($4, url_hint),
         events = COALESCE($5, events), active = COALESCE($6, active), updated_at = now() WHERE id = $1`,
      [r.id, input.name ?? null, url ? encrypt(url) : null, url ? hintOf(url) : null, input.events ?? null, input.active ?? null],
    );
    await auditFromRequest(s.db, req, a, "notification_integration.updated", { targetType: "notification_integration", targetId: r.id, data: { fields: Object.keys(input) } });
    return toApi(await load(a.tenantId, r.id));
  });

  app.delete<{ Params: { id: string } }>("/v1/notification-integrations/:id", { preHandler: auth }, async (req, reply) => {
    const a = req.auth!;
    const r = await load(a.tenantId, req.params.id);
    await s.db.query(`DELETE FROM notification_integrations WHERE id = $1`, [r.id]);
    await auditFromRequest(s.db, req, a, "notification_integration.deleted", { targetType: "notification_integration", targetId: r.id, data: { name: r.name } });
    reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/notification-integrations/:id/test", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const a = req.auth!;
    const r = await load(a.tenantId, req.params.id);
    const t = await s.db.one<any>(`SELECT default_locale FROM tenants WHERE id = $1`, [a.tenantId]);
    const L = TXT[(t?.default_locale as keyof typeof TXT) ?? "es"] ?? TXT.es;
    try {
      const res = await postToChannel(r.kind, decrypt(r.url_enc), { title: L.test });
      await recordResult(s.db, r.id, { status: res.status, ok: res.ok, error: res.ok ? null : `HTTP ${res.status}: ${res.text}` });
      return { ok: res.ok, status: res.status, error: res.ok ? null : res.text || `HTTP ${res.status}` };
    } catch (err) {
      const msg = String((err as Error).message ?? err).slice(0, 300);
      await recordResult(s.db, r.id, { status: null, ok: false, error: msg });
      return { ok: false, status: null, error: msg };
    }
  });
}
