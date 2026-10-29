// Certificados de la organización, nivel PAdES y conectores de firma.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { EvidenceSettings, SealLevelSetting, SignatureProviderInfo, SignatureProviderTestResult, TenantCertificate } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n, placeholderText } from "../lib/i18n";
import { useEvidenceText } from "../lib/i18n-evidence";
import { ErrorBox, Spinner } from "../components/ui";
import { useTitle } from "../lib/white-label";

function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

// La API acepta hasta 2 000 000 caracteres en base64 (≈ 1,5 MB de archivo).
const MAX_P12_BYTES = 1_500_000;

export function CertificatesPage() {
  const ev = useEvidenceText();
  useTitle(ev("cert.title"));
  const { locale, t: tc } = useI18n();
  const [items, setItems] = useState<TenantCertificate[] | null>(null);
  const [settings, setSettings] = useState<EvidenceSettings | null>(null);
  const [providers, setProviders] = useState<SignatureProviderInfo[]>([]);
  const [tests, setTests] = useState<Record<string, SignatureProviderTestResult>>({});
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [usages, setUsages] = useState<string[]>(["xml", "pdf_seal"]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = () =>
    Promise.all([
      api<{ items: TenantCertificate[] }>("/v1/certificates").then((r) => setItems(r.items)),
      api<EvidenceSettings>("/v1/settings/evidence").then(setSettings),
      api<{ items: SignatureProviderInfo[] }>("/v1/signature-providers").then((r) => setProviders(r.items)),
    ]).catch((e) => setError(errorText(e)));

  useEffect(() => {
    void load();
  }, []);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    if (file.size > MAX_P12_BYTES) {
      setNotice(null);
      setError(ev("cert.tooBig"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api("/v1/certificates", { method: "POST", body: { name, password, usages, p12Base64: await fileToBase64(file) } });
      setName("");
      setPassword("");
      if (fileRef.current) fileRef.current.value = "";
      setNotice(ev("cert.uploaded"));
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    // Doble clic en "Eliminar": el segundo DELETE respondía 404 y se mostraba un error aunque se hubiera borrado.
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/certificates/${id}`, { method: "DELETE" });
      setConfirming(null);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const setLevel = async (sealLevel: SealLevelSetting) => {
    setError(null);
    try {
      setSettings(await api<EvidenceSettings>("/v1/settings/evidence", { method: "PATCH", body: { sealLevel } }));
      setNotice(ev("level.saved"));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const test = async (id: string) => {
    try {
      const r = await api<SignatureProviderTestResult>(`/v1/signature-providers/${encodeURIComponent(id)}/test`, { method: "POST", body: {} });
      setTests((t) => ({ ...t, [id]: r }));
    } catch (err) {
      setError(errorText(err));
    }
  };

  const toggleUsage = (u: string) => setUsages((list) => (list.includes(u) ? list.filter((x) => x !== u) : [...list, u]));

  return (
    <div className="page narrow stack">
      <div className="page-head">
        <h1>{ev("cert.title")}</h1>
      </div>
      <p className="muted">{ev("cert.intro")}</p>
      <ErrorBox error={error} />
      {notice && (
        <div className="alert alert-success" role="status">
          {notice}
        </div>
      )}

      <form onSubmit={upload} className="card pad stack" aria-labelledby="cert-upload-title">
        <h2 id="cert-upload-title" className="h3">
          {ev("cert.upload")}
        </h2>
        <div className="row-wrap">
          <label className="field grow">
            <span>{ev("cert.name")}</span>
            <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholderText("seal")} />
          </label>
          <label className="field grow">
            <span>{ev("cert.file")}</span>
            <input ref={fileRef} required type="file" accept=".p12,.pfx,application/x-pkcs12" data-testid="cert-file" />
          </label>
          <label className="field grow">
            <span>{ev("cert.password")}</span>
            <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </div>
        <fieldset className="row-wrap">
          <legend className="small muted">{ev("cert.usages")}</legend>
          {(["pdf_seal", "xml"] as const).map((u) => (
            <label key={u} className="check">
              <input type="checkbox" checked={usages.includes(u)} onChange={() => toggleUsage(u)} /> {ev(`cert.usage.${u}`)}
            </label>
          ))}
        </fieldset>
        <div>
          <button className="btn btn-primary" disabled={busy || !name.trim() || usages.length === 0}>
            {busy ? <Spinner /> : ev("cert.upload")}
          </button>
        </div>
      </form>

      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{ev("cert.empty")}</div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{ev("cert.name")}</th>
                <th>{ev("cert.subject")}</th>
                <th className="hide-sm">{ev("cert.issuer")}</th>
                <th className="hide-sm">{ev("cert.validUntil")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} data-testid="cert-row">
                  <td>
                    {c.name}
                    <div className="muted small">{c.usages.map((u) => ev(`cert.usage.${u}` as Parameters<typeof ev>[0])).join(" · ")}</div>
                  </td>
                  <td className="break">{c.commonName ?? c.subject}</td>
                  <td className="hide-sm break">{c.issuer}</td>
                  <td className="hide-sm">
                    {formatDateTime(c.notAfter, locale)} {c.expired && <span className="badge badge-declined">{ev("cert.expired")}</span>}
                  </td>
                  <td className="right">
                    {confirming === c.id ? (
                      <span className="row-wrap">
                        <span className="small">{ev("cert.deleteConfirm")}</span>
                        <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => remove(c.id)}>
                          {ev("cert.delete")}
                        </button>
                        <button type="button" className="btn btn-sm" aria-label={tc("common.cancel")} onClick={() => setConfirming(null)}>
                          ✕
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirming(c.id)}>
                        {ev("cert.delete")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {settings && (
        <section className="card pad stack" aria-labelledby="level-title">
          <h2 id="level-title" className="h3">
            {ev("level.title")}
          </h2>
          <p className="muted small">{ev("level.intro")}</p>
          <label className="field">
            <select value={settings.sealLevel} onChange={(e) => void setLevel(e.target.value as SealLevelSetting)} data-testid="seal-level-setting">
              <option value="auto">{ev("level.auto")}</option>
              {(["B-B", "B-T", "B-LT", "B-LTA"] as const).map((l) => (
                <option key={l} value={l}>
                  PAdES {l}
                </option>
              ))}
            </select>
          </label>
          <p className="small">{settings.tsaConfigured ? ev("level.effective", { level: `PAdES ${settings.effectiveLevel}` }) : ev("level.noTsa")}</p>
        </section>
      )}

      {providers.length > 0 && (
        <section className="card pad stack" aria-labelledby="prov-title">
          <h2 id="prov-title" className="h3">
            {ev("prov.title")}
          </h2>
          <p className="muted small">{ev("prov.intro")}</p>
          <table className="table small">
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.type === "platform" ? ev("prov.platform") : p.id}</strong>
                    {p.baseUrl && <div className="muted break">{p.baseUrl}</div>}
                  </td>
                  <td>{p.level}</td>
                  <td className="right">
                    {!p.configured ? (
                      <span className="muted">{ev("prov.notConfigured")}</span>
                    ) : p.type === "csc" ? (
                      tests[p.id] ? (
                        <span className={tests[p.id].ok ? "" : "error-text"}>
                          {tests[p.id].ok ? `✓ ${ev("prov.ok")}${tests[p.id].holder ? ` · ${tests[p.id].holder}` : ""}` : `✕ ${ev("prov.fail")}`}
                        </span>
                      ) : (
                        <button type="button" className="btn btn-sm" onClick={() => void test(p.id)}>
                          {ev("prov.test")}
                        </button>
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
