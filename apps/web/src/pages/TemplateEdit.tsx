// Editor de plantilla: datos, documentos, roles y campos (mismo editor que los sobres, en modo roles).
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Document, RecipientRole, TemplateDetail } from "@calasign/shared";
import { LOCALES } from "@calasign/shared";
import { HttpError, api, errorText, fieldErrorIndex, isVersionChanged, uuid, type VersionedSave } from "../lib/api";
import { LOCALE_LABELS, useI18n, useUnsavedWarning, confirmAction } from "../lib/i18n";
import { forgetPdf } from "../lib/pdf";
import { FieldEditor, validateFields, type DraftField } from "../components/FieldEditor";
import { ErrorBox, OrderInput, Spinner, formatBytes, recipientColor } from "../components/ui";
import { ShareControl } from "../components/ShareControl";
import { CertificateOption, EMPTY_CERT_DRAFT, certToDraft, draftToCert, type CertDraft } from "../components/CertSign";

const STEPS = ["details", "documents", "roles", "fields"] as const;
type Step = (typeof STEPS)[number];

interface DraftRole {
  id: string;
  name: string;
  role: RecipientRole;
  routingOrder: number;
  cert?: CertDraft;
}

function toDraftFields(d: TemplateDetail): DraftField[] {
  return d.fields.map((f) => ({
    id: f.id,
    documentId: f.documentId,
    recipientId: f.roleId,
    type: f.type,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    required: f.required,
    label: f.label,
    value: f.value,
    readOnly: f.readOnly,
    options: f.options,
    min: f.min,
    max: f.max,
    conditions: f.conditions,
    formula: f.formula,
  }));
}

export function TemplateEditPage() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [step, setStep] = useState<Step>("details");
  const [info, setInfo] = useState({ name: "", description: "", subject: "", message: "", locale: "es" });
  const [roles, setRoles] = useState<DraftRole[]>([]);
  const [fields, setFields] = useState<DraftField[]>([]);
  const [dirty, setDirty] = useState({ info: false, roles: false, fields: false });
  const fieldsRev = useRef(0);
  const anyDirty = dirty.info || dirty.roles || dirty.fields;
  useUnsavedWarning(anyDirty);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Control de edición concurrente: updatedAt de la plantilla cargada o devuelta por el último guardado. Se manda en
  // cada PATCH/PUT (X-Expected-Updated-At): si otra pestaña u otra persona la cambió, la API responde 409
  // version_changed en vez de pisar esos cambios.
  const version = useRef<string | null>(null);
  const [stale, setStale] = useState(false);
  // Campo con error al guardar: el editor lo selecciona y lo muestra.
  const [focusField, setFocusField] = useState<{ id: string; seq: number } | null>(null);
  // El campo con error se señala una vez: al salir del paso de campos se olvida (si no, al volver se volvía a saltar a él).
  useEffect(() => {
    if (step !== "fields") setFocusField(null);
  }, [step]);

  const track = useCallback((d: TemplateDetail) => {
    version.current = d.template.updatedAt;
    setDetail(d);
  }, []);
  const expected = () => (version.current ? { "X-Expected-Updated-At": version.current } : undefined);
  // Compartir con otra visibilidad también cambia el updatedAt: se guarda con la versión del editor (si otro cambió la
  // plantilla, 409 y el aviso de recargar), el editor queda ocupado hasta que termina y adopta el updatedAt devuelto.
  // Antes se volvía a leer sin esperar: se adoptaba la versión de otro sin sus datos y un guardado inmediato daba 409.
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

  const apply = useCallback((d: TemplateDetail) => {
    track(d);
    setInfo({
      name: d.template.name,
      description: d.template.description ?? "",
      subject: d.template.subject ?? "",
      message: d.template.message ?? "",
      locale: d.template.locale,
    });
    setRoles(d.roles.map((r) => ({ id: r.id, name: r.name, role: r.role, routingOrder: r.routingOrder, cert: certToDraft(r) })));
    setFields(toDraftFields(d));
    setDirty({ info: false, roles: false, fields: false });
  }, [track]);

  /** Recarga la plantilla tras un 409 version_changed (descarta lo no guardado, con confirmación). */
  const reload = async () => {
    if (anyDirty && !window.confirm(t("edit.reloadConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      apply(await api<TemplateDetail>(`/v1/templates/${id}`));
      setStale(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    api<TemplateDetail>(`/v1/templates/${id}`)
      .then(apply)
      .catch((e) => setError(errorText(e)));
  }, [id, apply]);

  const saveCurrent = async (): Promise<boolean> => {
    // Lo que la API rechazaría de un campo se avisa antes, señalando el campo (la API solo dice "Campo N").
    const sentFields = fields;
    if (step === "fields" && dirty.fields) {
      const bad = validateFields(sentFields, t);
      if (bad) {
        setError(bad.message);
        setFocusField({ id: bad.id, seq: Date.now() });
        return false;
      }
    }
    setBusy(true);
    setError(null);
    try {
      if (step === "details" && dirty.info) {
        const d = await api<TemplateDetail>(`/v1/templates/${id}`, {
          method: "PATCH",
          body: {
            name: info.name.trim(),
            description: info.description.trim() || null,
            subject: info.subject.trim() || null,
            message: info.message.trim() || null,
            locale: info.locale,
          },
          headers: expected(),
        });
        track(d);
        setDirty((x) => ({ ...x, info: false }));
      }
      if (step === "roles" && dirty.roles) {
        const d = await api<TemplateDetail>(`/v1/templates/${id}/roles`, {
          method: "PUT",
          body: { roles: roles.map(({ cert, ...r }) => ({ ...r, name: r.name.trim(), ...draftToCert(cert ?? EMPTY_CERT_DRAFT, r.role) })) },
          headers: expected(),
        });
        track(d);
        setRoles(d.roles.map((r) => ({ id: r.id, name: r.name, role: r.role, routingOrder: r.routingOrder, cert: certToDraft(r) })));
        setFields(toDraftFields(d));
        setDirty((x) => ({ ...x, roles: false }));
      }
      if (step === "fields" && dirty.fields) {
        const rev = fieldsRev.current;
        const d = await api<TemplateDetail>(`/v1/templates/${id}/fields`, {
          method: "PUT",
          body: {
            fields: sentFields.map(({ recipientId, ...f }) => ({
              ...f,
              roleId: recipientId,
              options: f.options ? f.options.map((o) => o.trim()).filter(Boolean) : f.options,
            })),
          },
          headers: expected(),
        });
        track(d);
        // Si se editó algo mientras se guardaba, se conserva (queda pendiente de guardar).
        if (fieldsRev.current === rev) {
          setFields(toDraftFields(d));
          setDirty((x) => ({ ...x, fields: false }));
        }
      }
      return true;
    } catch (e) {
      if (e instanceof HttpError && e.code === "version_changed") {
        setStale(true);
        return false;
      }
      setError(errorText(e));
      const i = step === "fields" ? fieldErrorIndex(e) : null;
      const f = i != null ? sentFields[i] : undefined;
      if (f) setFocusField({ id: f.id, seq: Date.now() });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const go = async (target: Step) => {
    if (!(await saveCurrent())) return;
    const next = STEPS.indexOf(target);
    if (next >= 3 && roles.filter((r) => r.role === "signer").length === 0) {
      setError(t("tpl.noRoles"));
      return;
    }
    if (next >= 3 && (detail?.documents.length ?? 0) === 0) {
      setError(t("edit.noDocuments"));
      return;
    }
    setStep(target);
    window.scrollTo({ top: 0 });
  };

  const finish = async () => {
    if (await saveCurrent()) nav("/app/templates");
  };

  if (!detail) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  const stepIdx = STEPS.indexOf(step);
  // Quien la ve por ser de la organización o por un grupo (sin templates:manage ni haberla creado) solo la consulta:
  // editor en solo lectura en vez de un 403 al guardar.
  const readOnly = detail.canManage === false;
  const stepLabel = (s: Step) =>
    s === "details" ? t("tpl.step.details") : s === "roles" ? t("tpl.roles") : t(s === "documents" ? "edit.step.documents" : "edit.step.fields");

  return (
    <div className={`page ${step === "fields" ? "page-wide" : ""}`}>
      <div className="page-head">
        <div>
          <Link to="/app/templates" className="muted small">
            ← {t("tpl.title")}
          </Link>
          <h1>{info.name || detail.template.name}</h1>
          <ShareControl kind="templates" id={id!} canEdit={!readOnly} versioned={versioned} disabled={busy} />
        </div>
        {/* Se guarda el paso actual antes de usarla: con un Link, los cambios sin guardar se perdían y el sobre salía
            con la versión anterior de la plantilla. */}
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            if (await saveCurrent()) nav(`/app/templates/${id}/use`);
          }}
        >
          {t("tpl.use")}
        </button>
      </div>

      <ol className="stepper">
        {STEPS.map((s, i) => (
          <li key={s} className={`${i === stepIdx ? "current" : ""} ${i < stepIdx ? "done" : ""}`}>
            <button type="button" onClick={() => go(s)} disabled={busy} aria-current={i === stepIdx ? "step" : undefined}>
              <span className="step-n">{i + 1}</span>
              <span className="step-l">{stepLabel(s)}</span>
            </button>
          </li>
        ))}
      </ol>

      <ErrorBox error={error} />
      {readOnly && (
        <div className="alert" role="status">
          {t("tpl.readOnly")}
        </div>
      )}
      {stale && (
        <div className="alert alert-error row-between" role="alert">
          <span>{t("edit.versionChanged")}</span>
          <button type="button" className="btn btn-sm" disabled={busy} onClick={reload}>
            {t("edit.reload")}
          </button>
        </div>
      )}

      {/* Bloqueado mientras se guarda: la respuesta marca el paso como guardado y lo tipeado entretanto se perdía. */}
      {step === "details" && (
        <fieldset className="form-lock card pad stack" disabled={busy || readOnly} aria-busy={busy || undefined}>
          <label className="field">
            <span>{t("tpl.name")}</span>
            <input
              required
              maxLength={200}
              value={info.name}
              onChange={(e) => {
                setInfo({ ...info, name: e.target.value });
                setDirty((x) => ({ ...x, info: true }));
              }}
            />
          </label>
          <label className="field">
            <span>
              {t("tpl.description")} <span className="muted">({t("common.optional")})</span>
            </span>
            <textarea
              rows={2}
              maxLength={2000}
              value={info.description}
              onChange={(e) => {
                setInfo({ ...info, description: e.target.value });
                setDirty((x) => ({ ...x, info: true }));
              }}
            />
          </label>
          <label className="field">
            <span>{t("tpl.defaultSubject")}</span>
            <input
              maxLength={300}
              value={info.subject}
              onChange={(e) => {
                setInfo({ ...info, subject: e.target.value });
                setDirty((x) => ({ ...x, info: true }));
              }}
            />
          </label>
          <label className="field">
            <span>{t("tpl.defaultMessage")}</span>
            <textarea
              rows={3}
              maxLength={5000}
              value={info.message}
              onChange={(e) => {
                setInfo({ ...info, message: e.target.value });
                setDirty((x) => ({ ...x, info: true }));
              }}
            />
          </label>
          <label className="field">
            <span>{t("edit.locale")}</span>
            <select
              value={info.locale}
              onChange={(e) => {
                setInfo({ ...info, locale: e.target.value });
                setDirty((x) => ({ ...x, info: true }));
              }}
            >
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {LOCALE_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      )}

      {step === "documents" && (
        <TemplateDocuments
          templateId={id}
          documents={detail.documents}
          setError={setError}
          busy={busy}
          readOnly={readOnly}
          setBusy={setBusy}
          // Todo lo de la plantilla, no solo los campos: con track + campos se adoptaba la versión del servidor sin sus
          // datos (nombre, roles de otra pestaña) y el próximo guardado los pisaba sin 409. Acá no hay cambios sin
          // guardar: go() guarda el paso anterior antes de llegar a documentos.
          onChanged={async () => apply(await api<TemplateDetail>(`/v1/templates/${id}`))}
        />
      )}

      {step === "roles" && (
        <RolesStep
          roles={roles}
          busy={busy}
          readOnly={readOnly}
          fieldCount={(rid) => fields.filter((f) => f.recipientId === rid).length}
          onChange={(r) => {
            setRoles(r);
            setDirty((x) => ({ ...x, roles: true }));
          }}
        />
      )}

      {step === "fields" && (
        <FieldEditor
          envelopeId={id}
          documents={detail.documents}
          signers={detail.roles.filter((r) => r.role === "signer")}
          fields={fields}
          fileUrl={(docId) => `/v1/templates/${id}/documents/${docId}/file`}
          focus={focusField}
          onChange={(f) => {
            if (readOnly) return;
            setFields(f);
            setDirty((x) => ({ ...x, fields: true }));
            fieldsRev.current++;
          }}
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
        {stepIdx < STEPS.length - 1 ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => go(STEPS[stepIdx + 1])}>
            {busy ? t("common.saving") : `${t("common.next")} →`}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={finish}>
            {busy ? t("common.saving") : `✓ ${t("tpl.done")}`}
          </button>
        )}
      </div>
    </div>
  );
}

function TemplateDocuments({
  templateId,
  documents,
  onChanged,
  setError,
  busy,
  readOnly,
  setBusy,
}: {
  templateId: string;
  documents: Document[];
  onChanged: () => Promise<void>;
  setError: (e: string | null) => void;
  busy: boolean;
  readOnly: boolean;
  setBusy: (b: boolean) => void;
}) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState<string | null>(null);
  // Archivos subidos que traían firmas digitales (se pierden al sanear el PDF): aviso que no bloquea.
  const [hadSignatures, setHadSignatures] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Mientras se sube o se borra, la página queda ocupada (no se puede pasar de paso): al terminar, la recarga
  // reemplaza los campos y lo editado en el paso de campos se perdía sin aviso.
  const upload = async (files: FileList) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const signed: string[] = [];
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        const res = await api<Document>(`/v1/templates/${templateId}/documents`, { method: "POST", form });
        if (res?.hadSignatures) signed.push(file.name);
      } catch (e) {
        setError(`${file.name}: ${errorText(e)}`);
        break;
      }
    }
    setUploading(null);
    setHadSignatures(signed);
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
      await api(`/v1/templates/${templateId}/documents/${docId}`, { method: "DELETE" });
      forgetPdf(`/v1/templates/${templateId}/documents/${docId}/file`);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {!readOnly && (
      <div className="dropzone">
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
      )}
      {hadSignatures.length > 0 && (
        <div className="alert alert-warn" role="status">
          {t("edit.hadSignatures", { names: hadSignatures.join(", ") })}
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
              {!readOnly && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => remove(d.id)}>
                  {t("common.delete")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RolesStep({
  roles,
  busy,
  readOnly,
  fieldCount,
  onChange,
}: {
  roles: DraftRole[];
  /** Sin permiso para modificar la plantilla: solo se consulta. */
  readOnly: boolean;
  /** Guardando: bloqueado (al volver, la respuesta reemplaza los roles y lo tipeado entretanto se perdía). */
  busy: boolean;
  /** Campos ubicados para el rol (se borran al guardar si deja de ser firmante). */
  fieldCount: (roleId: string) => number;
  onChange: (r: DraftRole[]) => void;
}) {
  const { t } = useI18n();
  const set = (i: number, patch: Partial<DraftRole>) => onChange(roles.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  let signerIdx = -1;
  return (
    <fieldset className="form-lock stack" disabled={busy || readOnly} aria-busy={busy || undefined}>
      <p className="muted small">
        {t("tpl.rolesHint")} {t("edit.orderHint")}
      </p>
      {roles.length === 0 && <div className="empty">{t("tpl.noRoles")}</div>}
      {roles.map((r, i) => {
        if (r.role === "signer") signerIdx++;
        const color = r.role === "signer" ? recipientColor(signerIdx) : "#94a3b8";
        return (
          <div key={r.id} className="card pad recipient-row" style={{ borderLeftColor: color }}>
            <div className="role-grid">
              <label className="field rr-order">
                <span>{t("edit.order")}</span>
                <OrderInput value={r.routingOrder} onChange={(n) => set(i, { routingOrder: n })} />
              </label>
              <label className="field">
                <span>{t("tpl.roleName")}</span>
                <input required maxLength={100} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
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
                  {/* Las plantillas admiten aprobadores (p. ej. las creadas desde un sobre): sin esta opción se veían como firmante. */}
                  <option value="approver">{t("edit.role.approver")}</option>
                </select>
              </label>
              {r.role === "signer" && <CertificateOption value={r.cert ?? EMPTY_CERT_DRAFT} hasIdDocument onChange={(v) => set(i, { cert: v })} />}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => (!roles[i]?.id || confirmAction()) && onChange(roles.filter((_, j) => j !== i))}>
                {t("common.delete")}
              </button>
            </div>
          </div>
        );
      })}
      {!readOnly && (
      <button
        type="button"
        className="btn"
        onClick={() =>
          onChange([
            ...roles,
            {
              id: uuid(),
              name: "",
              role: "signer",
              routingOrder: roles.reduce((m, r) => Math.max(m, r.routingOrder), 0) + 1,
            },
          ])
        }
      >
        + {t("tpl.addRole")}
      </button>
      )}
    </fieldset>
  );
}
