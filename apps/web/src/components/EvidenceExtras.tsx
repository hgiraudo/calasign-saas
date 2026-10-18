// Piezas de evidencia reutilizables: opciones de sello del sobre y reporte técnico de validación.
import { useEffect, useState } from "react";
import type { PdfValidationResponse, SealOptions, SignatureLevel, TenantCertificate } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { useEvidenceText } from "../lib/i18n-evidence";
import { ErrorBox } from "./ui";

/**
 * Sello de empresa y nivel de firma declarado de un sobre (borrador o en curso).
 * `sealOnly`: sobre trabado en la finalización; solo se puede cambiar o quitar el sello (no el nivel), y solo si tiene uno.
 */
export function SealOptionsPanel({
  envelopeId,
  disabled,
  sealOnly,
}: {
  envelopeId: string;
  disabled?: boolean;
  sealOnly?: boolean;
}) {
  const ev = useEvidenceText();
  const [opts, setOpts] = useState<SealOptions | null>(null);
  const [certs, setCerts] = useState<TenantCertificate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<SealOptions>(`/v1/envelopes/${envelopeId}/seal-options`).then(setOpts).catch((e) => setError(errorText(e)));
    api<{ items: TenantCertificate[] }>("/v1/certificates")
      .then((r) => setCerts(r.items.filter((c) => !c.expired && c.usages.includes("pdf_seal"))))
      .catch(() => setCerts([]));
  }, [envelopeId]);

  const save = async (patch: { companySealCertificateId?: string | null; signatureLevel?: SignatureLevel }) => {
    setError(null);
    setSaved(false);
    try {
      setOpts(await api<SealOptions>(`/v1/envelopes/${envelopeId}/seal-options`, { method: "PUT", body: patch }));
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!opts) return error ? <ErrorBox error={error} /> : null;
  if (sealOnly && !opts.companySealCertificateId && !saved) return null;
  // El certificado actual puede no estar en la lista (vencido o borrado): se muestra igual para no aparentar "sin sello".
  const currentMissing = !!opts.companySealCertificateId && !certs.some((c) => c.id === opts.companySealCertificateId);
  return (
    <section className="card pad stack" aria-labelledby="seal-options-title">
      <h2 id="seal-options-title" className="h3">
        {ev("seal.title")}
      </h2>
      {sealOnly && <p className="muted small">{ev("seal.recover")}</p>}
      <div className="row-wrap">
        {!sealOnly && (
          <label className="field grow">
            <span>{ev("seal.level")}</span>
          <select
            value={opts.signatureLevel}
            disabled={disabled}
            onChange={(e) => void save({ signatureLevel: e.target.value as SignatureLevel })}
            data-testid="seal-level"
          >
            {(["simple", "advanced", "qualified"] as const).map((l) => (
              <option key={l} value={l}>
                {ev(`seal.level.${l}`)}
              </option>
            ))}
          </select>
          </label>
        )}
        <label className="field grow">
          <span>{ev("seal.company")}</span>
          <select
            value={opts.companySealCertificateId ?? ""}
            disabled={disabled || (certs.length === 0 && !opts.companySealCertificateId)}
            onChange={(e) => void save({ companySealCertificateId: e.target.value || null })}
            data-testid="company-seal"
          >
            <option value="">{ev("seal.none")}</option>
            {currentMissing && (
              <option value={opts.companySealCertificateId!} disabled>
                {ev("seal.current")}
              </option>
            )}
            {certs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.commonName ?? c.subject}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">{certs.length === 0 ? ev("seal.noCerts") : ev("seal.hint")}</p>
      {saved && (
        <p className="small" role="status">
          ✓ {ev("seal.saved")}
        </p>
      )}
      <ErrorBox error={error} />
    </section>
  );
}

/** Reporte técnico de /v1/validate. */
export function ValidationReportView({ report }: { report: PdfValidationResponse }) {
  const ev = useEvidenceText();
  const { locale } = useI18n();
  if (report.signatures.length === 0) return <p className="muted">{ev("val.none")}</p>;
  let n = 0;
  return (
    <div className="stack" data-testid="validation-report">
      <h2 className="h3">{ev("val.title")}</h2>
      {report.dss && <p className="muted small">{ev("val.dss", report.dss)}</p>}
      {report.signatures.map((s) => {
        const title = s.kind === "document_timestamp" ? ev("val.docTimestamp") : ev("val.signature", { n: ++n });
        const ok = s.integrity.valid && (!s.timestamp || s.timestamp.valid) && s.changesAfter !== "content";
        // "De confianza" solo si además ningún certificado estaba revocado ni vencido al firmar (mismo criterio que summary.allTrusted).
        const chainLabel = s.chain.revoked
          ? ev("val.rev.revoked")
          : s.chain.timeValid === false
            ? ev("val.expiredAtSigning")
            : s.chain.trusted
              ? ev("val.trusted")
              : ev("val.untrusted");
        const chainOk = s.chain.trusted && !s.chain.revoked && s.chain.timeValid !== false;
        return (
          <div key={s.index} className="card pad stack" data-testid="validation-signature">
            <div className="row-wrap">
              <strong>{title}</strong>
              <span className={`badge ${ok ? "badge-completed" : "badge-declined"}`}>{ok ? ev("val.intact") : ev("val.broken")}</span>
              {s.chain.entries.length > 0 && (
                <span className={`badge ${chainOk ? "badge-completed" : s.chain.revoked || s.chain.timeValid === false ? "badge-declined" : "badge-sent"}`}>{chainLabel}</span>
              )}
              {s.level && <span className="badge badge-draft">{s.level}</span>}
            </div>
            <table className="table small">
              <tbody>
                {s.signer && (
                  <tr>
                    <th>{ev("val.signer")}</th>
                    <td className="break">{s.signer.commonName ?? s.signer.subject}</td>
                  </tr>
                )}
                {s.signingTime && (
                  <tr>
                    <th>{ev("val.time")}</th>
                    <td>{formatDateTime(s.signingTime, locale)}</td>
                  </tr>
                )}
                {s.timestamp && (
                  <tr>
                    <th>{ev("val.timestamp")}</th>
                    <td>
                      {formatDateTime(s.timestamp.time, locale)} · {s.timestamp.tsa ?? "TSA"} {s.timestamp.valid ? (s.timestamp.trusted === false ? `⚠ ${ev("val.tsaUntrusted")}` : "✓") : "✕"}
                    </td>
                  </tr>
                )}
                {!s.integrity.valid && s.integrity.reason && (
                  <tr>
                    <th>{ev("val.integrity")}</th>
                    <td className="break">{s.integrity.reason}</td>
                  </tr>
                )}
                <tr>
                  <th>{ev("val.coverage")}</th>
                  <td>{s.coversWholeDocument ? ev("val.coversAll") : s.changesAfter === "content" ? ev("val.changedAfter") : ev("val.modifiedAfter")}</td>
                </tr>
                {s.chain.entries.length > 0 && (
                  <tr>
                    <th>{ev("val.chain")}</th>
                    <td>
                      {s.chain.entries.map((c, i) => (
                        <div key={i} className="break">
                          {c.commonName ?? c.subject}{" "}
                          <span className="muted">
                            · {ev(`val.rev.${c.revocation.status}` as Parameters<typeof ev>[0])}
                            {c.revocation.source ? ` (${c.revocation.source})` : ""}
                          </span>
                        </div>
                      ))}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
