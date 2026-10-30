// Bloque Datos en la web: selector de celda en el alta, verificación de dominios SSO y archivo a largo plazo.
import { useEffect, useState } from "react";
import type { ArchiveInfo, CellInfo, CellsResponse, SsoDomainStatus } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { useDataText } from "../lib/i18n-data";
import { ErrorBox } from "./ui";

const AREAS = ["americas", "europe", "asia_pacific", "middle_east_africa"] as const;

/** «Dónde se guardan tus documentos»: todas las regiones del catálogo, habilitadas y agrupadas por zona. */
export function CellPicker({ value, onChange }: { value: string; onChange: (cell: string) => void }) {
  const dt = useDataText();
  const { locale } = useI18n();
  const [cells, setCells] = useState<CellInfo[]>([]);
  useEffect(() => {
    let vivo = true;
    api<CellsResponse>("/v1/public/cells")
      .then((r) => {
        if (!vivo) return;
        setCells(r.items);
        if (!value) onChange(r.items.find((c) => c.default)?.id ?? r.items.find((c) => c.available)?.id ?? "");
      })
      .catch(() => vivo && setCells([]));
    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (cells.filter((c) => c.available).length < 1) return null;

  // El país en el idioma de la pantalla (Intl), con la ciudad: «Canadá (Calgary)», «Canada (Calgary)».
  let countries: Intl.DisplayNames | null = null;
  try {
    countries = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    countries = null; // navegador sin Intl.DisplayNames: queda el nombre en castellano de la API
  }
  const name = (c: CellInfo) => {
    const country = c.country && countries ? countries.of(c.country) : null;
    if (!country) return c.label;
    return c.city && c.city !== country ? `${country} (${c.city})` : country;
  };
  const option = (c: CellInfo) => (
    <option key={c.id} value={c.id}>
      {name(c)}
    </option>
  );
  const sinZona = cells.filter((c) => !c.area);
  return (
    <label className="field data-cells">
      <span>{dt("cells.title")}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {sinZona.map(option)}
        {AREAS.map((a) => {
          const items = cells.filter((c) => c.area === a);
          if (!items.length) return null;
          return (
            <optgroup key={a} label={dt(`cells.area.${a}`)}>
              {items.map(option)}
            </optgroup>
          );
        })}
      </select>
      <small className="muted">{dt("cells.hint")}</small>
    </label>
  );
}

/** Estado de verificación DNS de los dominios SSO, con el TXT a publicar y el botón Verificar. */
export function SsoDomainVerification({ refreshKey }: { refreshKey?: unknown }) {
  const dt = useDataText();
  const [items, setItems] = useState<SsoDomainStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    api<{ items: SsoDomainStatus[] }>("/v1/settings/sso/domains")
      .then((r) => {
        setItems(r.items);
        // El error de una carga anterior (o de un "Verificar") no queda a la vista con la lista ya al día.
        setError(null);
      })
      .catch((e) => setError(errorText(e)));
  }, [refreshKey]);
  if (!items || items.length === 0) return error ? <ErrorBox error={error} /> : null;
  const verify = async (domain: string) => {
    setBusy(domain);
    setError(null);
    try {
      const r = await api<SsoDomainStatus>(`/v1/settings/sso/domains/${encodeURIComponent(domain)}/verify`, { method: "POST" });
      setItems((list) => (list ?? []).map((x) => (x.domain === domain ? r : x)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card pad data-domains" aria-labelledby="sso-domains-h">
      <h3 id="sso-domains-h">{dt("sso.domainStatus")}</h3>
      <p className="muted small">{dt("sso.domainHint")}</p>
      <ul className="data-domain-list">
        {items.map((d) => (
          <li key={d.domain}>
            <div className="data-domain-head">
              <strong>{d.domain}</strong>
              <span className={`badge ${d.verified ? "badge-completed" : "badge-draft"}`}>{d.verified ? dt("sso.verified") : dt("sso.pending")}</span>
              {!d.verified && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy === d.domain} onClick={() => void verify(d.domain)}>
                  {dt("sso.verify")}
                </button>
              )}
            </div>
            {!d.verified && (
              <div className="data-txt">
                <code>{d.txtName}</code> TXT <code className="secret">{d.txtValue}</code>
              </div>
            )}
            {!d.verified && d.lastError && <p className="muted small">{dt("sso.lastError", { error: d.lastError })}</p>}
          </li>
        ))}
      </ul>
      <ErrorBox error={error} />
    </section>
  );
}

/** Archivo a largo plazo de un sobre completado: vigencia del sello, versiones y renovación manual. */
export function ArchivePanel({ envelopeId, canManage }: { envelopeId: string; canManage: boolean }) {
  const dt = useDataText();
  const { locale } = useI18n();
  const [info, setInfo] = useState<ArchiveInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    api<ArchiveInfo>(`/v1/envelopes/${envelopeId}/archive`)
      .then(setInfo)
      .catch((e) => setError(errorText(e)));
  }, [envelopeId]);
  if (!info) return error ? <ErrorBox error={error} /> : null;
  const renew = async () => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await api<ArchiveInfo>(`/v1/envelopes/${envelopeId}/archive/renew`, { method: "POST" }));
      setDone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card pad data-archive" aria-labelledby="archive-h">
      <h3 id="archive-h">{dt("archive.title")}</h3>
      {info.validUntil ? (
        <p>{dt("archive.validUntil", { date: formatDateTime(info.validUntil, locale) })}</p>
      ) : (
        <p className="muted small">{dt("archive.noLtv")}</p>
      )}
      {info.renewals > 0 && <p className="muted small">{dt("archive.renewals", { n: info.renewals })}</p>}
      {info.versions.length > 0 && (
        <>
          <h4>{dt("archive.versions")}</h4>
          <ol className="data-versions">
            {info.versions.map((v) => (
              <li key={v.version}>
                <span>
                  v{v.version} · {dt(v.reason === "completed" ? "archive.reason.completed" : "archive.reason.archive_renewal")}
                </span>
                <span className="muted small"> · {formatDateTime(v.createdAt, locale)} · </span>
                <code className="small">{v.sha256.slice(0, 16)}…</code>
              </li>
            ))}
          </ol>
        </>
      )}
      {info.errorCode === "tsa_cannot_extend" && <p className="alert alert-warn">{dt("archive.tsaCannotExtend")}</p>}
      {done && (
        <p className="alert alert-success" role="status">
          {dt("archive.renewed")}
        </p>
      )}
      {canManage && info.validUntil && (
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void renew()}>
          {dt("archive.renew")}
        </button>
      )}
      <ErrorBox error={error} />
    </section>
  );
}
