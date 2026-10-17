import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import type { EnvelopeDetail, EnvelopeEvent } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { ErrorBox, Modal, RecipientStatusBadge, Spinner, StatusBadge, formatBytes, recipientColor } from "../components/ui";
import { ReassignModal } from "../components/SignerExtras";
import { useSignerText } from "../lib/i18n-signer";
import type { Recipient } from "@calasign/shared";
import { SaveAsTemplateButton } from "../components/SaveAsTemplate";
import { ShareControl } from "../components/ShareControl";

export function EnvelopeDetailPage() {
  const { id = "" } = useParams();
  const { t, locale } = useI18n();
  const [detail, setDetail] = useState<EnvelopeDetail | null>(null);
  const [events, setEvents] = useState<EnvelopeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [reassigning, setReassigning] = useState<Recipient | null>(null);
  const sx = useSignerText();

  const load = useCallback(async () => {
    try {
      const [d, ev] = await Promise.all([
        api<EnvelopeDetail>(`/v1/envelopes/${id}`),
        api<{ items: EnvelopeEvent[] }>(`/v1/envelopes/${id}/events`),
      ]);
      setDetail(d);
      setEvents(ev.items);
      setError(null);
    } catch (e) {
      if ((e as { status?: number }).status === 404) setNotFound(true);
      setError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresco automático mientras el sobre está en curso.
  const status = detail?.envelope.status;
  useEffect(() => {
    if (status !== "sent" && status !== "finalizing") return;
    const h = window.setInterval(load, status === "finalizing" ? 3000 : 10000);
    return () => window.clearInterval(h);
  }, [status, load]);

  if (notFound) return <Navigate to="/app" replace />;
  if (!detail) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  if (detail.envelope.status === "draft") return <Navigate to={`/app/envelopes/${id}/edit`} replace />;

  const env = detail.envelope;
  const isOpen = env.status === "sent";

  const remind = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ notified: number }>(`/v1/envelopes/${id}/remind`, { method: "POST" });
      setNotice(`${t("detail.reminded")}: ${r.notified}`);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const doVoid = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await api<EnvelopeDetail>(`/v1/envelopes/${id}/void`, { method: "POST", body: { reason } });
      setDetail(d);
      setVoiding(false);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const signers = detail.recipients.filter((r) => r.role === "signer");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <Link to="/app" className="muted small">
            ← {t("nav.envelopes")}
          </Link>
          <h1>{env.subject}</h1>
          <div className="row-wrap">
            <StatusBadge status={env.status} />
            <span className="muted small">
              {t("detail.sent")}: {formatDateTime(env.sentAt, locale)}
            </span>
            {env.completedAt && (
              <span className="muted small">
                {t("status.completed")}: {formatDateTime(env.completedAt, locale)}
              </span>
            )}
          </div>
          <ShareControl kind="envelopes" id={id!} canEdit />
        </div>
        <div className="row-wrap">
          {env.status === "completed" && (
            <a className="btn btn-primary" href={`/v1/envelopes/${id}/signed.pdf`}>
              ⬇ {t("detail.download")}
            </a>
          )}
          {isOpen && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={remind}>
                {t("detail.remind")}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setVoiding(true)}>
                {t("detail.void")}
              </button>
            </>
          )}
          <SaveAsTemplateButton envelopeId={id} defaultName={env.subject} />
        </div>
      </div>

      <ErrorBox error={error} />
      {notice && <div className="alert alert-success">{notice}</div>}
      {env.voidReason && (
        <div className="alert alert-warn">
          {t("detail.voidedReason")} {env.voidReason}
        </div>
      )}
      {env.message && <p className="message-box">{env.message}</p>}

      <div className="grid-2">
        <section className="card pad">
          <h2>{t("detail.recipients")}</h2>
          <ul className="recipient-list">
            {detail.recipients.map((r) => {
              const idx = signers.findIndex((s) => s.id === r.id);
              return (
                <li key={r.id}>
                  <span className="dot" style={{ background: r.role === "signer" ? recipientColor(idx) : "#94a3b8" }} />
                  <div className="grow">
                    <div className="row-wrap">
                      <strong>{r.name}</strong>
                      <RecipientStatusBadge status={r.status} />
                      <span className="muted small">
                        #{r.routingOrder} · {t(`edit.role.${r.role}`)}
                        {r.authMethod && r.authMethod !== "link" ? ` · 🔒 ${sx(`auth.${r.authMethod}`)}` : ""}
                      </span>
                      {isOpen && r.role !== "cc" && ["created", "sent", "viewed"].includes(r.status) && (
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setReassigning(r)}>
                          {sx("reassign.button")}
                        </button>
                      )}
                      {r.channels.includes("telegram") && (
                        <span className={`badge ${r.telegramLinked ? "chan-telegram" : "rbadge-created"}`}>
                          {r.telegramLinked ? `✓ ${t("detail.telegramLinked")}` : t("detail.telegramPending")}
                        </span>
                      )}
                    </div>
                    <div className="muted small">{[r.email, r.phone].filter(Boolean).join(" · ")}</div>
                    <div className="muted small timeline-mini">
                      {r.sentAt && <span>{t("detail.sent")}: {formatDateTime(r.sentAt, locale)}</span>}
                      {r.viewedAt && <span>{t("detail.viewed")}: {formatDateTime(r.viewedAt, locale)}</span>}
                      {r.signedAt && <span>{t("detail.signed")}: {formatDateTime(r.signedAt, locale)}</span>}
                      {r.declinedAt && <span>{t("detail.declined")}: {formatDateTime(r.declinedAt, locale)}</span>}
                    </div>
                    {r.replacedBy && (
                      <div className="small">
                        ↪ {sx("detail.replacedBy", { name: detail.recipients.find((x) => x.id === r.replacedBy)?.name ?? "" })}
                      </div>
                    )}
                    {r.declineReason && (
                      <div className="small">
                        {t("detail.declineReason")}: {r.declineReason}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <h2>{t("detail.documents")}</h2>
          <ul className="doc-list">
            {detail.documents.map((d) => (
              <li key={d.id}>
                <span className="doc-icon">PDF</span>
                <div className="grow">
                  <div>{d.name}</div>
                  <div className="muted small mono" title={d.sha256}>
                    {d.pageCount} {t("edit.pages")} · {formatBytes(d.sizeBytes)} · sha256 {d.sha256.slice(0, 16)}…
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {env.signedSha256 && (
            <p className="small mono break">
              {t("detail.sha")}: {env.signedSha256}
            </p>
          )}
        </section>

        <section className="card pad">
          <div className="row-between">
            <h2>{t("detail.timeline")}</h2>
            <button type="button" className="btn btn-ghost btn-sm" onClick={load}>
              {t("common.refresh")}
            </button>
          </div>
          <ol className="timeline">
            {events.map((ev) => (
              <li key={ev.seq}>
                <div className="tl-dot" />
                <div className="grow">
                  <div className="row-between">
                    <code className="tl-type">{ev.type}</code>
                    <span className="muted small">{formatDateTime(ev.occurredAt, locale)}</span>
                  </div>
                  <div className="small">
                    {ev.actorLabel ?? ev.actorType}
                    {ev.ip && <span className="muted"> · IP {ev.ip}</span>}
                  </div>
                  <div className="muted small mono" title={ev.hash}>
                    #{ev.seq} · {ev.hash.slice(0, 12)}…
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {reassigning && (
        <ReassignModal
          envelopeId={id}
          recipient={reassigning}
          onClose={() => setReassigning(null)}
          onDone={(d) => {
            setDetail(d);
            setReassigning(null);
            load();
          }}
        />
      )}

      {voiding && (
        <Modal
          title={t("detail.void")}
          onClose={() => setVoiding(false)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setVoiding(false)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy || !reason.trim()} onClick={doVoid}>
                {t("detail.void")}
              </button>
            </>
          }
        >
          <label className="field">
            <span>{t("detail.voidReason")}</span>
            <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={1000} />
          </label>
        </Modal>
      )}
    </div>
  );
}
