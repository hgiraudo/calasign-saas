// Ajustes → Organización: el huso horario de las horas del certificado y de la fecha de firma (migración 0123).
import { useEffect, useMemo, useState } from "react";
import { formatDateTimeInZone, type OrganizationSettings } from "@calasign/shared";
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
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let vivo = true;
    api<OrganizationSettings>("/v1/settings/organization")
      .then((x) => {
        if (!vivo) return;
        setS(x);
        setTimeZone(x.timeZone);
      })
      .catch((e) => vivo && setError(errorText(e)));
    return () => {
      vivo = false;
    };
  }, []);

  const zones = useMemo(() => zoneList(s?.timeZone ?? "UTC"), [s?.timeZone]);

  if (!s) return error ? <ErrorBox error={error} /> : <Spinner />;

  const save = async () => {
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      const x = await api<OrganizationSettings>("/v1/settings/organization", { method: "PATCH", body: { timeZone } });
      setS(x);
      setTimeZone(x.timeZone);
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{o("org.title")}</h1>
      </div>
      <p className="muted">{o("org.intro")}</p>
      <section className="card pad stack">
        <label className="field">
          <span>{o("org.timeZone")}</span>
          <select
            value={timeZone}
            disabled={!canEdit}
            onChange={(e) => {
              setTimeZone(e.target.value);
              setSaved(false);
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
        <ErrorBox error={error} />
        {canEdit && (
          <div className="row-wrap">
            <button type="button" className="btn btn-primary" disabled={busy || timeZone === s.timeZone} onClick={save}>
              {o("org.save")}
            </button>
            {saved && (
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
