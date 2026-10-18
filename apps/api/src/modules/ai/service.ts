// Reglas comunes de la IA: opt-in por organización, aviso de tratamiento de datos, presupuesto mensual
// de tokens, registro de consumo, evidencia de cada interacción y texto de los documentos.
import { extractPdfText, InvalidPdfError } from "@calasign/pdf";
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
import { getAiProvider, AiOutputError, AiRefusalError, type ProviderUsage } from "./provider";
import { docsToText, type DocText } from "./heuristics";

export const DISCLAIMER: Record<string, string> = {
  es: "Generado con IA a partir del documento. Puede contener errores y no es asesoramiento legal: ante dudas, leé el documento completo o consultá a un profesional.",
  "pt-BR": "Gerado com IA a partir do documento. Pode conter erros e não é aconselhamento jurídico: em caso de dúvida, leia o documento completo ou consulte um profissional.",
  en: "AI-generated from the document. It may contain errors and is not legal advice: if in doubt, read the full document or consult a professional.",
};

export const SIGNER_NOTICE: Record<string, string> = {
  es: "Al usar esta función, el texto del documento se envía a un proveedor de IA para generar la respuesta. No se envían tus datos personales ni tu firma.",
  "pt-BR": "Ao usar esta função, o texto do documento é enviado a um provedor de IA para gerar a resposta. Seus dados pessoais e sua assinatura não são enviados.",
  en: "When you use this feature, the document text is sent to an AI provider to generate the answer. Your personal data and signature are not sent.",
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
  const p = getAiProvider();
  return {
    enabled: Boolean(t?.ai_enabled),
    provider: p.name,
    model: p.model,
    monthlyTokenBudget: Number(t?.ai_monthly_token_budget ?? 0),
    autoExtractMetadata: Boolean(t?.ai_auto_extract),
    renewalAlertDays: Number(t?.ai_renewal_alert_days ?? 30),
    playbook: Array.isArray(t?.ai_playbook) ? t.ai_playbook : [],
    noticeVersion: AI_NOTICE_VERSION,
    noticeAcceptedAt: iso(t?.ai_notice_accepted_at),
    noticeAcceptedBy: t?.ai_notice_accepted_by ?? null,
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
export async function assertAiAvailable(db: Db, tenantId: string, opts: { reserve?: boolean } = {}) {
  const reserve = opts.reserve !== false;
  await db.tx(async (t) => {
    const tenant = await t.one<any>(`SELECT ai_enabled, ai_monthly_token_budget FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
    if (!tenant?.ai_enabled) throw new AppError(403, "ai_disabled", "La IA no está habilitada para esta organización");
    await t.query(`DELETE FROM ai_usage WHERE tenant_id = $1 AND feature = $2 AND created_at < now() - interval '${RESERVATION_TTL}'`, [tenantId, RESERVATION]);
    const row = await t.one<any>(
      `SELECT COALESCE(sum(input_tokens + output_tokens) FILTER (WHERE feature <> $2), 0)::bigint AS used,
              (count(*) FILTER (WHERE feature = $2))::int AS inflight
       FROM ai_usage WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())`,
      [tenantId, RESERVATION],
    );
    const used = Number(row?.used ?? 0);
    const committed = used + Number(row?.inflight ?? 0) * RESERVATION_TOKENS;
    const budget = Number(tenant.ai_monthly_token_budget ?? 0);
    if (used >= budget || (reserve && committed >= budget && Number(row?.inflight ?? 0) > 0)) {
      throw new AppError(429, "ai_budget_exceeded", "Se agotó el presupuesto mensual de IA de la organización", { used, budget });
    }
    if (reserve) {
      await t.query(
        `INSERT INTO ai_usage (id, tenant_id, envelope_id, feature, provider, model, input_tokens, output_tokens, prompt_sha256, actor_type)
         VALUES ($1, $2, NULL, $3, 'reserva', '-', 0, 0, '', 'system')`,
        [uuidv7(), tenantId, RESERVATION],
      );
    }
  });
}

/** Libera una reserva de presupuesto (la llamada al modelo falló o no se hizo). */
export async function releaseAiReservation(db: Db, tenantId: string) {
  await db.query(`DELETE FROM ai_usage WHERE id = (SELECT id FROM ai_usage WHERE tenant_id = $1 AND feature = $2 ORDER BY created_at LIMIT 1)`, [
    tenantId,
    RESERVATION,
  ]);
}

/**
 * Corre la llamada al modelo con la reserva ya tomada: si falla (rechazo, respuesta cortada, proveedor caído), libera
 * la reserva en el momento. Si no, una organización con presupuesto chico quedaba bloqueada (429) durante 10 minutos
 * después de unas pocas fallas, aunque le sobrara presupuesto.
 */
export async function withAiReservation<T>(db: Db, tenantId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await releaseAiReservation(db, tenantId).catch(() => {});
    throw err;
  }
}

// ───────────────────────────── Documentos ─────────────────────────────

/** Texto (con posiciones) de los documentos del sobre. Si los originales se purgaron por retención, usa el PDF sellado. */
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
  const out: DocText[] = [];
  const purged = rows.filter((r) => r.purged_at);
  for (const r of rows.filter((x) => !x.purged_at)) {
    out.push({ id: r.id, name: r.name, pages: await readText(await blobs.get(r.storage_key)) });
  }
  if (purged.length && !opts.documentId) {
    const signed = await db.one<any>(
      `SELECT f.storage_key FROM envelopes e JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1 AND f.purged_at IS NULL`,
      [envelopeId],
    );
    if (signed) out.push({ id: purged[0].id, name: "documento-firmado.pdf", pages: await readText(await blobs.get(signed.storage_key)) });
  }
  return out;
}

/** Texto de un PDF; uno demasiado pesado para leer (tope de pdf.js) es 422, no un error interno. */
async function readText(pdf: Uint8Array) {
  try {
    return await extractPdfText(pdf);
  } catch (e) {
    if (e instanceof InvalidPdfError) throw new AppError(422, "pdf_too_heavy", e.message);
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

/** Registra el consumo y deja constancia en la evidencia del sobre (hash del prompt, modelo y tokens; nunca el texto). */
export async function recordAiUse(
  db: Db,
  args: { tenantId: string; envelopeId: string | null; feature: AiFeature; usage: ProviderUsage; actor: Actor; data?: Record<string, unknown> },
) {
  await db.tx(async (t) => {
    if (args.envelopeId) await t.query(`SELECT id FROM envelopes WHERE id = $1 FOR UPDATE`, [args.envelopeId]);
    // Libera la reserva de presupuesto tomada por assertAiAvailable para esta llamada.
    await releaseAiReservation(t, args.tenantId);
    await t.query(
      `INSERT INTO ai_usage (id, tenant_id, envelope_id, feature, provider, model, input_tokens, output_tokens, prompt_sha256, actor_type, actor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
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
      ],
    );
    if (args.envelopeId) {
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

/** Traduce errores del modelo a respuestas HTTP claras. */
export async function callModel<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AiRefusalError) throw new AppError(422, "ai_refused", e.message);
    if (e instanceof AiOutputError) throw new AppError(502, "ai_bad_output", e.message);
    if (e instanceof AppError) throw e;
    const status = (e as { status?: number }).status;
    if (status === 429) throw new AppError(503, "ai_rate_limited", "El proveedor de IA está saturado; probá de nuevo en un momento");
    throw new AppError(502, "ai_unavailable", "No se pudo contactar al proveedor de IA");
  }
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
) {
  // Lo que devuelve el modelo es texto libre: fechas que no existen, textos largos o valores fuera de rango se
  // normalizan (lo manual ya llega validado y no cambia).
  const metadata: ContractMetadata = sanitizeAiMetadata(metadataIn);
  const t = await db.one<any>(`SELECT ai_renewal_alert_days FROM tenants WHERE id = $1`, [tenantId]);
  const alertAt = renewalAlertDate(metadata, Number(t?.ai_renewal_alert_days ?? 30));
  await db.query(
    `UPDATE envelopes SET ai_metadata = $2, ai_metadata_confidence = $3, ai_metadata_source = $4, ai_metadata_updated_at = now(),
       ai_renewal_alert_at = $5::date,
       ai_renewal_alert_sent_at = CASE WHEN ai_renewal_alert_at IS DISTINCT FROM $5::date THEN NULL ELSE ai_renewal_alert_sent_at END
     WHERE id = $1`,
    [envelopeId, JSON.stringify(metadata), JSON.stringify(confidence), source, alertAt],
  );
}

export function isAiError(e: unknown) {
  return e instanceof AppError && (e.code === "ai_disabled" || e.code === "ai_budget_exceeded");
}
