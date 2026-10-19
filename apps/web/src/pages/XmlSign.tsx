// Firma XML (facturación electrónica) con el certificado de la organización.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TenantCertificate, XmlProfileName, XmlSignResponse } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useEvidenceText } from "../lib/i18n-evidence";
import { ErrorBox, Spinner } from "../components/ui";

const PROFILES: XmlProfileName[] = ["dgii-ecf", "dian-fe", "sunat-cpe", "xades-bes", "xades-epes"];

export function XmlSignPage() {
  const ev = useEvidenceText();
  const [certs, setCerts] = useState<TenantCertificate[] | null>(null);
  const [certificateId, setCertificateId] = useState("");
  const [profile, setProfile] = useState<XmlProfileName>("dgii-ecf");
  const [xml, setXml] = useState("");
  const [policyId, setPolicyId] = useState("");
  const [policyHash, setPolicyHash] = useState("");
  const [result, setResult] = useState<XmlSignResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Aparte del error general: un archivo leído bien limpia el de uno anterior sin borrar, p. ej., el de los certificados.
  const [fileError, setFileError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ items: TenantCertificate[] }>("/v1/certificates")
      .then((r) => {
        const usable = r.items.filter((c) => !c.expired && c.usages.includes("xml"));
        setCerts(usable);
        if (usable[0]) setCertificateId(usable[0].id);
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  // Como en el envío masivo: solo vale la lectura del último archivo elegido y un archivo que no se puede leer (movido,
  // sin permiso) muestra el error en lugar de un rechazo sin manejar (antes no pasaba nada al elegirlo).
  const fileSeq = useRef(0);
  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    const mine = ++fileSeq.current;
    try {
      const text = await f.text();
      if (mine !== fileSeq.current) return;
      setXml(text);
      setResult(null);
      setFileError(null);
    } catch (e) {
      if (mine === fileSeq.current) setFileError(errorText(e));
    }
  };

  const sign = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFileError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = { xml, profile, certificateId };
      if (profile === "xades-epes") body.policy = { identifier: policyId, hashBase64: policyHash };
      setResult(await api<XmlSignResponse>("/v1/xml/sign", { method: "POST", body }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([result.signedXml], { type: "application/xml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `firmado-${profile}.xml`;
    a.click();
    // Revocar en el mismo tick puede cancelar la descarga (Safari/Firefox): se libera después, como en Documents.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <div className="page narrow stack">
      <div className="page-head">
        <h1>{ev("xml.title")}</h1>
      </div>
      <p className="muted">{ev("xml.intro")}</p>
      <ErrorBox error={error} />
      <ErrorBox error={fileError} />
      {certs && certs.length === 0 ? (
        <div className="empty">{ev("xml.noCerts")}</div>
      ) : (
        <form onSubmit={sign} className="card pad stack">
          <div className="row-wrap">
            <label className="field grow">
              <span>{ev("xml.profile")}</span>
              <select value={profile} onChange={(e) => setProfile(e.target.value as XmlProfileName)} data-testid="xml-profile">
                {PROFILES.map((p) => (
                  <option key={p} value={p}>
                    {ev(`xml.profile.${p}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field grow">
              <span>{ev("xml.certificate")}</span>
              <select value={certificateId} onChange={(e) => setCertificateId(e.target.value)} required>
                {(certs ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.commonName ?? c.subject}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {profile === "xades-epes" && (
            <div className="row-wrap">
              <label className="field grow">
                <span>{ev("xml.policyId")}</span>
                <input type="url" required value={policyId} onChange={(e) => setPolicyId(e.target.value)} />
              </label>
              <label className="field grow">
                <span>{ev("xml.policyHash")}</span>
                <input required value={policyHash} onChange={(e) => setPolicyHash(e.target.value)} />
              </label>
            </div>
          )}
          <label className="field">
            <span>{ev("xml.input")}</span>
            <textarea rows={10} className="mono small" value={xml} onChange={(e) => setXml(e.target.value)} required spellCheck={false} data-testid="xml-input" />
          </label>
          <div className="row-wrap">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              {ev("xml.loadFile")}
            </button>
            <input ref={fileRef} type="file" accept=".xml,application/xml,text/xml" className="sr-only" onChange={(e) => {
                const f = e.target.files?.[0];
                // Vaciado: volver a elegir el mismo archivo (después de editar el texto) no disparaba onChange.
                e.target.value = "";
                void loadFile(f);
              }}
            />
            <button className="btn btn-primary" disabled={busy || !xml.trim() || !certificateId}>
              {busy ? <Spinner /> : ev("xml.sign")}
            </button>
          </div>
        </form>
      )}
      {result && (
        <section className="card pad stack" data-testid="xml-result">
          <div className="row-wrap">
            <h2 className="h3">{ev("xml.signed")}</h2>
            <span className={`badge ${result.verification.valid ? "badge-completed" : "badge-declined"}`}>
              {result.verification.valid ? ev("xml.valid") : ev("xml.invalid")}
            </span>
          </div>
          {result.verification.errors.length > 0 && <ErrorBox error={result.verification.errors.join(" · ")} />}
          <p className="small mono break">SHA-256: {result.sha256}</p>
          <textarea readOnly rows={8} className="mono small" value={result.signedXml} />
          <div>
            <button type="button" className="btn btn-primary" onClick={download}>
              {ev("xml.download")}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
