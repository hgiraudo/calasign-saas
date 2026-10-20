// SDK oficial de CalaSign para Node.js (≥ 18). Sin dependencias: usa fetch y node:crypto.
//
//   import { CalaSign } from "@calasign/sdk";
//   const cs = new CalaSign({ apiKey: process.env.CALASIGN_KEY, baseUrl: "https://dev.calasign.com" });
//   const { envelope } = await cs.envelopes.createAndSend({
//     subject: "Contrato", documents: [{ content: pdfBytes }], recipients: [{ name: "Ana", email: "ana@x.com" }],
//     fields: [{ type: "signature", anchor: { text: "[[firma]]", width: 150, height: 40 } }],
//   });
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ApiEvent,
  CloneEnvelopeInput,
  CompleteSigningInput,
  EnvelopeBatchInput,
  EnvelopeBatchResponse,
  EnvelopeFormData,
  ListEventsResponse,
  CreateEnvelopeInput,
  CreateEnvelopeRequest,
  CreateEnvelopeResponse,
  CreateSigningUrlInput,
  InlineDocumentInput,
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
  Brand,
  BrandAssetKind,
  BrandConfigInput,
  BrandEmailPreview,
  BrandDomain,
  BrandPreviewInput,
  EmailDomain,
  PublicBrandTheme,
} from "@calasign/shared";

export type { ApiEvent, CompleteSigningInput, CreateEnvelopeRequest, CreateEnvelopeResponse, EnvelopeBatchResponse, EnvelopeDetail, EnvelopeFormData, EnvelopeSummary, WebhookEventPayload, Brand, BrandConfigInput, PublicBrandTheme };

export const VERSION = "0.1.0";

// ───────────────────────────── Errores ─────────────────────────────

export class CalaSignError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
    readonly requestId?: string | null,
    /** Idempotency-Key del pedido (si tenía): reintentar con la misma clave es seguro, no duplica el sobre ni el envío. */
    readonly idempotencyKey?: string | null,
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
  /**
   * Espera total ante un 409 `idempotency_in_progress` (el pedido original con la misma Idempotency-Key sigue
   * ejecutándose). Es aparte de `maxRetries`. Por defecto 60 s.
   */
  idempotencyWaitMs?: number;
  /** Para tests o entornos sin fetch global. */
  fetch?: typeof fetch;
  userAgent?: string;
}

export interface RequestOptions {
  body?: unknown;
  /** Headers extra del pedido (p. ej. `X-Expected-Updated-At`). No reemplazan Authorization ni Idempotency-Key. */
  headers?: Record<string, string>;
  form?: FormData;
  query?: Record<string, string | number | undefined | null>;
  idempotencyKey?: string;
  /** El método es seguro de reintentar aunque la respuesta sea 500 (GET/PUT/DELETE o POST con idempotencia). */
  retryable?: boolean;
  /** Devuelve los bytes y los headers de la respuesta (descargas) en vez del JSON. */
  raw?: boolean;
  /** Cancela el pedido (y las esperas entre reintentos); se combina con el timeout de cada intento. */
  signal?: AbortSignal;
  /**
   * Se llama antes de cada reintento en el que el intento anterior PUDO haberse procesado en el servidor (error de red,
   * corte al leer la respuesta o 500/502/504). No se llama ante 408/425/429/503, que la API responde sin procesar.
   */
  onRetry?: () => void;
}

/**
 * Control de concurrencia de los borradores: el `updatedAt` del sobre (o plantilla) que cargaste. Si cambió desde
 * entonces (otra persona o proceso lo editó), la API responde 409 `version_changed` con `details.updatedAt` (el valor
 * actual): volvé a cargar, reaplicá el cambio y reintentá con el nuevo `updatedAt`. Con esta opción el SDK no reintenta
 * solo ante errores de red ni 5xx (sí ante 429 y 503): un reintento de un intento que se guardó daría un
 * `version_changed` falso. Ante un `network_error` o 5xx, recargá el sobre y comprobá si el cambio quedó aplicado.
 */
export interface DraftEditOptions {
  expectedUpdatedAt?: string | Date;
}

const draftHeaders = (o: DraftEditOptions): Record<string, string> | undefined =>
  o.expectedUpdatedAt ? { "x-expected-updated-at": isoOf(o.expectedUpdatedAt)! } : undefined;

/**
 * Con `expectedUpdatedAt` el pedido NO es reintentable ante errores de red/5xx: si el primer intento se guardó y se perdió
 * la respuesta, el reintento compararía contra el `updatedAt` que ese mismo intento cambió y daría un 409
 * `version_changed` falso. Solo se reintentan 429 (límite por IP) y 503, que la API responde sin procesar el pedido.
 */
const draftRequest = (o: DraftEditOptions, body: unknown, retryableWithout: boolean): RequestOptions =>
  o.expectedUpdatedAt ? { body, headers: draftHeaders(o), retryable: false } : { body, retryable: retryableWithout };

/** Respuesta de `request(…, { raw: true })`. */
export interface RawResponse {
  bytes: Uint8Array;
  headers: Headers;
}

const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Estados reintentables tras los que el pedido pudo haberse procesado igual (el resto se rechaza antes de procesarlo). */
const MAYBE_PROCESSED_STATUS = new Set([500, 502, 504]);

/** Espera `ms`; con `signal`, termina apenas se cancela (sin lanzar). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Timeout del intento combinado con la señal de quien llama. A mano: AbortSignal.any recién está desde Node 20.3. */
function attemptSignal(timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; release: () => void } {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!outer) return { signal: timeout, release: () => {} };
  const c = new AbortController();
  const onAbort = (ev: Event) => c.abort((ev.target as AbortSignal).reason);
  if (outer.aborted) c.abort(outer.reason);
  outer.addEventListener("abort", onAbort);
  timeout.addEventListener("abort", onAbort);
  return {
    signal: c.signal,
    release: () => {
      outer.removeEventListener("abort", onAbort);
      timeout.removeEventListener("abort", onAbort);
    },
  };
}

// ───────────────────────────── Cliente ─────────────────────────────

export class CalaSign {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly idempotencyWaitMs: number;
  private readonly userAgent: string;
  private token: { value: string; expiresAt: number } | null = null;

  readonly envelopes: EnvelopesApi;
  readonly templates: TemplatesApi;
  readonly webhooks: WebhooksApi;
  /** Marca blanca: marcas (la de la organización = "default" y sub-marcas), archivos, dominios y vista previa. */
  readonly brands: BrandsApi;
  readonly events: EventsApi;

  constructor(private readonly opts: CalaSignOptions) {
    if (!opts.apiKey && !opts.accessToken && !opts.oauth) throw new Error("CalaSign: falta apiKey, accessToken u oauth");
    this.baseUrl = (opts.baseUrl ?? "https://dev.calasign.com").replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = opts.maxRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.idempotencyWaitMs = opts.idempotencyWaitMs ?? 60_000;
    this.userAgent = opts.userAgent ?? `calasign-node/${VERSION}`;
    this.envelopes = new EnvelopesApi(this);
    this.templates = new TemplatesApi(this);
    this.webhooks = new WebhooksApi(this);
    this.brands = new BrandsApi(this);
    this.events = new EventsApi(this);
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
    // Un expires_in ausente, no numérico, cero o negativo vale 3600 s: con NaN o 0 el token no se reutilizaba y cada
    // pedido a la API pedía antes otro token.
    const ttl = Number(data.expires_in);
    this.token = { value: data.access_token, expiresAt: Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600) * 1000 };
    return this.token.value;
  }

  /** Pedido genérico a la API v1 (para endpoints que el SDK todavía no envuelve). */
  async request<T = any>(method: string, path: string, o: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const idem = o.idempotencyKey;
    const retryable = o.retryable ?? (method === "GET" || method === "PUT" || method === "DELETE" || Boolean(idem));
    // Todo error lleva la Idempotency-Key: quien lo atrapa puede reintentar con la misma sin duplicar.
    const fail = (message: string, status: number, code: string, details?: unknown, requestId?: string | null) =>
      new CalaSignError(message, status, code, details, requestId ?? null, idem ?? null);
    const aborted = () => fail("Pedido cancelado", 0, "aborted");
    let refreshed = false;
    // Las esperas por un 409 idempotency_in_progress tienen su propio tope (en tiempo), aparte de maxRetries.
    let idemWaited = 0;
    let idemWaits = 0;
    for (let attempt = 0; ; attempt++) {
      if (o.signal?.aborted) throw aborted();
      const headers: Record<string, string> = {
        ...Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
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
      const { signal, release } = attemptSignal(this.timeoutMs, o.signal);
      try {
        let res: Response;
        try {
          res = await this.fetchImpl(url, { method, headers, body, signal });
        } catch (err) {
          if (o.signal?.aborted) throw aborted();
          // Error de red: solo se reintenta si el pedido es idempotente (si no, podría duplicarse).
          if (retryable && attempt < this.maxRetries) {
            await sleep(backoff(attempt), o.signal);
            o.onRetry?.();
            continue;
          }
          throw fail(`Error de red: ${(err as Error).message}`, 0, "network_error");
        }
        const requestId = res.headers.get("x-request-id");
        if (res.status === 401 && this.opts.oauth && !refreshed) {
          refreshed = true;
          // Como en los reintentos: el cuerpo descartado libera la conexión.
          await res.body?.cancel().catch(() => {});
          await this.bearer(true);
          attempt--;
          continue;
        }
        let text: string | undefined;
        if (RETRY_STATUS.has(res.status) && attempt < this.maxRetries && (retryable || res.status === 429 || res.status === 503)) {
          const raHeader = res.headers.get("retry-after");
          let retry = true;
          // Un 429 sin Retry-After y con código propio (reminded_recently, form_rate_limited, ai_signer_limit…) es un tope
          // de negocio que no se libera en segundos: no se reintenta. Solo el límite por IP (con Retry-After) sí.
          if (res.status === 429 && !raHeader) {
            text = await res.text().catch(() => "");
            retry = !isBusiness429(text);
          }
          if (retry) {
            // Se descarta el cuerpo: si no, undici deja la conexión tomada hasta que el GC lo junte.
            if (text === undefined) await res.body?.cancel().catch(() => {});
            const ra = Number(raHeader);
            await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : backoff(attempt), o.signal);
            // 408/425/429/503 llegan sin que la API procese el pedido: solo un 500/502/504 pudo haberlo procesado.
            if (MAYBE_PROCESSED_STATUS.has(res.status)) o.onRetry?.();
            continue;
          }
        }
        if (res.status === 204) return undefined as T;
        let bytes: Uint8Array | undefined;
        if (text === undefined) {
          // El cuerpo se lee acá, bajo el mismo timeout y los mismos reintentos que el pedido: un corte a mitad de una
          // descarga es un error de red (no un TypeError/AbortError suelto) y en un GET se reintenta.
          try {
            if (o.raw && res.ok) bytes = new Uint8Array(await res.arrayBuffer());
            else text = await res.text();
          } catch (err) {
            if (o.signal?.aborted) throw aborted();
            if (retryable && attempt < this.maxRetries) {
              await sleep(backoff(attempt), o.signal);
              o.onRetry?.();
              continue;
            }
            throw fail(`Error de red: ${(err as Error).message}`, 0, "network_error", undefined, requestId);
          }
        }
        if (bytes) return { bytes, headers: res.headers } satisfies RawResponse as T;
        let data: any = undefined;
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch {
          /* cuerpo no JSON */
        }
        // El pedido original con esta Idempotency-Key sigue ejecutándose (típico del reintento que el SDK hace después de
        // un timeout): se espera y se repite hasta recibir la respuesta guardada, en vez de fallar con el sobre ya creado.
        if (res.status === 409 && idem && data?.error?.code === "idempotency_in_progress") {
          const wait = backoff(++idemWaits);
          if (idemWaited + wait <= this.idempotencyWaitMs) {
            idemWaited += wait;
            await sleep(wait, o.signal);
            attempt--;
            continue;
          }
        }
        if (!res.ok) {
          const e = data?.error;
          throw fail(e?.message ?? `HTTP ${res.status}`, res.status, e?.code ?? `http_${res.status}`, e?.details, requestId);
        }
        // 2xx que no es JSON (un proxy, una página de error): como el SDK de Python, no se devuelve undefined.
        if (text && data === undefined) throw fail("La respuesta de la API no es JSON válido", res.status, "invalid_response", undefined, requestId);
        return data as T;
      } finally {
        release();
      }
    }
  }
}

/** Códigos del 429 del límite por IP (genérico): cualquier otro código en un 429 es un tope de negocio. */
const GENERIC_429_CODES = new Set(["bad_request", "rate_limited"]);

function isBusiness429(text: string): boolean {
  try {
    const code = JSON.parse(text)?.error?.code;
    return typeof code === "string" && !GENERIC_429_CODES.has(code);
  } catch {
    return false;
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
  /** Rangos de fechas (ISO 8601 o Date): *_from inclusive, *_to exclusivo. */
  createdFrom?: string | Date;
  createdTo?: string | Date;
  /** Sincronización incremental: sobres modificados desde esta fecha. */
  updatedFrom?: string | Date;
  updatedTo?: string | Date;
  sentFrom?: string | Date;
  sentTo?: string | Date;
  completedFrom?: string | Date;
  completedTo?: string | Date;
  /** Pares de metadata que tienen que coincidir (valores string). */
  metadata?: Record<string, string>;
  /** Correo o teléfono E.164 de un destinatario. */
  recipient?: string;
  templateId?: string;
  createdVia?: "api" | "web";
}

const isoOf = (d: string | Date | undefined) => (d instanceof Date ? d.toISOString() : d);

/**
 * Un id como segmento de la ruta. Sin codificar, un id que llega de afuera ("../webhooks", "x?y") cambiaba el pedido:
 * `fetch` resuelve los "..", así que `envelopes.get("../webhooks")` pedía GET /v1/webhooks con la credencial del
 * integrador, y `webhooks.delete("../envelopes/<id>")` borraba un sobre.
 */
/**
 * Bytes de un PDF como Blob. Copia exacta de los bytes de la vista: un Buffer chico de Node es una ventana sobre un
 * pool compartido de 8 KB y su `.buffer` (también el de `buf.slice()`, que no copia) traería todo el pool, con datos
 * de otras partes del proceso.
 */
function toPdfBlob(file: Uint8Array | ArrayBuffer | Blob): Blob {
  if (file instanceof Blob) return file;
  return new Blob([file instanceof ArrayBuffer ? new Uint8Array(file) : Uint8Array.prototype.slice.call(file)], { type: "application/pdf" });
}

/** Documento para `envelopes.create`: además de base64/url/file de la API, `content` con los bytes del PDF. */
export type SdkEnvelopeDocument = InlineDocumentInput | { content: Uint8Array | ArrayBuffer | Blob; name?: string; ref?: string };

/** Cuerpo de POST /v1/envelopes con el sobre completo; los documentos aceptan `content` (bytes). */
export type SdkCreateEnvelopeInput = Omit<CreateEnvelopeRequest, "documents"> & { documents?: SdkEnvelopeDocument[] };

function seg(v: string): string {
  return encodeURIComponent(String(v));
}

class EnvelopesApi {
  constructor(private readonly c: CalaSign) {}

  list(p: ListEnvelopesParams = {}): Promise<ListEnvelopesResponse> {
    const query: Record<string, string | number | undefined> = {
      status: Array.isArray(p.status) ? p.status.join(",") : p.status,
      q: p.q,
      limit: p.limit,
      cursor: p.cursor,
      created_from: isoOf(p.createdFrom),
      created_to: isoOf(p.createdTo),
      updated_from: isoOf(p.updatedFrom),
      updated_to: isoOf(p.updatedTo),
      sent_from: isoOf(p.sentFrom),
      sent_to: isoOf(p.sentTo),
      completed_from: isoOf(p.completedFrom),
      completed_to: isoOf(p.completedTo),
      recipient: p.recipient,
      template_id: p.templateId,
      created_via: p.createdVia,
    };
    // metadata[clave]=valor: una entrada por par (todas tienen que coincidir).
    for (const [k, v] of Object.entries(p.metadata ?? {})) query[`metadata[${k}]`] = v;
    return this.c.request("GET", "/v1/envelopes", { query });
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

  /**
   * Crea un sobre en UNA llamada: solo el borrador (`{ subject }`) o completo, con `documents`, `recipients`, `fields`
   * y, con `send: true`, también enviado. Los documentos pueden ir con `content` (bytes del PDF: se suben como
   * multipart, sin base64), `base64` o `url`. Atómico e idempotente (Idempotency-Key automática): un reintento no
   * crea un segundo sobre. Con firmantes `embedded`, la respuesta trae `signingUrls`.
   */
  create(input: CreateEnvelopeInput | SdkCreateEnvelopeInput, o: { idempotencyKey?: string } = {}): Promise<CreateEnvelopeResponse> {
    const idempotencyKey = o.idempotencyKey ?? randomUUID();
    const docs = (input as SdkCreateEnvelopeInput).documents;
    if (!docs?.some((d) => "content" in d && d.content !== undefined)) {
      return this.c.request("POST", "/v1/envelopes", { body: input, idempotencyKey });
    }
    // Con bytes: multipart/form-data, el JSON en la parte `payload` y cada PDF en su parte (`file`).
    const fd = new FormData();
    const documents = docs.map((d, i) => {
      if (!("content" in d) || d.content === undefined) return d;
      const { content, ...rest } = d;
      const part = `document${i}`;
      fd.append(part, toPdfBlob(content), d.name ?? `documento-${i + 1}.pdf`);
      return { ...rest, file: part };
    });
    fd.set("payload", JSON.stringify({ ...input, documents }));
    return this.c.request("POST", "/v1/envelopes", { form: fd, idempotencyKey });
  }

  /** Como `create` con `send: true`: crea el sobre completo y lo envía en una sola llamada. */
  createAndSend(input: SdkCreateEnvelopeInput, o: { idempotencyKey?: string } = {}): Promise<CreateEnvelopeResponse> {
    return this.create({ ...input, send: true }, o);
  }

  /**
   * Edita el borrador. Con `expectedUpdatedAt`, 409 `version_changed` si alguien lo modificó mientras tanto (y, en ese
   * caso, no se reintenta ante errores de red/5xx: ver `DraftEditOptions`).
   */
  update(id: string, input: UpdateEnvelopeInput, o: DraftEditOptions = {}): Promise<EnvelopeDetail> {
    return this.c.request("PATCH", `/v1/envelopes/${seg(id)}`, draftRequest(o, input, true));
  }

  delete(id: string): Promise<void> {
    return this.c.request("DELETE", `/v1/envelopes/${seg(id)}`);
  }

  uploadDocument(id: string, file: Uint8Array | ArrayBuffer | Blob, filename = "documento.pdf") {
    const fd = new FormData();
    fd.append("file", toPdfBlob(file), filename);
    return this.c.request<EnvelopeDetail["documents"][number]>("POST", `/v1/envelopes/${seg(id)}/documents`, { form: fd });
  }

  removeDocument(id: string, documentId: string): Promise<void> {
    return this.c.request("DELETE", `/v1/envelopes/${seg(id)}/documents/${seg(documentId)}`);
  }

  /** Reemplaza los destinatarios del borrador. Con `expectedUpdatedAt`, 409 `version_changed` si cambió. */
  setRecipients(id: string, recipients: RecipientInput[], o: DraftEditOptions = {}): Promise<EnvelopeDetail> {
    return this.c.request("PUT", `/v1/envelopes/${seg(id)}/recipients`, draftRequest(o, { recipients }, true));
  }

  /** Reemplaza los campos del borrador. Con `expectedUpdatedAt`, 409 `version_changed` si cambió. */
  setFields(id: string, fields: (FieldInput | Record<string, unknown>)[], o: DraftEditOptions = {}): Promise<EnvelopeDetail> {
    return this.c.request("PUT", `/v1/envelopes/${seg(id)}/fields`, draftRequest(o, { fields }, true));
  }

  send(id: string, o: { idempotencyKey?: string } = {}): Promise<EnvelopeDetail> {
    return this.c.request("POST", `/v1/envelopes/${seg(id)}/send`, { idempotencyKey: o.idempotencyKey ?? `send-${seg(id)}` });
  }

  /**
   * Anula el sobre. Se reintenta ante errores de red/5xx; si el primer intento sí llegó a anularlo, el reintento recibe
   * 409 `not_voidable`: en ese caso (solo tras un reintento cuyo intento previo pudo haberse procesado: red o
   * 500/502/504, no 429/503) se confirma con un GET y, si quedó `voided`, se devuelve el
   * detalle. Anular un sobre ya anulado sin reintentos sigue lanzando 409 `not_voidable`.
   */
  async void(id: string, reason: string): Promise<EnvelopeDetail> {
    let retried = false;
    try {
      return await this.c.request("POST", `/v1/envelopes/${seg(id)}/void`, { body: { reason }, retryable: true, onRetry: () => (retried = true) });
    } catch (err) {
      if (retried && err instanceof CalaSignError && err.code === "not_voidable") {
        const detail = await this.get(id);
        if (detail.envelope.status === "voided") return detail;
      }
      throw err;
    }
  }

  remind(id: string): Promise<{ notified: number }> {
    return this.c.request("POST", `/v1/envelopes/${seg(id)}/remind`);
  }

  async events(id: string): Promise<EnvelopeEvent[]> {
    return (await this.c.request<{ items: EnvelopeEvent[] }>("GET", `/v1/envelopes/${seg(id)}/events`)).items;
  }

  /** PDF sellado (solo con el sobre completado). */
  async downloadSigned(id: string): Promise<Uint8Array> {
    return (await this.c.request<RawResponse>("GET", `/v1/envelopes/${seg(id)}/signed.pdf`, { raw: true })).bytes;
  }

  /**
   * URL de firma (5 min, un solo uso) de un destinatario: embebida (`embedded: true`, en un iframe con
   * `frameAncestors`) o no (para abrirla en una pestaña o redirigir). Devuelve `{ url, expiresAt, tabOnly? }`:
   * `tabOnly: true` para destinatarios con OTP, que no se pueden embeber (abrir en pestaña/redirigir); pedir
   * `frameAncestors` para ellos da 409 `otp_not_embeddable`. Embebida, la página avisa por `postMessage` los eventos
   * `viewed`, `signing_complete`, `declined`, `error` y `closed` (este último con `status`).
   */
  signingUrl(envelopeId: string, recipientId: string, input: CreateSigningUrlInput = {}): Promise<SigningUrlResponse> {
    return this.c.request("POST", `/v1/envelopes/${seg(envelopeId)}/recipients/${seg(recipientId)}/signing-url`, { body: input });
  }

  /** Valores completados por destinatario y vista plana etiqueta → valor. */
  formData(id: string): Promise<EnvelopeFormData> {
    return this.c.request("GET", `/v1/envelopes/${seg(id)}/form-data`);
  }

  /** Archivo que subió un firmante en un campo de adjunto. */
  async downloadAttachment(id: string, fieldId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const res = await this.c.request<RawResponse>("GET", `/v1/envelopes/${seg(id)}/attachments/${seg(fieldId)}`, { raw: true });
    return { bytes: res.bytes, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  /** Clona el sobre (en cualquier estado) como borrador nuevo. */
  clone(id: string, input: CloneEnvelopeInput = {}): Promise<EnvelopeDetail> {
    return this.c.request("POST", `/v1/envelopes/${seg(id)}/clone`, { body: input });
  }

  /** Operación en lote (get, void, remind, delete) sobre hasta 100 sobres; un resultado por id. */
  batch(input: EnvelopeBatchInput): Promise<EnvelopeBatchResponse> {
    // get es seguro de reintentar; void/remind/delete no (un reintento repetiría la operación en los que ya salieron).
    return this.c.request("POST", "/v1/envelopes/batch", { body: input, retryable: input.action === "get" });
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

  /** Rota el secreto. Durante `graceHours` (por defecto 24) las entregas llevan firmas con el nuevo y el anterior. */
  rotateSecret(id: string, o: { graceHours?: number } = {}): Promise<CreateWebhookResponse> {
    return this.c.request("POST", `/v1/webhooks/${seg(id)}/rotate-secret`, { body: o });
  }
}

export interface ListEventsParams {
  /** Cursor (`nextCursor` del pedido anterior). */
  after?: string | null;
  /** Sin `after`: desde esta fecha (por defecto, últimas 24 h). */
  since?: string | Date;
  types?: string[];
  envelopeId?: string;
  /** "all": todos los tipos de evidencia, no solo los de webhooks. */
  scope?: "webhook" | "all";
  limit?: number;
}

class EventsApi {
  constructor(private readonly c: CalaSign) {}

  /** Una página de eventos, del más viejo al más nuevo. Guardá `nextCursor` y pasalo como `after`. */
  list(p: ListEventsParams = {}): Promise<ListEventsResponse> {
    return this.page(p);
  }

  private page(p: ListEventsParams, signal?: AbortSignal): Promise<ListEventsResponse> {
    return this.c.request("GET", "/v1/events", {
      query: { after: p.after ?? undefined, since: isoOf(p.since), types: p.types?.join(","), envelope_id: p.envelopeId, scope: p.scope, limit: p.limit },
      signal,
    });
  }

  /**
   * Polling continuo: `for await (const ev of cs.events.poll({ after: savedCursor }))`. Espera `intervalMs` cuando no
   * hay eventos nuevos. Corta con `signal`: la espera y el pedido en curso se cancelan y el iterador termina enseguida
   * (sin lanzar). Guardá `ev.cursor` después de procesar cada evento.
   */
  async *poll(p: ListEventsParams & { intervalMs?: number; signal?: AbortSignal } = {}): AsyncGenerator<ApiEvent> {
    const { signal } = p;
    let after = p.after ?? undefined;
    while (!signal?.aborted) {
      let page: ListEventsResponse;
      try {
        page = await this.page({ ...p, after }, signal);
      } catch (err) {
        if (signal?.aborted) return;
        throw err;
      }
      for (const ev of page.items) {
        yield ev;
        if (signal?.aborted) return;
      }
      after = page.nextCursor ?? after;
      if (!page.hasMore) await sleep(p.intervalMs ?? 5000, signal);
    }
  }
}

class BrandsApi {
  constructor(private readonly c: CalaSign) {}

  async list(): Promise<Brand[]> {
    return (await this.c.request<{ items: Brand[] }>("GET", "/v1/settings/brands", { retryable: true })).items;
  }

  /** `id`: "default" (marca de la organización) o el id de una sub-marca. */
  get(id = "default"): Promise<Brand> {
    return this.c.request("GET", `/v1/settings/brands/${seg(id)}`, { retryable: true });
  }

  /** Sub-marca (cliente de una organización revendedora). Usala al crear sobres con `brandId`. */
  create(input: { name: string; config?: BrandConfigInput }): Promise<Brand> {
    return this.c.request("POST", "/v1/settings/brands", { body: input });
  }

  /** Reemplaza la configuración entera (hacé get, modificá y update). */
  update(id: string, input: { name?: string; config: BrandConfigInput }): Promise<Brand> {
    return this.c.request("PUT", `/v1/settings/brands/${seg(id)}`, { body: input, retryable: true });
  }

  delete(id: string): Promise<void> {
    return this.c.request("DELETE", `/v1/settings/brands/${seg(id)}`);
  }

  /** Vista previa de un correo (asunto, HTML, texto, remitente) con configuración opcional sin guardar. */
  preview(id: string, input: Partial<BrandPreviewInput> = {}): Promise<BrandEmailPreview & { theme?: PublicBrandTheme }> {
    return this.c.request("POST", `/v1/settings/brands/${seg(id)}/preview`, { body: input });
  }

  /** Sube logo, logoDark, favicon o font. */
  uploadAsset(id: string, kind: BrandAssetKind, file: Uint8Array | ArrayBuffer | Blob, filename = kind, contentType = "application/octet-stream"): Promise<Brand> {
    const fd = new FormData();
    const blob = file instanceof Blob ? file : new Blob([file instanceof ArrayBuffer ? new Uint8Array(file) : Uint8Array.prototype.slice.call(file)], { type: contentType });
    fd.append("file", blob, filename);
    return this.c.request("POST", `/v1/settings/brands/${seg(id)}/assets/${seg(kind)}`, { form: fd });
  }

  deleteAsset(id: string, kind: BrandAssetKind): Promise<Brand> {
    return this.c.request("DELETE", `/v1/settings/brands/${seg(id)}/assets/${seg(kind)}`);
  }

  setDomain(id: string, domain: string): Promise<{ domain: BrandDomain }> {
    return this.c.request("PUT", `/v1/settings/brands/${seg(id)}/domain`, { body: { domain } });
  }

  verifyDomain(id: string): Promise<{ domain: BrandDomain }> {
    return this.c.request("POST", `/v1/settings/brands/${seg(id)}/domain/verify`);
  }

  async listEmailDomains(): Promise<EmailDomain[]> {
    return (await this.c.request<{ items: EmailDomain[] }>("GET", "/v1/settings/email-domains", { retryable: true })).items;
  }

  /** Devuelve los registros DNS (TXT de propiedad, DKIM, SPF, DMARC) a publicar. */
  addEmailDomain(domain: string): Promise<EmailDomain> {
    return this.c.request("POST", "/v1/settings/email-domains", { body: { domain } });
  }

  verifyEmailDomain(domain: string): Promise<EmailDomain> {
    return this.c.request("POST", `/v1/settings/email-domains/${seg(domain)}/verify`);
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
  // `t=<unix>,v1=<hex>[,v1=<hex>]`: durante la rotación del secreto llegan dos v1 (nuevo y anterior).
  const pairs = i.header.split(",").map((kv) => {
    const k = kv.indexOf("=");
    return [kv.slice(0, k).trim(), kv.slice(k + 1).trim()] as const;
  });
  const t = Number(pairs.find(([k]) => k === "t")?.[1]);
  const v1s = pairs.filter(([k, v]) => k === "v1" && v).map(([, v]) => v);
  if (!Number.isFinite(t) || !v1s.length) throw new WebhookSignatureError("Header de firma mal formado");
  const now = Math.floor((i.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > (i.toleranceSec ?? 300)) throw new WebhookSignatureError("Firma fuera de la tolerancia de tiempo");
  const body = typeof i.payload === "string" ? i.payload : Buffer.from(i.payload).toString("utf8");
  const expected = createHmac("sha256", i.secret).update(`${t}.${body}`).digest("hex");
  const a = Buffer.from(expected);
  const ok = v1s.some((v) => {
    const b = Buffer.from(v);
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!ok) throw new WebhookSignatureError("Firma inválida");
  try {
    return JSON.parse(body) as WebhookEventPayload;
  } catch {
    // Como el SDK de Python: quien atrapa WebhookSignatureError no recibe un SyntaxError suelto.
    throw new WebhookSignatureError("El cuerpo del webhook no es JSON válido");
  }
}

export default CalaSign;
