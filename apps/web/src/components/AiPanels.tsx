// Fase 6 — piezas de IA en la web: detección de campos (editor), revisión del playbook y asistencia al firmante
// (paso de revisión), datos del contrato (detalle del sobre) y asistente del documento (página del firmante).
import { useEffect, useState } from "react";
import type {
  AiAnswerResponse,
  AiCitation,
  AiPreviewResponse,
  AiSettings,
  AiSummaryResponse,
  ContractMetadata,
  DetectFieldsResponse,
  Document,
  EnvelopeAiMetadata,
  FieldSuggestion,
  PlaybookReviewResponse,
  Recipient,
  SignerAiInfo,
} from "@calasign/shared";
import { api, errorText, isVersionChanged, runVersioned, uuid, type VersionedSave } from "../lib/api";
import { formatDateTime, formatDay, formatNumber, useI18n } from "../lib/i18n";
import { parseAmountText } from "../lib/logic";
import { useAiText } from "../lib/i18n-ai";
import type { DraftField } from "./FieldEditor";
import { ErrorBox, Modal, recipientColor } from "./ui";

// ───────────────────────────── Vista previa de lo enviado ─────────────────────────────

function PreviewButton({ envelopeId, feature }: { envelopeId: string; feature: string }) {
  const ai = useAiText();
  const [data, setData] = useState<AiPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() =>
          api<AiPreviewResponse>(`/v1/envelopes/${envelopeId}/ai/preview?feature=${feature}`)
            .then(setData)
            .catch((e) => setError(errorText(e)))
        }
      >
        {ai("detect.preview")}
      </button>
      <ErrorBox error={error} />
      {data && (
        <Modal title={ai("detect.preview")} onClose={() => setData(null)} wide>
          <p className="muted small">{ai("detect.sent", { chars: formatNumber(data.sent.characters) })}</p>
          <pre className="ai-preview">{data.text}</pre>
        </Modal>
      )}
    </>
  );
}

// ───────────────────────────── Detección de campos ─────────────────────────────

export function AiFieldDetect({
  envelopeId,
  documents,
  signers,
  fields,
  onAdd,
}: {
  envelopeId: string;
  documents: Document[];
  signers: Recipient[];
  fields: DraftField[];
  onAdd: (f: DraftField[]) => void;
}) {
  const ai = useAiText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<DetectFieldsResponse | null>(null);
  const [assign, setAssign] = useState<Record<string, string>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  if (documents.length === 0 || signers.length === 0) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<DetectFieldsResponse>(`/v1/envelopes/${envelopeId}/ai/detect-fields`, { method: "POST", body: {} });
      setRes(r);
      setDismissed(new Set());
      setAssign(Object.fromEntries(r.suggestions.map((s) => [s.id, signers[Math.min(s.signerIndex, signers.length - 1)].id])));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const toField = (s: FieldSuggestion): DraftField => ({
    id: uuid(),
    documentId: s.documentId,
    recipientId: assign[s.id] ?? signers[0].id,
    type: s.type,
    page: s.page,
    x: s.x,
    y: s.y,
    width: s.width,
    height: s.height,
    required: true,
    label: null,
  });

  // Una sugerencia ya aceptada (mismo documento, página, tipo y posición) no se vuelve a ofrecer.
  const exists = (s: FieldSuggestion) =>
    fields.some(
      (f) => f.documentId === s.documentId && f.page === s.page && f.type === s.type && Math.abs(f.x - s.x) < 0.01 && Math.abs(f.y - s.y) < 0.01,
    );
  const pending = (res?.suggestions ?? []).filter((s) => !dismissed.has(s.id) && !exists(s));

  return (
    <section className="card pad ai-panel">
      <div className="row-wrap">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={run}>
          ✨ {busy ? ai("detect.running") : ai("detect.button")}
        </button>
        <PreviewButton envelopeId={envelopeId} feature="detect_fields" />
      </div>
      <ErrorBox error={error} />
      {res && (
        <div className="ai-suggestions">
          <p className="muted small">
            {res.usage ? ai("detect.sent", { chars: formatNumber(res.sent?.characters ?? 0) }) : ai("detect.heuristicOnly")}
          </p>
          {res.suggestions.length === 0 && <p className="muted">{ai("detect.none")}</p>}
          {pending.length > 0 && (
            <>
              <div className="row-wrap">
                <strong>{ai("detect.title")}</strong>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => onAdd(pending.map(toField))}>
                  {ai("detect.acceptAll")} ({pending.length})
                </button>
              </div>
              <ul className="ai-list">
                {pending.map((s) => {
                  const idx = signers.findIndex((r) => r.id === assign[s.id]);
                  return (
                    <li key={s.id}>
                      <span className="ai-chip" style={{ borderColor: recipientColor(Math.max(0, idx)) }}>
                        {ai(`type.${s.type}` as "type.signature")}
                      </span>
                      <span className="grow small">
                        <span className="muted">
                          {documents.length > 1 ? `${documents.find((d) => d.id === s.documentId)?.name} · ` : ""}
                          {ai("detect.page", { page: s.page + 1 })} · {ai(`detect.source.${s.source}` as "detect.source.ai")} ·{" "}
                        </span>
                        «{s.context}»
                      </span>
                      <label className="small">
                        {ai("detect.signer")}{" "}
                        <select value={assign[s.id]} onChange={(e) => setAssign({ ...assign, [s.id]: e.target.value })}>
                          {signers.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="button" className="btn btn-sm" onClick={() => onAdd([toField(s)])}>
                        {ai("detect.accept")}
                      </button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDismissed(new Set([...dismissed, s.id]))}>
                        {ai("detect.reject")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}

// ───────────────────────────── Revisión antes de enviar ─────────────────────────────

const STATUS_CLASS = { ok: "ai-ok", violation: "ai-bad", not_found: "ai-warn" } as const;

function CitationLine({ c }: { c: AiCitation }) {
  const ai = useAiText();
  return (
    <blockquote className="ai-quote">
      «{c.quote}» <span className="muted small">— {ai("signer.page", { page: c.page })}</span>
      {!c.verified && <span className="muted small"> · {ai("review.unverified")}</span>}
    </blockquote>
  );
}

/**
 * `versioned`: control de versión del editor (cambiar la asistencia al firmante cambia el updatedAt del sobre).
 * `disabled`: el editor está guardando.
 */
export function AiReviewPanel({ envelopeId, versioned, disabled }: { envelopeId: string; versioned?: VersionedSave; disabled?: boolean }) {
  const ai = useAiText();
  const { locale } = useI18n();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  // null mientras carga o si no se pudo leer: no se muestra "desmarcado" (y guardarlo así la apagaba sin querer).
  const [assist, setAssist] = useState<boolean | null>(null);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [review, setReview] = useState<PlaybookReviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<AiSettings>("/v1/settings/ai")
      .then(setSettings)
      .catch(() => setSettings(null));
    setAssist(null);
    setAssistError(null);
    api<EnvelopeAiMetadata>(`/v1/envelopes/${envelopeId}/ai/metadata`)
      .then((m) => setAssist(m.signerAssist))
      .catch((e) => setAssistError(errorText(e)));
    api<PlaybookReviewResponse | null>(`/v1/envelopes/${envelopeId}/ai/review`)
      .then(setReview)
      .catch(() => {});
  }, [envelopeId]);

  if (!settings) return null;
  if (!settings.enabled) {
    return (
      <fieldset className="field ai-panel">
        <legend>{ai("review.title")}</legend>
        <p className="muted small">{ai("ai.disabledHint")}</p>
      </fieldset>
    );
  }

  // Uno a la vez: con clics seguidos, las respuestas podían llegar en otro orden y dejar el valor equivocado.
  const toggle = async (v: boolean) => {
    if (toggling) return;
    setToggling(true);
    setError(null);
    try {
      const m = await runVersioned(
        versioned,
        (headers) => api<EnvelopeAiMetadata>(`/v1/envelopes/${envelopeId}/ai/settings`, { method: "PATCH", body: { signerAssist: v }, headers }),
        (r) => r.envelopeUpdatedAt,
      );
      setAssist(m.signerAssist);
    } catch (e) {
      // El editor ya avisa que el borrador cambió (con el botón para recargar).
      if (!(versioned && isVersionChanged(e))) setError(errorText(e));
    } finally {
      setToggling(false);
    }
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReview(await api<PlaybookReviewResponse>(`/v1/envelopes/${envelopeId}/ai/review`, { method: "POST", body: {} }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="field ai-panel">
      <legend>✨ {ai("review.title")}</legend>
      <label className="check">
        <input
          type="checkbox"
          checked={assist ?? false}
          disabled={assist === null || toggling || disabled}
          aria-busy={toggling || undefined}
          onChange={(e) => void toggle(e.target.checked)}
        />
        {ai("review.signerAssist")}
      </label>
      {assistError && <ErrorBox error={`${ai("review.signerAssistLoadError")} ${assistError}`} />}
      {settings.playbook.length === 0 ? (
        <p className="muted small">{ai("review.empty")}</p>
      ) : (
        <div className="row-wrap">
          <button type="button" className="btn btn-sm" disabled={busy} onClick={run}>
            {busy ? ai("review.running") : ai("review.run")}
          </button>
          <PreviewButton envelopeId={envelopeId} feature="playbook_review" />
        </div>
      )}
      <ErrorBox error={error} />
      {review && (
        <div aria-live="polite">
          <p className="muted small">{ai("review.at", { date: formatDateTime(review.reviewedAt, locale) })}</p>
          <ul className="ai-findings">
            {review.findings.map((f, i) => (
              <li key={i} className={STATUS_CLASS[f.status]}>
                <div>
                  <strong>{ai(`review.status.${f.status}` as "review.status.ok")}</strong>
                  {f.status !== "ok" && <span className="muted small"> · {ai(`review.severity.${f.severity}` as "review.severity.low")}</span>} —{" "}
                  {f.rule}
                </div>
                <div className="small">{f.explanation}</div>
                {f.citation && <CitationLine c={f.citation} />}
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}

// ───────────────────────────── Datos del contrato (detalle) ─────────────────────────────

/** Monto con su moneda; una moneda que no es ISO 4217 ("pesos", "US$") hacía lanzar a Intl y dejaba la página en blanco. */
function formatAmount(value: number, currency: string | null, locale: string) {
  if (currency) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
    } catch {
      return `${currency} ${value.toLocaleString(locale)}`;
    }
  }
  return value.toLocaleString(locale);
}

const EMPTY_META: ContractMetadata = {
  parties: [],
  effectiveDate: null,
  expiryDate: null,
  renewalDate: null,
  autoRenewal: null,
  amounts: [],
  governingLaw: null,
  noticePeriodDays: null,
};

/** canManage: quien solo puede ver el sobre no ve "Extraer" ni "Editar" (la API pide poder modificarlo). */
export function AiMetadataPanel({ envelopeId, completed, canManage = true }: { envelopeId: string; completed: boolean; canManage?: boolean }) {
  const ai = useAiText();
  const { locale } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [data, setData] = useState<EnvelopeAiMetadata | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ m: ContractMetadata; parties: string; amounts: string } | null>(null);

  useEffect(() => {
    api<AiSettings>("/v1/settings/ai")
      .then((s) => setEnabled(s.enabled))
      .catch(() => setEnabled(false));
    api<EnvelopeAiMetadata>(`/v1/envelopes/${envelopeId}/ai/metadata`)
      .then(setData)
      .catch(() => setData(null));
  }, [envelopeId]);

  if (!completed || (!enabled && !data?.metadata)) return null;

  const extract = async () => {
    setBusy(true);
    setError(null);
    try {
      setData(await api<EnvelopeAiMetadata>(`/v1/envelopes/${envelopeId}/ai/extract-metadata`, { method: "POST", body: {} }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = () => {
    const m = data?.metadata ?? EMPTY_META;
    setEdit({
      m,
      parties: m.parties.map((p) => [p.name, p.role ?? ""].join(" | ")).join("\n"),
      amounts: m.amounts.map((a) => [a.value, a.currency ?? "", a.description ?? ""].join(" | ")).join("\n"),
    });
  };

  const save = async () => {
    if (!edit) return;
    setError(null);
    const parties = edit.parties
      .split("\n")
      .map((l) => l.split("|").map((x) => x.trim()))
      .filter((p) => p[0])
      .map(([name, role]) => ({ name, role: role || null }));
    const rows = edit.amounts
      .split("\n")
      .map((l) => l.split("|").map((x) => x.trim()))
      .filter((p) => p[0]);
    // Una línea con un valor que no es número se avisa en vez de descartarse sin decir nada.
    const bad = rows.find(([v]) => parseAmountText(v) === null);
    if (bad) return setError(ai("meta.invalidAmount", { value: bad[0] }));
    const amounts = rows.map(([v, currency, description]) => ({
      value: parseAmountText(v) as number,
      currency: currency ? currency.toUpperCase() : null,
      description: description || null,
    }));
    try {
      setData(
        await api<EnvelopeAiMetadata>(`/v1/envelopes/${envelopeId}/ai/metadata`, {
          method: "PUT",
          body: { metadata: { ...edit.m, parties, amounts } },
        }),
      );
      setEdit(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const m = data?.metadata;
  const fmt = (d: string | null) => (d ? formatDay(d, locale) : ai("meta.unknown"));
  const setM = (patch: Partial<ContractMetadata>) => edit && setEdit({ ...edit, m: { ...edit.m, ...patch } });

  return (
    <section className="card pad ai-panel">
      <div className="row-wrap">
        <h2 className="grow">✨ {ai("meta.title")}</h2>
        {enabled && !edit && canManage && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={extract}>
            {busy ? ai("meta.extracting") : ai("meta.extract")}
          </button>
        )}
        {!edit && canManage && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={startEdit}>
            {ai("meta.edit")}
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      {edit ? (
        <div className="ai-meta-form">
          <label>
            {ai("meta.parties")} <span className="muted small">({ai("meta.partiesHelp")})</span>
            <textarea rows={3} value={edit.parties} onChange={(e) => setEdit({ ...edit, parties: e.target.value })} />
          </label>
          <div className="ai-grid-3">
            {(["effectiveDate", "expiryDate", "renewalDate"] as const).map((k) => (
              <label key={k}>
                {ai(`meta.${k}`)}
                <input type="date" value={edit.m[k] ?? ""} onChange={(e) => setM({ [k]: e.target.value || null })} />
              </label>
            ))}
          </div>
          <div className="ai-grid-3">
            <label>
              {ai("meta.autoRenewal")}
              <select
                value={edit.m.autoRenewal === null ? "" : String(edit.m.autoRenewal)}
                onChange={(e) => setM({ autoRenewal: e.target.value === "" ? null : e.target.value === "true" })}
              >
                <option value="">{ai("meta.unknown")}</option>
                <option value="true">{ai("meta.yes")}</option>
                <option value="false">{ai("meta.no")}</option>
              </select>
            </label>
            <label>
              {ai("meta.noticePeriodDays")}
              <input
                type="number"
                min={0}
                value={edit.m.noticePeriodDays ?? ""}
                onChange={(e) => setM({ noticePeriodDays: e.target.value === "" ? null : Math.max(0, Math.round(Number(e.target.value))) })}
              />
            </label>
            <label>
              {ai("meta.governingLaw")}
              <input value={edit.m.governingLaw ?? ""} onChange={(e) => setM({ governingLaw: e.target.value || null })} />
            </label>
          </div>
          <label>
            {ai("meta.amounts")} <span className="muted small">({ai("meta.amountsHelp")})</span>
            <textarea rows={3} value={edit.amounts} onChange={(e) => setEdit({ ...edit, amounts: e.target.value })} />
          </label>
          <div className="row-wrap">
            <button type="button" className="btn btn-primary btn-sm" onClick={save}>
              {ai("meta.save")}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEdit(null)}>
              {ai("meta.cancel")}
            </button>
          </div>
        </div>
      ) : !m ? (
        <p className="muted">{ai("meta.none")}</p>
      ) : (
        <>
          <p className="muted small">{data?.source === "manual" ? ai("meta.source.manual") : ai("meta.source.ai")}</p>
          <dl className="ai-meta">
            <dt>{ai("meta.parties")}</dt>
            <dd>{m.parties.length ? m.parties.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join(" · ") : ai("meta.unknown")}</dd>
            <dt>{ai("meta.effectiveDate")}</dt>
            <dd>{fmt(m.effectiveDate)}</dd>
            <dt>{ai("meta.expiryDate")}</dt>
            <dd>{fmt(m.expiryDate)}</dd>
            {m.renewalDate && (
              <>
                <dt>{ai("meta.renewalDate")}</dt>
                <dd>{fmt(m.renewalDate)}</dd>
              </>
            )}
            <dt>{ai("meta.autoRenewal")}</dt>
            <dd>{m.autoRenewal === null ? ai("meta.unknown") : m.autoRenewal ? ai("meta.yes") : ai("meta.no")}</dd>
            <dt>{ai("meta.amounts")}</dt>
            <dd>
              {m.amounts.length
                ? m.amounts.map((a, i) => (
                    <div key={i}>
                      {/* Con varios montos, sin la descripción no se sabía cuál es cuál (p. ej. cuota mensual y depósito). */}
                      {formatAmount(a.value, a.currency, locale)}
                      {a.description && <span className="muted"> — {a.description}</span>}
                    </div>
                  ))
                : ai("meta.unknown")}
            </dd>
            <dt>{ai("meta.governingLaw")}</dt>
            <dd>{m.governingLaw ?? ai("meta.unknown")}</dd>
            <dt>{ai("meta.noticePeriodDays")}</dt>
            <dd>{m.noticePeriodDays ?? ai("meta.unknown")}</dd>
          </dl>
          {data?.renewalAlertSentAt ? (
            <p className="small">🔔 {ai("meta.alertSent", { date: formatDateTime(data.renewalAlertSentAt, locale) })}</p>
          ) : (
            data?.renewalAlertAt && <p className="small">🔔 {ai("meta.alert", { date: fmt(data.renewalAlertAt) })}</p>
          )}
        </>
      )}
    </section>
  );
}

// ───────────────────────────── Asistente del firmante ─────────────────────────────

export function AiSignerAssist({ base }: { base: string }) {
  const ai = useAiText();
  // El idioma elegido en la página: el aviso, el resumen y las respuestas lo siguen (si no, salían en el del envío).
  const { locale } = useI18n();
  const localeQs = `?locale=${encodeURIComponent(locale)}`;
  const [info, setInfo] = useState<SignerAiInfo | null>(null);
  const [summary, setSummary] = useState<AiSummaryResponse | null>(null);
  const [answers, setAnswers] = useState<{ q: string; a: AiAnswerResponse }[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<"summary" | "ask" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SignerAiInfo>(`${base}/ai${localeQs}`)
      .then(setInfo)
      .catch(() => setInfo(null));
  }, [base, localeQs]);

  if (!info?.enabled) return null;

  const doSummary = async () => {
    setBusy("summary");
    setError(null);
    try {
      setSummary(await api<AiSummaryResponse>(`${base}/ai/summary${localeQs}`, { method: "POST", body: {} }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (q.length < 3) return;
    setBusy("ask");
    setError(null);
    try {
      const a = await api<AiAnswerResponse>(`${base}/ai/ask${localeQs}`, { method: "POST", body: { question: q } });
      setAnswers([{ q, a }, ...answers]);
      setQuestion("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card pad ai-panel ai-signer" aria-labelledby="ai-signer-title">
      <h2 id="ai-signer-title">✨ {ai("signer.title")}</h2>
      <p className="muted small">{info.notice}</p>
      {!summary && (
        <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={doSummary}>
          {busy === "summary" ? ai("signer.thinking") : ai("signer.summary")}
        </button>
      )}
      <div aria-live="polite">
        {summary && (
          <div className="ai-answer">
            <p>{summary.summary}</p>
            {summary.keyPoints.length > 0 && (
              <>
                <strong className="small">{ai("signer.keyPoints")}</strong>
                <ul>
                  {summary.keyPoints.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </>
            )}
            {summary.citations.length > 0 && (
              <details>
                <summary className="small">{ai("signer.sources")}</summary>
                {summary.citations.map((c, i) => (
                  <CitationLine key={i} c={c} />
                ))}
              </details>
            )}
          </div>
        )}
      </div>
      <form className="ai-ask" onSubmit={ask}>
        <label htmlFor="ai-question" className="small">
          {ai("signer.ask")}
        </label>
        <div className="row-wrap">
          <input
            id="ai-question"
            className="grow"
            value={question}
            maxLength={1000}
            placeholder={ai("signer.askPlaceholder")}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button type="submit" className="btn btn-sm" disabled={busy !== null || question.trim().length < 3}>
            {busy === "ask" ? ai("signer.thinking") : ai("signer.send")}
          </button>
        </div>
      </form>
      <ErrorBox error={error} />
      <div aria-live="polite">
        {answers.map(({ q, a }, i) => (
          <div key={i} className="ai-answer">
            <p className="small">
              <strong>{q}</strong>
            </p>
            <p>{a.answer}</p>
            {a.citations.map((c, j) => (
              <CitationLine key={j} c={c} />
            ))}
          </div>
        ))}
      </div>
      <p className="muted small ai-disclaimer">{info.disclaimer}</p>
    </section>
  );
}
