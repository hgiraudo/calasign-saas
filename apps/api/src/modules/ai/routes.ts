import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AI_FEATURES,
  AI_NOTICE_VERSION,
  AiAskInput,
  DetectFieldsInput,
  PlaybookReviewInput,
  PutContractMetadataInput,
  UpdateAiSettingsInput,
  UpdateEnvelopeAiInput,
  type AiAnswerResponse,
  type AiCitation,
  type AiFeature,
  type AiPreviewResponse,
  type AiSummaryResponse,
  type DetectFieldsResponse,
  type EnvelopeAiMetadata,
  type FieldSuggestion,
  type PlaybookReviewResponse,
  type SignerAiInfo,
} from "@calasign/shared";
import { config } from "../../config";
import { appendEvent } from "../../infra/evidence";
import { runAiSweep } from "./sweep";
import { AppError, badRequest, notFound } from "../../lib/errors";
import { iso, uuidv7 } from "../../lib/util";
import { authenticate, type AuthContext, type Services } from "../context";
import { recipientActor, resolveToken } from "../signing";
import { heuristicFieldSuggestions, locateQuote, placeSuggestion, type DocText, type RawSuggestion } from "./heuristics";
import { getAiProvider, type RawCitation } from "./provider";
import {
  SIGNER_NOTICE,
  assertAiAvailable,
  withAiReservation,
  callModel,
  disclaimerFor,
  getAiSettings,
  invalidMetadataDates,
  loadEnvelopeDocs,
  previewText,
  recordAiUse,
  saveMetadata,
  sentSummary,
  usageInfo,
} from "./service";

type P = { Params: { id: string } };
type TP = { Params: { token: string } };

/** Resúmenes ya generados (por sobre + idioma) para no repetir llamadas idénticas durante una hora. */
const summaryCache = new Map<string, { at: number; value: Omit<AiSummaryResponse, "usage"> & { usage: AiSummaryResponse["usage"] } }>();

function citations(docs: DocText[], raw: RawCitation[]): AiCitation[] {
  return raw
    .filter((c) => c.quote && c.quote.trim())
    .slice(0, 8)
    .map((c) => {
      const loc = locateQuote(docs, c.quote, c.page);
      return { page: loc.verified ? loc.page : (c.page ?? loc.page), documentId: loc.documentId, quote: c.quote.trim().slice(0, 500), verified: loc.verified };
    });
}

async function envelopeOf(s: Services, req: FastifyRequest & { params: { id: string } }) {
  const a = req.auth as AuthContext;
  const e = await s.db.one<any>(`SELECT * FROM envelopes WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
  if (!e) throw notFound("Sobre");
  return { a, e };
}

export async function aiRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  // Solo en local (pruebas): corre ya las tareas periódicas de IA (extracción automática y alertas de renovación).
  if (config.environment === "local" && !config.production) {
    app.post("/dev/ai/sweep", { preHandler: auth }, async (req) => runAiSweep({ db: s.db, blobs: s.blobs, log: req.log }));
  }

  // ───────── Configuración de la organización ─────────

  app.get("/v1/settings/ai", { preHandler: auth }, async (req) => getAiSettings(s.db, req.auth!.tenantId));

  app.patch("/v1/settings/ai", { preHandler: auth }, async (req) => {
    const a = req.auth!;
    const input = UpdateAiSettingsInput.parse(req.body);
    const t = await s.db.one<any>(`SELECT ai_notice_accepted_at, ai_notice_version FROM tenants WHERE id = $1`, [a.tenantId]);
    const noticeOk = t?.ai_notice_accepted_at && t?.ai_notice_version === AI_NOTICE_VERSION;
    if (input.enabled === true && !noticeOk && !input.acceptNotice) {
      throw new AppError(422, "ai_notice_required", "Para habilitar la IA hay que aceptar el aviso de tratamiento de datos");
    }
    await s.db.query(
      `UPDATE tenants SET
         ai_enabled = COALESCE($2, ai_enabled),
         ai_monthly_token_budget = COALESCE($3, ai_monthly_token_budget),
         ai_auto_extract = COALESCE($4, ai_auto_extract),
         ai_renewal_alert_days = COALESCE($5, ai_renewal_alert_days),
         ai_playbook = COALESCE($6::jsonb, ai_playbook),
         ai_notice_version = CASE WHEN $7::boolean THEN $8 ELSE ai_notice_version END,
         ai_notice_accepted_at = CASE WHEN $7::boolean THEN now() ELSE ai_notice_accepted_at END,
         ai_notice_accepted_by = CASE WHEN $7::boolean THEN $9::uuid ELSE ai_notice_accepted_by END
       WHERE id = $1`,
      [
        a.tenantId,
        input.enabled ?? null,
        input.monthlyTokenBudget ?? null,
        input.autoExtractMetadata ?? null,
        input.renewalAlertDays ?? null,
        input.playbook ? JSON.stringify(input.playbook) : null,
        Boolean(input.acceptNotice),
        AI_NOTICE_VERSION,
        a.userId,
      ],
    );
    return getAiSettings(s.db, a.tenantId);
  });

  // ───────── Transparencia: qué se enviaría ─────────

  app.get<P & { Querystring: { feature?: string; documentId?: string } }>("/v1/envelopes/:id/ai/preview", { preHandler: auth }, async (req) => {
    const { e } = await envelopeOf(s, req);
    const feature = (AI_FEATURES as readonly string[]).includes(req.query.feature ?? "") ? (req.query.feature as AiFeature) : "summary";
    const docs = await loadEnvelopeDocs(s.db, s.blobs, e.id, { documentId: req.query.documentId });
    const text = previewText(docs, feature);
    const out: AiPreviewResponse = { sent: sentSummary(docs, text), text };
    return out;
  });

  // ───────── Detección de campos ─────────

  app.post<P>("/v1/envelopes/:id/ai/detect-fields", { preHandler: auth }, async (req) => {
    const { a, e } = await envelopeOf(s, req);
    const input = DetectFieldsInput.parse(req.body ?? {});
    const docs = await loadEnvelopeDocs(s.db, s.blobs, e.id, { documentId: input.documentId });
    const heur = docs.flatMap((d) => heuristicFieldSuggestions(d));

    // Con IA habilitada se combina con las sugerencias del modelo; si no, solo heurísticas (nada sale del servidor).
    const t = await s.db.one<any>(`SELECT ai_enabled FROM tenants WHERE id = $1`, [a.tenantId]);
    let ai: RawSuggestion[] = [];
    let usage: DetectFieldsResponse["usage"] = null;
    let sent: DetectFieldsResponse["sent"] = null;
    if (t?.ai_enabled) {
      await assertAiAvailable(s.db, a.tenantId);
      const provider = getAiProvider();
      const r = await withAiReservation(s.db, a.tenantId, () => callModel(() => provider.detectFields(docs)));
      const lineDoc = new Map(docs.flatMap((d) => d.pages.flatMap((p) => p.lines.map((l) => [l.id, { doc: d.id, page: p.page }] as const))));
      // Los ids de línea se repiten entre documentos: con varios documentos se usa el primero que coincide.
      ai = r.result
        .filter((x) => lineDoc.has(x.lineId))
        .map((x) => ({
          documentId: lineDoc.get(x.lineId)!.doc,
          page: lineDoc.get(x.lineId)!.page,
          lineId: x.lineId,
          type: x.type,
          roleHint: x.roleHint,
          label: x.label,
          confidence: Math.max(0, Math.min(1, x.confidence)),
          source: "ai" as const,
        }));
      const text = previewText(docs, "detect_fields");
      sent = sentSummary(docs, text);
      usage = usageInfo(r.usage);
      await recordAiUse(s.db, { tenantId: a.tenantId, envelopeId: e.id, feature: "detect_fields", usage: r.usage, actor: a.actor, data: { suggestions: ai.length } });
    }

    const merged = new Map<string, RawSuggestion>();
    for (const x of [...heur, ...ai]) {
      const k = `${x.documentId}|${x.lineId}|${x.type}`;
      const prev = merged.get(k);
      merged.set(k, prev ? { ...prev, roleHint: prev.roleHint ?? x.roleHint, confidence: Math.max(prev.confidence, x.confidence), source: prev.source } : x);
    }
    const roles: string[] = [];
    const suggestions: FieldSuggestion[] = [];
    for (const x of merged.values()) {
      const doc = docs.find((d) => d.id === x.documentId)!;
      const page = doc.pages[x.page];
      const line = page?.lines.find((l) => l.id === x.lineId);
      if (!page || !line) continue;
      const role = x.roleHint?.toLowerCase().trim() || null;
      if (role && !roles.includes(role)) roles.push(role);
      suggestions.push({
        id: uuidv7(),
        documentId: x.documentId,
        page: x.page,
        ...placeSuggestion(line, page, x.type),
        type: x.type,
        roleHint: role,
        signerIndex: role ? roles.indexOf(role) : 0,
        label: x.label,
        confidence: Math.round(x.confidence * 100) / 100,
        source: x.source,
        context: line.text.slice(0, 200),
      });
    }
    suggestions.sort((p, q) => p.documentId.localeCompare(q.documentId) || p.page - q.page || p.y - q.y || p.x - q.x);
    const out: DetectFieldsResponse = { suggestions, sent, usage };
    return out;
  });

  // ───────── Asistencia al firmante (habilitada por el remitente) ─────────

  app.patch<P>("/v1/envelopes/:id/ai/settings", { preHandler: auth }, async (req) => {
    const { a, e } = await envelopeOf(s, req);
    const input = UpdateEnvelopeAiInput.parse(req.body);
    if (input.signerAssist) await assertAiAvailable(s.db, a.tenantId, { reserve: false });
    await s.db.query(`UPDATE envelopes SET ai_signer_assist = $2, updated_at = now() WHERE id = $1`, [e.id, input.signerAssist]);
    return metadataView(s, e.id);
  });

  // ───────── Metadatos del contrato ─────────

  app.get<P>("/v1/envelopes/:id/ai/metadata", { preHandler: auth }, async (req) => {
    const { e } = await envelopeOf(s, req);
    return metadataView(s, e.id);
  });

  app.post<P>("/v1/envelopes/:id/ai/extract-metadata", { preHandler: auth }, async (req) => {
    const { a, e } = await envelopeOf(s, req);
    await assertAiAvailable(s.db, a.tenantId, { reserve: false });
    const docs = await loadEnvelopeDocs(s.db, s.blobs, e.id);
    await assertAiAvailable(s.db, a.tenantId);
    const provider = getAiProvider();
    const r = await withAiReservation(s.db, a.tenantId, () => callModel(() => provider.extractMetadata(docs)));
    await saveMetadata(s.db, e.id, a.tenantId, r.result.metadata, r.result.confidence, "ai");
    await recordAiUse(s.db, { tenantId: a.tenantId, envelopeId: e.id, feature: "extract_metadata", usage: r.usage, actor: a.actor });
    return { ...(await metadataView(s, e.id)), usage: usageInfo(r.usage) };
  });

  app.put<P>("/v1/envelopes/:id/ai/metadata", { preHandler: auth }, async (req) => {
    const { a, e } = await envelopeOf(s, req);
    const input = PutContractMetadataInput.parse(req.body);
    const bad = invalidMetadataDates(input.metadata);
    if (bad.length) throw badRequest("invalid_date", `Fecha inválida: ${bad.join(", ")} (tiene que existir, en formato AAAA-MM-DD)`);
    await saveMetadata(s.db, e.id, a.tenantId, input.metadata, {}, "manual");
    await s.db.tx(async (t) => {
      await t.query(`SELECT id FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      await appendEvent(t, { tenantId: a.tenantId, envelopeId: e.id, type: "ai.metadata_edited", actor: a.actor, data: { fields: Object.keys(input.metadata) } });
    });
    return metadataView(s, e.id);
  });

  // ───────── Revisión contra el playbook ─────────

  app.get<P>("/v1/envelopes/:id/ai/review", { preHandler: auth }, async (req) => {
    const { e } = await envelopeOf(s, req);
    return e.ai_review ?? null;
  });

  app.post<P>("/v1/envelopes/:id/ai/review", { preHandler: auth }, async (req) => {
    const { a, e } = await envelopeOf(s, req);
    const input = PlaybookReviewInput.parse(req.body ?? {});
    // Primero el chequeo sin reserva (IA deshabilitada → 403 antes que cualquier otra validación).
    await assertAiAvailable(s.db, a.tenantId, { reserve: false });
    const t = await s.db.one<any>(`SELECT ai_playbook FROM tenants WHERE id = $1`, [a.tenantId]);
    const rules: string[] = input.rules ?? (Array.isArray(t?.ai_playbook) ? t.ai_playbook : []);
    if (rules.length === 0) throw badRequest("playbook_empty", "No hay reglas para revisar: cargá el playbook en Ajustes → IA");
    const docs = await loadEnvelopeDocs(s.db, s.blobs, e.id);
    await assertAiAvailable(s.db, a.tenantId);
    const provider = getAiProvider();
    const r = await withAiReservation(s.db, a.tenantId, () => callModel(() => provider.reviewPlaybook(docs, rules, e.locale)));
    const text = previewText(docs, "playbook_review");
    const out: PlaybookReviewResponse = {
      findings: r.result.map((f) => ({
        rule: f.rule,
        status: f.status,
        severity: f.severity,
        explanation: f.explanation,
        citation: f.quote ? citations(docs, [{ page: f.page, quote: f.quote }])[0] ?? null : null,
      })),
      reviewedAt: new Date().toISOString(),
      sent: sentSummary(docs, text),
      usage: usageInfo(r.usage),
    };
    await s.db.query(`UPDATE envelopes SET ai_review = $2 WHERE id = $1`, [e.id, JSON.stringify(out)]);
    await recordAiUse(s.db, {
      tenantId: a.tenantId,
      envelopeId: e.id,
      feature: "playbook_review",
      usage: r.usage,
      actor: a.actor,
      data: { rules: rules.length, violations: out.findings.filter((f) => f.status === "violation").length },
    });
    return out;
  });

  // ───────── Firmante: resumen y preguntas ─────────

  const signerGate = async (req: FastifyRequest & { params: { token: string } }) => {
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    const t = await s.db.one<any>(`SELECT ai_enabled FROM tenants WHERE id = $1`, [e.tenant_id]);
    const enabled = Boolean(t?.ai_enabled && e.ai_signer_assist && ["sent", "completed"].includes(e.status));
    return { r, e, enabled, locale: (r.locale ?? e.locale ?? "es") as string };
  };

  app.get<TP>("/v1/signing/:token/ai", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const { enabled, locale } = await signerGate(req);
    const out: SignerAiInfo = { enabled, disclaimer: disclaimerFor(locale), notice: SIGNER_NOTICE[locale] ?? SIGNER_NOTICE.es };
    return out;
  });

  app.post<TP>("/v1/signing/:token/ai/summary", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { r, e, enabled, locale } = await signerGate(req);
    if (!enabled) throw new AppError(403, "ai_disabled", "La asistencia con IA no está disponible para este documento");
    const docs = await loadEnvelopeDocs(s.db, s.blobs, e.id);
    const key = `${e.id}|${locale}|${docs.map((d) => d.id).join(",")}`;
    const hit = summaryCache.get(key);
    let out: AiSummaryResponse;
    if (hit && Date.now() - hit.at < 3600_000) {
      out = hit.value;
      // Igual queda constancia de que este firmante pidió el resumen (sin consumo nuevo).
      await s.db.tx(async (t) => {
        await t.query(`SELECT id FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
          await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "ai.summary", actor: recipientActor(req, r), data: { feature: "summary", cached: true, model: out.usage.model } });
      });
    } else {
      await assertAiAvailable(s.db, e.tenant_id);
      const provider = getAiProvider();
      const res = await withAiReservation(s.db, e.tenant_id, () => callModel(() => provider.summarize(docs, locale)));
      out = {
        summary: res.result.summary,
        keyPoints: res.result.keyPoints.slice(0, 8),
        citations: citations(docs, res.result.citations),
        disclaimer: disclaimerFor(locale),
        usage: usageInfo(res.usage),
      };
      // Caché acotada: se descartan los vencidos y, si sigue llena, los más viejos.
      const now = Date.now();
      for (const [k, v] of summaryCache) if (now - v.at >= 3600_000) summaryCache.delete(k);
      while (summaryCache.size >= 500) summaryCache.delete(summaryCache.keys().next().value!);
      summaryCache.set(key, { at: now, value: out });
      await recordAiUse(s.db, { tenantId: e.tenant_id, envelopeId: e.id, feature: "summary", usage: res.usage, actor: recipientActor(req, r), data: { locale } });
    }
    return out;
  });

  app.post<TP>("/v1/signing/:token/ai/ask", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const input = AiAskInput.parse(req.body);
    const { r, e, enabled, locale } = await signerGate(req);
    if (!enabled) throw new AppError(403, "ai_disabled", "La asistencia con IA no está disponible para este documento");
    await assertAiAvailable(s.db, e.tenant_id, { reserve: false });
    const docs = await loadEnvelopeDocs(s.db, s.blobs, e.id);
    await assertAiAvailable(s.db, e.tenant_id);
    const provider = getAiProvider();
    const res = await withAiReservation(s.db, e.tenant_id, () => callModel(() => provider.answer(docs, input.question, locale)));
    const out: AiAnswerResponse = {
      answer: res.result.answer,
      answered: res.result.answered,
      citations: citations(docs, res.result.citations),
      disclaimer: disclaimerFor(locale),
      usage: usageInfo(res.usage),
    };
    await recordAiUse(s.db, {
      tenantId: e.tenant_id,
      envelopeId: e.id,
      feature: "ask",
      usage: res.usage,
      actor: recipientActor(req, r),
      data: { locale, answered: out.answered, questionChars: input.question.length },
    });
    return out;
  });
}

async function metadataView(s: Services, envelopeId: string): Promise<EnvelopeAiMetadata> {
  const e = await s.db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [envelopeId]);
  return {
    metadata: e?.ai_metadata ?? null,
    confidence: e?.ai_metadata_confidence ?? {},
    source: e?.ai_metadata_source ?? null,
    updatedAt: iso(e?.ai_metadata_updated_at),
    renewalAlertAt: e?.ai_renewal_alert_at ? new Date(e.ai_renewal_alert_at).toISOString().slice(0, 10) : null,
    renewalAlertSentAt: iso(e?.ai_renewal_alert_sent_at),
    signerAssist: Boolean(e?.ai_signer_assist),
    usage: null,
  };
}
