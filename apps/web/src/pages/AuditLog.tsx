// Auditoría de la cuenta: filtros, paginación y export CSV.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AuditLogEntry, AuditLogResponse } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { csvFormatParams, downloadCsv } from "../lib/csv";
import { useTeamsText } from "../lib/i18n-teams";
import { ErrorBox, Spinner } from "../components/ui";
import { useTitle } from "../lib/white-label";

interface Filters {
  action: string;
  actor: string;
  from: string;
  to: string;
}

function query(f: Filters, cursor?: string | null) {
  const p = new URLSearchParams();
  if (f.action.trim()) p.set("action", f.action.trim());
  if (f.actor.trim()) p.set("actor", f.actor.trim());
  if (f.from) p.set("from", new Date(`${f.from}T00:00:00`).toISOString());
  // .999: la API compara con <=, y sin los milisegundos quedaba afuera lo ocurrido en el último segundo del día.
  if (f.to) p.set("to", new Date(`${f.to}T23:59:59.999`).toISOString());
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export function AuditLogPage() {
  const tt = useTeamsText();
  useTitle(tt("audit.title"));
  const { locale } = useI18n();
  const [filters, setFilters] = useState<Filters>({ action: "", actor: "", from: "", to: "" });
  const [applied, setApplied] = useState<Filters>(filters);
  const [items, setItems] = useState<AuditLogEntry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Cada búsqueda con filtros abre una "generación": una página extra pedida antes (o durante) la carga nueva no se
  // mezcla en la lista, y "cargar más" no descarta la carga de los filtros recién aplicados.
  const gen = useRef(0);
  const moreInFlight = useRef(false);

  const load = async (f: Filters, more = false) => {
    if (more && (moreInFlight.current || !cursor)) return;
    const n = more ? gen.current : ++gen.current;
    moreInFlight.current = more;
    setError(null);
    setLoadingMore(more);
    // Con filtros nuevos, el cursor viejo no sirve: se oculta "cargar más" hasta que llegue la primera página.
    if (!more) {
      setCursor(null);
      // Las filas son de los filtros anteriores: no quedan a la vista mientras carga (o si falla) la búsqueda nueva.
      setItems(null);
    }
    try {
      const r = await api<AuditLogResponse>(`/v1/audit-log?${query(f, more ? cursor : null)}`);
      if (n !== gen.current) return;
      setItems((prev) => (more && prev ? [...prev, ...r.items] : r.items));
      setCursor(r.nextCursor);
    } catch (e) {
      if (n === gen.current) setError(errorText(e));
    } finally {
      if (n === gen.current && more) {
        moreInFlight.current = false;
        setLoadingMore(false);
      }
    }
  };
  useEffect(() => {
    void load(applied);
  }, [applied]); // eslint-disable-line react-hooks/exhaustive-deps

  const [downloading, setDownloading] = useState(false);
  // Export truncado: filtros con los que se exportó (no los que estén en el formulario) e id de la última fila, para
  // descargar la parte siguiente con beforeId (X-Next-Before-Id).
  const [csvNext, setCsvNext] = useState<{ filters: Filters; beforeId: string | null; part: number } | null>(null);
  const exportCsv = async (cont?: { filters: Filters; beforeId: string; part: number }) => {
    setDownloading(true);
    setError(null);
    // Una exportación nueva descarta la continuación de la anterior; si falla una continuación, se puede reintentar.
    if (!cont) setCsvNext(null);
    const f = cont?.filters ?? applied;
    try {
      const day = new Date().toISOString().slice(0, 10);
      const qs = [query(f), csvFormatParams(locale, { tz: true }).toString(), cont ? `beforeId=${encodeURIComponent(cont.beforeId)}` : ""]
        .filter(Boolean)
        .join("&");
      const part = cont ? cont.part + 1 : 1;
      const r = await downloadCsv(`/v1/audit-log.csv?${qs}`, part > 1 ? `auditoria-${day}-${part}.csv` : `auditoria-${day}.csv`);
      setCsvNext(r.truncated ? { filters: f, beforeId: r.nextBeforeId, part } : null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setDownloading(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied({ ...filters });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{tt("audit.title")}</h1>
          <p className="muted">{tt("audit.intro")}</p>
        </div>
        {/* Separador según el idioma y, con la zona del navegador, la columna occurred_at_local. Con fetch: un error
            (sin permiso, sesión vencida) se muestra como mensaje; con un <a href> el navegador abría el JSON del error. */}
        <button type="button" className="btn" onClick={() => void exportCsv()} disabled={downloading}>
          {tt("audit.export")}
        </button>
      </div>
      {csvNext && (
        <p className="muted small row-wrap" style={{ alignItems: "center", gap: ".5rem" }}>
          <span>{tt("audit.csvTruncated")}</span>
          {csvNext.beforeId && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={downloading}
              onClick={() => void exportCsv({ filters: csvNext.filters, beforeId: csvNext.beforeId!, part: csvNext.part })}
            >
              {tt("audit.exportContinue")}
            </button>
          )}
        </p>
      )}
      <form className="card pad row-wrap" onSubmit={submit} style={{ marginBottom: "1rem" }}>
        <label className="field grow">
          <span>{tt("audit.filterAction")}</span>
          <input value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} placeholder="member.*" />
        </label>
        <label className="field grow">
          <span>{tt("audit.filterActor")}</span>
          <input value={filters.actor} onChange={(e) => setFilters({ ...filters, actor: e.target.value })} />
        </label>
        <label className="field">
          <span>{tt("audit.from")}</span>
          <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        </label>
        <label className="field">
          <span>{tt("audit.to")}</span>
          <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </label>
        <button className="btn btn-primary">OK</button>
      </form>
      <ErrorBox error={error} />
      {!items ? (
        error ? null : (
          <Spinner />
        )
      ) : items.length === 0 ? (
        <div className="empty">{tt("audit.empty")}</div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{tt("audit.when")}</th>
                <th>{tt("audit.action")}</th>
                <th>{tt("audit.actor")}</th>
                <th className="hide-sm">{tt("audit.target")}</th>
                <th className="hide-sm">IP</th>
              </tr>
            </thead>
            <tbody>
              {items.map((x) => (
                <tr key={x.id}>
                  <td className="small">{formatDateTime(x.occurredAt, locale)}</td>
                  <td>
                    <code>{x.action}</code>
                    {Object.keys(x.data).length > 0 && (
                      <div className="muted small" style={{ wordBreak: "break-word" }}>
                        {JSON.stringify(x.data).slice(0, 160)}
                      </div>
                    )}
                  </td>
                  <td className="small">{x.actorLabel ?? x.actorType}</td>
                  <td className="hide-sm small">{x.targetType ? `${x.targetType} ${x.targetId?.slice(0, 8) ?? ""}` : "—"}</td>
                  <td className="hide-sm small">{x.ip ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <div className="row-end" style={{ marginTop: "1rem" }}>
          <button type="button" className="btn" disabled={loadingMore} onClick={() => load(applied, true)}>
            {tt("audit.more")}
          </button>
        </div>
      )}
    </div>
  );
}
