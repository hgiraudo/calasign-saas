// Webhooks (Fase 3): endpoints por organización, entregas firmadas con HMAC-SHA256, reintentos con
// backoff exponencial (vía la cola de jobs), registro de entregas y reenvío manual.
import { createHmac } from "node:crypto";
import dns from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  CreateWebhookInput,
  RotateWebhookSecretInput,
  UpdateWebhookInput,
  WEBHOOK_EVENT_TYPES,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEventPayload,
} from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { enqueue } from "../infra/queue";
import { badRequest, notFound } from "../lib/errors";
import { decrypt, encrypt, iso, randomToken, uuidv7 } from "../lib/util";
import { recordAudit } from "./audit";
import { authenticate, type AuthContext, type Services } from "./context";

const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 10_000;
export const SIGNATURE_HEADER = "CalaSign-Signature";

// ───────────────────────────── Firma ─────────────────────────────

/**
 * Encabezado `t=<unix>,v1=<hex>` con HMAC-SHA256(secret, "<t>.<body>"). Con varios secretos (rotación con período de
 * gracia) lleva un `v1=` por secreto, el vigente primero: `t=…,v1=<nuevo>,v1=<anterior>`. El receptor acepta si
 * alguno coincide.
 */
export function signPayload(secret: string | string[], body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const secrets = Array.isArray(secret) ? secret : [secret];
  const sigs = secrets.map((k) => `v1=${createHmac("sha256", k).update(`${timestamp}.${body}`).digest("hex")}`);
  return `t=${timestamp},${sigs.join(",")}`;
}

// ───────────────────────────── Validación de URL (SSRF) ─────────────────────────────

const isLocalEnv = () => config.environment === "local";

function validateUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest("invalid_url", "URL inválida");
  }
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && localHost && isLocalEnv())) {
    throw badRequest("invalid_url", "La URL del webhook debe ser https");
  }
  if (u.username || u.password) throw badRequest("invalid_url", "La URL no puede llevar credenciales");
  if (localHost && !isLocalEnv()) throw badRequest("invalid_url", "No se permiten destinos locales");
  return u.toString();
}

/** IPv6 en sus 8 grupos de 16 bits (acepta "::" y una IPv4 punteada al final). null si no es válida. */
function ipv6Groups(ip: string): number[] | null {
  let x = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (dotted) {
    const p = dotted[1].split(".").map(Number);
    x = x.slice(0, -dotted[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = x.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = x.includes("::") ? 8 - h.length - t.length : 0;
  const parts = [...h, ...Array(Math.max(fill, 0)).fill("0"), ...t];
  if (parts.length !== 8) return null;
  const g = parts.map((s) => parseInt(s || "0", 16));
  return g.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : g;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const g = ipv6Groups(ip);
    if (!g) return true; // no la entendemos: no se arriesga
    const zeros = (from: number, to: number) => g.slice(from, to).every((n) => n === 0);
    if (zeros(0, 7) && g[7] <= 1) return true; // :: y ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 (ULA)
    if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local y site-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    if (g[0] === 0x0100 && zeros(1, 4)) return true; // 100::/64 (descarte)
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo: IPv4 embebida ofuscada
    // Formatos con una IPv4 adentro: se valida la IPv4.
    if (zeros(0, 5) && g[5] === 0xffff) return isPrivateAddress(v4FromGroups(g[6], g[7])); // ::ffff:a.b.c.d
    if (zeros(0, 6)) return isPrivateAddress(v4FromGroups(g[6], g[7])); // ::a.b.c.d (IPv4-compatible)
    if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateAddress(v4FromGroups(g[6], g[7])); // NAT64
    if (g[0] === 0x2002) return isPrivateAddress(v4FromGroups(g[1], g[2])); // 6to4
    return false;
  }
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // 192.0.0.0/24 (IETF) y 192.0.2.0/24 (documentación)
    (a === 192 && b === 88 && c === 99) || // relay 6to4
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || // documentación
    (a === 203 && b === 0 && c === 113) || // documentación
    a >= 224
  );
}

/** Rechaza destinos que resuelven a direcciones internas (metadata de la nube, red privada). */
export async function assertPublicDestination(url: string) {
  if (isLocalEnv()) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`destino no permitido: ${host} resuelve a una dirección interna`);
  }
}

/**
 * `lookup` para sockets salientes hacia destinos que elige el cliente: resuelve y rechaza direcciones internas
 * en la MISMA resolución que usa la conexión. Así no hay ventana entre validar y conectar (DNS rebinding).
 */
export function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err, "");
    const list = addrs as dns.LookupAddress[];
    if (!list.length || (!isLocalEnv() && list.some((a) => isPrivateAddress(a.address)))) {
      const e: NodeJS.ErrnoException = new Error(`destino no permitido: ${hostname} resuelve a una dirección interna`);
      e.code = "EPRIVATEADDR";
      return callback(e, "");
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

/** Agentes HTTP(S) con la validación de destino en cada conexión (también los usa el cliente S3). */
export const safeHttpsAgent = new https.Agent({ lookup: safeLookup as never });
export const safeHttpAgent = new http.Agent({ lookup: safeLookup as never });

/**
 * POST a una URL de un cliente (webhook, Slack, Teams): valida literales IP y conecta con `safeLookup`,
 * sin seguir redirecciones. Devuelve el status y el comienzo de la respuesta.
 */
export async function postToCustomerUrl(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  await assertPublicDestination(url);
  const u = new URL(url);
  const secure = u.protocol === "https:";
  return new Promise((resolve, reject) => {
    const req = (secure ? https : http).request(
      u,
      { method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, agent: secure ? safeHttpsAgent : safeHttpAgent },
      (res) => {
        let text = "";
        const done = () => {
          clearTimeout(deadline);
          resolve({ status: res.statusCode ?? 0, text: text.slice(0, 2000) });
        };
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
          // Basta con el principio de la respuesta: no se sigue leyendo un cuerpo sin fin.
          if (text.length >= 2000) {
            done();
            res.destroy();
          }
        });
        res.on("end", done);
        res.on("error", (e) => {
          clearTimeout(deadline);
          reject(e);
        });
      },
    );
    // Plazo TOTAL: setTimeout del socket solo mide inactividad, y un receptor que gotea bytes retendría al worker.
    const deadline = setTimeout(() => req.destroy(new Error(`timeout después de ${timeoutMs} ms`)), timeoutMs);
    req.on("error", (e) => {
      clearTimeout(deadline);
      reject(e);
    });
    req.end(body);
  });
}

/**
 * Pedido HTTP(S) saliente a un destino que no controlamos (URLs de certificados ajenos, pasos HTTP de workflows):
 * valida literales IP, conecta con `safeLookup` (sin ventana de DNS rebinding), no sigue redirecciones y
 * corta la respuesta en `maxBytes`.
 */
export async function safeRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocolo no permitido");
  await assertPublicDestination(url);
  const secure = u.protocol === "https:";
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  const payload = opts.body === undefined ? undefined : typeof opts.body === "string" ? Buffer.from(opts.body) : Buffer.from(opts.body);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (payload) headers["content-length"] = String(payload.length);
  // Plazo TOTAL (conexión + respuesta completa). req.setTimeout solo mide inactividad del socket: un servidor que
  // manda un byte cada pocos segundos lo esquivaría y retendría el pedido (p. ej. una URL de OCSP/CRL hostil en un
  // PDF subido al validador público). Sin timeoutMs explícito se aplica igual un tope de 30 s.
  const deadlineMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn();
    };
    const req = (secure ? https : http).request(
      u,
      { method: opts.method ?? "GET", headers, agent: secure ? safeHttpsAgent : safeHttpAgent, signal: opts.signal },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new Error(`respuesta demasiado grande (más de ${maxBytes} bytes)`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(", ") : String(v);
          done(() => resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks) }));
        });
        res.on("error", (err) => done(() => reject(err)));
      },
    );
    const deadline = setTimeout(() => req.destroy(new Error(`timeout después de ${deadlineMs} ms`)), deadlineMs);
    req.on("error", (err) => done(() => reject(err)));
    req.end(payload);
  });
}

// ───────────────────────────── Mapeo ─────────────────────────────

const toEndpoint = (r: any): WebhookEndpoint => ({
  id: r.id,
  url: r.url,
  description: r.description,
  events: r.events,
  active: r.active,
  secretPrefix: r.secret_prefix,
  previousSecretExpiresAt: r.previous_secret_enc && r.previous_secret_expires_at && new Date(r.previous_secret_expires_at) > new Date() ? iso(r.previous_secret_expires_at) : null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

const toDelivery = (r: any): WebhookDelivery => ({
  id: r.id,
  endpointId: r.endpoint_id,
  eventId: r.event_id,
  eventType: r.event_type,
  envelopeId: r.envelope_id,
  status: r.status,
  attempts: r.attempts,
  lastStatusCode: r.last_status_code,
  lastResponse: r.last_response,
  lastError: r.last_error,
  lastAttemptAt: iso(r.last_attempt_at),
  nextRetryAt: iso(r.next_retry_at),
  createdAt: iso(r.created_at)!,
  deliveredAt: iso(r.delivered_at),
});

export async function envelopeSnapshot(db: Db, envelopeId: string) {
  const e = await db.one<any>(
    `SELECT e.*, f.sha256 AS signed_sha256 FROM envelopes e LEFT JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1`,
    [envelopeId],
  );
  if (!e) return null;
  const recips = await db.query<any>(
    `SELECT id, name, email, role, status, routing_order FROM recipients WHERE envelope_id = $1 ORDER BY routing_order, created_at, id`,
    [envelopeId],
  );
  return {
    id: e.id,
    subject: e.subject,
    status: e.status,
    metadata: e.metadata ?? {},
    sentAt: iso(e.sent_at),
    completedAt: iso(e.completed_at),
    signedSha256: e.signed_sha256 ?? null,
    recipients: recips.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, status: r.status, routingOrder: r.routing_order })),
  };
}

// ───────────────────────────── Jobs ─────────────────────────────

interface Deps {
  db: Db;
  log: { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };
}

type WebhookJob =
  | { kind: "fanout"; tenantId: string; envelopeId: string; type: string; recipientId?: string | null; reason?: string | null }
  | { kind: "deliver"; deliveryId: string; manual?: boolean };

export async function handleWebhookJob(d: Deps, p: WebhookJob, job?: { attempts: number }) {
  if (p.kind === "fanout") return fanout(d, p);
  return deliverOne(d, p.deliveryId, job?.attempts ?? 1, Boolean(p.manual));
}

/**
 * Suscripciones creadas por una integración (API key o app OAuth de un usuario) cuya credencial ya no vale: key revocada,
 * app revocada, el usuario la desconectó (tokens revocados) o dejó la organización. Se desactivan (quedan a la vista en
 * la consola): si no, el tercero seguía recibiendo los datos de todos los sobres después de cortarle el acceso.
 */
async function deactivateOrphanedEndpoints(db: Db, tenantId: string) {
  const off = await db.query<{ id: string }>(
    `UPDATE webhook_endpoints ep SET active = false, updated_at = now()
      WHERE ep.tenant_id = $1 AND ep.active AND (
        (ep.created_by_api_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ep.created_by_api_key AND k.revoked_at IS NULL))
        OR (ep.oauth_client_id IS NOT NULL AND (
          NOT EXISTS (SELECT 1 FROM oauth_clients c WHERE c.id = ep.oauth_client_id AND c.revoked_at IS NULL)
          OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = ep.tenant_id AND m.user_id = ep.created_by)
          OR NOT EXISTS (SELECT 1 FROM oauth_tokens ot WHERE ot.client_id = ep.oauth_client_id AND ot.user_id = ep.created_by
                           AND ot.tenant_id = ep.tenant_id AND ot.revoked_at IS NULL))))
      RETURNING ep.id`,
    [tenantId],
  );
  for (const e of off) {
    await recordAudit(db, {
      tenantId,
      action: "webhook.deactivated",
      actor: { type: "system", label: "CalaSign" },
      targetType: "webhook",
      targetId: e.id,
      data: { reason: "credencial de origen revocada" },
    });
  }
}

async function fanout(d: Deps, p: Extract<WebhookJob, { kind: "fanout" }>) {
  await deactivateOrphanedEndpoints(d.db, p.tenantId);
  const endpoints = await d.db.query<any>(`SELECT * FROM webhook_endpoints WHERE tenant_id = $1 AND active`, [p.tenantId]);
  const targets = endpoints.filter((ep) => ep.events.length === 0 || ep.events.includes(p.type));
  if (targets.length === 0) return;
  const eventId = uuidv7();
  const payload: WebhookEventPayload = {
    id: eventId,
    type: p.type as WebhookEventPayload["type"],
    createdAt: new Date().toISOString(),
    tenantId: p.tenantId,
    data: { envelope: await envelopeSnapshot(d.db, p.envelopeId), recipientId: p.recipientId ?? null, reason: p.reason ?? null },
  };
  await d.db.tx(async (t) => {
    for (const ep of targets) {
      const id = uuidv7();
      await t.query(
        `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_id, event_type, envelope_id, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, p.tenantId, ep.id, eventId, p.type, p.envelopeId, JSON.stringify(payload)],
      );
      await enqueue(t, "webhook", { kind: "deliver", deliveryId: id }, { maxAttempts: MAX_ATTEMPTS, dedupeKey: `whdel:${id}` });
    }
  });
}

/** Un intento de entrega. Lanza si falla, para que la cola reintente con backoff. */
async function deliverOne(d: Deps, deliveryId: string, attempt: number, manual: boolean) {
  const row = await d.db.one<any>(
    `SELECT dl.*, ep.url, ep.secret_enc, ep.active,
            CASE WHEN ep.previous_secret_expires_at > now() THEN ep.previous_secret_enc END AS previous_secret_enc
       FROM webhook_deliveries dl JOIN webhook_endpoints ep ON ep.id = dl.endpoint_id WHERE dl.id = $1`,
    [deliveryId],
  );
  if (!row || row.status === "succeeded") return;
  if (!row.active && !manual) {
    await d.db.query(`UPDATE webhook_deliveries SET status = 'failed', last_error = 'endpoint desactivado', next_retry_at = NULL WHERE id = $1`, [deliveryId]);
    return;
  }
  const body = JSON.stringify(row.payload);
  // Durante el período de gracia de una rotación se firma también con el secreto anterior.
  const signature = signPayload(row.previous_secret_enc ? [decrypt(row.secret_enc), decrypt(row.previous_secret_enc)] : decrypt(row.secret_enc), body);
  let statusCode: number | null = null;
  let responseText: string | null = null;
  let error: string | null = null;
  try {
    // Sin seguir redirecciones (un 3xx cuenta como fallo) y con la IP validada en la misma conexión.
    const res = await postToCustomerUrl(
      row.url,
      {
        "Content-Type": "application/json",
        "User-Agent": "CalaSign-Webhooks/1.0",
        [SIGNATURE_HEADER]: signature,
        "CalaSign-Event-Id": row.event_id,
        "CalaSign-Event-Type": row.event_type,
        "CalaSign-Delivery-Id": row.id,
      },
      body,
      TIMEOUT_MS,
    );
    statusCode = res.status;
    responseText = res.text.slice(0, 1000);
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (e) {
    error = String((e as Error).message ?? e).slice(0, 500);
  }

  const ok = error === null;
  const willRetry = !ok && !manual && attempt < MAX_ATTEMPTS;
  const backoffSec = Math.min(3600, 5 * 2 ** (attempt - 1));
  await d.db.query(
    `UPDATE webhook_deliveries SET attempts = attempts + 1, last_attempt_at = now(), last_status_code = $2, last_response = $3, last_error = $4,
       status = $5, delivered_at = CASE WHEN $5 = 'succeeded' THEN now() ELSE delivered_at END,
       next_retry_at = CASE WHEN $6::boolean THEN now() + ($7 || ' seconds')::interval ELSE NULL END
     WHERE id = $1`,
    [deliveryId, statusCode, responseText, error, ok ? "succeeded" : willRetry ? "pending" : "failed", willRetry, String(backoffSec)],
  );
  if (!ok) {
    d.log.warn({ deliveryId, url: row.url, attempt, error }, "entrega de webhook fallida");
    if (willRetry) throw new Error(`webhook ${deliveryId}: ${error}`);
  }
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function webhookRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  type P = { Params: { id: string } };

  const load = async (tenantId: string, id: string) => {
    const r = await s.db.one<any>(`SELECT * FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (!r) throw notFound("Webhook");
    return r;
  };

  app.get("/v1/webhooks", { preHandler: auth }, async (req) => {
    const rows = await s.db.query(`SELECT * FROM webhook_endpoints WHERE tenant_id = $1 ORDER BY created_at DESC`, [A(req).tenantId]);
    return { items: rows.map(toEndpoint), eventTypes: WEBHOOK_EVENT_TYPES };
  });

  app.post("/v1/webhooks", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = CreateWebhookInput.parse(req.body);
    const url = validateUrl(input.url);
    const secret = `whsec_${randomToken(24)}`;
    // Conteo e inserción con la organización bloqueada: altas simultáneas no pasan el tope.
    const row = await s.db.tx(async (t) => {
      await t.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [a.tenantId]);
      const count = await t.one<any>(`SELECT count(*)::int AS n FROM webhook_endpoints WHERE tenant_id = $1`, [a.tenantId]);
      if (count.n >= 20) throw badRequest("too_many_webhooks", "Máximo 20 webhooks por organización");
      return t.one(
        `INSERT INTO webhook_endpoints (id, tenant_id, url, description, events, secret_enc, secret_prefix, active, created_by, created_by_api_key, oauth_client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          uuidv7(),
          a.tenantId,
          url,
          input.description ?? null,
          input.events ?? [],
          encrypt(secret),
          secret.slice(0, 12),
          input.active ?? true,
          a.userId,
          a.apiKeyId,
          // Token OAuth de un usuario: la suscripción vive mientras la app siga conectada a su nombre.
          a.oauth && a.userId ? a.oauth.clientId : null,
        ],
      );
    });
    // Location: los triggers por webhook de Power Automate / Logic Apps borran la suscripción con DELETE a esta URL.
    reply.code(201).header("location", `${config.appUrl}/v1/webhooks/${(row as any).id}`);
    return { webhook: toEndpoint(row), secret };
  });

  app.get<P>("/v1/webhooks/:id", { preHandler: auth }, async (req) => toEndpoint(await load(A(req).tenantId, req.params.id)));

  app.patch<P>("/v1/webhooks/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateWebhookInput.parse(req.body);
    await load(a.tenantId, req.params.id);
    const row = await s.db.one(
      `UPDATE webhook_endpoints SET url = COALESCE($3, url), description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         events = COALESCE($6, events), active = COALESCE($7, active), updated_at = now(),
         -- Quien la (re)activa pasa a ser su origen: si no, una suscripción desactivada porque se revocó la credencial
         -- que la creó se volvía a desactivar sola en el próximo evento.
         created_by = CASE WHEN $7 THEN $8 ELSE created_by END,
         created_by_api_key = CASE WHEN $7 THEN $9 ELSE created_by_api_key END,
         oauth_client_id = CASE WHEN $7 THEN $10 ELSE oauth_client_id END
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [
        req.params.id,
        a.tenantId,
        input.url ? validateUrl(input.url) : null,
        input.description !== undefined,
        input.description ?? null,
        input.events ?? null,
        input.active ?? null,
        a.userId,
        a.apiKeyId,
        a.oauth && a.userId ? a.oauth.clientId : null,
      ],
    );
    return toEndpoint(row);
  });

  app.delete<P>("/v1/webhooks/:id", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    await load(a.tenantId, req.params.id);
    await s.db.query(`DELETE FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    return reply.code(204).send();
  });

  // Rotación del secreto: el nuevo se devuelve una sola vez; durante `graceHours` (por defecto 24) cada entrega va
  // firmada con los dos, así el receptor puede cambiar el secreto sin perder eventos. graceHours = 0 lo corta ya.
  app.post<P>("/v1/webhooks/:id/rotate-secret", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = RotateWebhookSecretInput.parse(req.body ?? {});
    const ep = await load(a.tenantId, req.params.id);
    const grace = input.graceHours ?? 24;
    const secret = `whsec_${randomToken(24)}`;
    const row = await s.db.one(
      `UPDATE webhook_endpoints SET secret_enc = $3, secret_prefix = $4,
         previous_secret_enc = CASE WHEN $5::int > 0 THEN secret_enc ELSE NULL END,
         previous_secret_expires_at = CASE WHEN $5::int > 0 THEN now() + ($5::int * interval '1 hour') ELSE NULL END,
         updated_at = now()
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      // El anterior es el de la fila al actualizar (no el leído antes): con dos rotaciones simultáneas, la segunda
      // guardaba como "anterior" el secreto original y el que devolvió la primera dejaba de valer en el acto.
      [ep.id, a.tenantId, encrypt(secret), secret.slice(0, 12), grace],
    );
    return { webhook: toEndpoint(row), secret };
  });

  app.get<P & { Querystring: { limit?: string } }>("/v1/webhooks/:id/deliveries", { preHandler: auth }, async (req) => {
    const a = A(req);
    await load(a.tenantId, req.params.id);
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(req.query.limit ?? 50)) || 50));
    const rows = await s.db.query(
      `SELECT * FROM webhook_deliveries WHERE endpoint_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT $3`,
      [req.params.id, a.tenantId, limit],
    );
    return { items: rows.map(toDelivery) };
  });

  app.post<P>("/v1/webhook-deliveries/:id/retry", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const row = await s.db.one<any>(`SELECT * FROM webhook_deliveries WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!row) throw notFound("Entrega");
    await s.db.tx(async (t) => {
      await t.query(`UPDATE webhook_deliveries SET status = 'pending', next_retry_at = NULL WHERE id = $1`, [row.id]);
      await enqueue(t, "webhook", { kind: "deliver", deliveryId: row.id, manual: true }, { maxAttempts: 1 });
    });
    reply.code(202);
    return toDelivery({ ...row, status: "pending", next_retry_at: null });
  });

  app.post<P>("/v1/webhooks/:id/test", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const ep = await load(a.tenantId, req.params.id);
    const eventId = uuidv7();
    const id = uuidv7();
    const payload: WebhookEventPayload = {
      id: eventId,
      type: "webhook.test",
      createdAt: new Date().toISOString(),
      tenantId: a.tenantId,
      data: { envelope: null },
    };
    const row = await s.db.tx(async (t) => {
      const r = await t.one(
        `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_id, event_type, envelope_id, payload) VALUES ($1,$2,$3,$4,'webhook.test',NULL,$5) RETURNING *`,
        [id, a.tenantId, ep.id, eventId, JSON.stringify(payload)],
      );
      await enqueue(t, "webhook", { kind: "deliver", deliveryId: id, manual: true }, { maxAttempts: 1 });
      return r;
    });
    reply.code(202);
    return toDelivery(row);
  });
}
