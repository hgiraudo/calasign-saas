// Verificación pública de un PDF sellado (sin sesión).
import { useEffect, useRef, useState } from "react";
import type { PdfValidationResponse, PublicBrandTheme, VerifyResponse } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, interpolate, useI18n } from "../lib/i18n";
import { useSignerText } from "../lib/i18n-signer";
import { ErrorBox, LocaleSwitcher, Logo, Spinner } from "../components/ui";
import { ValidationReportView } from "../components/EvidenceExtras";
import { BrandFooter } from "../components/BrandFooter";
import { brandTheme, setBrandTheme, setVerifyPageMode, useTitle } from "../lib/white-label";

export function VerifyPage() {
  const { t, locale } = useI18n();
  const sx = useSignerText();
  useTitle(sx("verify.title"));
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [report, setReport] = useState<PdfValidationResponse | null>(null);
  const [fileName, setFileName] = useState("");
  const [over, setOver] = useState(false);
  // Solo vale la respuesta del último archivo: si se elige otro mientras el anterior se verifica, el resultado viejo
  // (que puede llegar después) se mostraba junto al nombre del archivo nuevo.
  const seq = useRef(0);
  // Marca blanca: el link del certificado trae ?b=<marca>. Normalmente el servidor ya la inyectó en la página; si se
  // llegó navegando dentro de la web, se pide acá.
  // Tema restringido mientras esta página está abierta (sin el CSS propio de la marca: ver white-label.ts).
  useEffect(() => {
    setVerifyPageMode(true);
    return () => setVerifyPageMode(false);
  }, []);
  useEffect(() => {
    const b = new URLSearchParams(window.location.search).get("b");
    if (!b || brandTheme()) return;
    api<PublicBrandTheme>(`/v1/public/brand-theme?b=${encodeURIComponent(b)}`)
      .then(setBrandTheme)
      .catch(() => {});
  }, []);

  const check = async (file: File | undefined) => {
    if (!file) return;
    const mine = ++seq.current;
    setBusy(true);
    setError(null);
    setResult(null);
    setFileName(file.name);
    try {
      const form = new FormData();
      form.append("file", file);
      setReport(null);
      const form2 = new FormData();
      form2.append("file", file);
      const [r, v] = await Promise.all([
        api<VerifyResponse>("/v1/verify", { method: "POST", form }),
        // Reporte técnico (integridad, cadena, revocación, nivel PAdES); si falla, se muestra igual la búsqueda por hash.
        api<PdfValidationResponse>("/v1/validate", { method: "POST", form: form2 }).catch(() => null),
      ]);
      if (mine !== seq.current) return;
      setResult(r);
      setReport(v);
    } catch (e) {
      if (mine === seq.current) setError(errorText(e));
    } finally {
      if (mine === seq.current) setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const roleLabel = (r: string) => (r === "approver" ? sx("role.approver") : t("edit.role.signer"));

  return (
    <div className="signer">
      <header className="signer-bar">
        <div className="signer-org">
          <Logo light />
        </div>
        <LocaleSwitcher compact />
      </header>
      <main className="signer-main stack">
        <div className="card pad stack">
          <h1>{sx("verify.title")}</h1>
          <p className="muted">{sx("verify.text")}</p>
          <label
            className={`dropzone ${over ? "over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              check(e.dataTransfer.files[0]);
            }}
          >
            <input ref={input} type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(e) => check(e.target.files?.[0])} />
            <span className="btn btn-primary">{sx("verify.choose")}</span>
            {fileName && <span className="muted small">{fileName}</span>}
          </label>
          {busy && (
            <div className="row-wrap">
              <Spinner /> <span className="muted">{sx("verify.checking")}</span>
            </div>
          )}
          <ErrorBox error={error} />
        </div>

        {/* Aviso del resultado para lectores de pantalla: región siempre presente (si se crea junto con el texto, no se
            anuncia) y solo con el título, no la tabla. La cadena rota se anuncia aparte con role=alert. */}
        <div role="status" aria-live="polite" className="sr-only">
          {result && !(result.match && result.chain && !result.chain.ok)
            ? `${result.match ? sx("verify.matchTitle") : sx("verify.noMatchTitle")}. ${result.match ? sx("verify.matchText") : sx("verify.noMatchText")}`
            : ""}
        </div>
        {result && (() => { const broken = Boolean(result.match && result.chain && !result.chain.ok); return (
          <div className="final card" data-testid={result.match ? "verify-match" : "verify-nomatch"} role={broken ? "alert" : undefined}>
            {/* Cadena de eventos rota: no se muestra "Documento válido ✓" aunque el PDF coincida. */}
            <div className={`final-icon ${result.match && !broken ? "ok" : ""}`} aria-hidden="true">
              {result.match ? (broken ? "!" : "✓") : "✕"}
            </div>
            <h1>{result.match ? (broken ? sx("verify.brokenTitle") : sx("verify.matchTitle")) : sx("verify.noMatchTitle")}</h1>
            <p className="muted">{result.match ? (broken ? sx("verify.brokenText") : sx("verify.matchText")) : sx("verify.noMatchText")}</p>
            {result.match && result.version && !result.version.isLatest && (
              <p className="notice" role="status" data-testid="verify-older-version">
                {interpolate(sx("verify.olderVersion"), { n: result.version.number, latest: result.version.latest })}
              </p>
            )}
            {result.match && result.envelope && (
              <table className="table" style={{ textAlign: "left" }}>
                <tbody>
                  <tr>
                    <th>{sx("verify.subject")}</th>
                    <td>{result.envelope.subject}</td>
                  </tr>
                  <tr>
                    <th>{sx("verify.org")}</th>
                    <td>{result.envelope.organizationName}</td>
                  </tr>
                  <tr>
                    <th>{sx("verify.completed")}</th>
                    <td>{formatDateTime(result.envelope.completedAt, locale)}</td>
                  </tr>
                  <tr>
                    <th>{sx("verify.participants")}</th>
                    <td>
                      {result.participants?.map((p, i) => (
                        <div key={i}>
                          {p.name} <span className="muted small">· {roleLabel(p.role)} · {formatDateTime(p.signedAt, locale)}</span>
                        </div>
                      ))}
                    </td>
                  </tr>
                  <tr>
                    <th>{sx("verify.seal")}</th>
                    <td>{result.seal?.format ?? "—"}</td>
                  </tr>
                  <tr>
                    <th>{sx("verify.chain")}</th>
                    <td>{result.chain?.ok ? sx("verify.chainOk", { n: result.chain.events }) : sx("verify.chainBroken")}</td>
                  </tr>
                  <tr>
                    <th>{sx("verify.envelope")}</th>
                    <td className="mono small break">{result.envelope.id}</td>
                  </tr>
                </tbody>
              </table>
            )}
            <p className="small mono break">
              {sx("verify.hash")}: {result.sha256}
            </p>
          </div>
        ); })()}
        {report && (
          <div className="card pad">
            <ValidationReportView report={report} />
          </div>
        )}
      </main>
      <BrandFooter />
    </div>
  );
}
