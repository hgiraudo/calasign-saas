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
  type Permission,
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
import { enqueue, isLastAttempt, type JobContext } from "../infra/queue";
import { badRequest, conflict, notFound } from "../lib/errors";
import { decrypt, encrypt, hostOf, iso, randomToken, uuidv5, uuidv7 } from "../lib/util";
import { sendTracked } from "../notifications/outbound";
import { normLocale, render } from "../notifications/templates";
import { loadAccess } from "./access";
import { recordAudit } from "./audit";
import { authenticate, type AuthContext, type Services } from "./context";
import { tenantBaseUrl } from "./custom-domains";
import { permissionsForScopes } from "./oauth-tokens";
import { mailBranding, resolveBrand, senderFor } from "./white-label/brand";

const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 10_000;
/** Tope de endpoints por organización: cuentan los activos y los desactivados en los últimos 30 días. */
export const MAX_WEBHOOKS = 20;
/**
 * Tope absoluto de endpoints por organización (activos e inactivos de cualquier fecha): los inactivos viejos no cuentan
 * para MAX_WEBHOOKS, y sin este tope crear y pausar en bucle llenaba la tabla.
 */
export const MAX_WEBHOOKS_TOTAL = 100;
const COUNTS_FOR_CAP = `(active OR deactivated_at IS NULL OR deactivated_at > now() - interval '30 days')`;
/** Namespace de los UUIDv5 de eventos (event_id determinístico por sobre, seq y tipo). */
const EVENT_ID_NAMESPACE = "6f1c3a52-6a0e-4d0b-9c55-2b8a4f6e9d17";

/** id del evento de un fanout: el mismo (sobre, seq, tipo) da siempre el mismo id, así re-ejecutarlo no duplica entregas. */
export function webhookEventId(envelopeId: string, seq: number, type: string) {
  return uuidv5(`${envelopeId}:${seq}:${type}`, EVENT_ID_NAMESPACE);
}
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

const DEACTIVATION_REASONS = ["credential_revoked", "permission_lost", "gone", "failing"] as const;
type DeactivationReason = (typeof DEACTIVATION_REASONS)[number];

export const toEndpoint = (r: any): WebhookEndpoint => ({
  id: r.id,
  url: r.url,
  description: r.description,
  events: r.events,
  active: r.active,
  // Solo en las filas leídas con DEACTIVATED_REASON (columna calculada, no guardada); si no, null.
  deactivatedReason: !r.active && DEACTIVATION_REASONS.includes(r.deactivated_reason) ? (r.deactivated_reason as DeactivationReason) : null,
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
  // seq: el del evento de evidencia (los jobs encolados antes de la migración 0087 no lo traen).
  | { kind: "fanout"; tenantId: string; envelopeId: string; seq?: number | null; type: string; recipientId?: string | null; reason?: string | null }
  | { kind: "deliver"; deliveryId: string; manual?: boolean }
  | { kind: "deactivated_notice"; tenantId: string; endpointId: string; reason: Exclude<DeactivationReason, "credential_revoked"> };

export async function handleWebhookJob(d: Deps, p: WebhookJob, job?: Omit<JobContext, "maxAttempts"> & { maxAttempts?: number }) {
  if (p.kind === "fanout") return fanout(d, p);
  if (p.kind === "deactivated_notice") return notifyWebhookDeactivated(d, p, job?.id);
  try {
    return await deliverOne(d, p.deliveryId, job?.attempts ?? 1, Boolean(p.manual));
  } catch (err) {
    // Último intento con un error fuera del POST (base, descifrado del secreto…): la entrega no puede quedar
    // 'pending' para siempre.
    if (job?.maxAttempts != null && isLastAttempt(job as JobContext, err)) {
      await webhookJobGaveUp(d, p, String((err as Error)?.message ?? err)).catch((e) =>
        d.log.error({ deliveryId: p.deliveryId, err: String(e) }, "no se pudo marcar la entrega del webhook como fallida"),
      );
    }
    throw err;
  }
}

/**
 * El job de una entrega no va a correr más (último intento fallido o worker muerto en el último intento): la entrega
 * que siguiera 'pending' pasa a 'failed'. Idempotente; los jobs de fanout y avisos no tienen fila propia.
 */
export async function webhookJobGaveUp(d: Pick<Deps, "db">, p: WebhookJob, error: string) {
  if (p?.kind !== "deliver" || !p.deliveryId) return;
  await d.db.query(
    `UPDATE webhook_deliveries SET status = 'failed', next_retry_at = NULL, last_error = left(COALESCE(last_error || E'\\n', '') || $2, 1000)
      WHERE id = $1 AND status = 'pending'`,
    [p.deliveryId, error],
  );
}

/**
 * Suscripciones creadas por una integración (API key o app OAuth de un usuario) cuya credencial ya no vale: key revocada,
 * app revocada, el usuario la desconectó (tokens revocados) o dejó la organización. Se desactivan (quedan a la vista en
 * la consola): si no, el tercero seguía recibiendo los datos de todos los sobres después de cortarle el acceso.
 */
/**
 * Token OAuth (alias `ot`) que todavía cuenta como autorización vigente: un refresh token ya usado no (al rotar, el uso
 * emite uno nuevo y el viejo queda con used_at, sin revocar; con él, la app seguía "conectada" con scopes anteriores).
 */
const LIVE_TOKEN = `NOT (ot.kind = 'refresh' AND ot.used_at IS NOT NULL)`;

/** La credencial que creó la suscripción (alias `ep`) ya no vale. */
const ORPHANED_ORIGIN = `(
  (ep.created_by_api_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ep.created_by_api_key AND k.revoked_at IS NULL))
  OR (ep.oauth_client_id IS NOT NULL AND (
    NOT EXISTS (SELECT 1 FROM oauth_clients c WHERE c.id = ep.oauth_client_id AND c.revoked_at IS NULL)
    OR NOT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = ep.tenant_id AND m.user_id = ep.created_by)
    OR NOT EXISTS (SELECT 1 FROM oauth_tokens ot WHERE ot.client_id = ep.oauth_client_id AND ot.user_id = ep.created_by
                     AND ot.tenant_id = ep.tenant_id AND ot.revoked_at IS NULL AND ${LIVE_TOKEN}))))`;

/**
 * Columna calculada `deactivated_reason` (alias de la tabla: `ep`): "credential_revoked" si la suscripción está inactiva
 * y la credencial que la creó ya no vale (la desactivó deactivateOrphanedEndpoints, o se pausó y después se revocó la
 * credencial); si no, el motivo de una desactivación automática guardado (auto_deactivated_reason: "permission_lost",
 * "gone", "failing"); NULL si está activa o se pausó a mano. Los conectores (n8n) reactivan con "credential_revoked" o
 * "permission_lost": reactivarla con PATCH { active: true } la ata a la credencial actual.
 */
export const DEACTIVATED_REASON = `CASE WHEN ep.active THEN NULL WHEN ${ORPHANED_ORIGIN} THEN 'credential_revoked' ELSE ep.auto_deactivated_reason END AS deactivated_reason`;

async function deactivateOrphanedEndpoints(db: Db, tenantId: string) {
  const off = await db.query<{ id: string }>(
    `UPDATE webhook_endpoints ep SET active = false, deactivated_at = now(), updated_at = now()
      WHERE ep.tenant_id = $1 AND ep.active AND ${ORPHANED_ORIGIN}
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

/** Permisos que exige un webhook (access.ts: crearlo o modificarlo pide los dos). */
const REQUIRED_PERMS: Permission[] = ["webhooks:manage", "envelopes:view_all"];

/**
 * Permisos actuales de la credencial que creó la suscripción: los del rol de la API key (si la key es la identidad de
 * servicio de una app con client_credentials, recortados a los scopes que la app tiene hoy: oauth_clients.scopes, que
 * acotan cada token que emite), o los del usuario recortados a los scopes que le concedió a la app OAuth (unión de sus
 * tokens vigentes). null si no se pueden calcular (dejó la organización: eso lo cubre deactivateOrphanedEndpoints).
 */
async function originPermissions(db: Db, tenantId: string, ep: { created_by: string | null; created_by_api_key: string | null; oauth_client_id: string | null }) {
  if (ep.created_by_api_key) {
    const perms = (await loadAccess(db, { tenantId, userId: null, apiKeyId: ep.created_by_api_key })).permissions;
    const app = await db.one<{ scopes: string[] }>(
      `SELECT c.scopes FROM api_keys k JOIN oauth_clients c ON c.id = k.oauth_client_id WHERE k.id = $1`,
      [ep.created_by_api_key],
    );
    if (!app) return perms;
    const allowed = permissionsForScopes(app.scopes);
    return new Set([...perms].filter((p) => allowed.has(p)));
  }
  if (!ep.oauth_client_id || !ep.created_by) return null;
  let perms: ReadonlySet<Permission>;
  try {
    perms = (await loadAccess(db, { tenantId, userId: ep.created_by, apiKeyId: null })).permissions;
  } catch {
    return null;
  }
  const scopes = await db.query<{ s: string }>(
    `SELECT DISTINCT unnest(ot.scopes) AS s FROM oauth_tokens ot
      WHERE ot.client_id = $1 AND ot.user_id = $2 AND ot.tenant_id = $3 AND ot.revoked_at IS NULL AND ${LIVE_TOKEN}`,
    [ep.oauth_client_id, ep.created_by, tenantId],
  );
  const allowed = permissionsForScopes(scopes.map((r) => r.s));
  return new Set([...perms].filter((p) => allowed.has(p)));
}

/**
 * Cada cuánto se recalculan los permisos de las credenciales de origen de una organización. La caché es por proceso
 * (memoria de cada réplica de la API o del worker, no compartida): tras quitarle un permiso a la key, al usuario o a la
 * app, cada proceso puede seguir entregando hasta 60 s más. La revocación de la credencial no espera (ORPHANED_ORIGIN
 * se mira en cada entrega, sin caché). La consola (GET /v1/webhooks) usa la misma caché: puede mostrar activa durante
 * ese margen una suscripción que la próxima entrega va a desactivar.
 */
const PERMISSION_CHECK_TTL_MS = 60_000;
const permissionCheckedAt = new Map<string, number>();

/**
 * Suscripciones creadas por una integración cuya credencial sigue vigente pero ya no tiene webhooks:manage y
 * envelopes:view_all (le cambiaron el rol a la key o al usuario, o la app perdió el scope): se desactivan con motivo
 * "permission_lost". Cacheado por organización durante PERMISSION_CHECK_TTL_MS para no recalcular en cada entrega.
 */
export async function deactivateEndpointsWithoutPermission(d: Deps, tenantId: string, opts: { force?: boolean } = {}) {
  const now = Date.now();
  if (!opts.force && now - (permissionCheckedAt.get(tenantId) ?? 0) < PERMISSION_CHECK_TTL_MS) return;
  if (permissionCheckedAt.size > 10_000) permissionCheckedAt.clear();
  permissionCheckedAt.set(tenantId, now);
  const eps = await d.db.query<any>(
    `SELECT ep.id, ep.url, ep.description, ep.created_by, ep.created_by_api_key, ep.oauth_client_id FROM webhook_endpoints ep
      WHERE ep.tenant_id = $1 AND ep.active AND (ep.created_by_api_key IS NOT NULL OR ep.oauth_client_id IS NOT NULL) AND NOT ${ORPHANED_ORIGIN}`,
    [tenantId],
  );
  for (const ep of eps) {
    const perms = await originPermissions(d.db, tenantId, ep);
    if (!perms) continue;
    const missing = REQUIRED_PERMS.filter((p) => !perms.has(p));
    if (missing.length) await autoDeactivate(d, tenantId, ep.id, "permission_lost", { missing });
  }
}

/**
 * Desactiva el endpoint (si sigue activo) con un motivo automático, lo registra en la auditoría y encola el aviso al
 * equipo (job "deactivated_notice" en la cola de webhooks, en la misma transacción: el correo no sale dentro de la
 * entrega o del pedido que lo desactivó). `url`: solo si el endpoint sigue apuntando a esa URL (un 410 de la URL vieja no
 * desactiva el endpoint al que le acaban de cambiar la URL).
 */
async function autoDeactivate(
  d: Deps,
  tenantId: string,
  endpointId: string,
  reason: Exclude<DeactivationReason, "credential_revoked">,
  data: Record<string, unknown> = {},
  url: string | null = null,
) {
  return d.db.tx(async (t) => {
    const off = await t.query<any>(
      `UPDATE webhook_endpoints SET active = false, auto_deactivated_reason = $2, deactivated_at = now(), updated_at = now()
        WHERE id = $1 AND active AND ($3::text IS NULL OR url = $3) RETURNING id, (extract(epoch FROM deactivated_at) * 1000)::bigint AS at`,
      [endpointId, reason, url],
    );
    if (!off.length) return false;
    await recordAudit(t, {
      tenantId,
      action: "webhook.deactivated",
      actor: { type: "system", label: "CalaSign" },
      targetType: "webhook",
      targetId: endpointId,
      data: { reason, ...data },
    });
    // Dedupe por endpoint y motivo (y la desactivación: si se reactiva y se vuelve a desactivar, se avisa otra vez).
    await enqueue(t, "webhook", { kind: "deactivated_notice", tenantId, endpointId, reason } satisfies WebhookJob, {
      dedupeKey: `whoff:${endpointId}:${reason}:${off[0].at}`,
      maxAttempts: 5,
    });
    return true;
  });
}

/** Motivo de la desactivación en el aviso, por idioma. */
const DEACTIVATION_REASON_TEXT: Record<"es" | "pt-BR" | "en", Record<string, string>> = {
  es: {
    gone: "Motivo: el servidor respondió 410 Gone (el destino ya no existe).",
    failing: "Motivo: las entregas fallan desde hace demasiado tiempo (sin ninguna entrega exitosa).",
    permission_lost: "Motivo: la API key o la app que lo creó ya no tiene los permisos webhooks:manage y envelopes:view_all.",
  },
  en: {
    gone: "Reason: the server responded 410 Gone (the destination no longer exists).",
    failing: "Reason: deliveries have been failing for too long (no successful delivery).",
    permission_lost: "Reason: the API key or app that created it no longer has the webhooks:manage and envelopes:view_all permissions.",
  },
  "pt-BR": {
    gone: "Motivo: o servidor respondeu 410 Gone (o destino não existe mais).",
    failing: "Motivo: as entregas estão falhando há tempo demais (sem nenhuma entrega bem-sucedida).",
    permission_lost: "Motivo: a chave de API ou o aplicativo que o criou não tem mais as permissões webhooks:manage e envelopes:view_all.",
  },
};

/**
 * Job del aviso de desactivación: correo a quienes pueden administrar webhooks (propietarios, administradores y roles
 * con webhooks:manage), con la marca de la organización (remitente, colores, logo, marca blanca) y el link en su URL
 * base (dominio propio si tiene). Un reintento del job no repite a quien ya lo recibió (sendTracked con el id del job);
 * solo un fallo transitorio lo hace reintentar. No avisa si el endpoint se borró o ya se reactivó.
 */
async function notifyWebhookDeactivated(d: Deps, p: Extract<WebhookJob, { kind: "deactivated_notice" }>, jobId?: number) {
  const ep = await d.db.one<any>(`SELECT url, active FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2`, [p.endpointId, p.tenantId]);
  if (!ep || ep.active) return;
  const to = await d.db.query<any>(
    `SELECT u.email, u.name, u.locale FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN roles r ON r.id = m.role_id
      WHERE m.tenant_id = $1 AND (m.role IN ('owner','admin') OR (m.role = 'custom' AND 'webhooks:manage' = ANY(r.permissions)))`,
    [p.tenantId],
  );
  if (!to.length) return;
  const wl = await resolveBrand(d.db, p.tenantId, null);
  const sendAs = await senderFor(d.db, wl);
  const org = await d.db.one<any>(`SELECT name FROM tenants WHERE id = $1`, [p.tenantId]);
  // Solo el host: la URL puede llevar un secreto (?token=…).
  const host = hostOf(ep.url) ?? "?";
  const link = `${await tenantBaseUrl(d.db, p.tenantId)}/app/settings/integrations`;
  const transient: string[] = [];
  for (const u of to) {
    if (!u.email) continue;
    const locale = normLocale(u.locale);
    const m = render(
      "webhook_deactivated",
      locale,
      {
        recipientName: u.name ?? "",
        senderName: wl.name,
        organizationName: org?.name ?? wl.name,
        subject: `Webhook · ${host}`,
        detail: host,
        reason: DEACTIVATION_REASON_TEXT[locale][p.reason] ?? null,
        link,
      },
      mailBranding(wl, null, locale),
    );
    const out = await sendTracked(
      d.db,
      { tenantId: p.tenantId, template: "webhook_deactivated", jobId, log: d.log },
      { channel: "email", to: u.email, subject: m.subject, text: m.text, html: m.html, link, locale, tenantId: p.tenantId, from: sendAs.from, replyTo: sendAs.replyTo, dkim: sendAs.dkim },
    );
    if (out.status === "failed") {
      if (out.transient) transient.push(out.error);
      else d.log.warn({ tenantId: p.tenantId }, "aviso de webhook desactivado no entregado (error permanente, no se reintenta)");
    }
  }
  if (transient.length) throw new Error(`no se pudo avisar la desactivación del webhook (${transient.length}): ${transient.join("; ")}`);
}

/** Entrega exitosa: se reinicia la racha de fallas. */
async function recordEndpointSuccess(db: Db, endpointId: string) {
  await db.query(
    `UPDATE webhook_endpoints SET consecutive_failures = 0, failing_since = NULL, last_success_at = now() WHERE id = $1`,
    [endpointId],
  );
}

/**
 * Entrega fallida definitiva (agotados los reintentos automáticos, o un 410 de un endpoint creado a mano): suma a la
 * racha y desactiva el endpoint ("failing") con config.webhooks.maxConsecutiveFailures seguidas Y al menos
 * failingMinHours horas fallando sin ningún éxito (un receptor caído 15 minutos durante un envío masivo junta 50 fallas
 * sin estar roto), o con failingDays días fallando sin ningún éxito y al menos failingDaysMinFailures fallas seguidas.
 * `url`: la URL a la que se entregó; si el endpoint ya apunta a otra (se la cambiaron, lo que reinicia la racha), la
 * falla no cuenta.
 */
async function recordEndpointFailure(d: Deps, tenantId: string, endpointId: string, url: string) {
  const r = await d.db.one<any>(
    `UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1, failing_since = COALESCE(failing_since, now())
      WHERE id = $1 AND url = $4 RETURNING active, consecutive_failures,
        (failing_since < now() - make_interval(days => $2::int)) AS stale,
        (failing_since < now() - make_interval(secs => $3::double precision * 3600)) AS long_enough`,
    [endpointId, config.webhooks.failingDays, config.webhooks.failingMinHours, url],
  );
  if (!r?.active) return;
  // Los días fallando también piden un mínimo de fallas seguidas: con pocos eventos, dos fallas separadas por una semana
  // (un receptor que tuvo dos cortes cortos) desactivaban un endpoint que funciona.
  const staleMin = Math.min(config.webhooks.failingDaysMinFailures, config.webhooks.maxConsecutiveFailures);
  if ((r.consecutive_failures >= config.webhooks.maxConsecutiveFailures && r.long_enough) || (r.stale && r.consecutive_failures >= staleMin)) {
    await autoDeactivate(d, tenantId, endpointId, "failing", { consecutiveFailures: r.consecutive_failures }, url);
  }
}

async function fanout(d: Deps, p: Extract<WebhookJob, { kind: "fanout" }>) {
  await deactivateOrphanedEndpoints(d.db, p.tenantId);
  await deactivateEndpointsWithoutPermission(d, p.tenantId);
  const endpoints = await d.db.query<any>(`SELECT * FROM webhook_endpoints WHERE tenant_id = $1 AND active`, [p.tenantId]);
  const targets = endpoints.filter((ep) => ep.events.length === 0 || ep.events.includes(p.type));
  if (targets.length === 0) return;
  // Determinístico: un reintento del job (o un worker que se cayó a mitad) no duplica las entregas (UNIQUE endpoint_id,
  // event_id). Los jobs viejos sin seq siguen con un id nuevo por ejecución.
  const eventId = typeof p.seq === "number" ? webhookEventId(p.envelopeId, p.seq, p.type) : uuidv7();
  // createdAt: cuándo ocurrió el evento (el registro de evidencia), no cuándo corrió el fanout: con la cola atrasada o
  // un reintento del job, la hora del fanout no coincidía con occurredAt de GET /v1/events. Los jobs sin seq (anteriores
  // a 0087) o sin registro (purgado) usan la hora actual. data.envelope sí es el estado al armar la entrega (documentado).
  const occurred =
    typeof p.seq === "number"
      ? await d.db.one<{ occurred_at: Date | string }>(`SELECT occurred_at FROM envelope_events WHERE envelope_id = $1 AND seq = $2`, [p.envelopeId, p.seq])
      : null;
  const payload: WebhookEventPayload = {
    id: eventId,
    type: p.type as WebhookEventPayload["type"],
    createdAt: occurred ? iso(occurred.occurred_at)! : new Date().toISOString(),
    tenantId: p.tenantId,
    data: { envelope: await envelopeSnapshot(d.db, p.envelopeId), recipientId: p.recipientId ?? null, reason: p.reason ?? null },
  };
  await d.db.tx(async (t) => {
    for (const ep of targets) {
      const id = uuidv7();
      const ins = await t.query(
        `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event_id, event_type, envelope_id, payload) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (endpoint_id, event_id) DO NOTHING RETURNING id`,
        [id, p.tenantId, ep.id, eventId, p.type, p.envelopeId, JSON.stringify(payload)],
      );
      if (!ins.length) continue; // ya registrada por una ejecución anterior
      await enqueue(t, "webhook", { kind: "deliver", deliveryId: id }, { maxAttempts: MAX_ATTEMPTS, dedupeKey: `whdel:${id}` });
    }
  });
}

/** Un intento de entrega. Lanza si falla, para que la cola reintente con backoff. */
async function deliverOne(d: Deps, deliveryId: string, attempt: number, manual: boolean) {
  const row = await d.db.one<any>(
    `SELECT dl.*, ep.url, ep.secret_enc, ep.active, ep.created_by_api_key, ep.oauth_client_id,
            CASE WHEN ep.previous_secret_expires_at > now() THEN ep.previous_secret_enc END AS previous_secret_enc
       FROM webhook_deliveries dl JOIN webhook_endpoints ep ON ep.id = dl.endpoint_id WHERE dl.id = $1`,
    [deliveryId],
  );
  if (!row || row.status === "succeeded") return;
  // Una entrega encolada antes de revocar la credencial que creó la suscripción (o de que perdiera los permisos) tampoco
  // sale. También las manuales (reintento, prueba): si no, un reintento pedido justo antes de revocar la key, o una
  // prueba sobre un endpoint huérfano todavía activo, mandaba los datos del sobre a la integración ya cortada.
  let revoked = false;
  if (row.active) {
    await deactivateOrphanedEndpoints(d.db, row.tenant_id);
    await deactivateEndpointsWithoutPermission(d, row.tenant_id);
    row.active = Boolean((await d.db.one<any>(`SELECT active FROM webhook_endpoints WHERE id = $1`, [row.endpoint_id]))?.active);
    revoked = !row.active;
  }
  if ((!row.active && !manual) || revoked) {
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
  // 410 Gone: el receptor dice que el destino ya no existe. No se reintenta. Una suscripción de una integración (Zapier,
  // Make, n8n, una app OAuth: REST hooks que piden 410 para darse de baja) se desactiva en el acto; una creada a mano
  // cuenta como falla definitiva (la racha): un 410 suelto de un proxy o de un deploy a medias no la apaga.
  const gone = statusCode === 410;
  const fromIntegration = Boolean(row.created_by_api_key || row.oauth_client_id);
  const willRetry = !ok && !manual && !gone && attempt < MAX_ATTEMPTS;
  const backoffSec = Math.min(3600, 5 * 2 ** (attempt - 1));
  await d.db.query(
    `UPDATE webhook_deliveries SET attempts = attempts + 1, last_attempt_at = now(), last_status_code = $2, last_response = $3, last_error = $4,
       status = $5, delivered_at = CASE WHEN $5 = 'succeeded' THEN now() ELSE delivered_at END,
       next_retry_at = CASE WHEN $6::boolean THEN now() + ($7 || ' seconds')::interval ELSE NULL END
     WHERE id = $1`,
    [deliveryId, statusCode, responseText, error, ok ? "succeeded" : willRetry ? "pending" : "failed", willRetry, String(backoffSec)],
  );
  if (ok) await recordEndpointSuccess(d.db, row.endpoint_id);
  else if (gone && fromIntegration) await autoDeactivate(d, row.tenant_id, row.endpoint_id, "gone", { deliveryId }, row.url);
  else if (!willRetry && !manual) await recordEndpointFailure(d, row.tenant_id, row.endpoint_id, row.url);
  if (!ok) {
    // Solo el host: los integradores suelen poner un secreto en la URL (?token=…) y quedaba en los logs.
    d.log.warn({ deliveryId, host: hostOf(row.url), attempt, error }, "entrega de webhook fallida");
    if (willRetry) throw new Error(`webhook ${deliveryId}: ${error}`);
  }
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function webhookRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  type P = { Params: { id: string } };
  const deps: Deps = { db: s.db, log: app.log };
  /** Antes de mostrar el estado: las de una credencial revocada o sin permisos quedan ya desactivadas. */
  const refresh = async (tenantId: string) => {
    await deactivateOrphanedEndpoints(s.db, tenantId);
    await deactivateEndpointsWithoutPermission(deps, tenantId);
  };
  /** Tope de endpoints (con la organización bloqueada: altas simultáneas no lo pasan). `except`: el que se reactiva. */
  const assertBelowCap = async (t: Db, tenantId: string, except: string | null = null) => {
    await t.query(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
    const count = await t.one<any>(
      `SELECT count(*)::int AS n FROM webhook_endpoints WHERE tenant_id = $1 AND ${COUNTS_FOR_CAP} AND id IS DISTINCT FROM $2`,
      [tenantId, except],
    );
    if (count.n >= MAX_WEBHOOKS) throw badRequest("too_many_webhooks", `Máximo ${MAX_WEBHOOKS} webhooks por organización`);
    // Tope absoluto (también los inactivos viejos) solo para altas: reactivar uno no cambia el total.
    if (except === null) {
      const total = await t.one<any>(`SELECT count(*)::int AS n FROM webhook_endpoints WHERE tenant_id = $1`, [tenantId]);
      if (total.n >= MAX_WEBHOOKS_TOTAL) {
        throw badRequest(
          "too_many_webhooks",
          `La organización tiene ${total.n} webhooks guardados (máximo ${MAX_WEBHOOKS_TOTAL}, contando los desactivados): borrá los que ya no uses para crear otro`,
        );
      }
    }
  };

  const load = async (tenantId: string, id: string) => {
    const r = await s.db.one<any>(`SELECT ep.*, ${DEACTIVATED_REASON} FROM webhook_endpoints ep WHERE ep.id = $1 AND ep.tenant_id = $2`, [id, tenantId]);
    if (!r) throw notFound("Webhook");
    return r;
  };

  app.get("/v1/webhooks", { preHandler: auth }, async (req) => {
    // Que la consola muestre ya desactivadas las de una credencial revocada o sin permisos (no recién en el próximo evento).
    await refresh(A(req).tenantId);
    const rows = await s.db.query(`SELECT ep.*, ${DEACTIVATED_REASON} FROM webhook_endpoints ep WHERE ep.tenant_id = $1 ORDER BY ep.created_at DESC`, [A(req).tenantId]);
    return { items: rows.map(toEndpoint), eventTypes: WEBHOOK_EVENT_TYPES };
  });

  app.post("/v1/webhooks", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    const input = CreateWebhookInput.parse(req.body);
    const url = validateUrl(input.url);
    const secret = `whsec_${randomToken(24)}`;
    // Conteo e inserción con la organización bloqueada: altas simultáneas no pasan el tope.
    const row = await s.db.tx(async (t) => {
      await assertBelowCap(t, a.tenantId);
      return t.one(
        `INSERT INTO webhook_endpoints (id, tenant_id, url, description, events, secret_enc, secret_prefix, active, created_by, created_by_api_key, oauth_client_id, deactivated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $8 THEN NULL ELSE now() END) RETURNING *`,
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

  // Como el listado: primero se desactivan los de una credencial revocada (si no, un conector como n8n lo veía activo
  // y daba la suscripción por buena hasta el próximo evento, que la desactivaba en silencio).
  app.get<P>("/v1/webhooks/:id", { preHandler: auth }, async (req) => {
    await refresh(A(req).tenantId);
    return toEndpoint(await load(A(req).tenantId, req.params.id));
  });

  app.patch<P>("/v1/webhooks/:id", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = UpdateWebhookInput.parse(req.body);
    const cur = await load(a.tenantId, req.params.id);
    // Para la auditoría (audit.ts): la URL anterior, de la que solo se registra el host.
    (req as FastifyRequest & { auditBefore?: Record<string, unknown> }).auditBefore = { url: cur.url };
    // Reactivar una suscripción que se desactivó porque se revocó la credencial que la creó (o porque perdió los
    // permisos) la pasa a quien la reactiva (si no, se volvía a desactivar sola en el próximo evento). Solo en ese caso:
    // pausar y reanudar una que funciona no le cambia el origen (si no, dejaba de cortarse al revocar la key de
    // Zapier/Make). En el SET, ep.* son los valores anteriores.
    const retie = `($7 AND NOT ep.active AND (${ORPHANED_ORIGIN} OR ep.auto_deactivated_reason = 'permission_lost'))`;
    // Reactivarla (o cambiarle la URL) empieza una racha nueva: si no, la primera falla la volvía a desactivar.
    const reset = `(($7 AND NOT ep.active) OR ($3::text IS NOT NULL AND $3::text <> ep.url))`;
    const sql = `UPDATE webhook_endpoints ep SET url = COALESCE($3, url), description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         events = COALESCE($6, events), active = COALESCE($7, active), updated_at = now(),
         deactivated_at = CASE WHEN COALESCE($7, ep.active) THEN NULL WHEN ep.active THEN now() ELSE ep.deactivated_at END,
         auto_deactivated_reason = CASE WHEN COALESCE($7, ep.active) THEN NULL ELSE ep.auto_deactivated_reason END,
         consecutive_failures = CASE WHEN ${reset} THEN 0 ELSE ep.consecutive_failures END,
         failing_since = CASE WHEN ${reset} THEN NULL ELSE ep.failing_since END,
         created_by = CASE WHEN ${retie} THEN $8 ELSE created_by END,
         created_by_api_key = CASE WHEN ${retie} THEN $9 ELSE created_by_api_key END,
         oauth_client_id = CASE WHEN ${retie} THEN $10 ELSE oauth_client_id END
       WHERE id = $1 AND tenant_id = $2 RETURNING ep.*, ${DEACTIVATED_REASON}`;
    // Reactivar uno inactivo vuelve a ocupar un lugar del tope (los inactivos viejos no cuentan).
    const reactivating = input.active === true && !cur.active;
    const row = await s.db.tx(async (t) => {
      if (reactivating) await assertBelowCap(t, a.tenantId, cur.id);
      return t.one(sql, [
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
      ]);
    });
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
      `UPDATE webhook_endpoints ep SET secret_enc = $3, secret_prefix = $4,
         previous_secret_enc = CASE WHEN $5::int > 0 THEN ep.secret_enc ELSE NULL END,
         previous_secret_expires_at = CASE WHEN $5::int > 0 THEN now() + ($5::int * interval '1 hour') ELSE NULL END,
         updated_at = now()
       WHERE ep.id = $1 AND ep.tenant_id = $2 RETURNING ep.*, ${DEACTIVATED_REASON}`,
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
    // Primero se desactivan los de una credencial revocada o sin permisos (como al listar): si no, el reintento pasaba el
    // chequeo de activo y salía hacia la integración ya cortada.
    await refresh(a.tenantId);
    // Con el endpoint inactivo (pausado o desactivado por fallas, 410 o permisos) no sale: primero hay que reactivarlo.
    const endpointActive = async (db: Db) => Boolean((await db.one<any>(`SELECT active FROM webhook_endpoints WHERE id = $1`, [row.endpoint_id]))?.active);
    if (!(await endpointActive(s.db))) throw conflict("endpoint_inactive", "El webhook está desactivado: reactivalo para reintentar la entrega");
    // Pendiente con su reintento automático programado: se adelanta ese mismo trabajo (encolar otro mandaba el evento
    // dos veces). Si ya está en curso, o hay un reintento manual pedido, 409.
    if (row.status === "pending") {
      const moved = await s.db.query(
        `UPDATE jobs SET run_at = now() WHERE dedupe_key = $1 AND status = 'pending' AND run_at > now() RETURNING id`,
        [`whdel:${row.id}`],
      );
      if (moved.length) {
        reply.code(202);
        return toDelivery({ ...row, next_retry_at: null });
      }
      // Un intento en curso (automático o manual) o un manual ya pedido: 409. Si no queda ningún trabajo (un worker que
      // se cayó a mitad), sigue como reintento manual (si no, quedaba trabada en 409 para siempre).
      const live = await s.db.one(
        `SELECT 1 FROM jobs WHERE queue = 'webhook' AND status IN ('pending','running') AND payload->>'deliveryId' = $1 LIMIT 1`,
        [row.id],
      );
      if (live) throw conflict("delivery_pending", "La entrega ya se está reintentando");
    }
    await s.db.tx(async (t) => {
      // Con la entrega bloqueada se vuelve a mirar que no haya un intento vivo: dos reintentos simultáneos de una
      // pendiente (doble clic) pasaban los dos el chequeo de afuera y la mandaban dos veces.
      const cur = await t.one<any>(`SELECT status FROM webhook_deliveries WHERE id = $1 FOR UPDATE`, [row.id]);
      if (cur?.status !== row.status) throw conflict("delivery_pending", "La entrega ya se está reintentando");
      if (!(await endpointActive(t))) throw conflict("endpoint_inactive", "El webhook está desactivado: reactivalo para reintentar la entrega");
      const live = await t.one(
        `SELECT 1 FROM jobs WHERE queue = 'webhook' AND status IN ('pending','running') AND payload->>'deliveryId' = $1 LIMIT 1`,
        [row.id],
      );
      if (live) throw conflict("delivery_pending", "La entrega ya se está reintentando");
      await t.query(`UPDATE webhook_deliveries SET status = 'pending', next_retry_at = NULL WHERE id = $1`, [row.id]);
      await enqueue(t, "webhook", { kind: "deliver", deliveryId: row.id, manual: true }, { maxAttempts: 1 });
    });
    reply.code(202);
    return toDelivery({ ...row, status: "pending", next_retry_at: null });
  });

  // Cada prueba es un POST a la URL del cliente: con límite propio (10 por minuto por credencial o IP).
  app.post<P>("/v1/webhooks/:id/test", { preHandler: auth, config: { rateLimit: { max: 10, timeWindow: "1 minute" }, rateLimitByCredential: true } }, async (req, reply) => {
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
