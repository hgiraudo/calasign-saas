import { lockEnvelope, pastExpiry } from "../envelopes";
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
import { AppError, assertNotStale, badRequest, conflict, notFound } from "../../lib/errors";
import { identityBlocking } from "../identity/kyc";
import { iso, uuidv7 } from "../../lib/util";
import { authenticate, type AuthContext, type Services } from "../context";
import { recipientActor, resolveToken } from "../signing";
import { heuristicFieldSuggestions, locateQuote, pairPlaybookFindings, placeSuggestion, resolveDocLineId, type DocText, type RawSuggestion } from "./heuristics";
import { aiProviderStatus, getAiProvider, type RawCitation } from "./provider";
import { assertAiBudgetWithinPlan, planById } from "../billing/plans";
import {
  SIGNER_NOTICE,
  assertAiAvailable,
  assertSignerAiQuota,
  inputEstimate,
  withAiReservation,
  callModel,
  disclaimerFor,
  getAiSettings,
  invalidMetadataDates,
  loadEnvelopeDocs,
  previewText,
  recordAiUse,
  saveMetadata,
  metadataVersion,
  sentSummary,
  usageInfo,
  recomputeRenewalAlerts,
  isAiError,
} from "./service";

type P = { Params: { id: string } };
type TP = { Params: { token: string } };

/** Recorta un texto libre del modelo (rol, rótulo) a `max` caracteres; vacío → null. */
const clipText = (v: unknown, max = 100): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

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

/** Huella de los documentos de un sobre (ids y contenido, en orden) para saber si cambiaron durante una revisión. */
async function reviewDocsKey(db: Services["db"], envelopeId: string): Promise<string> {
  const rows = await db.query<{ id: string; sha256: string }>(
    `SELECT d.id, f.sha256 FROM documents d JOIN files f ON f.id = d.file_id WHERE d.envelope_id = $1 ORDER BY d.position, d.id`,
    [envelopeId],
  );
  return rows.map((r) => `${r.id}:${r.sha256}`).join(",");
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
    const t = await s.db.one<any>(`SELECT ai_notice_accepted_at, ai_notice_version, ai_renewal_alert_days, billing_plan FROM tenants WHERE id = $1`, [a.tenantId]);
    const prevDays = Number(t?.ai_renewal_alert_days ?? 30);
    const before = await s.db.one<any>(`SELECT ai_enabled, ai_auto_extract, ai_monthly_token_budget FROM tenants WHERE id = $1`, [a.tenantId]);
    // Valores anteriores para la auditoría (settings.changed registra también los nuevos).
    (req as FastifyRequest & { auditBefore?: Record<string, unknown> }).auditBefore = {
      enabled: Boolean(before?.ai_enabled),
      autoExtractMetadata: Boolean(before?.ai_auto_extract),
      renewalAlertDays: prevDays,
      monthlyTokenBudget: before?.ai_monthly_token_budget ?? null,
    };
    const noticeOk = t?.ai_notice_accepted_at && t?.ai_notice_version === AI_NOTICE_VERSION;
    // Aceptar el aviso de tratamiento de datos (y habilitar la IA cuando nunca se aceptó el vigente) lo hace una persona
    // con sesión web: queda a su nombre (ai_notice_accepted_by). Con una API key o una app OAuth quedaba aceptado por nadie.
    if (input.acceptNotice || (input.enabled === true && !before?.ai_enabled && !noticeOk)) {
      if (!a.userId || a.apiKeyId || a.oauth) {
        throw new AppError(
          403,
          "session_required",
          "Aceptar el aviso de tratamiento de datos de la IA (o habilitarla por primera vez) requiere iniciar sesión en la web: no se puede con una API key ni una app OAuth",
        );
      }
    }
    // Al habilitar hace falta el aviso vigente. Ya habilitada con un aviso anterior se pueden guardar los demás ajustes:
    // la IA queda en pausa (assertAiAvailable: 403 ai_notice_required) hasta que se acepte la versión vigente.
    if (input.enabled === true && !before?.ai_enabled && !noticeOk && !input.acceptNotice) {
      throw new AppError(403, "ai_notice_required", "Para habilitar la IA hay que aceptar el aviso de tratamiento de datos");
    }
    // Tope de tokens de IA del plan: el presupuesto de la organización no puede superarlo (lo paga la plataforma), y un
    // plan sin IA no la habilita.
    const plan = planById(t?.billing_plan ?? null);
    // (Reenviar el valor guardado no falla: tras bajar de plan se puede seguir guardando lo demás; rige el mínimo.)
    if (input.monthlyTokenBudget != null && input.monthlyTokenBudget !== Number(before?.ai_monthly_token_budget ?? 0)) {
      assertAiBudgetWithinPlan(plan, input.monthlyTokenBudget);
    }
    if (input.enabled === true && !before?.ai_enabled && plan.aiTokensPerMonth === 0) assertAiBudgetWithinPlan(plan, 1);
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
    // Solo si cambió: recorre los sobres con metadatos de la organización.
    if (input.renewalAlertDays != null && input.renewalAlertDays !== prevDays) await recomputeRenewalAlerts(s.db, a.tenantId, input.renewalAlertDays);
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
    // Sin presupuesto o con un documento demasiado largo para el modelo, siguen las heurísticas (como con la IA apagada)
    // en vez de fallar toda la detección.
    const rid = t?.ai_enabled
      ? await (async () => assertAiAvailable(s.db, a.tenantId, { estimate: inputEstimate(docs), envelopeId: e.id }))().catch((err) => {
          if (isAiError(err) || (err as AppError)?.status === 413 || (err as AppError)?.code === "ai_unavailable") return null;
          throw err;
        })
      : null;
    if (rid) {
      const provider = getAiProvider();
      const r = await withAiReservation(
        s.db,
        { tenantId: a.tenantId, reservationId: rid, envelopeId: e.id, feature: "detect_fields", actor: a.actor },
        () => callModel(() => provider.detectFields(docs)),
      );
      // Ids con el documento (d{n}-p{n}-l{n}, ver docsToText): los ids de línea se repiten entre documentos.
      ai = r.result.flatMap((x) => {
        const at = resolveDocLineId(docs, x.lineId);
        if (!at) return [];
        return [
          {
            documentId: at.documentId,
            page: at.page,
            lineId: at.lineId,
            type: x.type,
            roleHint: clipText(x.roleHint),
            label: clipText(x.label),
            confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0)),
            source: "ai" as const,
          },
        ];
      });
      const text = previewText(docs, "detect_fields");
      sent = sentSummary(docs, text);
      usage = usageInfo(r.usage);
      await recordAiUse(s.db, { reservationId: rid, tenantId: a.tenantId, envelopeId: e.id, feature: "detect_fields", usage: r.usage, actor: a.actor, data: { suggestions: ai.length } });
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
      const role = x.roleHint?.toLowerCase().trim().slice(0, 100) || null;
      if (role && !roles.includes(role)) roles.push(role);
      suggestions.push({
        id: uuidv7(),
        documentId: x.documentId,
        page: x.page,
        ...placeSuggestion(line, page, x.type),
        type: x.type,
        roleHint: role,
        signerIndex: role ? roles.indexOf(role) : 0,
        label: x.label ? x.label.slice(0, 100) : null,
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
    return s.db.tx(async (t) => {
      const cur = await lockEnvelope(t, a.tenantId, e.id);
      // Cambia el updatedAt del sobre: con X-Expected-Updated-At (el editor lo manda) no tapa una edición ajena.
      assertNotStale(req.headers, cur.updated_at);
      // La vista sale de la fila que dejó este guardado (RETURNING): si otro guarda después del COMMIT, el editor no
      // adopta su updatedAt sin sus datos.
      const row = await t.one<any>(
        `UPDATE envelopes SET ai_signer_assist = $2, updated_at = GREATEST(clock_timestamp(), updated_at + interval '1 millisecond') WHERE id = $1 RETURNING *`,
        [e.id, input.signerAssist],
      );
      // Con el sobre ya enviado, el firmante ve (o deja de ver) la asistencia de IA a mitad de camino: queda en la
      // evidencia, como los demás cambios del remitente. En borrador no hace falta (el envío fija lo vigente).
      if (cur.status !== "draft" && Boolean(cur.ai_signer_assist) !== Boolean(input.signerAssist))
        await appendEvent(t, { tenantId: a.tenantId, envelopeId: e.id, type: "envelope.ai_settings_updated", actor: a.actor, data: { signerAssist: input.signerAssist } });
      return metadataViewOf(row);
    });
  });

  // ───────── Metadatos del contrato ─────────

  app.get<P>("/v1/envelopes/:id/ai/metadata", { preHandler: auth }, async (req) => {
    const { e } = await envelopeOf(s, req);
    return metadataView(s, e.id);
  });

  app.post<P>("/v1/envelopes/:id/ai/extract-metadata", { preHandler: auth }, async (req) => {
    const { a, e } = await envelopeOf(s, req);
    await assertAiAvailable(s.db, a.tenantId, { reserve: false });
    // Antes de llamar al modelo: la versión de los metadatos y la huella de los documentos. Si cualquiera cambia mientras
    // el modelo responde (edición manual, otra extracción, documentos subidos o quitados), el resultado no se guarda.
    const version = await metadataVersion(s.db, e.id);
    const docsKey = await reviewDocsKey(s.db, e.id);
    const docs = await loadEnvelopeDocs(s.db, s.blobs, e.id);
    const rid = await assertAiAvailable(s.db, a.tenantId, { estimate: inputEstimate(docs), envelopeId: e.id });
    const provider = getAiProvider();
    const r = await withAiReservation(
      s.db,
      { tenantId: a.tenantId, reservationId: rid, envelopeId: e.id, feature: "extract_metadata", actor: a.actor },
      () => callModel(() => provider.extractMetadata(docs)),
    );
    const outcome = await s.db.tx(async (tx) => {
      await tx.query(`SELECT id FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      if ((await reviewDocsKey(tx, e.id)) !== docsKey) return "documents_changed" as const;
      const saved = await saveMetadata(tx, e.id, a.tenantId, r.result.metadata, r.result.confidence, "ai", { expectUpdatedAt: version });
      return saved ? ("saved" as const) : ("metadata_changed" as const);
    });
    // El uso se registra igual: el modelo ya respondió (y consumió).
    await recordAiUse(s.db, {
      reservationId: rid,
      tenantId: a.tenantId,
      envelopeId: e.id,
      feature: "extract_metadata",
      usage: r.usage,
      actor: a.actor,
      ...(outcome === "saved" ? {} : { data: { discarded: outcome } }),
    });
    if (outcome === "documents_changed") throw conflict("documents_changed", "Los documentos del sobre cambiaron durante la extracción: volvé a extraer los metadatos");
    if (outcome === "metadata_changed") {
      throw conflict("metadata_changed", "Los metadatos del contrato cambiaron mientras se extraían (alguien los editó o los volvió a extraer): revisalos y, si hace falta, volvé a extraerlos");
    }
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
    // Huella de los documentos revisados (antes de leerlos): si cambian mientras el modelo responde, el resultado ya no
    // es de los documentos vigentes y no se guarda (subir o quitar un documento deja ai_review en NULL).
    const docsKey = await reviewDocsKey(s.db, e.id);
    const docs = await loadEnvelopeDocs(s.db, s.blobs, e.id);
    const rid = await assertAiAvailable(s.db, a.tenantId, { estimate: inputEstimate(docs), envelopeId: e.id });
    const provider = getAiProvider();
    const r = await withAiReservation(
      s.db,
      { tenantId: a.tenantId, reservationId: rid, envelopeId: e.id, feature: "playbook_review", actor: a.actor },
      () => callModel(() => provider.reviewPlaybook(docs, rules, e.locale)),
    );
    const text = previewText(docs, "playbook_review");
    const out: PlaybookReviewResponse = {
      // Uno por regla enviada, en su orden (las que el modelo no devolvió, not_found; las inventadas, afuera).
      findings: pairPlaybookFindings(rules, r.result).map((f) => ({
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
    const stored = await s.db.tx(async (tx) => {
      await tx.query(`SELECT id FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
      if ((await reviewDocsKey(tx, e.id)) !== docsKey) return false;
      await tx.query(`UPDATE envelopes SET ai_review = $2 WHERE id = $1`, [e.id, JSON.stringify(out)]);
      return true;
    });
    // El uso se registra igual: el modelo ya respondió (y consumió).
    await recordAiUse(s.db, {
      reservationId: rid,
      tenantId: a.tenantId,
      envelopeId: e.id,
      feature: "playbook_review",
      usage: r.usage,
      actor: a.actor,
      data: { rules: rules.length, violations: out.findings.filter((f) => f.status === "violation").length },
    });
    if (!stored) throw conflict("documents_changed", "Los documentos del sobre cambiaron durante la revisión: volvé a revisarlo");
    return out;
  });

  // ───────── Firmante: resumen y preguntas ─────────

  // Tope por firmante (service.ts assertSignerAiQuota / assertAiAvailable con signer): un link (o uno reenviado) con
  // muchas IP podía gastar todo el presupuesto mensual de IA de la organización y llenar la evidencia de eventos ai.*.
  // Las llamadas al modelo cuentan al reservar (antes de llamar), con la organización bloqueada.

  const signerGate = async (req: FastifyRequest & { params: { token: string } }) => {
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    const t = await s.db.one<any>(`SELECT ai_enabled, ai_notice_version, ai_notice_accepted_at, billing_plan FROM tenants WHERE id = $1`, [e.tenant_id]);
    // Aviso vigente aceptado, proveedor configurado y un plan que incluya IA: si no, la asistencia no se ofrece.
    const aiUsable =
      Boolean(t?.ai_enabled && t?.ai_notice_accepted_at && t?.ai_notice_version === AI_NOTICE_VERSION) &&
      aiProviderStatus().name !== "none" &&
      planById(t?.billing_plan ?? null).aiTokensPerMonth !== 0;
    // Sin la verificación de identidad que pide el remitente, el firmante tampoco ve el contenido por esta vía.
    const blocked = identityBlocking(r);
    // Un sobre en curso vencido (aunque el barrido todavía no lo marcó) no consume cuota de IA.
    const expired = (e.status === "sent" && pastExpiry(e)) || Boolean(e.purged_at); // sin originales no hay qué resumir
    const enabled = Boolean(aiUsable && e.ai_signer_assist && ["sent", "completed"].includes(e.status) && !blocked && !expired);
    return { r, e, enabled, blocked, locale: (r.locale ?? e.locale ?? "es") as string };
  };

  app.get<TP>("/v1/signing/:token/ai", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const { enabled, locale } = await signerGate(req);
    const out: SignerAiInfo = { enabled, disclaimer: disclaimerFor(locale), notice: SIGNER_NOTICE[locale] ?? SIGNER_NOTICE.es };
    return out;
  });

  app.post<TP>("/v1/signing/:token/ai/summary", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const { r, e, enabled, blocked, locale } = await signerGate(req);
    if (blocked) throw new AppError(403, "identity_required", "Hace falta verificar tu identidad para continuar");
    if (!enabled) throw new AppError(403, "ai_disabled", "La asistencia con IA no está disponible para este documento");
    await assertSignerAiQuota(s.db, e.id, r.id);
    const docs = await loadEnvelopeDocs(s.db, s.blobs, e.id);
    const key = `${e.id}|${locale}|${docs.map((d) => d.id).join(",")}`;
    const hit = summaryCache.get(key);
    let out: AiSummaryResponse;
    if (hit && Date.now() - hit.at < 3600_000) {
      out = hit.value;
      // Igual queda constancia de que este firmante pidió el resumen (sin consumo nuevo).
      await s.db.tx(async (t) => {
        const cur = await t.one<any>(`SELECT status FROM envelopes WHERE id = $1 FOR UPDATE`, [e.id]);
        // Sobre anulado, rechazado o vencido mientras tanto: no se suma el evento a su evidencia.
        if (["voided", "declined", "expired"].includes(cur?.status)) return;
        await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "ai.summary", actor: recipientActor(req, r), data: { feature: "summary", cached: true, model: out.usage.model } });
      });
    } else {
      const rid = await assertAiAvailable(s.db, e.tenant_id, { estimate: inputEstimate(docs), signer: { envelopeId: e.id, recipientId: r.id } });
      const provider = getAiProvider();
      const actor = recipientActor(req, r);
      const res = await withAiReservation(
        s.db,
        { tenantId: e.tenant_id, reservationId: rid, envelopeId: e.id, feature: "summary", actor, recipientId: r.id, skipEventIfClosed: true },
        () => callModel(() => provider.summarize(docs, locale)),
      );
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
      await recordAiUse(s.db, { reservationId: rid, tenantId: e.tenant_id, envelopeId: e.id, feature: "summary", usage: res.usage, actor, recipientId: r.id, data: { locale }, skipEventIfClosed: true });
    }
    return out;
  });

  app.post<TP>("/v1/signing/:token/ai/ask", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const input = AiAskInput.parse(req.body);
    const { r, e, enabled, blocked, locale } = await signerGate(req);
    if (blocked) throw new AppError(403, "identity_required", "Hace falta verificar tu identidad para continuar");
    if (!enabled) throw new AppError(403, "ai_disabled", "La asistencia con IA no está disponible para este documento");
    await assertSignerAiQuota(s.db, e.id, r.id);
    await assertAiAvailable(s.db, e.tenant_id, { reserve: false });
    const docs = await loadEnvelopeDocs(s.db, s.blobs, e.id);
    const rid = await assertAiAvailable(s.db, e.tenant_id, { estimate: inputEstimate(docs), signer: { envelopeId: e.id, recipientId: r.id } });
    const provider = getAiProvider();
    const actor = recipientActor(req, r);
    const res = await withAiReservation(
      s.db,
      { tenantId: e.tenant_id, reservationId: rid, envelopeId: e.id, feature: "ask", actor, recipientId: r.id, skipEventIfClosed: true },
      () => callModel(() => provider.answer(docs, input.question, locale)),
    );
    const out: AiAnswerResponse = {
      answer: res.result.answer,
      answered: res.result.answered,
      citations: citations(docs, res.result.citations),
      disclaimer: disclaimerFor(locale),
      usage: usageInfo(res.usage),
    };
    await recordAiUse(s.db, {
      reservationId: rid,
      tenantId: e.tenant_id,
      envelopeId: e.id,
      feature: "ask",
      usage: res.usage,
      actor,
      recipientId: r.id,
      data: { locale, answered: out.answered, questionChars: input.question.length },
      skipEventIfClosed: true,
    });
    return out;
  });
}

async function metadataView(s: Services, envelopeId: string): Promise<EnvelopeAiMetadata> {
  return metadataViewOf(await s.db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [envelopeId]));
}

function metadataViewOf(e: any): EnvelopeAiMetadata {
  return {
    metadata: e?.ai_metadata ?? null,
    confidence: e?.ai_metadata_confidence ?? {},
    source: e?.ai_metadata_source ?? null,
    updatedAt: iso(e?.ai_metadata_updated_at),
    renewalAlertAt: e?.ai_renewal_alert_at ? new Date(e.ai_renewal_alert_at).toISOString().slice(0, 10) : null,
    renewalAlertSentAt: iso(e?.ai_renewal_alert_sent_at),
    signerAssist: Boolean(e?.ai_signer_assist),
    usage: null,
    envelopeUpdatedAt: e?.updated_at ? new Date(e.updated_at).toISOString() : null,
  };
}
