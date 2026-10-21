// Controles de identidad para el remitente: selector de verificación por destinatario y estado en el detalle.
import { useEffect, useState } from "react";
import type { IdentitySettings, Recipient, RecipientIdentity } from "@calasign/shared";
import { IDV_LEVELS } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useIdnText, type IdnKey } from "../lib/i18n-identity";

// Por organización: el caché vive fuera de React y sobrevivía al cambio de organización (se ofrecían los proveedores
// de la otra y el guardado fallaba, o no se ofrecía ninguno) y a configurar un proveedor en Ajustes sin recargar.
let cache: { tenant: string | null; settings: Promise<IdentitySettings | null> } | null = null;
function loadSettings(tenant: string | null) {
  if (!cache || cache.tenant !== tenant) {
    const settings: Promise<IdentitySettings | null> = api<IdentitySettings>("/v1/settings/identity").catch(() => {
      // Un error no se cachea: si falló (red, sesión), el próximo uso vuelve a pedir.
      if (cache?.settings === settings) cache = null;
      return null;
    });
    cache = { tenant, settings };
  }
  return cache.settings;
}

/** Ajustes de identidad cambiados (p. ej. otro proveedor por defecto): el próximo selector los vuelve a pedir. */
export function forgetIdentitySettings() {
  cache = null;
}

/** Valor "proveedor:nivel" o "" (sin verificación). */
export function IdentitySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tx = useIdnText();
  const tenant = useAuth().me?.tenant.id ?? null;
  const [settings, setSettings] = useState<IdentitySettings | null>(null);
  useEffect(() => {
    let alive = true;
    loadSettings(tenant).then((s) => alive && setSettings(s));
    return () => {
      alive = false;
    };
  }, [tenant]);
  const providers = (settings?.providers ?? []).filter((p) => p.configured);
  // Con un valor ya guardado, el selector se muestra aunque no quede ningún proveedor configurado (o no se pudieran
  // leer los ajustes): oculto, se seguía mandando ese valor y el guardado de destinatarios fallaba sin forma de quitarlo.
  if (!value && (!settings || providers.length === 0)) return null;
  const options: { v: string; label: string }[] = [];
  for (const p of providers) {
    for (const l of IDV_LEVELS) options.push({ v: `${p.id}:${l}`, label: `${p.name} · ${tx(`idv.level.${l}` as IdnKey)}` });
  }
  // Un valor ya guardado con un proveedor que dejó de estar configurado se sigue mostrando.
  if (value && !options.some((o) => o.v === value)) options.push({ v: value, label: value });
  return (
    <label className="field">
      <span>{tx("idv.edit.label")}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{tx("idv.edit.none")}</option>
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function identityToDraft(i: RecipientIdentity | null | undefined): string {
  return i ? `${i.provider}:${i.level}` : "";
}

export function draftToIdentity(v: string) {
  if (!v) return null;
  const [provider, level] = v.split(":");
  return { provider: provider as "mock" | "truora" | "veriff", level: level as (typeof IDV_LEVELS)[number] };
}

export function IdentityBadge({ identity }: { identity: RecipientIdentity | null | undefined }) {
  const tx = useIdnText();
  if (!identity) return null;
  const cls = identity.status === "verified" ? "badge-completed" : identity.status === "failed" ? "badge-declined" : "badge-sent";
  return (
    <span className={`badge ${cls} idv-badge`} title={identity.failureReason ?? undefined}>
      🪪 {tx(`idv.status.${identity.status}` as IdnKey)}
    </span>
  );
}

/**
 * El remitente reinicia la verificación de identidad de un destinatario (POST …/identity/reset): se anulan las
 * anteriores y vuelve a tener todos los intentos. P. ej. agotó los intentos por fotos malas o el proveedor no respondió.
 */
export function IdentityResetButton({
  envelopeId,
  recipient,
  onDone,
  onError,
}: {
  envelopeId: string;
  recipient: Recipient;
  onDone: (msg: string) => void;
  onError: (e: string) => void;
}) {
  const tx = useIdnText();
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    if (!window.confirm(tx("idv.resetConfirm", { name: recipient.name }))) return;
    setBusy(true);
    try {
      await api(`/v1/envelopes/${envelopeId}/recipients/${recipient.id}/identity/reset`, { method: "POST" });
      onDone(tx("idv.resetDone", { name: recipient.name }));
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={reset}>
      🪪 {tx("idv.reset")}
    </button>
  );
}
