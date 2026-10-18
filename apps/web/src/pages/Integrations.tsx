// /app/settings/integrations — webhooks y orígenes autorizados para la firma embebida.
import { useEffect, useState, type FormEvent } from "react";
import {
  WEBHOOK_EVENT_TYPES,
  type CreateWebhookResponse,
  type EmbedSettings,
  type WebhookDelivery,
  type WebhookEndpoint,
} from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { useIntText } from "../lib/integrations-i18n";
import { ErrorBox, Spinner } from "../components/ui";

export function IntegrationsPage() {
  const tt = useIntText();
  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>{tt("int.title")}</h1>
      </div>
      <p className="muted">{tt("int.intro")}</p>
      <WebhooksSection />
      <EmbedSection />
    </div>
  );
}

function WebhooksSection() {
  const tt = useIntText();
  const [items, setItems] = useState<WebhookEndpoint[] | null>(null);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = () =>
    api<{ items: WebhookEndpoint[] }>("/v1/webhooks")
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));

  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<CreateWebhookResponse>("/v1/webhooks", {
        method: "POST",
        body: { url, description: description || null, events },
      });
      setSecret(r.secret);
      setCopied(false);
      setUrl("");
      setDescription("");
      setEvents([]);
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="stack" style={{ marginTop: 24 }}>
      <h2>{tt("wh.title")}</h2>
      <p className="muted small">{tt("wh.intro")}</p>

      <form onSubmit={create} className="card pad stack">
        <div className="row-wrap">
          <label className="field grow">
            <span>{tt("wh.url")}</span>
            <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.tuempresa.com/calasign/webhook" />
          </label>
          <label className="field grow">
            <span>{tt("wh.description")}</span>
            <input maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ERP producción" />
          </label>
        </div>
        <fieldset className="field">
          <span>{tt("wh.events")}</span>
          <div className="chips">
            <label className="check">
              <input type="checkbox" checked={events.length === 0} onChange={() => setEvents([])} /> {tt("wh.allEvents")}
            </label>
            {WEBHOOK_EVENT_TYPES.map((ev) => (
              <label key={ev} className="check">
                <input
                  type="checkbox"
                  checked={events.includes(ev)}
                  onChange={(e) => setEvents((cur) => (e.target.checked ? [...cur, ev] : cur.filter((x) => x !== ev)))}
                />{" "}
                <code>{ev}</code>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="row-end">
          <button className="btn btn-primary" disabled={busy || !url.trim()}>
            {tt("wh.create")}
          </button>
        </div>
      </form>

      {secret && (
        <div className="alert alert-success stack">
          <strong>{tt("wh.secretOnce")}</strong>
          <div className="secret-row">
            <code className="secret">{secret}</code>
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(secret);
                  setCopied(true);
                } catch {
                  /* copia manual */
                }
              }}
            >
              {copied ? tt("common.copied") : tt("common.copy")}
            </button>
          </div>
        </div>
      )}

      <ErrorBox error={error} />

      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{tt("wh.empty")}</div>
      ) : (
        items.map((w) => (
          <div key={w.id} className="card pad stack">
            <div className="row-between">
              <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                <code className="break">{w.url}</code>
                <span className="muted small">
                  {w.description ? `${w.description} · ` : ""}
                  {w.events.length ? w.events.join(", ") : tt("wh.allEvents")} · <code>{w.secretPrefix}…</code>
                </span>
              </div>
              <span className={`badge ${w.active ? "badge-completed" : "badge-voided"}`}>{w.active ? tt("wh.active") : tt("wh.inactive")}</span>
            </div>
            <div className="row-wrap">
              <button type="button" className="btn btn-sm" onClick={() => act(() => api(`/v1/webhooks/${w.id}/test`, { method: "POST" }).then(() => setOpen(w.id)))}>
                {tt("wh.test")}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => act(() => api(`/v1/webhooks/${w.id}`, { method: "PATCH", body: { active: !w.active } }))}>
                {w.active ? tt("wh.pause") : tt("wh.resume")}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(open === w.id ? null : w.id)}>
                {open === w.id ? tt("wh.hide") : tt("wh.show")}
              </button>
              <span className="grow" />
              <button type="button" className="btn btn-sm btn-danger" onClick={() => act(() => api(`/v1/webhooks/${w.id}`, { method: "DELETE" }))}>
                {tt("wh.delete")}
              </button>
            </div>
            {open === w.id && <Deliveries webhookId={w.id} />}
          </div>
        ))
      )}
    </section>
  );
}

function Deliveries({ webhookId }: { webhookId: string }) {
  const tt = useIntText();
  const { locale } = useI18n();
  const [items, setItems] = useState<WebhookDelivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ items: WebhookDelivery[] }>(`/v1/webhooks/${webhookId}/deliveries?limit=25`)
      .then((r) => {
        setItems(r.items);
        setError(null); // un error transitorio no debe ocultar las entregas para siempre
      })
      .catch((e) => setError(errorText(e)));

  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [webhookId]);

  const badge = (s: WebhookDelivery["status"]) => (s === "succeeded" ? "badge-completed" : s === "failed" ? "badge-declined" : "badge-sent");

  if (error) return <ErrorBox error={error} />;
  if (!items) return <Spinner />;
  if (items.length === 0) return <p className="muted small">{tt("wh.noDeliveries")}</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <h3 className="small">{tt("wh.deliveries")}</h3>
      <table className="table">
        <thead>
          <tr>
            <th>{tt("wh.when")}</th>
            <th>{tt("wh.event")}</th>
            <th>{tt("wh.result")}</th>
            <th>{tt("wh.attempts")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              <td className="small">{formatDateTime(d.createdAt, locale)}</td>
              <td>
                <code className="small">{d.eventType}</code>
              </td>
              <td className="small">
                <span className={`badge ${badge(d.status)}`}>{tt(`wh.status.${d.status}` as "wh.status.pending")}</span>{" "}
                {d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : d.lastError ?? ""}
                {d.status === "pending" && d.nextRetryAt && (
                  <div className="muted">
                    {tt("wh.nextRetry")}: {formatDateTime(d.nextRetryAt, locale)}
                  </div>
                )}
              </td>
              <td>{d.attempts}</td>
              <td className="right">
                {d.status !== "succeeded" && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      api(`/v1/webhook-deliveries/${d.id}/retry`, { method: "POST" })
                        .then(load)
                        .catch((e) => setError(errorText(e)))
                    }
                  >
                    {tt("wh.retry")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmbedSection() {
  const tt = useIntText();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<EmbedSettings>("/v1/settings/embed")
      .then((r) => setText(r.frameAncestors.join("\n")))
      .catch((e) => setError(errorText(e)));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const frameAncestors = (text ?? "")
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean);
      const r = await api<EmbedSettings>("/v1/settings/embed", { method: "PATCH", body: { frameAncestors } });
      setText(r.frameAncestors.join("\n"));
      setSaved(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="stack" style={{ marginTop: 32 }}>
      <h2>{tt("embed.title")}</h2>
      <p className="muted small">{tt("embed.intro")}</p>
      {/* Sin la lista cargada no se ofrece el formulario: guardar desde un textarea vacío por un error de carga
          reemplazaba (borraba) los orígenes que ya estaban configurados. */}
      {text === null ? (
        !error && <Spinner />
      ) : (
        <form onSubmit={save} className="card pad stack">
          <label className="field">
            <span>{tt("embed.origins")}</span>
            <textarea rows={4} value={text ?? ""} onChange={(e) => setText(e.target.value)} placeholder="https://app.tuempresa.com" />
          </label>
          <div className="row-end">
            {saved && <span className="muted small">{tt("embed.saved")}</span>}
            <button className="btn btn-primary" disabled={busy}>
              {tt("embed.save")}
            </button>
          </div>
        </form>
      )}
      <ErrorBox error={error} />
    </section>
  );
}
