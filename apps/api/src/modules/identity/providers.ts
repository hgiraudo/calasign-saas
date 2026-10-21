// Adaptadores de verificación de identidad. Todos devuelven un resultado normalizado (IdvResult).
//   mock    → captura integrada en CalaSign y decisión determinística configurable (pruebas y demos)
//   veriff  → sesión alojada en Veriff (REST + webhook firmado con HMAC-SHA256)
//   truora  → proceso de Digital Identity de Truora (link web + webhook JWT HS256)
// Las URLs y nombres de campos siguen la documentación pública de cada proveedor; validar contra su sandbox
// al activar cada integración.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IdvCaptureKind, IdvLevel, IdvProvider, IdvResult, IdentityProviderInfo, IdentitySettings } from "@calasign/shared";
import { requiredCaptures } from "@calasign/shared";
import { config } from "../../config";

export interface CreateSessionInput {
  verificationId: string;
  level: IdvLevel;
  person: { fullName: string; documentNumber: string | null; email: string | null; phone: string | null };
  /** A dónde vuelve el firmante al terminar en la página del proveedor. */
  returnUrl: string;
  /** Webhook de resultados. */
  callbackUrl: string;
  locale: string;
}

export interface WebhookParseResult {
  /** provider_ref de la verificación. */
  providerRef: string;
  /** Resultado si ya vino completo; null si hay que pedirlo con fetchResult. */
  result: IdvResult | null;
  /** Id de proceso adicional (Truora) para consultar el resultado. */
  processId?: string | null;
}

export interface IdvAdapter {
  id: IdvProvider;
  name: string;
  mode: "builtin" | "redirect";
  configured(): boolean;
  createSession?(input: CreateSessionInput): Promise<{ providerRef: string; redirectUrl: string | null }>;
  fetchResult?(providerRef: string, processId?: string | null): Promise<IdvResult>;
  /**
   * Verifica la firma y extrae los resultados (un webhook de Truora puede traer varios eventos, de distintas
   * verificaciones). Lanza si la firma no es válida.
   */
  parseWebhook?(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookParseResult[];
}

export class WebhookSignatureError extends Error {}

const emptyResult = (status: IdvResult["status"], reference: string | null): IdvResult => ({
  status,
  document: { type: null, number: null, country: null, expiresOn: null },
  person: { firstName: null, lastName: null, fullName: null, birthDate: null },
  faceMatchScore: null,
  liveness: null,
  riskFlags: [],
  reference,
  declineReason: null,
});

function header(h: Record<string, string | string[] | undefined>, name: string): string {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a.trim().toLowerCase(), "utf8");
  const y = Buffer.from(b.trim().toLowerCase(), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  const half = Math.ceil(parts.length / 2);
  return { first: parts.slice(0, half).join(" "), last: parts.slice(half).join(" ") };
}

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(`${new URL(url).host} respondió HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

// ───────────────────────────── Mock ─────────────────────────────

export interface MockCapture {
  kind: IdvCaptureKind;
  sha256: string;
}

/** Decisión determinística del proveedor de prueba. */
export function mockDecide(
  level: IdvLevel,
  captures: MockCapture[],
  settings: IdentitySettings["mock"],
  declared: { name: string; documentNumber: string | null },
  verificationId: string,
): IdvResult {
  const have = new Map(captures.map((c) => [c.kind, c.sha256]));
  const missing = requiredCaptures(level).filter((k) => !have.has(k));
  const r = emptyResult("approved", `mock-${verificationId}`);
  if (missing.length) return { ...r, status: "declined", declineReason: `missing_captures:${missing.join(",")}` };

  const fullName = settings.extractedName?.trim() || declared.name;
  const { first, last } = splitName(fullName);
  r.person = { firstName: first, lastName: last || null, fullName, birthDate: "1990-01-01" };
  r.document = {
    type: "national_id",
    number: settings.extractedDocumentNumber?.trim() || declared.documentNumber || `MOCK${(have.get("document_front") ?? "").slice(0, 8).toUpperCase()}`,
    country: null,
    expiresOn: "2032-12-31",
  };
  if (have.get("document_front") === have.get("document_back")) {
    return { ...r, status: "declined", declineReason: "document_front_back_identical", riskFlags: ["duplicate_image"] };
  }
  if (settings.decision === "reject_document") return { ...r, status: "declined", declineReason: "document_unreadable", riskFlags: ["document_quality"] };

  if (level !== "document") {
    r.faceMatchScore = settings.decision === "reject_face" ? 0.31 : 0.93;
    if (settings.decision === "reject_face") return { ...r, status: "declined", declineReason: "face_mismatch", riskFlags: ["face_mismatch"] };
  }
  if (level === "document_selfie_liveness") {
    // Prueba de vida: dos capturas de la cara distintas (el firmante se movió a pedido).
    const live = have.get("selfie") !== have.get("selfie_liveness") && settings.decision !== "reject_liveness";
    r.liveness = live;
    if (!live) return { ...r, status: "declined", declineReason: "liveness_failed", riskFlags: ["liveness"] };
  }
  return r;
}

const mockAdapter: IdvAdapter = {
  id: "mock",
  name: "CalaSign (prueba)",
  mode: "builtin",
  configured: () => true,
};

// ───────────────────────────── Veriff ─────────────────────────────

const VERIFF_STATUS: Record<string, IdvResult["status"]> = {
  approved: "approved",
  declined: "declined",
  // Veriff pide volver a enviar fotos en la MISMA sesión (la URL sigue sirviendo): no es una decisión final. Queda en
  // revisión y la decisión que llegue después para la misma sesión la reemplaza.
  resubmission_requested: "review",
  expired: "declined",
  abandoned: "declined",
  review: "review",
};

/** Normaliza un `verification` de Veriff (decision webhook o GET /decision). */
export function mapVeriffDecision(v: any): IdvResult {
  const status = VERIFF_STATUS[String(v?.status ?? "")] ?? "pending";
  const p = v?.person ?? {};
  const d = v?.document ?? {};
  const first = p.firstName ?? null;
  const last = p.lastName ?? null;
  const risk: string[] = [];
  for (const l of v?.riskLabels ?? []) if (l?.label) risk.push(String(l.label));
  if (v?.status === "resubmission_requested") risk.push("resubmission_requested");
  return {
    status,
    document: { type: d.type ?? null, number: d.number ?? p.idNumber ?? null, country: d.country ?? null, expiresOn: d.validUntil ?? null },
    person: { firstName: first, lastName: last, fullName: [first, last].filter(Boolean).join(" ") || null, birthDate: p.dateOfBirth ?? null },
    faceMatchScore: typeof v?.faceMatch?.similarity === "number" ? v.faceMatch.similarity : null,
    liveness: typeof v?.liveness === "boolean" ? v.liveness : null,
    riskFlags: risk,
    reference: v?.id ?? null,
    declineReason: status === "approved" ? null : v?.reason ?? v?.status ?? null,
  };
}

function veriffConfig() {
  return {
    base: (process.env.VERIFF_BASE_URL ?? "https://stationapi.veriff.com").replace(/\/$/, ""),
    key: process.env.VERIFF_API_KEY ?? "",
    secret: process.env.VERIFF_SHARED_SECRET ?? "",
  };
}

export function veriffSignature(payload: string | Buffer, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

const veriffAdapter: IdvAdapter = {
  id: "veriff",
  name: "Veriff",
  mode: "redirect",
  configured: () => Boolean(veriffConfig().key && veriffConfig().secret),
  async createSession(input) {
    const c = veriffConfig();
    const { first, last } = splitName(input.person.fullName);
    const body = await fetchJson(`${c.base}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AUTH-CLIENT": c.key },
      body: JSON.stringify({
        verification: {
          callback: input.returnUrl,
          person: { firstName: first, lastName: last || undefined, idNumber: input.person.documentNumber ?? undefined },
          vendorData: input.verificationId,
        },
      }),
    });
    const v = body?.verification;
    if (!v?.id || !v?.url) throw new Error("Veriff: respuesta sin verification.id / url");
    return { providerRef: String(v.id), redirectUrl: String(v.url) };
  },
  async fetchResult(providerRef) {
    const c = veriffConfig();
    const body = await fetchJson(`${c.base}/v1/sessions/${encodeURIComponent(providerRef)}/decision`, {
      headers: { "X-AUTH-CLIENT": c.key, "X-HMAC-SIGNATURE": veriffSignature(providerRef, c.secret) },
    });
    if (!body?.verification) return emptyResult("pending", providerRef);
    return mapVeriffDecision(body.verification);
  },
  parseWebhook(raw, headers) {
    const c = veriffConfig();
    const sig = header(headers, "x-hmac-signature");
    if (!sig || !c.secret || !safeEqualHex(sig, veriffSignature(raw, c.secret))) throw new WebhookSignatureError("firma de Veriff inválida");
    const body = JSON.parse(raw.toString("utf8"));
    // Decision webhook: { status, verification: {...} }. Event webhook (started/submitted): { id, action, ... }.
    if (body?.verification?.id) return [{ providerRef: String(body.verification.id), result: mapVeriffDecision(body.verification) }];
    if (body?.id) return [{ providerRef: String(body.id), result: null }];
    throw new Error("Veriff: webhook sin id de sesión");
  },
};

// ───────────────────────────── Truora ─────────────────────────────

/**
 * Flujo de Truora para un nivel: TRUORA_FLOW_ID_<NIVEL> (p. ej. TRUORA_FLOW_ID_DOCUMENT_SELFIE_LIVENESS) y, si no está,
 * TRUORA_FLOW_ID. Cada flujo se arma en el panel de Truora con las validaciones del nivel (documento; documento +
 * reconocimiento facial; documento + reconocimiento facial con prueba de vida). Igual se controla el resultado
 * (finalizeVerification): un flujo que no incluye lo que pide el nivel termina en level_not_met.
 */
export function truoraFlowId(level: IdvLevel): string {
  return process.env[`TRUORA_FLOW_ID_${level.toUpperCase()}`] || process.env.TRUORA_FLOW_ID || "";
}

function truoraConfig() {
  return {
    accountBase: (process.env.TRUORA_ACCOUNT_URL ?? "https://api.account.truora.com").replace(/\/$/, ""),
    identityBase: (process.env.TRUORA_IDENTITY_URL ?? "https://api.identity.truora.com").replace(/\/$/, ""),
    webBase: (process.env.TRUORA_WEB_URL ?? "https://identity.truora.com").replace(/\/$/, ""),
    key: process.env.TRUORA_API_KEY ?? "",
    flowId: process.env.TRUORA_FLOW_ID ?? "",
    webhookSecret: process.env.TRUORA_WEBHOOK_SECRET ?? "",
  };
}

const TRUORA_STATUS: Record<string, IdvResult["status"]> = { success: "approved", failure: "declined", pending: "pending", expired: "declined" };

/** Normaliza el resultado de un proceso de Digital Identity de Truora (GET /v1/processes/{id}/result). */
export function mapTruoraProcess(p: any): IdvResult {
  const status = TRUORA_STATUS[String(p?.status ?? "")] ?? "pending";
  const validations: any[] = Array.isArray(p?.validations) ? p.validations : [];
  const docV = validations.find((v) => v?.validation_type === "document-validation");
  const faceV = validations.find((v) => v?.validation_type === "face-recognition");
  const dd = docV?.details?.document_details ?? {};
  const fr = faceV?.details?.face_recognition_validations ?? {};
  const first = dd.name ?? null;
  const last = dd.last_name ?? null;
  const risk: string[] = [];
  for (const v of validations) if (v?.validation_status && v.validation_status !== "success") risk.push(`${v.validation_type}:${v.validation_status}`);
  const liveness =
    typeof fr.passive_liveness_status === "string" ? fr.passive_liveness_status === "success" : typeof fr.liveness === "boolean" ? fr.liveness : null;
  // Decisión explícita de la validación facial (cuando no viene el puntaje de similitud).
  const faceStatus = typeof fr.similarity_status === "string" ? fr.similarity_status : faceV?.validation_status;
  const faceMatched = typeof faceStatus === "string" ? faceStatus === "success" : null;
  return {
    status,
    document: { type: dd.document_type ?? null, number: dd.document_number ?? null, country: dd.country ?? null, expiresOn: dd.expiration_date ?? null },
    person: { firstName: first, lastName: last, fullName: [first, last].filter(Boolean).join(" ") || null, birthDate: dd.date_of_birth ?? null },
    faceMatchScore: typeof fr.confidence_score === "number" ? fr.confidence_score : null,
    faceMatched,
    liveness,
    riskFlags: risk,
    reference: p?.process_id ?? null,
    declineReason: status === "approved" ? null : p?.declined_reason ?? p?.failure_status ?? null,
  };
}

/** Verifica un JWT HS256 (formato de los webhooks de Truora) y devuelve su payload. */
export function verifyHs256Jwt(token: string, secret: string): any {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new WebhookSignatureError("JWT mal formado");
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  if (header.alg !== "HS256") throw new WebhookSignatureError("algoritmo de JWT no admitido");
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, "base64url");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new WebhookSignatureError("firma de Truora inválida");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now() - 60_000) throw new WebhookSignatureError("JWT vencido");
  return payload;
}

const truoraAdapter: IdvAdapter = {
  id: "truora",
  name: "Truora",
  mode: "redirect",
  configured: () =>
    Boolean(truoraConfig().key && truoraConfig().webhookSecret && (truoraConfig().flowId || Object.keys(process.env).some((k) => k.startsWith("TRUORA_FLOW_ID_") && process.env[k]))),
  async createSession(input) {
    const c = truoraConfig();
    const flowId = truoraFlowId(input.level);
    if (!flowId) throw new Error(`Truora: falta TRUORA_FLOW_ID (o TRUORA_FLOW_ID_${input.level.toUpperCase()}) para el nivel ${input.level}`);
    // account_id = id de nuestra verificación: Truora lo devuelve en los webhooks y une el proceso con la verificación.
    const form = new URLSearchParams({
      key_type: "web",
      grant: "digital-identity",
      api_key_version: "1",
      country: "ALL",
      redirect_url: input.returnUrl,
      flow_id: flowId,
      account_id: input.verificationId,
    });
    const body = await fetchJson(`${c.accountBase}/v1/api-keys`, {
      method: "POST",
      headers: { "Truora-API-Key": c.key, "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!body?.api_key) throw new Error("Truora: respuesta sin api_key");
    return { providerRef: input.verificationId, redirectUrl: `${c.webBase}/?token=${encodeURIComponent(body.api_key)}` };
  },
  // Sin process_id (el webhook todavía no llegó) no se consulta: la API de Digital Identity consulta resultados por
  // process_id y no documenta una búsqueda por account_id. El resultado llega por el webhook y, si no llega nunca, la
  // verificación vence por provider_timeout (expireStaleVerifications) sin consumir un intento.
  async fetchResult(_providerRef, processId) {
    if (!processId) return emptyResult("pending", null);
    const c = truoraConfig();
    const body = await fetchJson(`${c.identityBase}/v1/processes/${encodeURIComponent(processId)}/result`, {
      headers: { "Truora-API-Key": c.key },
    });
    return mapTruoraProcess(body);
  },
  parseWebhook(raw) {
    const c = truoraConfig();
    if (!c.webhookSecret) throw new WebhookSignatureError("Truora sin secreto de webhook");
    const payload = verifyHs256Jwt(raw.toString("utf8"), c.webhookSecret);
    // Un webhook puede traer varios eventos (de distintas verificaciones): se procesan todos, no solo el primero.
    const events: any[] = Array.isArray(payload?.events) ? payload.events : [payload];
    const out: WebhookParseResult[] = [];
    for (const ev of events) {
      const obj = ev?.object ?? {};
      if (!obj.account_id) continue;
      // El evento trae el estado; el detalle de las validaciones se consulta con el process_id.
      const terminal = ["success", "failure", "expired"].includes(String(obj.status ?? ""));
      out.push({
        providerRef: String(obj.account_id),
        result: terminal && Array.isArray(obj.validations) ? mapTruoraProcess(obj) : null,
        processId: obj.process_id ?? null,
      });
    }
    if (!out.length) throw new Error("Truora: webhook sin account_id");
    return out;
  },
};

// ───────────────────────── Capacidades de la integración ─────────────────────────

const LEVEL_RANK: Record<IdvLevel, number> = { document: 0, document_selfie: 1, document_selfie_liveness: 2 };

/**
 * Qué controles declara hacer la integración del proveedor para el nivel pedido (null = no declara nada: el resultado
 * tiene que traer la coincidencia facial y la prueba de vida explícitas).
 *   veriff → VERIFF_INTEGRATION_LEVEL si está definida explícitamente (la integración del panel de Veriff es una sola
 *            para todos los sobres); sin definir, null: no se infiere nada.
 *   truora → el nivel pedido, si hay un flujo propio para ese nivel (TRUORA_FLOW_ID_<NIVEL>): el flujo se arma con las
 *            validaciones del nivel. El flujo genérico (TRUORA_FLOW_ID) no declara nada.
 *   mock   → null (decide con las capturas y devuelve los datos explícitos)
 */
export function integrationLevel(provider: IdvProvider, level: IdvLevel): IdvLevel | null {
  if (provider === "veriff") return config.identity.veriffIntegrationLevel;
  if (provider === "truora") return process.env[`TRUORA_FLOW_ID_${level.toUpperCase()}`] ? level : null;
  return null;
}

/**
 * Lo que se guarda en identity_verifications.integration_level al iniciar una verificación: el nivel que la
 * integración declara explícitamente en ese momento, o "none" si no declara nada (Veriff sin VERIFF_INTEGRATION_LEVEL).
 * NULL queda solo para filas anteriores a la columna y se trata igual que "none".
 */
export function integrationLevelToStore(provider: IdvProvider, level: IdvLevel): IdvLevel | "none" {
  return integrationLevel(provider, level) ?? "none";
}

/** Avisos de configuración de identidad al arrancar (API y worker). */
export function warnIdentityConfig(log: { warn: (msg: string) => void }) {
  if (veriffAdapter.configured() && !config.identity.veriffIntegrationLevel) {
    log.warn(
      "VERIFF_INTEGRATION_LEVEL no está definida (o no es válida): no se infiere ningún control de la integración de Veriff y solo se ofrece el nivel document (los destinatarios con selfie o prueba de vida no se pueden pedir ni enviar con Veriff). Definila explícitamente con lo que hace la integración del panel de Veriff (document, document_selfie o document_selfie_liveness)",
    );
  }
}

/**
 * Por qué el proveedor (ya configurado) no puede hacer el nivel pedido, o null si puede: Truora sin flujo para el nivel
 * (createSession fallaba con un 500 al iniciar) o Veriff con una integración que no llega al nivel. Veriff sin
 * VERIFF_INTEGRATION_LEVEL solo llega a "document": no se infiere nada y la decisión de Veriff no suele traer el puntaje
 * facial ni la prueba de vida, así que una verificación con selfie terminaría siempre en level_not_met (el firmante
 * quedaría trabado). Se rechaza antes, al pedirla y al enviar, con un mensaje para el remitente.
 */
export function levelUnsupportedReason(provider: IdvProvider, level: IdvLevel): string | null {
  if (provider === "truora" && !truoraFlowId(level)) {
    return `Truora no tiene un flujo configurado para el nivel ${level} (TRUORA_FLOW_ID_${level.toUpperCase()} o TRUORA_FLOW_ID)`;
  }
  if (provider === "veriff") {
    const declared = config.identity.veriffIntegrationLevel;
    if (!declared && LEVEL_RANK[level] > 0) {
      return `VERIFF_INTEGRATION_LEVEL no está definida en el servidor y el destinatario pide ${level}: sin declararla, Veriff solo se ofrece para el nivel document. Si la integración del panel de Veriff hace ese control, definí VERIFF_INTEGRATION_LEVEL=${level}; si no, pedí otro nivel o proveedor`;
    }
    if (declared && LEVEL_RANK[declared] < LEVEL_RANK[level]) {
      return `La integración de Veriff declara el nivel ${declared} y el destinatario pide ${level}: si la integración del panel de Veriff hace ese control, definí VERIFF_INTEGRATION_LEVEL=${level} en el servidor; si no, pedí otro nivel o proveedor`;
    }
  }
  return null;
}

/**
 * Completa una aprobación con lo que la integración declara hacer: la decisión de Veriff no suele traer
 * faceMatch.similarity ni un booleano de prueba de vida, y sin esto toda aprobación de un nivel con selfie terminaba en
 * level_not_met. Solo con un nivel declarado explícitamente (nunca se infiere sin declaración). Un dato contrario
 * explícito gana: un puntaje facial bajo el umbral, faceMatched = false o liveness = false no se pisan. Devuelve también
 * qué se infirió (va a la evidencia).
 */
export function withIntegrationCapabilities(
  provider: IdvProvider,
  level: IdvLevel,
  result: IdvResult,
  faceThreshold = config.identity.faceMatchThreshold,
  /**
   * El nivel guardado al iniciar la verificación (integration_level): un cambio posterior de VERIFF_INTEGRATION_LEVEL o
   * de los flujos de Truora no cambia lo que se infiere de una verificación en curso. undefined = la configuración
   * actual (solo para usos sin fila); null (filas anteriores a la columna) y "none" = no se infiere nada.
   */
  storedIntegrationLevel?: string | null,
): { result: IdvResult; inferred: ("faceMatched" | "liveness")[] } {
  const declared =
    storedIntegrationLevel === undefined
      ? integrationLevel(provider, level)
      : storedIntegrationLevel && storedIntegrationLevel in LEVEL_RANK
        ? (storedIntegrationLevel as IdvLevel)
        : null;
  const cap = result.status === "approved" ? declared : null;
  if (!cap) return { result, inferred: [] };
  const out = { ...result };
  const inferred: ("faceMatched" | "liveness")[] = [];
  const score = typeof result.faceMatchScore === "number" ? result.faceMatchScore : null;
  if (LEVEL_RANK[cap] >= 1 && result.faceMatched == null && (score === null || score >= faceThreshold)) {
    out.faceMatched = true;
    inferred.push("faceMatched");
  }
  if (LEVEL_RANK[cap] >= 2 && result.liveness == null) {
    out.liveness = true;
    inferred.push("liveness");
  }
  return { result: out, inferred };
}

// ───────────────────────────── Registro ─────────────────────────────

const ADAPTERS: Record<IdvProvider, IdvAdapter> = { mock: mockAdapter, veriff: veriffAdapter, truora: truoraAdapter };

export function getAdapter(id: IdvProvider): IdvAdapter {
  return ADAPTERS[id];
}

export function listProviders(): IdentityProviderInfo[] {
  return Object.values(ADAPTERS).map((a) => ({ id: a.id, name: a.name, configured: a.configured(), mode: a.mode }));
}
