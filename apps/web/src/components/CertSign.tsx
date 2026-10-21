// Firma con certificado propio: opción del destinatario en el editor, progreso en el detalle del sobre y el paso
// del firmante (código de vinculación + enlace al Firmador CalaSign).
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CertsignPairing, EnvelopeCertificateProgress, SignatureType, SigningCertificateStep } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { useCertsignText } from "../lib/i18n-certsign";
import { ErrorBox } from "./ui";

export interface CertDraft {
  signatureType: SignatureType;
  matchIdDocument: boolean;
  requireQualified: boolean;
  /** Emisores separados por coma. */
  allowedIssuers: string;
}

// «Corresponde al documento» es opt-in: solo traba el envío si el remitente lo marca en un destinatario con documento.
export const EMPTY_CERT_DRAFT: CertDraft = { signatureType: "electronic", matchIdDocument: false, requireQualified: false, allowedIssuers: "" };

export function certToDraft(r: { signatureType?: SignatureType; certificateRequirements?: { matchIdDocument: boolean; allowedIssuers: string[]; requireQualified: boolean } | null }): CertDraft {
  const q = r.certificateRequirements;
  return {
    signatureType: r.signatureType ?? "electronic",
    matchIdDocument: q?.matchIdDocument ?? false,
    requireQualified: q?.requireQualified ?? false,
    allowedIssuers: (q?.allowedIssuers ?? []).join(", "),
  };
}

/** Campos para el cuerpo del PUT de destinatarios. */
export function draftToCert(d: CertDraft, role: string) {
  if (role !== "signer" || d.signatureType !== "certificate") return { signatureType: "electronic" as const, certificateRequirements: null };
  return {
    signatureType: "certificate" as const,
    certificateRequirements: {
      matchIdDocument: d.matchIdDocument,
      requireQualified: d.requireQualified,
      allowedIssuers: d.allowedIssuers
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length >= 2)
        .slice(0, 10),
    },
  };
}

/**
 * `hasIdDocument`: el destinatario tiene número de documento. `template`: en una plantilla el documento llega en cada
 * sobre (o no llega: formularios web, envíos masivos, CRM…), así que no se ofrece exigir que corresponda.
 */
export function CertificateOption({
  value,
  hasIdDocument,
  template = false,
  onChange,
}: {
  value: CertDraft;
  hasIdDocument: boolean;
  template?: boolean;
  onChange: (v: CertDraft) => void;
}) {
  const c = useCertsignText();
  return (
    <div className="certsign-option">
      <label className="field">
        <span>{c("edit.signatureType")}</span>
        <select
          value={value.signatureType}
          onChange={(e) => {
            // El control del documento no se marca ni se desmarca solo: queda lo que eligió el remitente (si lo marcó y
            // falta el documento, se muestra el aviso).
            onChange({ ...value, signatureType: e.target.value as SignatureType });
          }}
        >
          <option value="electronic">{c("edit.signatureType.electronic")}</option>
          <option value="certificate">{c("edit.signatureType.certificate")}</option>
        </select>
      </label>
      {value.signatureType === "certificate" && (
        <div className="certsign-reqs">
          <p className="muted small">{c("edit.certHint")}</p>
          {template ? (
            <p className="muted small">{c("edit.certMatchTemplate")}</p>
          ) : (
            <>
              <label className="check">
                <input type="checkbox" checked={value.matchIdDocument} onChange={(e) => onChange({ ...value, matchIdDocument: e.target.checked })} />
                <span>{c("edit.certMatch")}</span>
              </label>
              {value.matchIdDocument && !hasIdDocument && (
                <p className="error-text small" role="alert">
                  {c("edit.certMatchNoDoc")}
                </p>
              )}
              {!value.matchIdDocument && hasIdDocument && (
                <p className="muted small">
                  {c("edit.certMatchOffer")}{" "}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...value, matchIdDocument: true })}>
                    {c("edit.certMatchEnable")}
                  </button>
                </p>
              )}
            </>
          )}
          <label className="check">
            <input type="checkbox" checked={value.requireQualified} onChange={(e) => onChange({ ...value, requireQualified: e.target.checked })} />
            <span>{c("edit.certQualified")}</span>
          </label>
          <label className="field">
            <span>{c("edit.certIssuers")}</span>
            <input value={value.allowedIssuers} maxLength={600} placeholder={c("edit.certIssuersHint")} onChange={(e) => onChange({ ...value, allowedIssuers: e.target.value })} />
          </label>
        </div>
      )}
    </div>
  );
}

/** Detalle del sobre: firmas con certificado y su estado. No se muestra si nadie firma con certificado. */
/** `refreshKey` cambia cuando hay eventos nuevos del sobre (una firma con certificado no siempre cambia el estado). */
export function CertificateProgressPanel({ envelopeId, status, refreshKey }: { envelopeId: string; status: string; refreshKey?: number }) {
  const c = useCertsignText();
  const { locale } = useI18n();
  const [data, setData] = useState<EnvelopeCertificateProgress | null>(null);
  useEffect(() => {
    let alive = true;
    api<EnvelopeCertificateProgress>(`/v1/envelopes/${envelopeId}/certificate-signatures`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [envelopeId, status, refreshKey]);
  if (!data || data.signers.length === 0) return null;
  return (
    <div className="card pad certsign-progress">
      <h3>{c("detail.certTitle")}</h3>
      <p className="muted small">{c("detail.certIntro")}</p>
      <ol className="certsign-list">
        {data.signers.map((s) => (
          <li key={s.recipientId} className={s.status === "signed" ? "is-signed" : ""}>
            <strong>{s.name}</strong> · {s.status === "signed" ? `✓ ${c("detail.certSigned")}` : c("detail.certPending")}
            {s.status === "signed" && (
              <div className="muted small">
                {s.commonName} · {s.issuer}
                {s.serialNumber ? ` · ${c("detail.certSerial")} ${s.serialNumber}` : ""}
                {s.signedAt ? ` · ${formatDateTime(s.signedAt, locale)}` : ""}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Paso del firmante: espera, código de vinculación con el Firmador, o firma hecha. */
export function SignerCertificateStep({ step, base, onChange }: { step: SigningCertificateStep; base: string; onChange: () => void }) {
  const c = useCertsignText();
  const { locale } = useI18n();
  const [pairing, setPairing] = useState<CertsignPairing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mientras falte la firma, se consulta la sesión para enterarse cuando el Firmador termina o llega el turno.
  useEffect(() => {
    if (step.status === "signed") return;
    const t = setInterval(onChange, pairing ? 4000 : 15000);
    return () => clearInterval(t);
  }, [step.status, pairing, onChange]);

  const reqs: string[] = [];
  if (step.requirements.matchIdDocument) reqs.push(c("sign.certReqMatch"));
  if (step.requirements.requireQualified) reqs.push(c("sign.certReqQualified"));
  if (step.requirements.allowedIssuers.length) reqs.push(c("sign.certReqIssuers", { list: step.requirements.allowedIssuers.join(", ") }));

  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      setPairing(await api<CertsignPairing>(`${base}/certsign/pairing`, { method: "POST", body: {} }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (step.status === "signed") {
    return (
      <div className="certsign-step is-signed">
        <h3>✓ {c("sign.certSignedTitle")}</h3>
        {step.certificate && <p className="muted small">{c("sign.certSignedWith", { cn: step.certificate.commonName ?? step.certificate.subject, issuer: step.certificate.issuer })}</p>}
      </div>
    );
  }
  if (step.status === "waiting") {
    return (
      <div className="certsign-step">
        <h3>{c("sign.certTitle")}</h3>
        <p>{c("sign.certWaiting", { position: step.position, total: step.total })}</p>
        {reqs.length > 0 && <p className="muted small">{c("sign.certRequirements", { list: reqs.join(" · ") })}</p>}
      </div>
    );
  }
  return (
    <div className="certsign-step is-active">
      <h3>{c("sign.certTitle")}</h3>
      <p>{c("sign.certYourTurn")}</p>
      {reqs.length > 0 && <p className="muted small">{c("sign.certRequirements", { list: reqs.join(" · ") })}</p>}
      <ol className="certsign-steps">
        <li>
          {c("sign.certSteps1")}{" "}
          <Link to="/firmador" target="_blank" rel="noreferrer">
            {c("sign.certDownload")}
          </Link>
        </li>
        <li>{c("sign.certSteps2")}</li>
        <li>{c("sign.certSteps3")}</li>
      </ol>
      <ErrorBox error={error} />
      {!pairing ? (
        <button className="btn btn-primary" disabled={busy} onClick={pair}>
          {c("sign.certGetCode")}
        </button>
      ) : (
        <div className="certsign-code">
          <div className="muted small">{c("sign.certCode")}</div>
          <div className="certsign-code-value" aria-live="polite">
            {pairing.code}
          </div>
          <div className="muted small">{c("sign.certCodeExpires", { time: new Date(pairing.expiresAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) })}</div>
          <div className="row gap">
            <a className="btn btn-primary" href={pairing.deepLink}>
              {c("sign.certOpen")}
            </a>
            <button className="btn" disabled={busy} onClick={pair}>
              {c("sign.certGetCode")}
            </button>
          </div>
          <p className="muted small">{c("sign.certWaitingSignature")}</p>
        </div>
      )}
    </div>
  );
}
