// Controles de identidad para el remitente: selector de verificación por destinatario y estado en el detalle.
import { useEffect, useState } from "react";
import type { IdentitySettings, RecipientIdentity } from "@calasign/shared";
import { IDV_LEVELS } from "@calasign/shared";
import { api } from "../lib/api";
import { useIdnText, type IdnKey } from "../lib/i18n-identity";

let cache: Promise<IdentitySettings | null> | null = null;
function loadSettings() {
  // Un error no se cachea: si falló (red, sesión), el próximo uso vuelve a pedir.
  cache ??= api<IdentitySettings>("/v1/settings/identity").catch(() => {
    cache = null;
    return null;
  });
  return cache;
}

/** Valor "proveedor:nivel" o "" (sin verificación). */
export function IdentitySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tx = useIdnText();
  const [settings, setSettings] = useState<IdentitySettings | null>(null);
  useEffect(() => {
    loadSettings().then(setSettings);
  }, []);
  const providers = (settings?.providers ?? []).filter((p) => p.configured);
  if (!settings || providers.length === 0) return null;
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
