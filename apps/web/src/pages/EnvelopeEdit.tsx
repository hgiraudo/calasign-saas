import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SealOptionsPanel } from "../components/EvidenceExtras";
import { PaymentOptionsPanel } from "../components/BillingExtras";
import { useBillingText } from "../lib/i18n-billing";
import { AiFieldDetect, AiReviewPanel } from "../components/AiPanels";
import { useExpText } from "../lib/i18n-experience";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import type { Channel, Document, Envelope, EnvelopeDetail, Locale, RecipientRole } from "@calasign/shared";
import { CHANNELS, ID_DOCUMENT_TYPES, LOCALES, PREFILLABLE_FIELD_TYPES } from "@calasign/shared";
import { HttpError, api, errorText, fieldErrorIndex, isVersionChanged, uuid, type VersionedSave } from "../lib/api";
import { LOCALE_LABELS, expiryFromDateInput, localDateInput, useI18n, useUnsavedWarning, confirmAction } from "../lib/i18n";
import { forgetPdf } from "../lib/pdf";
import { FieldEditor, validateFields, type DraftField } from "../components/FieldEditor";
import { PHONE_RE, normalizePhone } from "../components/SignerExtras";
import { AUTH_METHODS, type AuthMethod } from "@calasign/shared";
import { useSignerText } from "../lib/i18n-signer";
import { ErrorBox, OrderInput, Spinner, StatusBadge, formatBytes, recipientColor } from "../components/ui";
import { SaveAsTemplateButton } from "../components/SaveAsTemplate";
import { ShareControl } from "../components/ShareControl";
import { IdentitySelect, draftToIdentity, identityToDraft } from "../components/IdentityControls";
import { CertificateOption, EMPTY_CERT_DRAFT, certToDraft, draftToCert, type CertDraft } from "../components/CertSign";
import { useTitle } from "../lib/white-label";

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
  /** "proveedor:nivel" o "" (sin verificación de identidad). */
  idVerification: string;
  cert: CertDraft;
  /** Firma embebida (marcada por API): sin correo ni teléfono, la API la rechaza si no se manda la marca. */
  embedded: boolean;
  /** Anfitrión de la firma en persona ya elegido (por API u otra persona): se conserva al guardar. */
  inPersonHostId: string | null;
  /** Agregado en esta edición y nunca guardado: se quita sin confirmar (no tiene campos guardados). */
  isNew?: boolean;
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
    idVerification: identityToDraft(r.identity),
    cert: certToDraft(r),
    embedded: r.embedded,
    inPersonHostId: r.inPersonHost?.id ?? null,
  }));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lo que la API rechazaría de un destinatario (los refine de RecipientInput), como clave de texto; null si está bien. */
function recipientProblem(r: DraftRecipient): Parameters<ReturnType<typeof useSignerText>>[0] | null {
  const email = r.email.trim();
  const phone = r.phone.trim();
  if (!r.name.trim()) return "edit.nameRequired";
  if (email && !EMAIL_RE.test(email)) return "edit.emailInvalid";
  // Teléfono como lo exige la API (E.164): con un aviso propio, no el "phone inválido" de la validación.
  if (phone && !PHONE_RE.test(phone)) return "delegate.phoneInvalid";
  // Embebido o en persona: no recibe avisos, no necesita contacto.
  const inPerson = r.role !== "cc" && r.authMethod === "in_person";
  if (!r.embedded && !inPerson) {
    if (!email && !phone) return "edit.contactRequired";
    if (r.channels.includes("email") && !email) return "edit.emailChannelNeedsEmail";
    if (r.channels.includes("whatsapp") && !phone) return "edit.whatsappNeedsPhone";
    // Ya vinculado (telegramLinked): la API conserva su chat_id, no hace falta escribirlo.
    if (r.channels.every((c) => c === "telegram") && !r.telegramChatId.trim() && !r.telegramLinked) return "edit.telegramNeedsChat";
  }
  // Un código OTP sin su contacto: se avisa (antes se bajaba a "link" en silencio y el sobre salía con una
  // autenticación más débil). Las copias no tienen método (se guardan con "link").
  if (r.role !== "cc" && ((r.authMethod === "otp_email" && !email) || ((r.authMethod === "otp_sms" || r.authMethod === "otp_whatsapp") && !phone))) {
    return "edit.otpNeedsContact";
  }
  // La API lo rechaza (missing_id_document): exigir que el certificado corresponda al documento sin documento cargado.
  if (r.role === "signer" && r.cert.signatureType === "certificate" && r.cert.matchIdDocument && !r.idDocumentNumber.trim()) return "edit.certNeedsIdDocument";
  return null;
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
    // Solo los tipos que el remitente puede prellenar llevan valor en el borrador: uno de otro tipo (p. ej. una casilla
    // o fecha copiada de un sobre firmado) no se ve ni se puede quitar en el editor y la API rechaza el guardado.
    value: PREFILLABLE_FIELD_TYPES.includes(f.type) ? f.value : null,
    readOnly: PREFILLABLE_FIELD_TYPES.includes(f.type) ? f.readOnly : false,
    options: f.options,
    min: f.min,
    max: f.max,
    conditions: f.conditions,
    formula: f.formula,
  }));
}

export function EnvelopeEditPage() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const [detail, setDetail] = useState<EnvelopeDetail | null>(null);
  useTitle(detail?.envelope.subject);
  const [step, setStep] = useState<Step>("documents");
  const [recipients, setRecipients] = useState<DraftRecipient[]>([]);
  const [fields, setFields] = useState<DraftField[]>([]);
  const [recDirty, setRecDirty] = useState(false);
  const [fieldsDirty, setFieldsDirty] = useState(false);
  // Revisión de los campos: un guardado que termina después de otra edición no pisa esa edición con lo guardado.
  const fieldsRev = useRef(0);
  const sx = useSignerText();
  // Lo cargado en "Revisar y enviar" sobrevive a volver a un paso anterior (antes se perdía al desmontar el paso).
  const [reviewDraft, setReviewDraft] = useState<ReviewDraft | null>(null);
  // Remonta "Revisar y enviar" tras recargar el borrador (su estado inicial sale del sobre recargado).
  const [reviewKey, setReviewKey] = useState(0);
  const reviewDirty = !!detail && !!reviewDraft && reviewChanged(reviewDraft, detail.envelope);
  const dirty = recDirty || fieldsDirty || reviewDirty;
  useUnsavedWarning(dirty);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);
  // Control de edición concurrente: updatedAt del borrador cargado o devuelto por el último guardado. Se manda en cada
  // PATCH/PUT (X-Expected-Updated-At): si otra pestaña u otra persona lo cambió, la API responde 409 version_changed
  // en vez de pisar esos cambios.
  const version = useRef<string | null>(null);
  const [stale, setStale] = useState(false);
  // Campo con error al guardar: el editor lo selecciona y lo muestra.
  const [focusField, setFocusField] = useState<{ id: string; seq: number } | null>(null);
  // El campo con error se señala una vez: al salir del paso de campos se olvida (si no, al volver se volvía a saltar a él).
  useEffect(() => {
    if (step !== "fields") setFocusField(null);
  }, [step]);

  const track = useCallback((d: EnvelopeDetail) => {
    version.current = d.envelope.updatedAt;
    setDetail(d);
  }, []);
  const expected = () => (version.current ? { "X-Expected-Updated-At": version.current } : undefined);
  /** `recipientNames`: los destinatarios enviados, para nombrarlos en los errores "recipients.N…" de la API. */
  const fail = useCallback((e: unknown, recipientNames?: string[]) => {
    if (e instanceof HttpError && e.code === "version_changed") {
      setStale(true);
      setError(null);
    } else setError(errorText(e, { recipientNames }));
  }, []);
  // Otros paneles (sello, asistencia de IA) también cambian el updatedAt del sobre: guardan con la versión del editor
  // (si otro cambió el borrador, 409 y el aviso de recargar), el editor queda ocupado hasta que terminan y adopta el
  // updatedAt que devuelve la API. Antes se volvía a leer el sobre sin esperar: se adoptaba la versión de otro sin sus
  // datos (y después se los pisaba sin 409) y un guardado inmediato chocaba con el cambio propio.
  const versioned: VersionedSave = useCallback(async (save, updatedAtOf) => {
    setBusy(true);
    try {
      const r = await save(version.current ? { "X-Expected-Updated-At": version.current } : undefined);
      const u = updatedAtOf(r);
      if (u) version.current = u;
      return r;
    } catch (e) {
      if (isVersionChanged(e)) setStale(true);
      throw e;
    } finally {
      setBusy(false);
    }
  }, []);

  const apply = useCallback((d: EnvelopeDetail) => {
    track(d);
    setRecipients(toDraftRecipients(d));
    setFields(toDraftFields(d));
    setRecDirty(false);
    setFieldsDirty(false);
  }, [track]);

  /** Recarga el borrador tras un 409 version_changed (descarta lo no guardado, con confirmación). */
  const reload = async () => {
    if (dirty && !window.confirm(t("edit.reloadConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      apply(await api<EnvelopeDetail>(`/v1/envelopes/${id}`));
      setReviewDraft(null);
      setReviewKey((k) => k + 1);
      setStale(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

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
    // Lo que rechazaría la validación de la API (RecipientInput), avisado con el nombre del destinatario (la API solo
    // dice "recipients.N.email: …").
    for (const [i, r] of recipients.entries()) {
      const problem = recipientProblem(r);
      if (problem) {
        setStep("recipients");
        setError(`${r.name.trim() || sx("edit.recipientN", { n: i + 1 })}: ${sx(problem)}`);
        return false;
      }
    }
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
          // Una copia no firma: el método (oculto en el formulario) se descarta. Si quedaba "en persona" de cuando era
          // firmante, la copia nunca recibía su invitación.
          authMethod: r.role === "cc" ? "link" : r.authMethod,
          // Firma en persona: la anfitriona es quien carga el sobre, salvo que ya tenga una elegida (con {} pasaba a ser
          // quien guardaba los destinatarios, aunque el anfitrión fuera otra persona).
          inPerson: r.role !== "cc" && r.authMethod === "in_person" ? (r.inPersonHostId ? { hostUserId: r.inPersonHostId } : {}) : null,
          // Ausente = sin cambios en la API, pero la validación lo necesita para un destinatario embebido sin contacto
          // ("email o phone requerido"): sin esto, no se podía guardar ningún cambio de destinatarios del sobre.
          ...(r.embedded ? { embedded: true } : {}),
          idVerification: r.role === "cc" ? null : draftToIdentity(r.idVerification),
          ...draftToCert(r.cert, r.role),
        })),
      };
      const d = await api<EnvelopeDetail>(`/v1/envelopes/${id}/recipients`, { method: "PUT", body, headers: expected() });
      track(d);
      setRecipients(toDraftRecipients(d));
      setFields(toDraftFields(d));
      setRecDirty(false);
      setFieldsDirty(false);
      return true;
    } catch (e) {
      fail(e, recipients.map((r) => r.name.trim()));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveFields = async (): Promise<boolean> => {
    if (!fieldsDirty) return true;
    const rev = fieldsRev.current;
    const sent = fields;
    // Lo que la API rechazaría de un campo se avisa antes, señalando el campo (la API solo dice "Campo N").
    const bad = validateFields(sent, t);
    if (bad) {
      setError(bad.message);
      setStep("fields");
      setFocusField({ id: bad.id, seq: Date.now() });
      return false;
    }
    setBusy(true);
    setError(null);
    try {
      const d = await api<EnvelopeDetail>(`/v1/envelopes/${id}/fields`, {
        method: "PUT",
        body: { fields: sent.map((f) => ({ ...f, options: f.options ? f.options.map((o) => o.trim()).filter(Boolean) : f.options })) },
        headers: expected(),
      });
      track(d);
      if (fieldsRev.current === rev) {
        setFields(toDraftFields(d));
        setFieldsDirty(false);
      }
      return true;
    } catch (e) {
      fail(e);
      const i = fieldErrorIndex(e);
      const f = i != null ? sent[i] : undefined;
      if (f) {
        setStep("fields");
        setFocusField({ id: f.id, seq: Date.now() });
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * Asunto y mensaje escritos en "Revisar y enviar" (solo se guardan al enviar): la plantilla se crea con los del sobre,
   * así que sin esto "Guardar como plantilla" salía con los anteriores.
   */
  const saveReviewText = async (): Promise<boolean> => {
    const r = reviewDraft;
    if (!r || !detail) return true;
    const subject = r.subject.trim();
    const message = r.message.trim() || null;
    if (!subject || (subject === detail.envelope.subject && message === (detail.envelope.message ?? null))) return true;
    setBusy(true);
    setError(null);
    try {
      track(await api<EnvelopeDetail>(`/v1/envelopes/${id}`, { method: "PATCH", body: { subject, message }, headers: expected() }));
      return true;
    } catch (e) {
      fail(e);
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
  // Quien solo puede ver el borrador (por un grupo, como anfitrión o con view_all) lo ve en el detalle, de solo lectura:
  // el asistente le dejaba editar todo y cada guardado daba 403.
  if (detail.envelope.status !== "draft" || detail.canManage === false) return <Navigate to={`/app/envelopes/${id}`} replace />;

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
          {/* Quien no puede gestionarlo ya salió al detalle (arriba). */}
          <ShareControl kind="envelopes" id={id!} canEdit />
        </div>
        <SaveAsTemplateButton
          envelopeId={id}
          defaultName={detail.envelope.subject}
          beforeSave={async () => (await saveRecipients()) && (await saveFields()) && (await saveReviewText())}
          disabled={busy}
        />
      </div>

      <ol className="stepper">
        {STEPS.map((s, i) => (
          <li key={s} className={`${i === stepIdx ? "current" : ""} ${i < stepIdx ? "done" : ""}`}>
            <button type="button" onClick={() => go(s)} disabled={busy} aria-current={i === stepIdx ? "step" : undefined}>
              <span className="step-n">{i + 1}</span>
              <span className="step-l">{t(`edit.step.${s}`)}</span>
            </button>
          </li>
        ))}
      </ol>

      <ErrorBox error={error} />
      {stale && (
        <div className="alert alert-error row-between" role="alert">
          <span>{t("edit.versionChanged")}</span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={reload}>
            {t("edit.reload")}
          </button>
        </div>
      )}

      {step === "documents" && (
        <DocumentsStep
          envelopeId={id}
          documents={detail.documents}
          onChanged={async () => apply(await api<EnvelopeDetail>(`/v1/envelopes/${id}`))}
          setError={setError}
          busy={busy}
          setBusy={setBusy}
        />
      )}

      {step === "recipients" && (
        <RecipientsStep
          recipients={recipients}
          busy={busy}
          fieldCount={(rid) => fields.filter((f) => f.recipientId === rid).length}
          onChange={(r) => {
            setRecipients(r);
            setRecDirty(true);
          }}
        />
      )}

      {step === "fields" && (
        <AiFieldDetect
          envelopeId={id}
          documents={detail.documents}
          signers={detail.recipients.filter((r) => r.role === "signer")}
          fields={fields}
          onAdd={(added) => {
            setFields([...fields, ...added]);
            setFieldsDirty(true);
            fieldsRev.current++;
          }}
        />
      )}
      {step === "fields" && (
        <FieldEditor
          envelopeId={id}
          documents={detail.documents}
          signers={detail.recipients.filter((r) => r.role === "signer")}
          fields={fields}
          focus={focusField}
          onChange={(f) => {
            setFields(f);
            setFieldsDirty(true);
            fieldsRev.current++;
          }}
        />
      )}

      {step === "review" && (
        <ReviewStep
          key={reviewKey}
          detail={detail}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          fail={fail}
          expected={expected}
          onSent={() => nav(`/app/envelopes/${id}`)}
          onUpdated={track}
          versioned={versioned}
          draft={reviewDraft}
          onDraft={setReviewDraft}
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
  busy,
  setBusy,
}: {
  envelopeId: string;
  documents: Document[];
  onChanged: () => Promise<void>;
  setError: (e: string | null) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState<string | null>(null);
  // Archivos subidos que traían firmas digitales (se pierden al sanear el PDF): aviso que no bloquea.
  const [hadSignatures, setHadSignatures] = useState<string[]>([]);
  // Archivos cuyo formulario no se pudo fijar tal como lo regeneraría un lector (se fijó la apariencia guardada).
  const [appearanceMismatch, setAppearanceMismatch] = useState<string[]>([]);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mientras se sube o se borra, la página queda ocupada (no se puede pasar de paso): al terminar, la recarga
  // (apply) reemplaza destinatarios y campos, y lo que se hubiera cargado en el paso siguiente se perdía sin aviso.
  const upload = async (files: FileList | File[]) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const signed: string[] = [];
    const mismatched: string[] = [];
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        const res = await api<Document>(`/v1/envelopes/${envelopeId}/documents`, { method: "POST", form });
        if (res?.hadSignatures) signed.push(file.name);
        if (res?.formAppearanceMismatch) mismatched.push(file.name);
      } catch (e) {
        setError(`${file.name}: ${errorText(e)}`);
        break;
      }
    }
    setUploading(null);
    setHadSignatures(signed);
    setAppearanceMismatch(mismatched);
    if (inputRef.current) inputRef.current.value = "";
    // Fuera del try de cada archivo: si la recarga fallaba, el rechazo quedaba sin manejar y la lista sin actualizar
    // ni aviso.
    await onChanged().catch((e) => setError(errorText(e)));
    setBusy(false);
  };

  const remove = async (docId: string) => {
    // Borra el documento con sus campos (y las condiciones que los citaban): no se deshace.
    if (busy || !confirmAction()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/envelopes/${envelopeId}/documents/${docId}`, { method: "DELETE" });
      forgetPdf(`/v1/envelopes/${envelopeId}/documents/${docId}/file`);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
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
          if (e.dataTransfer.files.length && !busy) void upload(e.dataTransfer.files);
        }}
      >
        <p>{t("edit.dropHint")}</p>
        {/* aria-disabled (no disabled) mientras sube: un botón deshabilitado pierde el foco y el lector de pantalla deja
            de anunciar el progreso "Subiendo…" que muestra; el clic se ignora. */}
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={busy}
          onClick={() => {
            if (!busy) inputRef.current?.click();
          }}
        >
          {uploading ? `${t("edit.uploading")} ${uploading}` : t("edit.upload")}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          disabled={busy}
          onChange={(e) => e.target.files && upload(e.target.files)}
        />
      </div>
      {hadSignatures.length > 0 && (
        <div className="alert alert-warn" role="status">
          {t("edit.hadSignatures", { names: hadSignatures.join(", ") })}
        </div>
      )}
      {appearanceMismatch.length > 0 && (
        <div className="alert alert-warn" role="status">
          {t("edit.formAppearanceMismatch", { names: appearanceMismatch.join(", ") })}
        </div>
      )}
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
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(d.id)}>
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

function RecipientsStep({
  recipients,
  busy,
  fieldCount,
  onChange,
}: {
  recipients: DraftRecipient[];
  /**
   * Guardando: el formulario queda bloqueado. Al volver, la respuesta reemplaza la lista y la marca guardada: lo que se
   * tipeaba mientras tanto se perdía (o quedaba sin guardar al pasar de paso).
   */
  busy: boolean;
  /** Campos ubicados para el destinatario (se borran al guardar si deja de ser firmante). */
  fieldCount: (recipientId: string) => number;
  onChange: (r: DraftRecipient[]) => void;
}) {
  const { t } = useI18n();
  const sx = useSignerText();
  const x = useExpText();
  const authLabel = (m: AuthMethod) => (m === "in_person" ? x("auth.in_person") : sx(`auth.${m}` as Parameters<typeof sx>[0]));

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
        idVerification: "",
        cert: EMPTY_CERT_DRAFT,
        embedded: false,
        inPersonHostId: null,
        telegramChatId: "",
        telegramLinked: false,
        idDocumentType: "",
        idDocumentNumber: "",
        isNew: true,
      },
    ]);
  };

  const set = (i: number, patch: Partial<DraftRecipient>) =>
    onChange(
      recipients.map((r, j) => {
        if (j !== i) return r;
        // No se baja el método a "link" al vaciar el contacto (p. ej. para corregirlo): se avisa al guardar.
        return { ...r, ...patch };
      }),
    );
  // Un destinatario ya guardado se borra con sus campos (y las condiciones que los citaban) al guardar: se confirma.
  // Uno recién agregado (nunca guardado) se quita sin preguntar.
  const del = (i: number) => {
    if (!recipients[i]?.isNew && !confirmAction()) return;
    onChange(recipients.filter((_, j) => j !== i));
  };

  let signerIdx = -1;
  const phoneInvalid = (phone: string) => !!phone.trim() && !PHONE_RE.test(phone.trim());

  return (
    <fieldset className="form-lock stack" disabled={busy} aria-busy={busy || undefined}>
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
                <OrderInput value={r.routingOrder} onChange={(n) => set(i, { routingOrder: n })} />
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
                  aria-invalid={phoneInvalid(r.phone) || undefined}
                  // Como en "Delegar": solo dígitos y un "+" inicial (E.164, lo que exige la API).
                  onChange={(e) => set(i, { phone: normalizePhone(e.target.value) })}
                />
                {phoneInvalid(r.phone) && <small className="error-text">{sx("delegate.phoneInvalid")}</small>}
              </label>
              <label className="field">
                <span>{t("edit.role")}</span>
                <select
                  value={r.role}
                  onChange={(e) => {
                    const role = e.target.value as RecipientRole;
                    // Dejar de ser firmante borra sus campos al guardar: se confirma si tiene alguno.
                    const n = r.role === "signer" && role !== "signer" ? fieldCount(r.id) : 0;
                    if (n > 0 && !window.confirm(t("edit.roleDropsFields", { name: r.name.trim() || t(`edit.role.${r.role}`), n }))) return;
                    set(i, { role });
                  }}
                >
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
                      <option
                        key={m}
                        value={m}
                        // Un destinatario embebido no usa código (lo autentica la app del integrador: la API lo rechaza).
                        disabled={
                          (r.embedded && m.startsWith("otp_")) ||
                          (m === "otp_email" && !r.email.trim()) ||
                          ((m === "otp_sms" || m === "otp_whatsapp") && !PHONE_RE.test(r.phone.trim()))
                        }
                      >
                        {authLabel(m)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {r.role !== "cc" && <IdentitySelect value={r.idVerification} onChange={(v) => set(i, { idVerification: v })} />}
              {r.role === "signer" && <CertificateOption value={r.cert} hasIdDocument={!!r.idDocumentNumber.trim()} onChange={(v) => set(i, { cert: v })} />}
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
    </fieldset>
  );
}

// ───────────────────────────── Paso 4: revisar y enviar ─────────────────────────────

/**
 * Opciones fijas más el valor actual si no está entre ellas: un borrador creado por la API (1–60 días) con, p. ej.,
 * recordatorios cada 14 días mostraba "Ninguno" pero al enviar se mandaba igual el 14.
 */
function withCurrent(options: number[], current: number | null): number[] {
  return current == null || current === 1 || options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

interface ReviewDraft {
  subject: string;
  message: string;
  expires: string;
  reminderEveryDays: number | null;
  expiryWarningDays: number | null;
  allowDelegation: boolean;
}

/** Cuerpo del PATCH con lo cargado en "Revisar y enviar". */
function reviewPatch(r: ReviewDraft, env: Envelope, mustBeFuture: boolean) {
  return {
    subject: r.subject.trim(),
    message: r.message.trim() || null,
    // Con la fecha sin tocar se conserva el vencimiento guardado (con mustBeFuture, si todavía no pasó: el envío lo rechazaría).
    expiresAt: expiryFromDateInput(r.expires, env.expiresAt, { mustBeFuture }),
    reminderEveryDays: r.reminderEveryDays,
    expiryWarningDays: r.expiryWarningDays,
    allowDelegation: r.allowDelegation,
  };
}

/** true si lo cargado en "Revisar y enviar" difiere de lo guardado en el sobre (cuenta como cambio sin guardar). */
function reviewChanged(r: ReviewDraft, env: Envelope, mustBeFuture = false): boolean {
  const p = reviewPatch(r, env, mustBeFuture);
  return (
    // Normalizados igual que el borrador (la API no recorta: un mensaje "" o con un salto final contaba como cambio).
    p.subject !== env.subject.trim() ||
    p.message !== ((env.message ?? "").trim() || null) ||
    p.expiresAt !== (env.expiresAt ?? null) ||
    p.reminderEveryDays !== (env.reminderEveryDays ?? null) ||
    p.expiryWarningDays !== (env.expiryWarningDays !== undefined ? env.expiryWarningDays : 3) ||
    p.allowDelegation !== (env.allowDelegation ?? true)
  );
}

function ReviewStep({
  detail,
  busy,
  setBusy,
  setError,
  fail,
  expected,
  onSent,
  onUpdated,
  versioned,
  draft,
  onDraft,
}: {
  detail: EnvelopeDetail;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (e: string | null) => void;
  /** Muestra un error (o el aviso de versión cambiada). */
  fail: (e: unknown) => void;
  /** Encabezado X-Expected-Updated-At con la versión cargada. */
  expected: () => Record<string, string> | undefined;
  onSent: () => void;
  onUpdated: (d: EnvelopeDetail) => void;
  /** Control de versión del editor para los paneles (sello, IA) que cambian el updatedAt del sobre. */
  versioned: VersionedSave;
  draft: ReviewDraft | null;
  onDraft: (d: ReviewDraft) => void;
}) {
  const { t, tn } = useI18n();
  const env = detail.envelope;
  const [init] = useState(draft);
  const [subject, setSubject] = useState(init?.subject ?? env.subject);
  const [message, setMessage] = useState(init?.message ?? env.message ?? "");
  const [expires, setExpires] = useState(init?.expires ?? localDateInput(env.expiresAt));
  const [idemKey] = useState(uuid);
  const sx = useSignerText();
  const x = useExpText();
  const authLabel = (m: AuthMethod) => (m === "in_person" ? x("auth.in_person") : sx(`auth.${m}` as Parameters<typeof sx>[0]));
  const [reminderEveryDays, setReminderEveryDays] = useState<number | null>(init ? init.reminderEveryDays : (env.reminderEveryDays ?? null));
  const [expiryWarningDays, setExpiryWarningDays] = useState<number | null>(
    // null es "sin aviso" elegido a propósito: no se convierte en 3 (el 3 por defecto ya viene de la base).
    init ? init.expiryWarningDays : env.expiryWarningDays !== undefined ? env.expiryWarningDays : 3,
  );
  const [allowDelegation, setAllowDelegation] = useState(init?.allowDelegation ?? env.allowDelegation ?? true);
  const b = useBillingText();
  const [paymentUnsaved, setPaymentUnsaved] = useState(false);
  // busy es compartido con los paneles de sello e IA: «Enviando…» solo mientras se envía de verdad.
  const [sending, setSending] = useState(false);
  useEffect(() => {
    onDraft({ subject, message, expires, reminderEveryDays, expiryWarningDays, allowDelegation });
  }, [onDraft, subject, message, expires, reminderEveryDays, expiryWarningDays, allowDelegation]);

  const signers = useMemo(() => detail.recipients.filter((r) => r.role === "signer"), [detail.recipients]);
  const minDate = localDateInput(new Date(Date.now() + 86400000).toISOString());

  const send = async () => {
    // El cobro se guarda con su propio botón: enviar con cambios sin guardar mandaba el sobre sin cobro (o con el anterior).
    if (paymentUnsaved) {
      setError(b("pay.unsavedBeforeSend"));
      return;
    }
    setBusy(true);
    setSending(true);
    setError(null);
    try {
      // Sin cambios no se manda el PATCH: si se perdió la respuesta de un envío que sí llegó, reintentar fallaba en el
      // PATCH (409 not_draft) antes de llegar al envío idempotente.
      const cur: ReviewDraft = { subject, message, expires, reminderEveryDays, expiryWarningDays, allowDelegation };
      if (reviewChanged(cur, env, true)) {
        onUpdated(await api<EnvelopeDetail>(`/v1/envelopes/${env.id}`, { method: "PATCH", body: reviewPatch(cur, env, true), headers: expected() }));
      }
      // Con la versión revisada: si otra pestaña u otra persona cambió el borrador, 409 version_changed (no se envía lo
      // que no se vio). El encabezado no cuenta para la Idempotency-Key.
      await api<EnvelopeDetail>(`/v1/envelopes/${env.id}/send`, { method: "POST", headers: { "Idempotency-Key": idemKey, ...expected() } });
      onSent();
    } catch (e) {
      // Ya no es borrador: el envío anterior llegó (o lo envió otra pestaña). Se recarga y se va al detalle.
      if (e instanceof HttpError && e.code === "not_draft") {
        const d = await api<EnvelopeDetail>(`/v1/envelopes/${env.id}`).catch(() => null);
        if (d && d.envelope.status !== "draft") {
          onSent();
          return;
        }
      }
      fail(e);
    } finally {
      setBusy(false);
      setSending(false);
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
              {withCurrent([2, 3, 5, 7], reminderEveryDays).map((n) => (
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
              {withCurrent([1, 2, 3, 5, 7], expiryWarningDays).map((n) => (
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
        <SealOptionsPanel envelopeId={env.id} versioned={versioned} disabled={busy} />
        <PaymentOptionsPanel envelopeId={env.id} recipients={detail.recipients} onUnsavedChange={setPaymentUnsaved} versioned={versioned} />
        <AiReviewPanel envelopeId={env.id} versioned={versioned} disabled={busy} />
        <button type="button" className="btn btn-primary btn-block" disabled={busy || !subject.trim()} onClick={send}>
          {sending ? t("edit.sending") : t("edit.send")}
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
                    {r.authMethod !== "link" ? ` · 🔒 ${authLabel(r.authMethod)}` : ""}
                  </span>
                  <div className="muted small">{[r.email, r.phone].filter(Boolean).join(" · ")}</div>
                  {r.role === "signer" && (
                    <div className="small">{tn("edit.fieldsCount", count)}</div>
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
