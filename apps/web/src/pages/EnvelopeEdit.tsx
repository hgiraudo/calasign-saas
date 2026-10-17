import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import type { Channel, Document, EnvelopeDetail, Locale, RecipientRole } from "@calasign/shared";
import { CHANNELS, ID_DOCUMENT_TYPES, LOCALES } from "@calasign/shared";
import { api, errorText, uuid } from "../lib/api";
import { LOCALE_LABELS, useI18n } from "../lib/i18n";
import { forgetPdf } from "../lib/pdf";
import { FieldEditor, type DraftField } from "../components/FieldEditor";
import { AUTH_METHODS, type AuthMethod } from "@calasign/shared";
import { useSignerText } from "../lib/i18n-signer";
import { ErrorBox, Spinner, StatusBadge, formatBytes, recipientColor } from "../components/ui";

interface DraftRecipient {
  id: string;
  role: RecipientRole;
  routingOrder: number;
  name: string;
  email: string;
  phone: string;
  locale: Locale | "";
  channels: Channel[];
  telegramChatId: string;
  telegramLinked: boolean;
  idDocumentType: string;
  idDocumentNumber: string;
  authMethod: AuthMethod;
}

const CHANNEL_LABELS: Record<Channel, string> = { email: "Email", whatsapp: "WhatsApp", telegram: "Telegram" };

const STEPS = ["documents", "recipients", "fields", "review"] as const;
type Step = (typeof STEPS)[number];

function toDraftRecipients(d: EnvelopeDetail): DraftRecipient[] {
  return d.recipients.map((r) => ({
    id: r.id,
    role: r.role,
    routingOrder: r.routingOrder,
    name: r.name,
    email: r.email ?? "",
    phone: r.phone ?? "",
    locale: r.locale ?? "",
    channels: r.channels.length ? r.channels : ["email"],
    telegramChatId: "",
    telegramLinked: r.telegramLinked,
    idDocumentType: r.idDocumentType ?? "",
    idDocumentNumber: r.idDocumentNumber ?? "",
    authMethod: r.authMethod ?? "link",
  }));
}

function toDraftFields(d: EnvelopeDetail): DraftField[] {
  return d.fields.map((f) => ({
    id: f.id,
    documentId: f.documentId,
    recipientId: f.recipientId,
    type: f.type,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    required: f.required,
    label: f.label,
  }));
}

function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function EnvelopeEditPage() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const [detail, setDetail] = useState<EnvelopeDetail | null>(null);
  const [step, setStep] = useState<Step>("documents");
  const [recipients, setRecipients] = useState<DraftRecipient[]>([]);
  const [fields, setFields] = useState<DraftField[]>([]);
  const [recDirty, setRecDirty] = useState(false);
  const [fieldsDirty, setFieldsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const apply = useCallback((d: EnvelopeDetail) => {
    setDetail(d);
    setRecipients(toDraftRecipients(d));
    setFields(toDraftFields(d));
    setRecDirty(false);
    setFieldsDirty(false);
  }, []);

  useEffect(() => {
    api<EnvelopeDetail>(`/v1/envelopes/${id}`)
      .then((d) => {
        apply(d);
        if (d.documents.length > 0) setStep(d.recipients.length > 0 ? (d.fields.length > 0 ? "review" : "fields") : "recipients");
      })
      .catch((e) => {
        if ((e as { status?: number }).status === 404) setNotFound(true);
        setError(errorText(e));
      });
  }, [id, apply]);

  const saveRecipients = async (): Promise<boolean> => {
    if (!recDirty) return true;
    setBusy(true);
    setError(null);
    try {
      const body = {
        recipients: recipients.map((r) => ({
          id: r.id,
          role: r.role,
          routingOrder: r.routingOrder,
          name: r.name.trim(),
          email: r.email.trim() || null,
          phone: r.phone.trim() || null,
          locale: r.locale || null,
          channels: r.channels,
          // Solo se manda si se cargó: omitirlo no desvincula un chat ya vinculado.
          ...(r.channels.includes("telegram") && r.telegramChatId.trim() ? { telegramChatId: r.telegramChatId.trim() } : {}),
          idDocumentType: r.idDocumentType || null,
          idDocumentNumber: r.idDocumentNumber.trim() || null,
          authMethod: r.authMethod,
        })),
      };
      const d = await api<EnvelopeDetail>(`/v1/envelopes/${id}/recipients`, { method: "PUT", body });
      setDetail(d);
      setRecipients(toDraftRecipients(d));
      setFields(toDraftFields(d));
      setRecDirty(false);
      setFieldsDirty(false);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveFields = async (): Promise<boolean> => {
    if (!fieldsDirty) return true;
    setBusy(true);
    setError(null);
    try {
      const d = await api<EnvelopeDetail>(`/v1/envelopes/${id}/fields`, {
        method: "PUT",
        body: { fields: fields.map((f) => ({ ...f })) },
      });
      setDetail(d);
      setFields(toDraftFields(d));
      setFieldsDirty(false);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const go = async (target: Step) => {
    const cur = STEPS.indexOf(step);
    const next = STEPS.indexOf(target);
    if (step === "recipients" && !(await saveRecipients())) return;
    if (step === "fields" && !(await saveFields())) return;
    if (next > cur) {
      if (next >= 1 && (detail?.documents.length ?? 0) === 0) {
        setError(t("edit.noDocuments"));
        return;
      }
      if (next >= 2 && recipients.filter((r) => r.role !== "cc").length === 0) {
        setError(t("edit.noRecipients"));
        return;
      }
    }
    setError(null);
    setStep(target);
    window.scrollTo({ top: 0 });
  };

  if (notFound) return <Navigate to="/app" replace />;
  if (!detail) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  if (detail.envelope.status !== "draft") return <Navigate to={`/app/envelopes/${id}`} replace />;

  const stepIdx = STEPS.indexOf(step);

  return (
    <div className={`page ${step === "fields" ? "page-wide" : ""}`}>
      <div className="page-head">
        <div>
          <Link to="/app" className="muted small">
            ← {t("nav.envelopes")}
          </Link>
          <h1>
            {detail.envelope.subject} <StatusBadge status={detail.envelope.status} />
          </h1>
        </div>
      </div>

      <ol className="stepper">
        {STEPS.map((s, i) => (
          <li key={s} className={`${i === stepIdx ? "current" : ""} ${i < stepIdx ? "done" : ""}`}>
            <button type="button" onClick={() => go(s)} disabled={busy}>
              <span className="step-n">{i + 1}</span>
              <span className="step-l">{t(`edit.step.${s}`)}</span>
            </button>
          </li>
        ))}
      </ol>

      <ErrorBox error={error} />

      {step === "documents" && (
        <DocumentsStep
          envelopeId={id}
          documents={detail.documents}
          onChanged={async () => apply(await api<EnvelopeDetail>(`/v1/envelopes/${id}`))}
          setError={setError}
        />
      )}

      {step === "recipients" && (
        <RecipientsStep
          recipients={recipients}
          onChange={(r) => {
            setRecipients(r);
            setRecDirty(true);
          }}
        />
      )}

      {step === "fields" && (
        <FieldEditor
          envelopeId={id}
          documents={detail.documents}
          signers={detail.recipients.filter((r) => r.role === "signer")}
          fields={fields}
          onChange={(f) => {
            setFields(f);
            setFieldsDirty(true);
          }}
        />
      )}

      {step === "review" && (
        <ReviewStep
          detail={detail}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onSent={() => nav(`/app/envelopes/${id}`)}
          onUpdated={(d) => setDetail(d)}
        />
      )}

      <div className="wizard-nav">
        {stepIdx > 0 ? (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => go(STEPS[stepIdx - 1])}>
            ← {t("common.back")}
          </button>
        ) : (
          <span />
        )}
        {step === "fields" && fieldsDirty && (
          <button type="button" className="btn" disabled={busy} onClick={saveFields}>
            {busy ? t("common.saving") : t("common.save")}
          </button>
        )}
        {stepIdx < STEPS.length - 1 && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => go(STEPS[stepIdx + 1])}>
            {busy ? t("common.saving") : `${t("common.next")} →`}
          </button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────── Paso 1: documentos ─────────────────────────────

function DocumentsStep({
  envelopeId,
  documents,
  onChanged,
  setError,
}: {
  envelopeId: string;
  documents: Document[];
  onChanged: () => Promise<void>;
  setError: (e: string | null) => void;
}) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | File[]) => {
    setError(null);
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        await api<Document>(`/v1/envelopes/${envelopeId}/documents`, { method: "POST", form });
      } catch (e) {
        setError(`${file.name}: ${errorText(e)}`);
        break;
      }
    }
    setUploading(null);
    if (inputRef.current) inputRef.current.value = "";
    await onChanged();
  };

  const remove = async (docId: string) => {
    setError(null);
    try {
      await api(`/v1/envelopes/${envelopeId}/documents/${docId}`, { method: "DELETE" });
      forgetPdf(`/v1/envelopes/${envelopeId}/documents/${docId}/file`);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="stack">
      <div
        className={`dropzone ${over ? "over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
        }}
      >
        <p>{t("edit.dropHint")}</p>
        <label className="btn btn-primary">
          {uploading ? `${t("edit.uploading")} ${uploading}` : t("edit.upload")}
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            hidden
            disabled={!!uploading}
            onChange={(e) => e.target.files && upload(e.target.files)}
          />
        </label>
      </div>
      {documents.length === 0 ? (
        <div className="empty">{t("edit.noDocuments")}</div>
      ) : (
        <ul className="card doc-list pad">
          {documents.map((d) => (
            <li key={d.id}>
              <span className="doc-icon">PDF</span>
              <div className="grow">
                <div>{d.name}</div>
                <div className="muted small">
                  {d.pageCount} {t("edit.pages")} · {formatBytes(d.sizeBytes)}
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(d.id)}>
                {t("common.delete")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────────── Paso 2: destinatarios ─────────────────────────────

function RecipientsStep({ recipients, onChange }: { recipients: DraftRecipient[]; onChange: (r: DraftRecipient[]) => void }) {
  const { t } = useI18n();
  const sx = useSignerText();

  const add = () => {
    const maxOrder = recipients.reduce((m, r) => Math.max(m, r.routingOrder), 0);
    onChange([
      ...recipients,
      {
        id: uuid(),
        role: "signer",
        routingOrder: maxOrder + 1,
        name: "",
        email: "",
        phone: "",
        locale: "",
        channels: ["email"],
        authMethod: "link",
        telegramChatId: "",
        telegramLinked: false,
        idDocumentType: "",
        idDocumentNumber: "",
      },
    ]);
  };

  const set = (i: number, patch: Partial<DraftRecipient>) => onChange(recipients.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const del = (i: number) => onChange(recipients.filter((_, j) => j !== i));

  let signerIdx = -1;

  return (
    <div className="stack">
      <p className="muted small">{t("edit.orderHint")}</p>
      {recipients.length === 0 && <div className="empty">{t("edit.noRecipients")}</div>}
      {recipients.map((r, i) => {
        if (r.role === "signer") signerIdx++;
        const color = r.role === "signer" ? recipientColor(signerIdx) : "#94a3b8";
        return (
          <div key={r.id} className="card pad recipient-row" style={{ borderLeftColor: color }}>
            <div className="rr-grid">
              <label className="field rr-order">
                <span>{t("edit.order")}</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={r.routingOrder}
                  onChange={(e) => set(i, { routingOrder: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
                />
              </label>
              <label className="field">
                <span>{t("edit.name")}</span>
                <input required value={r.name} maxLength={200} onChange={(e) => set(i, { name: e.target.value })} />
              </label>
              <label className="field">
                <span>{t("auth.email")}</span>
                <input type="email" value={r.email} maxLength={320} onChange={(e) => set(i, { email: e.target.value })} />
              </label>
              <label className="field">
                <span>{t("edit.phone")}</span>
                <input
                  type="tel"
                  value={r.phone}
                  placeholder="+5730012345678"
                  onChange={(e) => set(i, { phone: e.target.value.replace(/[^\d+]/g, "") })}
                />
              </label>
              <label className="field">
                <span>{t("edit.role")}</span>
                <select value={r.role} onChange={(e) => set(i, { role: e.target.value as RecipientRole })}>
                  <option value="signer">{t("edit.role.signer")}</option>
                  <option value="cc">{t("edit.role.cc")}</option>
                  <option value="approver">{t("edit.role.approver")}</option>
                </select>
              </label>
              {r.role !== "cc" && (
                <label className="field">
                  <span>{sx("edit.authMethod")}</span>
                  <select value={r.authMethod} onChange={(e) => set(i, { authMethod: e.target.value as AuthMethod })}>
                    {AUTH_METHODS.map((m) => (
                      <option key={m} value={m} disabled={(m === "otp_email" && !r.email.trim()) || ((m === "otp_sms" || m === "otp_whatsapp") && !r.phone.trim())}>
                        {sx(`auth.${m}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="field">
                <span>{t("edit.locale")}</span>
                <select value={r.locale} onChange={(e) => set(i, { locale: e.target.value as Locale | "" })}>
                  <option value="">—</option>
                  {LOCALES.map((l) => (
                    <option key={l} value={l}>
                      {LOCALE_LABELS[l]}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className="field rr-channels">
                <legend>{t("edit.channels")}</legend>
                {CHANNELS.map((c) => (
                  <label key={c} className="check">
                    <input
                      type="checkbox"
                      checked={r.channels.includes(c)}
                      onChange={(e) => {
                        const next = e.target.checked ? [...r.channels, c] : r.channels.filter((x) => x !== c);
                        set(i, { channels: next.length ? next : r.channels });
                      }}
                    />
                    {CHANNEL_LABELS[c]}
                  </label>
                ))}
              </fieldset>
              {r.channels.includes("telegram") && (
                <label className="field">
                  <span>
                    {t("edit.telegramChatId")} <span className="muted">({t("common.optional")})</span>
                  </span>
                  <input
                    inputMode="numeric"
                    value={r.telegramChatId}
                    placeholder={r.telegramLinked ? t("detail.telegramLinked") : "123456789"}
                    onChange={(e) => set(i, { telegramChatId: e.target.value.replace(/[^\d-]/g, "") })}
                  />
                  <small className="muted">{r.telegramLinked ? `✓ ${t("detail.telegramLinked")}` : t("edit.telegramHint")}</small>
                </label>
              )}
              <label className="field">
                <span>
                  {t("edit.idType")} <span className="muted">({t("common.optional")})</span>
                </span>
                <select value={r.idDocumentType} onChange={(e) => set(i, { idDocumentType: e.target.value })}>
                  <option value="">—</option>
                  {ID_DOCUMENT_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {x.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t("edit.idNumber")}</span>
                <input value={r.idDocumentNumber} maxLength={50} onChange={(e) => set(i, { idDocumentNumber: e.target.value })} />
              </label>
            </div>
            <div className="row-end">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => del(i)}>
                {t("common.delete")}
              </button>
            </div>
          </div>
        );
      })}
      <button type="button" className="btn" onClick={add}>
        + {t("edit.addRecipient")}
      </button>
    </div>
  );
}

// ───────────────────────────── Paso 4: revisar y enviar ─────────────────────────────

function ReviewStep({
  detail,
  busy,
  setBusy,
  setError,
  onSent,
  onUpdated,
}: {
  detail: EnvelopeDetail;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  onSent: () => void;
  onUpdated: (d: EnvelopeDetail) => void;
}) {
  const { t } = useI18n();
  const env = detail.envelope;
  const [subject, setSubject] = useState(env.subject);
  const [message, setMessage] = useState(env.message ?? "");
  const [expires, setExpires] = useState(toDateInput(env.expiresAt));
  const [idemKey] = useState(uuid);
  const sx = useSignerText();
  const [reminderEveryDays, setReminderEveryDays] = useState<number | null>(env.reminderEveryDays ?? null);
  const [expiryWarningDays, setExpiryWarningDays] = useState<number | null>(env.expiryWarningDays ?? 3);
  const [allowDelegation, setAllowDelegation] = useState(env.allowDelegation ?? true);

  const signers = useMemo(() => detail.recipients.filter((r) => r.role === "signer"), [detail.recipients]);
  const minDate = toDateInput(new Date(Date.now() + 86400000).toISOString());

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const expiresAt = expires ? new Date(`${expires}T23:59:59`).toISOString() : null;
      const patched = await api<EnvelopeDetail>(`/v1/envelopes/${env.id}`, {
        method: "PATCH",
        body: { subject: subject.trim(), message: message.trim() || null, expiresAt, reminderEveryDays, expiryWarningDays, allowDelegation },
      });
      onUpdated(patched);
      await api<EnvelopeDetail>(`/v1/envelopes/${env.id}/send`, { method: "POST", headers: { "Idempotency-Key": idemKey } });
      onSent();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid-2">
      <section className="card pad stack">
        <label className="field">
          <span>{t("edit.subject")}</span>
          <input value={subject} maxLength={300} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="field">
          <span>
            {t("edit.message")} <span className="muted">({t("common.optional")})</span>
          </span>
          <textarea rows={4} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <label className="field">
          <span>
            {t("edit.expires")} <span className="muted">({t("common.optional")})</span>
          </span>
          <input type="date" min={minDate} value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
        <fieldset className="field">
          <legend>{sx("review.automation")}</legend>
          <label className="field">
            <span>{sx("review.reminders")}</span>
            <select value={reminderEveryDays ?? ""} onChange={(e) => setReminderEveryDays(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{sx("review.none")}</option>
              <option value="1">{sx("review.everyDay")}</option>
              {[2, 3, 5, 7].map((n) => (
                <option key={n} value={n}>
                  {sx("review.everyDays", { n })}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{sx("review.expiryWarning")}</span>
            <select value={expiryWarningDays ?? ""} onChange={(e) => setExpiryWarningDays(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{sx("review.none")}</option>
              {[1, 2, 3, 5, 7].map((n) => (
                <option key={n} value={n}>
                  {sx("review.daysBefore", { n })}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={allowDelegation} onChange={(e) => setAllowDelegation(e.target.checked)} />
            {sx("review.allowDelegation")}
          </label>
        </fieldset>
        <button type="button" className="btn btn-primary btn-block" disabled={busy || !subject.trim()} onClick={send}>
          {busy ? t("edit.sending") : t("edit.send")}
        </button>
      </section>
      <section className="card pad">
        <h2>{t("edit.summary")}</h2>
        <ul className="doc-list">
          {detail.documents.map((d) => (
            <li key={d.id}>
              <span className="doc-icon">PDF</span>
              <div className="grow">
                {d.name} <span className="muted small">· {d.pageCount} {t("edit.pages")}</span>
              </div>
            </li>
          ))}
        </ul>
        <ul className="recipient-list">
          {detail.recipients.map((r) => {
            const idx = signers.findIndex((s) => s.id === r.id);
            const count = detail.fields.filter((f) => f.recipientId === r.id).length;
            return (
              <li key={r.id}>
                <span className="dot" style={{ background: r.role === "signer" ? recipientColor(idx) : "#94a3b8" }} />
                <div className="grow">
                  <strong>{r.name}</strong>{" "}
                  <span className="muted small">
                    #{r.routingOrder} · {t(`edit.role.${r.role}`)} · {r.channels.join(", ")}
                    {r.authMethod !== "link" ? ` · 🔒 ${sx(`auth.${r.authMethod}`)}` : ""}
                  </span>
                  <div className="muted small">{[r.email, r.phone].filter(Boolean).join(" · ")}</div>
                  {r.role === "signer" && (
                    <div className="small">
                      {count} {t("edit.fieldsCount")}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
