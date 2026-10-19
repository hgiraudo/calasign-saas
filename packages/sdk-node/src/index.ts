// SDK oficial de CalaSign para Node.js (≥ 18). Sin dependencias: usa fetch y node:crypto.
//
//   import { CalaSign } from "@calasign/sdk";
//   const cs = new CalaSign({ apiKey: process.env.CALASIGN_KEY, baseUrl: "https://dev.calasign.com" });
//   const { envelope } = await cs.envelopes.create({ subject: "Contrato" });
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  CompleteSigningInput,
  CreateEnvelopeInput,
  CreateSigningUrlInput,
  CreateWebhookInput,
  CreateWebhookResponse,
  EnvelopeDetail,
  EnvelopeEvent,
  EnvelopeFromTemplateInput,
  EnvelopeSummary,
  FieldInput,
  ListEnvelopesResponse,
  MeResponse,
  RecipientInput,
  SigningUrlResponse,
  TemplateDetail,
  TemplateSummary,
  UpdateEnvelopeInput,
  UpdateWebhookInput,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEventPayload,
} from "@calasign/shared";

export type { CompleteSigningInput, EnvelopeDetail, EnvelopeSummary, WebhookEventPayload };

export const VERSION = "0.1.0";

// ───────────────────────────── Errores ─────────────────────────────

export class CalaSignError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
    readonly requestId?: string | null,
  ) {
    super(message);
    this.name = "CalaSignError";
  }
}

export class WebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookSignatureError";
  }
}

// ───────────────────────────── Opciones ─────────────────────────────

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
  /** Scopes separados por espacios. Por defecto, todos los de la app. */
  scope?: string;
}

export interface CalaSignOptions {
  /** API key de la organización (cs_live_… / cs_test_…). */
  apiKey?: string;
  /** Access token OAuth ya obtenido (authorization_code). */
  accessToken?: string;
  /** OAuth client credentials: el SDK pide y renueva el token solo. */
  oauth?: ClientCredentials;
  /** Por defecto https://dev.calasign.com */
  baseUrl?: string;
  /** Reintentos ante errores de red, 429 y 5xx. Por defecto 3. */
  maxRetries?: number;
  /** Tiempo máximo por intento. Por defecto 30 s. */
  timeoutMs?: number;
  /** Para tests o entornos sin fetch global. */
  fetch?: typeof fetch;
  userAgent?: string;
}

interface RequestOptions {
  body?: unknown;
  form?: FormData;
  query?: Record<string, string | number | undefined | null>;
  idempotencyKey?: string;
  /** El método es seguro de reintentar aunque la respuesta sea 500 (GET/PUT/DELETE o POST con idempotencia). */
  retryable?: boolean;
  raw?: boolean;
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── Cliente ─────────────────────────────

export class CalaSign {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private token: { value: string; expiresAt: number } | null = null;

  readonly envelopes: EnvelopesApi;
  readonly templates: TemplatesApi;
  readonly webhooks: WebhooksApi;

  constructor(private readonly opts: CalaSignOptions) {
    if (!opts.apiKey && !opts.accessToken && !opts.oauth) throw new Error("CalaSign: falta apiKey, accessToken u oauth");
    this.baseUrl = (opts.baseUrl ?? "https://dev.calasign.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? `calasign-node/${VERSION}`;
    this.envelopes = new EnvelopesApi(this);
    this.templates = new TemplatesApi(this);
    this.webhooks = new WebhooksApi(this);
  }

  /** Usuario (o app) y organización del token. */
  me(): Promise<MeResponse> {
    return this.request("GET", "/v1/me", { retryable: true });
  }

  private async bearer(forceRefresh = false): Promise<string> {
    if (this.opts.apiKey) return this.opts.apiKey;
    if (this.opts.accessToken) return this.opts.accessToken;
    if (!forceRefresh && this.token && this.token.expiresAt - 60_000 > Date.now()) return this.token.value;
    const o = this.opts.oauth!;
    const body = new URLSearchParams({ grant_type: "client_credentials", ...(o.scope ? { scope: o.scope } : {}) });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.clientSecret)}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": this.userAgent,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Igual que los demás errores de red: quien atrapa CalaSignError no recibía un TypeError ("fetch failed") suelto.
      throw new CalaSignError(`Error de red al pedir el token OAuth: ${(err as Error).message}`, 0, "network_error");
    }
    const data: any = await res.json().catch(() => ({}));
    // Sin access_token (cuerpo cortado o no JSON) no se guarda "Bearer undefined" por una hora.
    if (!res.ok || typeof data?.access_token !== "string" || !data.access_token) {
      throw new CalaSignError(data?.error_description ?? "No se pudo obtener el token OAuth", res.status, data?.error ?? "oauth_error");
    }
    this.token = { value: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** Pedido genérico a la API v1 (para endpoints que el SDK todavía no envuelve). */
  async request<T = any>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const idem = o.idempotencyKey;
    const retryable = o.retryable ?? (method === "GET" || method === "PUT" || method === "DELETE" || Boolean(idem));
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${await this.bearer()}`,
        accept: "application/json",
        "user-agent": this.userAgent,
      };
      if (idem) headers["idempotency-key"] = idem;
      let body: BodyInit | undefined;
      if (o.form) body = o.form;
      else if (o.body !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(o.body);
      }
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (err) {
        // Error de red: solo se reintenta si el pedido es idempotente (si no, podría duplicarse).
        if (retryable && attempt < this.maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new CalaSignError(`Error de red: ${(err as Error).message}`, 0, "network_error");
      }
      if (res.status === 401 && this.opts.oauth && !refreshed) {
        refreshed = true;
        await this.bearer(true);
        attempt--;
        continue;
      }
      if (RETRY_STATUS.has(res.status) && attempt < this.maxRetries && (retryable || res.status === 429 || res.status === 503)) {
        // Se descarta el cuerpo: si no, undici deja la conexión tomada hasta que el GC lo junte.
        await res.body?.cancel().catch(() => {});
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : backoff(attempt));
        continue;
      }
      if (o.raw && res.ok) return res as unknown as T;
      if (res.status === 204) return undefined as T;
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        // Corte o timeout a mitad del cuerpo: también es un error de red (no un TypeError/AbortError suelto).
        throw new CalaSignError(`Error de red: ${(err as Error).message}`, 0, "network_error");
      }
      let data: any = undefined;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        /* cuerpo no JSON */
      }
      if (!res.ok) {
        const e = data?.error;
        throw new CalaSignError(e?.message ?? `HTTP ${res.status}`, res.status, e?.code ?? `http_${res.status}`, e?.details, res.headers.get("x-request-id"));
      }
      return data as T;
    }
  }
}

function backoff(attempt: number) {
  return Math.min(8000, 500 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}

// ───────────────────────────── Recursos ─────────────────────────────

export interface ListEnvelopesParams {
  status?: string | string[];
  q?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Un id como segmento de la ruta. Sin codificar, un id que llega de afuera ("../webhooks", "x?y") cambiaba el pedido:
 * `fetch` resuelve los "..", así que `envelopes.get("../webhooks")` pedía GET /v1/webhooks con la credencial del
 * integrador, y `webhooks.delete("../envelopes/<id>")` borraba un sobre.
 */
function seg(v: string): string {
  return encodeURIComponent(String(v));
}

class EnvelopesApi {
  constructor(private readonly c: CalaSign) {}

  list(p: ListEnvelopesParams = {}): Promise<ListEnvelopesResponse> {
    return this.c.request("GET", "/v1/envelopes", {
      query: { status: Array.isArray(p.status) ? p.status.join(",") : p.status, q: p.q, limit: p.limit, cursor: p.cursor },
    });
  }

  /** Recorre todas las páginas: `for await (const e of cs.envelopes.iterate({ status: "completed" }))`. */
  async *iterate(p: Omit<ListEnvelopesParams, "cursor"> = {}): AsyncGenerator<EnvelopeSummary> {
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...p, cursor });
      for (const e of page.items) yield e;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  get(id: string): Promise<EnvelopeDetail> {
    return this.c.request("GET", `/v1/envelopes/${seg(id)}`);
  }

  /** Crea un borrador. Con idempotencia automática: un reintento no crea un segundo sobre. */
  create(input: CreateEnvelopeInput, o: { idempotencyKey?: string } = {}): Promise<EnvelopeDetail> {
    return this.c.request("POST", "/v1/envelopes", { body: input, idempotencyKey: o.idempotencyKey ?? randomUUID() });
  }

  update(id: string, input: UpdateEnvelopeInput): Promise<EnvelopeDetail> {
    return this.c.request("PATCH", `/v1/envelopes/${seg(id)}`, { body: input, retryable: true });
  }

  delete(id: string): Promise<void> {
    return this.c.request("DELETE", `/v1/envelopes/${seg(id)}`);
  }

  uploadDocument(id: string, file: Uint8Array | ArrayBuffer | Blob, filename = "documento.pdf") {
    const fd = new FormData();
    // Copia exacta de los bytes de la vista: un Buffer chico de Node es una ventana sobre un pool compartido de 8 KB y
    // su `.buffer` (también el de `buf.slice()`, que no copia) traería todo el pool, con datos de otras partes del proceso.
    const blob =
      file instanceof Blob
        ? file
        : new Blob([file instanceof ArrayBuffer ? new Uint8Array(file) : Uint8Array.prototype.slice.call(file)], { type: "application/pdf" });
    fd.append("file", blob, filename);
    return this.c.request<EnvelopeDetail["documents"][number]>("POST", `/v1/envelopes/${seg(id)}/documents`, { form: fd });
  }

  removeDocument(id: string, documentId: string): Promise<void> {
    return this.c.request("DELETE", `/v1/envelopes/${seg(id)}/documents/${seg(documentId)}`);
  }

  setRecipients(id: string, recipients: RecipientInput[]): Promise<EnvelopeDetail> {
    return this.c.request("PUT", `/v1/envelopes/${seg(id)}/recipients`, { body: { recipients } });
  }

  setFields(id: string, fields: (FieldInput | Record<string, unknown>)[]): Promise<EnvelopeDetail> {
    return this.c.request("PUT", `/v1/envelopes/${seg(id)}/fields`, { body: { fields } });
  }

  send(id: string, o: { idempotencyKey?: string } = {}): Promise<EnvelopeDetail> {
    return this.c.request("POST", `/v1/envelopes/${seg(id)}/send`, { idempotencyKey: o.idempotencyKey ?? `send-${seg(id)}` });
  }

  void(id: string, reason: string): Promise<EnvelopeDetail> {
    return this.c.request("POST", `/v1/envelopes/${seg(id)}/void`, { body: { reason }, retryable: true });
  }

  remind(id: string): Promise<{ notified: number }> {
    return this.c.request("POST", `/v1/envelopes/${seg(id)}/remind`);
  }

  async events(id: string): Promise<EnvelopeEvent[]> {
    return (await this.c.request<{ items: EnvelopeEvent[] }>("GET", `/v1/envelopes/${seg(id)}/events`)).items;
  }

  /** PDF sellado (solo con el sobre completado). */
  async downloadSigned(id: string): Promise<Uint8Array> {
    const res = await this.c.request<Response>("GET", `/v1/envelopes/${seg(id)}/signed.pdf`, { raw: true });
    return new Uint8Array(await res.arrayBuffer());
  }

  /** URL de firma embebida (5 min, un solo uso) para un destinatario con `embedded: true`. */
  signingUrl(envelopeId: string, recipientId: string, input: CreateSigningUrlInput = {}): Promise<SigningUrlResponse> {
    return this.c.request("POST", `/v1/envelopes/${seg(envelopeId)}/recipients/${seg(recipientId)}/signing-url`, { body: input });
  }

  /** Crea (y opcionalmente envía) un sobre desde una plantilla. */
  fromTemplate(input: EnvelopeFromTemplateInput, o: { idempotencyKey?: string } = {}): Promise<EnvelopeDetail> {
    return this.c.request("POST", "/v1/envelopes/from-template", { body: input, idempotencyKey: o.idempotencyKey ?? randomUUID() });
  }
}

class TemplatesApi {
  constructor(private readonly c: CalaSign) {}

  async list(q?: string): Promise<TemplateSummary[]> {
    return (await this.c.request<{ items: TemplateSummary[] }>("GET", "/v1/templates", { query: { q } })).items;
  }

  get(id: string): Promise<TemplateDetail> {
    return this.c.request("GET", `/v1/templates/${seg(id)}`);
  }
}

class WebhooksApi {
  constructor(private readonly c: CalaSign) {}

  async list(): Promise<WebhookEndpoint[]> {
    return (await this.c.request<{ items: WebhookEndpoint[] }>("GET", "/v1/webhooks")).items;
  }

  /** El secreto se devuelve una sola vez: guardalo para verificar las firmas. */
  create(input: CreateWebhookInput): Promise<CreateWebhookResponse> {
    return this.c.request("POST", "/v1/webhooks", { body: input });
  }

  update(id: string, input: UpdateWebhookInput): Promise<WebhookEndpoint> {
    return this.c.request("PATCH", `/v1/webhooks/${seg(id)}`, { body: input, retryable: true });
  }

  delete(id: string): Promise<void> {
    return this.c.request("DELETE", `/v1/webhooks/${seg(id)}`);
  }

  async deliveries(id: string): Promise<WebhookDelivery[]> {
    return (await this.c.request<{ items: WebhookDelivery[] }>("GET", `/v1/webhooks/${seg(id)}/deliveries`)).items;
  }

  test(id: string): Promise<WebhookDelivery> {
    return this.c.request("POST", `/v1/webhooks/${seg(id)}/test`);
  }
}

// ───────────────────────────── Webhooks entrantes ─────────────────────────────

export interface VerifyWebhookInput {
  /** Cuerpo CRUDO del POST (string o bytes), sin parsear. */
  payload: string | Uint8Array;
  /** Valor del header CalaSign-Signature: `t=<unix>,v1=<hex>`. */
  header: string | null | undefined;
  secret: string;
  /** Tolerancia de reloj contra repeticiones. Por defecto 300 s. */
  toleranceSec?: number;
  /** Para tests. */
  now?: number;
}

/** true si la firma es válida y reciente. */
export function verifyWebhookSignature(i: VerifyWebhookInput): boolean {
  try {
    constructWebhookEvent(i);
    return true;
  } catch {
    return false;
  }
}

/** Verifica la firma y devuelve el evento parseado; lanza WebhookSignatureError si no es válida. */
export function constructWebhookEvent(i: VerifyWebhookInput): WebhookEventPayload {
  if (!i.header) throw new WebhookSignatureError("Falta el header CalaSign-Signature");
  const parts = Object.fromEntries(
    i.header.split(",").map((kv) => {
      const k = kv.indexOf("=");
      return [kv.slice(0, k).trim(), kv.slice(k + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) throw new WebhookSignatureError("Header de firma mal formado");
  const now = Math.floor((i.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (i.toleranceSec ?? 300)) throw new WebhookSignatureError("Firma fuera de la tolerancia de tiempo");
  const body = typeof i.payload === "string" ? i.payload : Buffer.from(i.payload).toString("utf8");
  const expected = createHmac("sha256", i.secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(parts.v1));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookSignatureError("Firma inválida");
  try {
    return JSON.parse(body) as WebhookEventPayload;
  } catch {
    // Como el SDK de Python: quien atrapa WebhookSignatureError no recibe un SyntaxError suelto.
    throw new WebhookSignatureError("El cuerpo del webhook no es JSON válido");
  }
}

export default CalaSign;
