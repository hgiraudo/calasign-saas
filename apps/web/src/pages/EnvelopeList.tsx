import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { EnvelopeDetail, EnvelopeStatus, ListEnvelopesResponse, EnvelopeSummary } from "@calasign/shared";
import { api, errorText, uuid } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { ErrorBox, Modal, RecipientStatusBadge, Spinner, StatusBadge } from "../components/ui";
import { useTitle } from "../lib/white-label";

const TABS: (EnvelopeStatus | "all")[] = ["all", "draft", "sent", "completed", "declined", "voided", "expired"];

export function EnvelopeListPage() {
  const { t, locale } = useI18n();
  useTitle(t("list.title"));
  const nav = useNavigate();
  const [status, setStatus] = useState<EnvelopeStatus | "all">("all");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<EnvelopeSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Cada cambio de filtro o búsqueda abre una "generación": una página extra pedida antes no se agrega a la lista nueva.
  const gen = useRef(0);
  const moreInFlight = useRef(false);

  useEffect(() => {
    const h = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(h);
  }, [q]);

  const load = useCallback(
    async (after: string | null, signal?: AbortSignal) => {
      const p = new URLSearchParams({ limit: "25" });
      // "En curso" incluye los sobres que se están sellando o esperan firmas con certificado.
      if (status !== "all") p.set("status", status === "sent" ? "sent,finalizing,awaiting_certificates" : status);
      if (query) p.set("q", query);
      if (after) p.set("cursor", after);
      return api<ListEnvelopesResponse>(`/v1/envelopes?${p}`, { signal });
    },
    [status, query],
  );

  useEffect(() => {
    const ac = new AbortController();
    gen.current++;
    moreInFlight.current = false;
    setLoadingMore(false);
    setLoading(true);
    setError(null);
    // El cursor es del filtro anterior: sin esto, "cargar más" podía pedir la página siguiente de la lista vieja.
    setCursor(null);
    load(null, ac.signal)
      .then((r) => {
        setItems(r.items);
        setCursor(r.nextCursor);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setError(errorText(e));
      })
      // Una carga abortada (cambio de filtro) no apaga el spinner de la carga nueva, que sigue en curso.
      .finally(() => !ac.signal.aborted && setLoading(false));
    return () => ac.abort();
  }, [load]);

  const more = async () => {
    if (!cursor || moreInFlight.current) return;
    const g = gen.current;
    moreInFlight.current = true;
    setLoadingMore(true);
    try {
      const r = await load(cursor);
      if (g !== gen.current) return;
      setItems((prev) => [...prev, ...r.items]);
      setCursor(r.nextCursor);
    } catch (e) {
      if (g === gen.current) setError(errorText(e));
    } finally {
      if (g === gen.current) {
        moreInFlight.current = false;
        setLoadingMore(false);
      }
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t("list.title")}</h1>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          + {t("list.new")}
        </button>
      </div>

      <div className="toolbar">
        <div className="tabs scroll" role="tablist">
          {TABS.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={status === s}
              className={status === s ? "active" : ""}
              onClick={() => setStatus(s)}
            >
              {t(`status.${s}`)}
            </button>
          ))}
        </div>
        <input className="search" type="search" placeholder={t("list.search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("list.search")} />
      </div>

      <ErrorBox error={error} />
      {loading ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{t("list.empty")}</div>
      ) : (
        <div className="card list-card">
          <table className="table">
            <thead>
              <tr>
                <th>{t("list.subject")}</th>
                <th className="hide-sm">{t("list.recipients")}</th>
                <th>{t("list.status")}</th>
                <th className="hide-sm">{t("list.created")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => nav(e.status === "draft" ? `/app/envelopes/${e.id}/edit` : `/app/envelopes/${e.id}`)}>
                  <td>
                    <Link to={e.status === "draft" ? `/app/envelopes/${e.id}/edit` : `/app/envelopes/${e.id}`} onClick={(ev) => ev.stopPropagation()}>
                      {e.subject}
                    </Link>
                    <div className="muted show-sm small">{e.recipients.map((r) => r.name).join(", ")}</div>
                  </td>
                  <td className="hide-sm">
                    <div className="chips">
                      {e.recipients.map((r, i) => (
                        <span key={i} className="chip">
                          {r.name} {r.role === "signer" && <RecipientStatusBadge status={r.status} />}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={e.status} />
                  </td>
                  <td className="hide-sm muted">{formatDateTime(e.createdAt, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor && (
            <div className="center pad">
              <button type="button" className="btn btn-ghost" disabled={loadingMore} onClick={more}>
                {t("list.loadMore")}
              </button>
            </div>
          )}
        </div>
      )}

      {creating && <NewEnvelopeModal onClose={() => setCreating(false)} onCreated={(id) => nav(`/app/envelopes/${id}/edit`)} />}
    </div>
  );
}

function NewEnvelopeModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { t, locale } = useI18n();
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idemKey] = useState(uuid);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await api<EnvelopeDetail>("/v1/envelopes", {
        method: "POST",
        body: { subject, locale },
        headers: { "Idempotency-Key": idemKey },
      });
      onCreated(d.envelope.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={t("list.new")} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span>{t("list.newSubject")}</span>
          <input autoFocus required maxLength={300} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <ErrorBox error={error} />
        <div className="row-end">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" disabled={busy || !subject.trim()}>
            {t("list.create")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
