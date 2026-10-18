// Editor de plantilla: datos, documentos, roles y campos (mismo editor que los sobres, en modo roles).
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Document, RecipientRole, TemplateDetail } from "@calasign/shared";
import { LOCALES } from "@calasign/shared";
import { api, errorText, uuid } from "../lib/api";
import { LOCALE_LABELS, useI18n } from "../lib/i18n";
import { forgetPdf } from "../lib/pdf";
import { FieldEditor, type DraftField } from "../components/FieldEditor";
import { ErrorBox, Spinner, formatBytes, recipientColor } from "../components/ui";
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = useCallback((d: TemplateDetail) => {
    setDetail(d);
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
  }, []);

  useEffect(() => {
    api<TemplateDetail>(`/v1/templates/${id}`)
      .then(apply)
      .catch((e) => setError(errorText(e)));
  }, [id, apply]);

  const saveCurrent = async (): Promise<boolean> => {
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
        });
        setDetail(d);
        setDirty((x) => ({ ...x, info: false }));
      }
      if (step === "roles" && dirty.roles) {
        const d = await api<TemplateDetail>(`/v1/templates/${id}/roles`, {
          method: "PUT",
          body: { roles: roles.map(({ cert, ...r }) => ({ ...r, name: r.name.trim(), ...draftToCert(cert ?? EMPTY_CERT_DRAFT, r.role) })) },
        });
        setDetail(d);
        setRoles(d.roles.map((r) => ({ id: r.id, name: r.name, role: r.role, routingOrder: r.routingOrder, cert: certToDraft(r) })));
        setFields(toDraftFields(d));
        setDirty((x) => ({ ...x, roles: false }));
      }
      if (step === "fields" && dirty.fields) {
        const d = await api<TemplateDetail>(`/v1/templates/${id}/fields`, {
          method: "PUT",
          body: {
            fields: fields.map(({ recipientId, ...f }) => ({
              ...f,
              roleId: recipientId,
              options: f.options ? f.options.map((o) => o.trim()).filter(Boolean) : f.options,
            })),
          },
        });
        setDetail(d);
        setFields(toDraftFields(d));
        setDirty((x) => ({ ...x, fields: false }));
      }
      return true;
    } catch (e) {
      setError(errorText(e));
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
          <ShareControl kind="templates" id={id!} canEdit />
        </div>
        <Link className="btn" to={`/app/templates/${id}/use`}>
          {t("tpl.use")}
        </Link>
      </div>

      <ol className="stepper">
        {STEPS.map((s, i) => (
          <li key={s} className={`${i === stepIdx ? "current" : ""} ${i < stepIdx ? "done" : ""}`}>
            <button type="button" onClick={() => go(s)} disabled={busy}>
              <span className="step-n">{i + 1}</span>
              <span className="step-l">{stepLabel(s)}</span>
            </button>
          </li>
        ))}
      </ol>

      <ErrorBox error={error} />

      {step === "details" && (
        <div className="card pad stack">
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
        </div>
      )}

      {step === "documents" && (
        <TemplateDocuments
          templateId={id}
          documents={detail.documents}
          setError={setError}
          onChanged={async () => {
            const d = await api<TemplateDetail>(`/v1/templates/${id}`);
            setDetail(d);
            setFields(toDraftFields(d));
          }}
        />
      )}

      {step === "roles" && (
        <RolesStep
          roles={roles}
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
          onChange={(f) => {
            setFields(f);
            setDirty((x) => ({ ...x, fields: true }));
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
}: {
  templateId: string;
  documents: Document[];
  onChanged: () => Promise<void>;
  setError: (e: string | null) => void;
}) {
  const { t } = useI18n();
  const [uploading, setUploading] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList) => {
    setError(null);
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        const form = new FormData();
        form.append("file", file, file.name);
        await api(`/v1/templates/${templateId}/documents`, { method: "POST", form });
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
    try {
      await api(`/v1/templates/${templateId}/documents/${docId}`, { method: "DELETE" });
      forgetPdf(`/v1/templates/${templateId}/documents/${docId}/file`);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <div className="stack">
      <div className="dropzone">
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

function RolesStep({ roles, onChange }: { roles: DraftRole[]; onChange: (r: DraftRole[]) => void }) {
  const { t } = useI18n();
  const set = (i: number, patch: Partial<DraftRole>) => onChange(roles.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  let signerIdx = -1;
  return (
    <div className="stack">
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
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={r.routingOrder}
                  onChange={(e) => set(i, { routingOrder: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })}
                />
              </label>
              <label className="field">
                <span>{t("tpl.roleName")}</span>
                <input required maxLength={100} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
              </label>
              <label className="field">
                <span>{t("edit.role")}</span>
                <select value={r.role} onChange={(e) => set(i, { role: e.target.value as RecipientRole })}>
                  <option value="signer">{t("edit.role.signer")}</option>
                  <option value="cc">{t("edit.role.cc")}</option>
                  {/* Las plantillas admiten aprobadores (p. ej. las creadas desde un sobre): sin esta opción se veían como firmante. */}
                  <option value="approver">{t("edit.role.approver")}</option>
                </select>
              </label>
              {r.role === "signer" && <CertificateOption value={r.cert ?? EMPTY_CERT_DRAFT} hasIdDocument onChange={(v) => set(i, { cert: v })} />}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(roles.filter((_, j) => j !== i))}>
                {t("common.delete")}
              </button>
            </div>
          </div>
        );
      })}
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
    </div>
  );
}
