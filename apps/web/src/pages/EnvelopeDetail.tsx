import { useCallback, useEffect, useRef, useState } from "react";
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
import { AiMetadataPanel } from "../components/AiPanels";
import { CorrectionModal, InPersonButton, ResendCopyButton } from "../components/EnvelopeExperience";
import { useExpText } from "../lib/i18n-experience";
import { IdentityBadge } from "../components/IdentityControls";
import { EnvelopePaymentSummary } from "../components/BillingExtras";
import { ArchivePanel } from "../components/DataExtras";
import { CertificateProgressPanel } from "../components/CertSign";
import { SealOptionsPanel } from "../components/EvidenceExtras";
import { useAccess } from "../lib/access";
import { useTitle } from "../lib/white-label";

export function EnvelopeDetailPage() {
  const { id = "" } = useParams();
  const { t, locale } = useI18n();
  const [detail, setDetail] = useState<EnvelopeDetail | null>(null);
  useTitle(detail?.envelope.subject);
  const { can } = useAccess();
  const [events, setEvents] = useState<EnvelopeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Error del refresco automático, aparte del de las acciones: el refresco limpia el suyo sin borrar el de una acción.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [reassigning, setReassigning] = useState<Recipient | null>(null);
  const sx = useSignerText();
  const x = useExpText();
  const [correcting, setCorrecting] = useState(false);

  // Solo se aplica la carga más reciente: un refresco automático pedido antes de anular o corregir que respondía
  // después volvía a mostrar el sobre como estaba (en curso, con los botones de acción habilitados).
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [d, ev] = await Promise.all([
        api<EnvelopeDetail>(`/v1/envelopes/${id}`),
        api<{ items: EnvelopeEvent[] }>(`/v1/envelopes/${id}/events`),
      ]);
      if (mine !== seq.current) return;
      setDetail(d);
      setEvents(ev.items);
      setLoadError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      if ((e as { status?: number }).status === 404) setNotFound(true);
      setLoadError(errorText(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresco automático mientras el sobre está en curso.
  const status = detail?.envelope.status;
  useEffect(() => {
    if (status !== "sent" && status !== "finalizing" && status !== "awaiting_certificates") return;
    const h = window.setInterval(load, status === "finalizing" ? 3000 : 10000);
    return () => window.clearInterval(h);
  }, [status, load]);

  if (notFound) return <Navigate to="/app" replace />;
  if (!detail) return loadError ? <div className="page"><ErrorBox error={loadError} /></div> : <Spinner />;
  // Un borrador se edita en el asistente; quien solo puede verlo (canManage false) se queda acá, de solo lectura.
  if (detail.envelope.status === "draft" && detail.canManage !== false) return <Navigate to={`/app/envelopes/${id}/edit`} replace />;
  // Quien lo ve por un grupo, como anfitrión o con view_all no puede modificarlo: sin estas acciones (la API daba 403).
  // Sin el dato (respuestas de acciones, que no lo traen) no se oculta nada: la API decide.
  const canManage = detail.canManage !== false;

  const env = detail.envelope;
  const isOpen = env.status === "sent";

  // La finalización falló definitivamente si el último evento de finalización es finalize_failed.
  const lastFinalize = [...events].reverse().find((ev) => ev.type === "envelope.finalize_failed" || ev.type === "envelope.finalize_retried");
  const finalizeFailed = detail?.envelope.status === "finalizing" && lastFinalize?.type === "envelope.finalize_failed";
  // Documento que no se puede sellar (InvalidPdfError al sanear un original viejo: el evento trae el código): reintentar
  // no lo resuelve.
  const unsealableCode = finalizeFailed && typeof lastFinalize?.data?.code === "string" ? lastFinalize.data.code : null;

  const retryFinalize = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/envelopes/${id}/retry-finalize`, { method: "POST" });
      setNotice(t("detail.finalizeRetried"));
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

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
            {env.sentAt && (
              <span className="muted small">
                {t("detail.sent")}: {formatDateTime(env.sentAt, locale)}
              </span>
            )}
            {env.completedAt && (
              <span className="muted small">
                {t("status.completed")}: {formatDateTime(env.completedAt, locale)}
              </span>
            )}
          </div>
          <ShareControl kind="envelopes" id={id!} canEdit={canManage} />
        </div>
        <div className="row-wrap">
          {env.status === "completed" && (
            <a className="btn btn-primary" href={`/v1/envelopes/${id}/signed.pdf`}>
              ⬇ {t("detail.download")}
            </a>
          )}
          {env.status === "awaiting_certificates" && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={remind}>
                {t("detail.remind")}
              </button>
              {canManage && (
                <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setVoiding(true)}>
                  {t("detail.void")}
                </button>
              )}
            </>
          )}
          {isOpen && (
            <>
              <button type="button" className="btn" disabled={busy} onClick={remind}>
                {t("detail.remind")}
              </button>
              {canManage && (
                <>
                  <button type="button" className="btn" disabled={busy} onClick={() => setCorrecting(true)}>
                    ✎ {x("correct.button")}
                  </button>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => setVoiding(true)}>
                    {t("detail.void")}
                  </button>
                </>
              )}
            </>
          )}
          {can("envelopes:create") && <SaveAsTemplateButton envelopeId={id} defaultName={env.subject} />}
        </div>
      </div>

      <ErrorBox error={error ?? loadError} />
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      {finalizeFailed && (
        <div className="alert alert-warn row-wrap" role="alert">
          <span>{unsealableCode ? t("detail.finalizeFailedUnsealable", { code: unsealableCode }) : t("detail.finalizeFailed")}</span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={retryFinalize}>
            {t("detail.retryFinalize")}
          </button>
        </div>
      )}
      {/* Si falló por el sello de empresa (vencido o borrado), se puede cambiar o quitar antes de reintentar. */}
      {finalizeFailed && <SealOptionsPanel envelopeId={env.id} sealOnly disabled={!canManage} />}
      {env.voidReason && (
        <div className="alert alert-warn">
          {t("detail.voidedReason")} {env.voidReason}
        </div>
      )}
      {env.message && <p className="message-box">{env.message}</p>}
      <EnvelopePaymentSummary envelopeId={env.id} recipients={detail.recipients} envelopeStatus={env.status} />

      <AiMetadataPanel envelopeId={env.id} completed={env.status === "completed"} canManage={canManage} />
      {env.status === "completed" && <ArchivePanel envelopeId={env.id} canManage={canManage} />}
      {detail.recipients.some((r) => r.signatureType === "certificate") && <CertificateProgressPanel envelopeId={env.id} status={env.status} refreshKey={events.length} />}

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
                      <IdentityBadge identity={r.identity} />
                      <span className="muted small">
                        #{r.routingOrder} · {t(`edit.role.${r.role}`)}
                        {r.authMethod === "in_person"
                          ? ` · 🤝 ${x("inperson.host", { host: r.inPersonHost?.name ?? "" })}`
                          : r.authMethod && r.authMethod !== "link"
                            ? ` · 🔒 ${sx(`auth.${r.authMethod}` as Parameters<typeof sx>[0])}`
                            : ""}
                      </span>
                      {isOpen && r.authMethod === "in_person" && ["sent", "viewed"].includes(r.status) && (
                        <InPersonButton envelopeId={id} recipient={r} onError={setError} />
                      )}
                      {env.status === "completed" && !["delegated", "reassigned"].includes(r.status) && (r.email || r.phone) && (
                        <ResendCopyButton envelopeId={id} recipient={r} onDone={setNotice} onError={setError} />
                      )}
                      {canManage && isOpen && r.role !== "cc" && ["created", "sent", "viewed"].includes(r.status) && (
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
                  {ev.type === "recipient.declined" && ev.data?.actorRole === "in_person_host" && (
                    <div className="small warn-text">{t("detail.declineInPersonUnconfirmed", { name: String(ev.data.recipient ?? "") })}</div>
                  )}
                  {ev.type === "recipient.declined" && ev.data?.identityVerified === false && (
                    <div className="small warn-text">{t("detail.declineIdentityUnverified")}</div>
                  )}
                  <div className="muted small mono" title={ev.hash}>
                    #{ev.seq} · {ev.hash.slice(0, 12)}…
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {correcting && (
        <CorrectionModal
          detail={detail}
          onClose={() => setCorrecting(false)}
          onDone={(d) => {
            setDetail(d);
            setCorrecting(false);
            setNotice(x("correct.done"));
            void load();
          }}
        />
      )}

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
          <ErrorBox error={error} />
        </Modal>
      )}
    </div>
  );
}
