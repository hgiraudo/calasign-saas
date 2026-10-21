// Modal para rechazar el sobre desde la página del firmante. Se usa en el flujo de firma y antes de él (consentimiento,
// verificación de identidad, entrega en persona): el servidor acepta /decline sin consentimiento ni identidad verificada.
import { useState } from "react";
import type { SigningSession } from "@calasign/shared";
import { api, errorText, isStaleError } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { ErrorBox, Modal } from "./ui";

export function DeclineModal({
  base,
  onClose,
  onDone,
  onStale,
}: {
  base: string;
  onClose: () => void;
  onDone: (s: SigningSession) => void;
  /** Vuelve a pedir la sesión ante un error terminal (sesión vencida, sobre cerrado…). */
  onStale: () => unknown;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decline = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await api<SigningSession>(`${base}/decline`, { method: "POST", body: { reason } });
      onClose();
      onDone(s);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
      // Si la sesión cambió (p. ej. venció y se vuelve a pedir el código), el modal se cierra antes de resincronizar:
      // si no, quedaba abierto dentro del flujo oculto y reaparecía (o atrapaba el teclado) detrás del código.
      if (isStaleError(e)) {
        onClose();
        void onStale();
      }
    }
  };
  return (
    <Modal
      title={t("sign.declineTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy || !reason.trim()} onClick={decline}>
            {t("sign.declineConfirm")}
          </button>
        </>
      }
    >
      <label className="field">
        <span>{t("sign.declineReason")}</span>
        <textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </label>
      {/* El error del rechazo se muestra acá: el de la página queda tapado por el modal. */}
      <ErrorBox error={error} />
    </Modal>
  );
}
