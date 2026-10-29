// Reglas comunes de la IA: opt-in por organización, aviso de tratamiento de datos, presupuesto mensual
// de tokens, registro de consumo, evidencia de cada interacción y texto de los documentos.
import { extractPdfText, InvalidPdfError, PdfReaderBusyError } from "@calasign/pdf";
import {
  AI_NOTICE_VERSION,
  type AiFeature,
  type AiSentSummary,
  type AiSettings,
  type AiUsageInfo,
  type AiUsageSummary,
  type ContractMetadata,
} from "@calasign/shared";
import type { Db } from "../../infra/db";
import { appendEvent, type Actor } from "../../infra/evidence";
import type { BlobStore } from "../../infra/storage";
import { AppError } from "../../lib/errors";
import { iso, uuidv7 } from "../../lib/util";
import { aiProviderStatus, getAiProvider, AiCallError, AiOutputError, AiRefusalError, AiTimeoutError, type ProviderUsage } from "./provider";
import { aiNotIncludedError, effectiveAiBudget, planById } from "../billing/plans";
import { docsToText, estimateTokens, type DocText } from "./heuristics";

export const DISCLAIMER: Record<string, string> = {
  es: "Generado con IA a partir del documento. Puede contener errores y no es asesoramiento legal: ante dudas, leé el documento completo o consultá a un profesional.",
  "pt-BR":
    "Gerado com IA a partir do documento. Pode conter erros e não é aconselhamento jurídico: em caso de dúvida, leia o documento completo ou consulte um profissional.",
  en: "AI-generated from the document. It may contain errors and is not legal advice: if in doubt, read the full document or consult a professional.",
};

// El texto del documento se envía tal cual (puede incluir datos personales que figuren en él) y, al preguntar, también
// la pregunta: el aviso no puede decir que "no se envían tus datos personales".
export const SIGNER_NOTICE: Record<string, string> = {
  es: "Al usar esta función, el texto del documento (y tu pregunta, si preguntás) se envía a un proveedor de IA para generar la respuesta. No se envían otros datos del sobre: ni tu firma, ni tus datos de contacto, ni los demás destinatarios.",
  "pt-BR":
    "Ao usar esta função, o texto do documento (e a sua pergunta, se perguntar) é enviado a um provedor de IA para gerar a resposta. Nenhum outro dado do envelope é enviado: nem a sua assinatura, nem os seus dados de contato, nem os demais destinatários.",
  en: "When you use this feature, the document text (and your question, if you ask one) is sent to an AI provider to generate the answer. No other envelope data is sent: not your signature, your contact details or the other recipients.",
};

export const disclaimerFor = (l: string | null | undefined) => DISCLAIMER[l ?? "es"] ?? DISCLAIMER.es;

// ───────────────────────────── Configuración ─────────────────────────────

export async function monthUsage(db: Db, tenantId: string): Promise<AiUsageSummary> {
  const rows = await db.query<any>(
    `SELECT feature, count(*)::int AS n, COALESCE(sum(input_tokens), 0)::int AS i, COALESCE(sum(output_tokens), 0)::int AS o
     FROM ai_usage WHERE tenant_id = $1 AND created_at >= date_trunc('month', now()) AND feature <> '${RESERVATION}' GROUP BY feature`,
    [tenantId],
  );
  const inputTokens = rows.reduce((s, r) => s + Number(r.i), 0);
  const outputTokens = rows.reduce((s, r) => s + Number(r.o), 0);
  return {
    month: new Date().toISOString().slice(0, 7),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    byFeature: rows.map((r) => ({ feature: r.feature, requests: Number(r.n), tokens: Number(r.i) + Number(r.o) })),
  };
}

export async function getAiSettings(db: Db, tenantId: string): Promise<AiSettings> {
  const t = await db.one<any>(`SELECT * FROM tenants WHERE id = $1`, [tenantId]);
  const p = aiProviderStatus();
  const plan = planById(t?.billing_plan ?? null);
  const budget = Number(t?.ai_monthly_token_budget ?? 0);
  return {
    enabled: Boolean(t?.ai_enabled),
    provider: p.name,
    model: p.model,
    monthlyTokenBudget: budget,
    planTokenCap: plan.aiTokensPerMonth,
    effectiveTokenBudget: effectiveAiBudget(plan, budget),
    autoExtractMetadata: Boolean(t?.ai_auto_extract),
    renewalAlertDays: Number(t?.ai_renewal_alert_days ?? 30),
    playbook: Array.isArray(t?.ai_playbook) ? t.ai_playbook : [],
    noticeVersion: AI_NOTICE_VERSION,
    noticeAcceptedAt: iso(t?.ai_notice_accepted_at),
    noticeAcceptedBy: t?.ai_notice_accepted_by ?? null,
    noticeAcceptedVersion: t?.ai_notice_version ?? null,
    usage: await monthUsage(db, tenantId),
  };
}

// Reserva de presupuesto: cada llamada en curso cuenta como RESERVATION_TOKENS hasta que se registra su consumo
// real. El chequeo y la reserva se hacen con la organización bloqueada, así que pedidos concurrentes no pueden
// pasarse del tope por más de una llamada. Una reserva que nunca se registra (falla del modelo) vence sola.
export const RESERVATION = "_reserved";
const RESERVATION_TOKENS = Math.max(1, Number(process.env.AI_REQUEST_TOKEN_ESTIMATE ?? 8000));
const RESERVATION_TTL = "10 minutes";

/**
 * Exige IA habilitada (403) y presupuesto disponible (429) antes de mandar nada al modelo, y reserva presupuesto
 * para la llamada que sigue (`reserve: false` solo chequea, para validar una configuración).
 */
/** Tope de entrada por llamada: un sobre con cientos de páginas no se manda entero al modelo. */
const MAX_INPUT_TOKENS = Math.max(1000, Number(process.env.AI_MAX_INPUT_TOKENS ?? 150_000));

/** Tokens estimados de entrada para estos documentos (413 si superan el tope por llamada). */
export function inputEstimate(docs: DocText[]): number {
  const est = estimateTokens(docsToText(docs, { lineIds: true }));
  if (est > MAX_INPUT_TOKENS) {
    throw new AppError(413, "ai_input_too_large", "El documento es demasiado largo para la asistencia con IA", {
      estimatedTokens: est,
      max: MAX_INPUT_TOKENS,
    });
  }
  return est;
}

/** Topes de consultas a la IA por firmante y sobre (por día y en total). */
export const SIGNER_AI_DAILY = 30;
export const SIGNER_AI_TOTAL = 100;

/**
 * Consultas del firmante a la IA en este sobre: las llamadas al modelo (ai_usage con recipient_id: en curso, hechas o
 * fallidas con consumo) más los resúmenes servidos desde la caché (eventos ai.* con cached).
 */
export async function signerAiCount(db: Db, envelopeId: string, recipientId: string): Promise<{ day: number; total: number }> {
  const q = await db.one<{ day: number; total: number }>(
    `SELECT count(*) FILTER (WHERE at > now() - interval '1 day')::int AS day, count(*)::int AS total FROM (
       SELECT created_at AS at FROM ai_usage WHERE envelope_id = $1 AND recipient_id = $2::uuid
       UNION ALL
       SELECT occurred_at FROM envelope_events WHERE envelope_id = $1 AND actor_type = 'recipient' AND actor_id = $2::text
         AND type LIKE 'ai.%' AND data->>'cached' = 'true'
     ) x`,
    [envelopeId, recipientId],
  );
  return { day: Number(q?.day ?? 0), total: Number(q?.total ?? 0) };
}

export async function assertSignerAiQuota(db: Db, envelopeId: string, recipientId: string) {
  const q = await signerAiCount(db, envelopeId, recipientId);
  if (q.day >= SIGNER_AI_DAILY || q.total >= SIGNER_AI_TOTAL) {
    throw new AppError(429, "ai_signer_limit", "Llegaste al máximo de consultas a la IA para este documento");
  }
}

/**
 * opts.estimate: tokens de entrada estimados de la llamada. La reserva cuenta eso (más la salida) en vez de un
 * número fijo: si no, decenas de llamadas simultáneas sobre un documento largo gastaban muchas veces el presupuesto.
 * opts.signer: consulta de un firmante. Su cupo se controla y se consume acá, con la organización bloqueada y antes de
 * llamar al modelo (la reserva lleva su recipient_id): dos consultas simultáneas no pasan juntas el tope.
 * El presupuesto efectivo es min(presupuesto de la organización, tope de tokens de IA del plan vigente).
 */
export async function assertAiAvailable(
  db: Db,
  tenantId: string,
  opts: { reserve?: boolean; estimate?: number; envelopeId?: string | null; signer?: { envelopeId: string; recipientId: string } } = {},
): Promise<string | null> {
  const reserve = opts.reserve !== false;
  const thisCall = Math.max(RESERVATION_TOKENS, Math.ceil(opts.estimate ?? 0) + RESERVATION_TOKENS);
  return db.tx(async (t) => {
    const tenant = await t.one<any>(
      `SELECT ai_enabled, ai_monthly_token_budget, ai_notice_version, ai_notice_accepted_at, billing_plan FROM tenants WHERE id = $1 FOR UPDATE`,
      [tenantId],
    );
    if (!tenant?.ai_enabled) throw new AppError(403, "ai_disabled", "La IA no está habilitada para esta organización");
    // Cambió el aviso de tratamiento de datos: hasta que la organización acepte la versión vigente no sale nada.
    if (!tenant.ai_notice_accepted_at || tenant.ai_notice_version !== AI_NOTICE_VERSION) {
      throw new AppError(403, "ai_notice_required", "La organización tiene que aceptar el aviso de tratamiento de datos vigente (Ajustes → IA)", {
        noticeVersion: AI_NOTICE_VERSION,
      });
    }
    getAiProvider(); // 503 ai_unavailable si el servidor no tiene proveedor
    const plan = planById(tenant.billing_plan ?? null);
    if (plan.aiTokensPerMonth === 0) {
      throw aiNotIncludedError(plan);
    }
    if (opts.signer) {
      const q = await signerAiCount(t, opts.signer.envelopeId, opts.signer.recipientId);
      if (q.day >= SIGNER_AI_DAILY || q.total >= SIGNER_AI_TOTAL) {
        throw new AppError(429, "ai_signer_limit", "Llegaste al máximo de consultas a la IA para este documento");
      }
    }
    await t.query(`DELETE FROM ai_usage WHERE tenant_id = $1 AND feature = $2 AND created_at < now() - interval '${RESERVATION_TTL}'`, [
      tenantId,
      RESERVATION,
    ]);
    const row = await t.one<any>(
      `SELECT COALESCE(sum(input_tokens + output_tokens) FILTER (WHERE feature <> $2), 0)::bigint AS used,
              (count(*) FILTER (WHERE feature = $2))::int AS inflight,
              COALESCE(sum(GREATEST(input_tokens, $3)) FILTER (WHERE feature = $2), 0)::bigint AS inflight_tokens
       FROM ai_usage WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())`,
      [tenantId, RESERVATION, RESERVATION_TOKENS],
    );
    const used = Number(row?.used ?? 0);
    const committed = used + Number(row?.inflight_tokens ?? 0);
    const orgBudget = Number(tenant.ai_monthly_token_budget ?? 0);
    const budget = effectiveAiBudget(plan, orgBudget);
    // Con llamadas en curso, esta solo entra si cabe junto con ellas; sola, si su entrada cabe en lo que queda.
    const inflight = Number(row?.inflight ?? 0);
    const tooBig = reserve && (inflight > 0 ? committed + thisCall > budget : used + (opts.estimate ?? 0) > budget);
    if (used >= budget || tooBig) {
      throw new AppError(429, "ai_budget_exceeded", "Se agotó el presupuesto mensual de IA de la organización", {
        used,
        budget,
        ...(budget < orgBudget ? { planCap: plan.aiTokensPerMonth, plan: plan.id } : {}),
      });
    }
    if (!reserve) return null;
    const id = uuidv7();
    await t.query(
      `INSERT INTO ai_usage (id, tenant_id, envelope_id, recipient_id, feature, provider, model, input_tokens, output_tokens, prompt_sha256, actor_type)
       VALUES ($1, $2, $3, $4, $5, 'reserva', '-', $6, 0, '', 'system')`,
      [id, tenantId, opts.signer?.envelopeId ?? opts.envelopeId ?? null, opts.signer?.recipientId ?? null, RESERVATION, thisCall],
    );
    return id;
  });
}

/** Libera una reserva de presupuesto (la llamada al modelo falló o no se hizo). */
export async function releaseAiReservation(db: Db, tenantId: string, reservationId?: string | null) {
  // La reserva de ESTA llamada (ahora cada una pesa distinto: liberar otra dejaba mal contado lo que está en curso).
  if (reservationId) {
    await db.query(`DELETE FROM ai_usage WHERE id = $1 AND tenant_id = $2 AND feature = $3`, [reservationId, tenantId, RESERVATION]);
    return;
  }
  await db.query(`DELETE FROM ai_usage WHERE id = (SELECT id FROM ai_usage WHERE tenant_id = $1 AND feature = $2 ORDER BY created_at LIMIT 1)`, [
    tenantId,
    RESERVATION,
  ]);
}

/** Datos de la llamada al modelo, para registrar su consumo también si falla. */
export interface AiCallContext {
  tenantId: string;
  /** La reserva que tomó assertAiAvailable para esta llamada. */
  reservationId: string | null;
  envelopeId: string | null;
  feature: AiFeature;
  actor: Actor;
  /** Consulta de un firmante: el consumo queda con su recipient_id (cuenta en su cupo). */
  recipientId?: string | null;
  skipEventIfClosed?: boolean;
}

/** Consumo que lleva un error de la llamada al modelo (AiCallError, o el AppError al que lo tradujo callModel). */
export function aiUsageOf(err: unknown): (ProviderUsage & { estimated?: boolean }) | null {
  if (err instanceof AiCallError && err.usage) return err.usage;
  const u = (err as { aiUsage?: ProviderUsage } | null)?.aiUsage;
  return u ?? null;
}

/**
 * Corre la llamada al modelo con la reserva ya tomada. Si falla:
 * - con consumo (rechazo, respuesta cortada o inválida, timeout con consumo estimado): se registra como cualquier
 *   llamada (presupuesto, cupo del firmante y evidencia con failed: true), porque el proveedor la cobra;
 * - sin consumo (proveedor caído, pedido rechazado): libera la reserva en el momento. Si no, una organización con
 *   presupuesto chico quedaba bloqueada (429) durante 10 minutos después de unas pocas fallas.
 */
export async function withAiReservation<T>(db: Db, ctx: AiCallContext, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const usage = aiUsageOf(err);
    if (usage) {
      await recordAiUse(db, {
        ...ctx,
        usage,
        data: { failed: true, error: (err as AppError).code ?? (err as Error).name ?? "error", ...(usage.estimated ? { estimated: true } : {}) },
      }).catch(() => releaseAiReservation(db, ctx.tenantId, ctx.reservationId).catch(() => {}));
    } else {
      await releaseAiReservation(db, ctx.tenantId, ctx.reservationId).catch(() => {});
    }
    throw err;
  }
}

// ───────────────────────────── Documentos ─────────────────────────────

/** Texto (con posiciones) de los documentos del sobre. Si los originales se purgaron por retención, 410 purged. */
export async function loadEnvelopeDocs(db: Db, blobs: BlobStore, envelopeId: string, opts: { documentId?: string } = {}): Promise<DocText[]> {
  if (opts.documentId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.documentId)) {
    throw new AppError(404, "not_found", "Documento no encontrado");
  }
  const rows = await db.query<any>(
    `SELECT d.id, d.name, f.storage_key, f.purged_at FROM documents d JOIN files f ON f.id = d.file_id
     WHERE d.envelope_id = $1 ${opts.documentId ? "AND d.id = $2" : ""} ORDER BY d.position`,
    opts.documentId ? [envelopeId, opts.documentId] : [envelopeId],
  );
  if (opts.documentId && rows.length === 0) throw new AppError(404, "not_found", "Documento no encontrado");
  // Originales borrados por retención: no se usa el PDF sellado en su lugar. Trae el certificado de finalización, con
  // correo, teléfono e IP de cada destinatario, y los valores cargados: eso no sale hacia el proveedor de IA (ver
  // docs/IA.md: nunca datos de contacto).
  if (rows.some((r) => r.purged_at)) {
    throw new AppError(410, "purged", "Los originales de este sobre se eliminaron por la política de retención: la IA ya no puede leerlos");
  }
  const out: DocText[] = [];
  for (const r of rows) {
    out.push({ id: r.id, name: r.name, pages: await readText(await blobs.get(r.storage_key)) });
  }
  return out;
}

/** Texto de un PDF; uno demasiado pesado para leer (tope de pdf.js) es 422, no un error interno. */
async function readText(pdf: Uint8Array) {
  try {
    return await extractPdfText(pdf);
  } catch (e) {
    if (e instanceof InvalidPdfError) throw new AppError(422, "pdf_too_heavy", e.message);
    // Lectores ocupados: es transitorio (503), no un PDF malo.
    if (e instanceof PdfReaderBusyError) throw new AppError(503, "pdf_reader_busy", e.message);
    throw e;
  }
}

export function sentSummary(docs: DocText[], text: string): AiSentSummary {
  return { documents: docs.map((d) => ({ id: d.id, name: d.name, pages: d.pages.length })), characters: text.length };
}

export function previewText(docs: DocText[], feature: AiFeature): string {
  return docsToText(docs, { lineIds: feature === "detect_fields" });
}

// ───────────────────────────── Consumo y evidencia ─────────────────────────────

export function usageInfo(u: ProviderUsage): AiUsageInfo {
  return { provider: u.provider, model: u.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens };
}

const CLOSED_ENVELOPE_STATUSES = ["voided", "declined", "expired"];

/** Registra el consumo y deja constancia en la evidencia del sobre (hash del prompt, modelo y tokens; nunca el texto). */
export async function recordAiUse(
  db: Db,
  args: {
    tenantId: string;
    envelopeId: string | null;
    feature: AiFeature;
    usage: ProviderUsage;
    actor: Actor;
    data?: Record<string, unknown>;
    /** Firmante: si el sobre se anuló, rechazó o venció durante la llamada al modelo, el consumo se registra sin evento. */
    skipEventIfClosed?: boolean;
    /** La reserva que tomó assertAiAvailable para esta llamada. */
    reservationId?: string | null;
    /** Firmante que hizo la consulta (cuenta en su cupo). */
    recipientId?: string | null;
  },
) {
  await db.tx(async (t) => {
    const cur = args.envelopeId ? await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR UPDATE`, [args.envelopeId]) : null;
    // Libera la reserva de presupuesto tomada por assertAiAvailable para esta llamada.
    await releaseAiReservation(t, args.tenantId, args.reservationId);
    await t.query(
      `INSERT INTO ai_usage (id, tenant_id, envelope_id, feature, provider, model, input_tokens, output_tokens, prompt_sha256, actor_type, actor_id, recipient_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        uuidv7(),
        args.tenantId,
        args.envelopeId,
        args.feature,
        args.usage.provider,
        args.usage.model,
        args.usage.inputTokens,
        args.usage.outputTokens,
        args.usage.promptSha256,
        args.actor.type,
        args.actor.id ?? null,
        args.recipientId ?? null,
      ],
    );
    if (args.envelopeId && !(args.skipEventIfClosed && CLOSED_ENVELOPE_STATUSES.includes(cur?.status))) {
      await appendEvent(t, {
        tenantId: args.tenantId,
        envelopeId: args.envelopeId,
        type: `ai.${args.feature}`,
        actor: args.actor,
        data: {
          feature: args.feature,
          provider: args.usage.provider,
          model: args.usage.model,
          promptSha256: args.usage.promptSha256,
          inputTokens: args.usage.inputTokens,
          outputTokens: args.usage.outputTokens,
          ...(args.data ?? {}),
        },
      });
    }
  });
}

/** Traduce errores del modelo a respuestas HTTP claras. El consumo de la llamada fallida viaja en `aiUsage`. */
export async function callModel<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const out = translateModelError(e);
    const usage = e instanceof AiCallError ? e.usage : undefined;
    if (usage && out !== e) Object.defineProperty(out, "aiUsage", { value: usage, enumerable: false });
    throw out;
  }
}

function translateModelError(e: unknown): unknown {
  if (e instanceof AiRefusalError) return new AppError(422, "ai_refused", e.message);
  if (e instanceof AiOutputError) return new AppError(502, "ai_bad_output", e.message);
  if (e instanceof AiTimeoutError) return new AppError(504, "ai_timeout", "El proveedor de IA no respondió a tiempo; probá de nuevo más tarde");
  if (e instanceof AppError) return e;
  const status = (e as { status?: number }).status;
  if (status === 429) return new AppError(503, "ai_rate_limited", "El proveedor de IA está saturado; probá de nuevo en un momento");
  // Un 4xx del proveedor (pedido inválido, clave o modelo mal configurados) no es transitorio: no se reintenta solo.
  if (typeof status === "number" && status >= 400 && status < 500) {
    return new AppError(502, "ai_request_rejected", "El proveedor de IA rechazó el pedido");
  }
  return new AppError(502, "ai_unavailable", "No se pudo contactar al proveedor de IA");
}

// ───────────────────────────── Metadatos y renovaciones ─────────────────────────────

/** Fecha (AAAA-MM-DD) en que conviene avisar: N días antes de la renovación o el vencimiento (o del preaviso, si es mayor). */
export function renewalAlertDate(m: ContractMetadata | null, alertDays: number, today = new Date()): string | null {
  if (!m || alertDays <= 0) return null;
  const base = m.renewalDate ?? m.expiryDate;
  if (!base) return null;
  const baseDate = new Date(`${base}T00:00:00Z`);
  if (Number.isNaN(baseDate.getTime())) return null;
  const todayIso = today.toISOString().slice(0, 10);
  if (base <= todayIso) return null;
  // Tope de 10 años (lo mismo que acepta la edición manual): un preaviso absurdo daba una fecha fuera de rango y
  // toISOString lanzaba RangeError, con lo que la extracción fallaba siempre.
  const notice = Math.min(Math.max(Number(m.noticePeriodDays) || 0, 0), 3650);
  const lead = Math.max(alertDays, notice + (m.autoRenewal ? 7 : 0));
  const alert = new Date(baseDate.getTime() - lead * 86400_000).toISOString().slice(0, 10);
  return alert < todayIso ? todayIso : alert;
}

/** AAAA-MM-DD de una fecha que existe, o null ("2027-02-31" no: JS la corre al 3 de marzo y la alerta saldría mal). */
export function realIsoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const META_DATES = ["effectiveDate", "expiryDate", "renewalDate"] as const;

/** Fechas de metadatos que no existen o no son AAAA-MM-DD (la edición manual las rechaza con 400). */
export function invalidMetadataDates(m: ContractMetadata): string[] {
  return META_DATES.filter((k) => m[k] != null && realIsoDate(m[k]) === null);
}

const clip = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Lleva la salida del modelo al mismo esquema que acepta la edición manual (ContractMetadataSchema). Sin esto, un
 * texto largo, una moneda como "pesos colombianos" o un preaviso de 99999 días quedaban guardados y después la
 * edición manual respondía 400 por un campo que el usuario no tocó.
 */
export function sanitizeAiMetadata(m: ContractMetadata): ContractMetadata {
  const parties = (Array.isArray(m.parties) ? m.parties : [])
    .map((p) => ({ name: clip(p?.name, 300), role: clip(p?.role, 100) }))
    .filter((p): p is { name: string; role: string | null } => !!p.name)
    .slice(0, 20);
  const amounts = (Array.isArray(m.amounts) ? m.amounts : [])
    .filter((a) => typeof a?.value === "number" && Number.isFinite(a.value))
    .map((a) => {
      const c = clip(a.currency, 1000);
      // Un código (ISO 4217 u otro corto); una descripción larga de la moneda no es un código.
      return { value: a.value, currency: c && c.length <= 10 ? c.toUpperCase() : null, description: clip(a.description, 300) };
    })
    .slice(0, 30);
  const d = m.noticePeriodDays;
  return {
    parties,
    effectiveDate: realIsoDate(m.effectiveDate),
    expiryDate: realIsoDate(m.expiryDate),
    renewalDate: realIsoDate(m.renewalDate),
    autoRenewal: typeof m.autoRenewal === "boolean" ? m.autoRenewal : null,
    amounts,
    governingLaw: clip(m.governingLaw, 300),
    noticePeriodDays: typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 3650 ? d : null,
  };
}

export async function saveMetadata(
  db: Db,
  envelopeId: string,
  tenantId: string,
  metadataIn: ContractMetadata,
  confidence: Record<string, number>,
  source: "ai" | "manual",
  /**
   * Escritura condicional (extracción con IA, que llama al modelo antes de guardar): `onlyIfUnset`, solo si el sobre
   * sigue sin metadatos (barrido automático); `expectUpdatedAt`, solo si ai_metadata_updated_at sigue siendo el leído
   * antes de llamar al modelo (metadataVersion). Sin esto, una edición manual hecha mientras el modelo respondía se pisaba.
   */
  cond: { onlyIfUnset?: boolean; expectUpdatedAt?: string | null } = {},
): Promise<boolean> {
  // Lo que devuelve el modelo es texto libre: fechas que no existen, textos largos o valores fuera de rango se
  // normalizan (lo manual ya llega validado y no cambia).
  const metadata: ContractMetadata = sanitizeAiMetadata(metadataIn);
  const t = await db.one<any>(`SELECT ai_renewal_alert_days FROM tenants WHERE id = $1`, [tenantId]);
  const alertAt = renewalAlertDate(metadata, Number(t?.ai_renewal_alert_days ?? 30));
  const rows = await db.query(
    `UPDATE envelopes SET ai_metadata = $2, ai_metadata_confidence = $3, ai_metadata_source = $4, ai_metadata_updated_at = now(),
       ai_renewal_alert_at = $5::date,
       ai_renewal_alert_sent_at = CASE WHEN ai_renewal_alert_at IS DISTINCT FROM $5::date THEN NULL ELSE ai_renewal_alert_sent_at END
     WHERE id = $1
       AND (NOT $6::boolean OR ai_metadata IS NULL)
       AND (NOT $7::boolean OR ai_metadata_updated_at::text IS NOT DISTINCT FROM $8::text)
     RETURNING id`,
    [
      envelopeId,
      JSON.stringify(metadata),
      JSON.stringify(confidence),
      source,
      alertAt,
      Boolean(cond.onlyIfUnset),
      cond.expectUpdatedAt !== undefined,
      cond.expectUpdatedAt ?? null,
    ],
  );
  return rows.length > 0;
}

/**
 * Versión de los metadatos de un sobre (ai_metadata_updated_at como texto, con microsegundos: un Date de JS los
 * pierde), para la escritura condicional de saveMetadata. null: sin metadatos todavía.
 */
export async function metadataVersion(db: Db, envelopeId: string): Promise<string | null> {
  const r = await db.one<{ v: string | null }>(`SELECT ai_metadata_updated_at::text AS v FROM envelopes WHERE id = $1`, [envelopeId]);
  return r?.v ?? null;
}

/**
 * Al cambiar los días de aviso de la organización, las alertas pendientes se reprograman (con 0 se cancelan): si no,
 * seguían saliendo con el valor anterior.
 */
export async function recomputeRenewalAlerts(db: Db, tenantId: string, alertDays: number) {
  const rows = await db.query<{ id: string; ai_metadata: ContractMetadata; ai_renewal_alert_at: string | null }>(
    `SELECT id, ai_metadata, to_char(ai_renewal_alert_at, 'YYYY-MM-DD') AS ai_renewal_alert_at FROM envelopes
      WHERE tenant_id = $1 AND ai_metadata IS NOT NULL AND ai_renewal_alert_sent_at IS NULL`,
    [tenantId],
  );
  for (const r of rows) {
    const at = renewalAlertDate(r.ai_metadata, alertDays);
    if (at !== r.ai_renewal_alert_at) await db.query(`UPDATE envelopes SET ai_renewal_alert_at = $2::date WHERE id = $1`, [r.id, at]);
  }
}

/** La IA no se puede usar ahora para esta organización (apagada, aviso sin aceptar, plan sin IA o sin presupuesto). */
export function isAiError(e: unknown) {
  return (
    e instanceof AppError &&
    (e.code === "ai_disabled" ||
      e.code === "ai_budget_exceeded" ||
      e.code === "ai_notice_required" ||
      (e.code === "plan_limit" && (e.details as { limit?: string } | undefined)?.limit === "ai_tokens_per_month"))
  );
}
