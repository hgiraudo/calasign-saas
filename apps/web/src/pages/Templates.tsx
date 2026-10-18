// Listado de plantillas: crear, usar, editar y eliminar.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { TemplateDetail, TemplateSummary } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { formatDateTime, useI18n } from "../lib/i18n";
import { ErrorBox, Modal, Spinner } from "../components/ui";
import { useScaleText } from "../lib/i18n-scale";

export function TemplatesPage() {
  const { t, locale } = useI18n();
  const sc = useScaleText();
  const nav = useNavigate();
  const [items, setItems] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: TemplateSummary[] }>("/v1/templates")).items);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await api<TemplateDetail>("/v1/templates", { method: "POST", body: { name: name.trim() } });
      nav(`/app/templates/${d.template.id}/edit`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/v1/templates/${deleting.id}`, { method: "DELETE" });
      setDeleting(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("tpl.title")}</h1>
          <p className="muted">{t("tpl.intro")}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          + {t("tpl.new")}
        </button>
      </div>
      <ErrorBox error={error} />
      {items === null ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{t("tpl.empty")}</div>
      ) : (
        <div className="tpl-grid">
          {items.map((it) => (
            <div key={it.id} className="card pad tpl-card">
              <div className="grow">
                <h3>{it.name}</h3>
                {it.description && <p className="muted small">{it.description}</p>}
                <p className="small">
                  {it.documentCount} {t("tpl.documents")} · {it.roles.map((r) => r.name).join(", ") || "—"}
                </p>
                <p className="muted small">{formatDateTime(it.updatedAt, locale)}</p>
              </div>
              <div className="row-wrap">
                <Link className="btn btn-primary btn-sm" to={`/app/templates/${it.id}/use`}>
                  {t("tpl.use")}
                </Link>
                <Link className="btn btn-sm" to={`/app/bulk/new?template=${it.id}`}>
                  {sc("bulk.useFromTemplate")}
                </Link>
                <Link className="btn btn-sm" to={`/app/forms?template=${it.id}`}>
                  {sc("forms.useFromTemplate")}
                </Link>
                <Link className="btn btn-sm" to={`/app/templates/${it.id}/edit`}>
                  {t("tpl.edit")}
                </Link>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDeleting(it)}>
                  {t("common.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <Modal title={t("tpl.new")} onClose={() => setCreating(false)}>
          <form onSubmit={create} className="stack">
            <label className="field">
              <span>{t("tpl.name")}</span>
              <input required autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <ErrorBox error={error} />
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
                {t("common.next")} →
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleting && (
        <Modal
          title={deleting.name}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)}>
                {t("common.cancel")}
              </button>
              <button type="button" className="btn btn-danger" disabled={busy} onClick={remove}>
                {t("common.delete")}
              </button>
            </>
          }
        >
          <p>{t("tpl.deleteConfirm")}</p>
          <ErrorBox error={error} />
        </Modal>
      )}
    </div>
  );
}
