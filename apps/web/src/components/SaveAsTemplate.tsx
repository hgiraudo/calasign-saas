// Botón "Guardar como plantilla" para un sobre (borrador o enviado).
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { TemplateDetail } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { ErrorBox, Modal } from "./ui";

export function SaveAsTemplateButton({
  envelopeId,
  defaultName,
  beforeSave,
  disabled,
}: {
  envelopeId: string;
  defaultName: string;
  beforeSave?: () => Promise<boolean>;
  /** La página está ocupada (p. ej. subiendo un documento): la plantilla saldría sin lo que todavía no terminó. */
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (beforeSave && !(await beforeSave())) {
        // El error del guardado previo lo muestra la página, detrás del modal: se cierra para que se vea.
        setBusy(false);
        setOpen(false);
        return;
      }
      const d = await api<TemplateDetail>(`/v1/templates/from-envelope/${envelopeId}`, { method: "POST", body: { name: name.trim() } });
      nav(`/app/templates/${d.template.id}/edit`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setOpen(true)}>
        ⧉ {t("edit.saveAsTemplate")}
      </button>
      {open && (
        <Modal title={t("edit.saveAsTemplate")} onClose={() => setOpen(false)}>
          <form onSubmit={submit} className="stack">
            <ErrorBox error={error} />
            <label className="field">
              <span>{t("tpl.fromEnvelopeName")}</span>
              <input required autoFocus maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy || disabled || !name.trim()}>
                {busy ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
