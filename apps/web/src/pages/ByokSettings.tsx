// Ajustes → Cifrado con tu clave (BYOK): política a agregar en la clave KMS del cliente, activación con prueba,
// estado y desactivación.
import { useEffect, useState, type FormEvent } from "react";
import type { ByokSettings, ByokTestResult } from "@calasign/shared";
import { api, errorText, HttpError } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { useDataText, type DataKey } from "../lib/i18n-data";
import { ErrorBox, Spinner } from "../components/ui";

const STATUS_BADGE = { none: "badge-draft", active: "badge-completed", failing: "badge-declined" } as const;

export function ByokSettingsPage() {
  const dt = useDataText();
  const { locale } = useI18n();
  const [data, setData] = useState<ByokSettings | null>(null);
  const [arn, setArn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<ByokTestResult["checks"] | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = () =>
    api<ByokSettings>("/v1/settings/byok")
      .then((d) => {
        setData(d);
        setArn((a) => a || d.keyArn || "");
      })
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  if (!data) return error ? <ErrorBox error={error} /> : <Spinner />;
  const policy = JSON.stringify(data.keyPolicy, null, 2);

  const enable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setChecks(null);
    setTestMsg(null);
    try {
      setData(await api<ByokSettings>("/v1/settings/byok", { method: "PUT", body: { keyArn: arn.trim() } }));
      setTestMsg(dt("byok.testOk"));
    } catch (err) {
      setError(errorText(err));
      const d = err instanceof HttpError ? (err.details as { checks?: ByokTestResult["checks"] } | undefined) : undefined;
      if (d?.checks) setChecks(d.checks);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setError(null);
    setTestMsg(null);
    try {
      const r = await api<ByokTestResult>("/v1/settings/byok/test", { method: "POST" });
      setChecks(r.checks);
      // Una prueba fallida va como error: antes salía en el recuadro verde de éxito.
      if (r.ok) setTestMsg(dt("byok.testOk"));
      else setError(dt("byok.testFail"));
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    if (!window.confirm(dt("byok.disableConfirm"))) return;
    setBusy(true);
    // El error de una prueba fallida anterior quedaba a la vista después de desactivar sin problemas.
    setError(null);
    try {
      await api("/v1/settings/byok", { method: "DELETE" });
      await load();
      setChecks(null);
      setTestMsg(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page data-byok">
      <div className="page-head">
        <div>
          <h1>{dt("nav.byok")}</h1>
          <p className="muted">{dt("byok.intro")}</p>
        </div>
      </div>

      {data.status === "failing" && (
        <p className="alert alert-error" role="alert">
          {dt("byok.failingBanner")}
        </p>
      )}

      <section className="card pad stack">
        <div className="row-wrap">
          <strong>{dt("byok.status")}</strong>
          <span className={`badge ${STATUS_BADGE[data.status]}`}>{dt(`byok.status.${data.status}` as DataKey)}</span>
          {data.keyArn && data.status !== "none" && <code className="small">{data.keyArn}</code>}
        </div>
        {data.enabledAt && data.status !== "none" && <p className="muted small">{dt("byok.enabledAt", { at: formatDateTime(data.enabledAt, locale) })}</p>}
        {data.checkedAt && <p className="muted small">{dt("byok.checkedAt", { at: formatDateTime(data.checkedAt, locale) })}</p>}
        {data.error && <p className="muted small">{dt("byok.error", { error: data.error })}</p>}
        {data.status !== "none" && (
          <div className="row-wrap">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void test()}>
              {dt("byok.test")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void disable()}>
              {dt("byok.disable")}
            </button>
          </div>
        )}
      </section>

      <section className="card pad stack">
        <h2>{dt("byok.step1")}</h2>
        <p className="muted small">{dt("byok.step1Hint", { principal: data.platformPrincipal })}</p>
        <pre className="data-policy" tabIndex={0}>
          {policy}
        </pre>
        <div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              // "Copiado" solo si se copió: sin portapapeles (http://IP) o sin permiso, se copia a mano.
              try {
                await navigator.clipboard.writeText(policy);
                setCopied(true);
              } catch {
                /* copia manual */
              }
            }}
          >
            {copied ? dt("byok.copied") : dt("byok.copy")}
          </button>
        </div>
      </section>

      <form className="card pad stack" onSubmit={enable}>
        <h2>{dt("byok.step2")}</h2>
        <label className="field">
          <span>{dt("byok.keyArn")}</span>
          <input
            required
            value={arn}
            onChange={(e) => setArn(e.target.value)}
            placeholder="arn:aws:kms:us-east-1:111122223333:key/…"
            pattern="arn:aws[a-z\-]*:kms:[a-z0-9\-]+:\d{12}:key/[A-Za-z0-9\-]+"
            spellCheck={false}
          />
          <small className="muted">{dt("byok.keyArnHint", { region: data.region || "—" })}</small>
        </label>
        <div>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? dt("common.loading") : data.status === "none" ? dt("byok.enable") : dt("byok.change")}
          </button>
        </div>
        {testMsg && (
          <p className="alert alert-success" role="status">
            {testMsg}
          </p>
        )}
        {checks && (
          <ul className="data-checks" aria-live="polite">
            {checks.map((c) => (
              <li key={c.name} className={c.ok ? "ok" : "fail"}>
                {c.ok ? "✓" : "✗"} {dt(`byok.check.${c.name}` as DataKey)}
                {c.detail ? <span className="muted small"> — {c.detail}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <ErrorBox error={error} />
      </form>
    </div>
  );
}
