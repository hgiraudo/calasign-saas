// Ajustes → Organización: el huso horario de las horas del certificado y de la fecha de firma (migración 0123) y los
// canales de terceros que la organización permite (SMS, WhatsApp, Telegram; migración 0128).
import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_ORGANIZATION_CHANNELS,
  formatDateTimeInZone,
  ORGANIZATION_CHANNELS,
  type OrganizationChannels,
  type OrganizationSettings,
} from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useAccess } from "../lib/access";
import { useOrganizationText } from "../lib/i18n-organization";
import { useTitle } from "../lib/white-label";
import { ErrorBox, Spinner } from "../components/ui";

/** Los husos que conoce el navegador, con el guardado siempre presente (aunque este navegador no lo liste). */
function zoneList(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set(["UTC", current, ...all])].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));
}

export function OrganizationSettingsPage() {
  const o = useOrganizationText();
  useTitle(o("org.title"));
  const { can } = useAccess();
  const canEdit = can("settings:manage");
  const [s, setS] = useState<OrganizationSettings | null>(null);
  const [timeZone, setTimeZone] = useState("UTC");
  const [channels, setChannels] = useState<OrganizationChannels>(DEFAULT_ORGANIZATION_CHANNELS);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"timeZone" | "channels" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let vivo = true;
    api<OrganizationSettings>("/v1/settings/organization")
      .then((x) => {
        if (!vivo) return;
        setS(x);
        setTimeZone(x.timeZone);
        setChannels(x.channels);
      })
      .catch((e) => vivo && setError(errorText(e)));
    return () => {
      vivo = false;
    };
  }, []);

  const zones = useMemo(() => zoneList(s?.timeZone ?? "UTC"), [s?.timeZone]);

  if (!s) return error ? <ErrorBox error={error} /> : <Spinner />;

  // Cada sección guarda solo lo suyo (PATCH parcial): guardar el huso no reenvía los canales y al revés.
  const save = async (what: "timeZone" | "channels") => {
    setError(null);
    setSaved(null);
    setBusy(true);
    try {
      const body = what === "timeZone" ? { timeZone } : { channels };
      const x = await api<OrganizationSettings>("/v1/settings/organization", { method: "PATCH", body });
      setS(x);
      // Lo que se está editando en la otra sección (sin guardar) se conserva.
      if (what === "timeZone") setTimeZone(x.timeZone);
      else setChannels(x.channels);
      setSaved(what);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const channelsChanged = ORGANIZATION_CHANNELS.some((c) => channels[c] !== s.channels[c]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{o("org.title")}</h1>
      </div>
      <p className="muted">{o("org.intro")}</p>
      <ErrorBox error={error} />
      <section className="card pad stack">
        <label className="field">
          <span>{o("org.timeZone")}</span>
          <select
            value={timeZone}
            disabled={!canEdit}
            onChange={(e) => {
              setTimeZone(e.target.value);
              setSaved(null);
            }}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small" role="status">
          {o("org.now", { time: formatDateTimeInZone(new Date(), timeZone) })}
        </p>
        {!canEdit && <p className="muted small">{o("org.readOnly")}</p>}
        {canEdit && (
          <div className="row-wrap">
            <button type="button" className="btn btn-primary" disabled={busy || timeZone === s.timeZone} onClick={() => save("timeZone")}>
              {o("org.save")}
            </button>
            {saved === "timeZone" && (
              <span className="muted small" role="status">
                {o("org.saved")}
              </span>
            )}
          </div>
        )}
      </section>
      <section className="card pad stack" aria-labelledby="org-channels">
        <h2 id="org-channels">{o("org.channels")}</h2>
        <p className="muted small">{o("org.channelsIntro")}</p>
        {ORGANIZATION_CHANNELS.map((c) => (
          <label key={c} className="check">
            <input
              type="checkbox"
              checked={channels[c]}
              disabled={!canEdit}
              onChange={(e) => {
                setChannels({ ...channels, [c]: e.target.checked });
                setSaved(null);
              }}
            />
            <span>
              <strong>{o(`org.ch.${c}`)}</strong>
              <br />
              <span className="muted small">{o(`org.ch.${c}Desc`)}</span>
            </span>
          </label>
        ))}
        {(!channels.sms || !channels.whatsapp) && <p className="small warn-text">{o("org.channelsOtpNote")}</p>}
        {!canEdit && <p className="muted small">{o("org.readOnly")}</p>}
        {canEdit && (
          <div className="row-wrap">
            <button type="button" className="btn btn-primary" disabled={busy || !channelsChanged} onClick={() => save("channels")}>
              {o("org.channelsSave")}
            </button>
            {saved === "channels" && (
              <span className="muted small" role="status">
                {o("org.saved")}
              </span>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
