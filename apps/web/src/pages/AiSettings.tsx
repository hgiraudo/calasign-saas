// Ajustes → Inteligencia artificial: activación con aviso de tratamiento de datos, presupuesto, consumo y playbook.
import { useEffect, useState } from "react";
import type { AiSettings } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { useAiText } from "../lib/i18n-ai";
import { useAccess } from "../lib/access";
import { ErrorBox, OrderInput, Spinner } from "../components/ui";

export function AiSettingsPage() {
  const ai = useAiText();
  const { locale } = useI18n();
  const { can } = useAccess();
  const canEdit = can("settings:manage");
  const [s, setS] = useState<AiSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [accept, setAccept] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [budget, setBudget] = useState(0);
  const [autoExtract, setAutoExtract] = useState(true);
  const [renewalDays, setRenewalDays] = useState(30);
  const [playbook, setPlaybook] = useState("");

  const apply = (x: AiSettings) => {
    setS(x);
    setEnabled(x.enabled);
    setBudget(x.monthlyTokenBudget);
    setAutoExtract(x.autoExtractMetadata);
    setRenewalDays(x.renewalAlertDays);
    setPlaybook(x.playbook.join("\n"));
  };

  useEffect(() => {
    api<AiSettings>("/v1/settings/ai").then(apply).catch((e) => setError(errorText(e)));
  }, []);

  if (!s) return error ? <ErrorBox error={error} /> : <Spinner />;

  const noticeAccepted = Boolean(s.noticeAcceptedAt);
  const save = async () => {
    setError(null);
    setSaved(false);
    try {
      const rules = playbook
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      apply(
        await api<AiSettings>("/v1/settings/ai", {
          method: "PATCH",
          body: {
            enabled,
            acceptNotice: !noticeAccepted && enabled ? accept : undefined,
            monthlyTokenBudget: budget,
            autoExtractMetadata: autoExtract,
            renewalAlertDays: renewalDays,
            playbook: rules,
          },
        }),
      );
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const used = s.usage.totalTokens;
  const pct = s.monthlyTokenBudget > 0 ? Math.min(100, Math.round((used / s.monthlyTokenBudget) * 100)) : 100;

  return (
    <div className="page">
      <div className="page-head">
        <h1>✨ {ai("ai.title")}</h1>
      </div>
      <p className="muted">{ai("ai.intro")}</p>
      <section className="card pad ai-form">
        <p className="small">
          <strong>{ai("ai.provider")}:</strong> {s.provider === "mock" ? ai("ai.provider.mock") : ai("ai.provider.anthropic", { model: s.model })}
        </p>
        <div className="ai-notice">
          <strong>{ai("ai.notice.title")}</strong>
          <p className="small">{ai("ai.notice.body")}</p>
          {noticeAccepted ? (
            <p className="muted small">{ai("ai.notice.accepted", { date: formatDateTime(s.noticeAcceptedAt, locale) })}</p>
          ) : (
            <label className="check">
              <input type="checkbox" checked={accept} disabled={!canEdit} onChange={(e) => setAccept(e.target.checked)} />
              {ai("ai.notice.accept")}
            </label>
          )}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canEdit || (!noticeAccepted && !accept && !enabled)}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <strong>{ai("ai.enabled")}</strong>
        </label>
        <div className="ai-grid-3">
          <label>
            {ai("ai.budget")}
            {/* Con Number(valor), borrar el campo lo dejaba en 0 (y guardar desactivaba el presupuesto sin querer). */}
            <OrderInput min={0} max={1_000_000_000} step={10000} value={budget} disabled={!canEdit} onChange={setBudget} />
          </label>
          <label>
            {ai("ai.renewalDays")}
            <OrderInput min={0} max={365} value={renewalDays} disabled={!canEdit} onChange={setRenewalDays} />
          </label>
        </div>
        <div className="ai-usage" role="group" aria-label={ai("ai.usage", { month: s.usage.month, used, budget: s.monthlyTokenBudget })}>
          <div className="small">{ai("ai.usage", { month: s.usage.month, used: used.toLocaleString(locale), budget: s.monthlyTokenBudget.toLocaleString(locale) })}</div>
          <div className="ai-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} className={pct >= 90 ? "ai-bar-hot" : ""} />
          </div>
          {s.usage.byFeature.length > 0 && (
            <ul className="muted small ai-usage-list">
              {s.usage.byFeature.map((f) => (
                <li key={f.feature}>
                  {ai(`ai.feature.${f.feature}` as "ai.feature.summary")}: {f.requests} · {f.tokens.toLocaleString(locale)} tokens
                </li>
              ))}
            </ul>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={autoExtract} disabled={!canEdit} onChange={(e) => setAutoExtract(e.target.checked)} />
          {ai("ai.autoExtract")}
        </label>
        <label>
          <strong>{ai("ai.playbook")}</strong>
          <span className="muted small ai-help">{ai("ai.playbook.help")}</span>
          <textarea rows={6} value={playbook} disabled={!canEdit} onChange={(e) => setPlaybook(e.target.value)} />
        </label>
        <ErrorBox error={error} />
        {canEdit && (
          <div className="row-wrap">
            <button type="button" className="btn btn-primary" onClick={save}>
              {ai("ai.save")}
            </button>
            {saved && <span className="muted small" role="status">{ai("ai.saved")}</span>}
          </div>
        )}
      </section>
    </div>
  );
}
