// Crear un sobre desde una plantilla: una persona por rol, datos prellenados opcionales.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Channel, EnvelopeDetail, EnvelopeFromTemplateInput, Locale, TemplateDetail } from "@calasign/shared";
import { LOCALES, PREFILLABLE_FIELD_TYPES } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { LOCALE_LABELS, useI18n } from "../lib/i18n";
import { ErrorBox, Spinner, recipientColor } from "../components/ui";

interface Person {
  name: string;
  email: string;
  phone: string;
  locale: Locale | "";
  channels: Channel[];
}

const CHANNELS_UI: { id: Channel; label: string }[] = [
  { id: "email", label: "Email" },
  { id: "whatsapp", label: "WhatsApp" },
];

export function TemplateUsePage() {
  const { id = "" } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const [tpl, setTpl] = useState<TemplateDetail | null>(null);
  const [people, setPeople] = useState<Record<string, Person>>({});
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [prefill, setPrefill] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<TemplateDetail>(`/v1/templates/${id}`)
      .then((d) => {
        setTpl(d);
        setSubject(d.template.subject ?? d.template.name);
        setMessage(d.template.message ?? "");
        setPeople(Object.fromEntries(d.roles.map((r) => [r.id, { name: "", email: "", phone: "", locale: "", channels: ["email"] }])));
      })
      .catch((e) => setError(errorText(e)));
  }, [id]);

  /** Campos prellenables, agrupados por etiqueta (el valor se aplica a todos los campos con esa etiqueta). */
  const prefillable = useMemo(() => {
    if (!tpl) return [];
    const seen = new Map<string, { field: (typeof tpl.fields)[number]; ids: string[] }>();
    for (const f of tpl.fields) {
      if (f.readOnly || f.formula || !PREFILLABLE_FIELD_TYPES.includes(f.type)) continue;
      // Misma etiqueta pero distinto tipo u opciones (p. ej. "Plan" texto en un rol y desplegable en otro): con un solo
      // control, lo escrito para el primero se aplicaba al otro y el alta fallaba ("opción inválida", "no es un número").
      const label = f.label?.trim();
      const key = label ? `${label}\u0000${f.type}\u0000${(f.options ?? []).join("\u0001")}` : f.id;
      const g = seen.get(key);
      if (g) g.ids.push(f.id);
      else seen.set(key, { field: f, ids: [f.id] });
    }
    return [...seen.entries()].map(([key, g]) => ({ key, ...g }));
  }, [tpl]);

  const submit = async (send: boolean, e?: FormEvent) => {
    e?.preventDefault();
    if (!tpl) return;
    setBusy(true);
    setError(null);
    const body: EnvelopeFromTemplateInput = {
      templateId: tpl.template.id,
      subject: subject.trim() || undefined,
      message: message.trim() || null,
      recipients: tpl.roles.map((r) => {
        const p = people[r.id];
        return {
          roleId: r.id,
          name: p.name.trim(),
          email: p.email.trim() || null,
          phone: p.phone.trim() || null,
          locale: p.locale || null,
          channels: p.channels,
        };
      }),
      // Por id de campo: la API busca por etiqueta exacta (con espacios) e incluye los campos de solo lectura con la
      // misma etiqueta, así que mandar la etiqueta recortada daba "no hay ningún campo" o "es de solo lectura".
      // Un valor borrado se manda vacío para quitar el valor por defecto de la plantilla (antes quedaba igual).
      prefill: Object.fromEntries(
        prefillable.flatMap((g) => (g.key in prefill && (prefill[g.key].trim() !== "" || g.field.value) ? g.ids.map((fid) => [fid, prefill[g.key].trim()]) : [])),
      ),
      send,
    };
    try {
      const d = await api<EnvelopeDetail>("/v1/envelopes/from-template", { method: "POST", body });
      nav(send ? `/app/envelopes/${d.envelope.id}` : `/app/envelopes/${d.envelope.id}/edit`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  if (!tpl) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  let signerIdx = -1;

  return (
    <form className="page stack" onSubmit={(e) => submit(true, e)}>
      <div className="page-head">
        <div>
          <Link to="/app/templates" className="muted small">
            ← {t("tpl.title")}
          </Link>
          <h1>{t("tpl.useTitle")}</h1>
          <p className="muted">{tpl.template.name}</p>
        </div>
      </div>
      <ErrorBox error={error} />

      {tpl.roles.map((r) => {
        if (r.role === "signer") signerIdx++;
        const p = people[r.id];
        if (!p) return null;
        const set = (patch: Partial<Person>) => setPeople((x) => ({ ...x, [r.id]: { ...x[r.id], ...patch } }));
        return (
          <div key={r.id} className="card pad recipient-row" style={{ borderLeftColor: r.role === "signer" ? recipientColor(signerIdx) : "#94a3b8" }}>
            <h3>
              {t("tpl.recipientFor")} «{r.name}» <span className="muted small">({t(r.role === "cc" ? "edit.role.cc" : r.role === "approver" ? "edit.role.approver" : "edit.role.signer")})</span>
            </h3>
            <div className="use-grid">
              <label className="field">
                <span>{t("edit.name")}</span>
                <input required maxLength={200} value={p.name} onChange={(e) => set({ name: e.target.value })} />
              </label>
              <label className="field">
                <span>{t("auth.email")}</span>
                <input type="email" maxLength={320} value={p.email} required={p.channels.includes("email")} onChange={(e) => set({ email: e.target.value })} />
              </label>
              <label className="field">
                <span>{t("edit.phone")}</span>
                <input
                  type="tel"
                  placeholder="+18095551234"
                  value={p.phone}
                  required={p.channels.includes("whatsapp")}
                  // Como en el resto de los teléfonos: "+1 809 555-1234" no pasaba la validación de la API (solo +dígitos).
                  onChange={(e) => set({ phone: e.target.value.replace(/[^\d+]/g, "") })}
                />
              </label>
              <label className="field">
                <span>{t("edit.locale")}</span>
                <select value={p.locale} onChange={(e) => set({ locale: e.target.value as Locale | "" })}>
                  <option value="">—</option>
                  {LOCALES.map((l) => (
                    <option key={l} value={l}>
                      {LOCALE_LABELS[l]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row-wrap">
              <span className="muted small">{t("edit.channels")}:</span>
              {CHANNELS_UI.map((c) => (
                <label key={c.id} className="check">
                  <input
                    type="checkbox"
                    checked={p.channels.includes(c.id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...p.channels, c.id] : p.channels.filter((x) => x !== c.id);
                      if (next.length) set({ channels: next });
                    }}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </div>
        );
      })}

      {prefillable.length > 0 && (
        <div className="card pad stack">
          <h3>{t("tpl.prefillTitle")}</h3>
          <p className="muted small">{t("tpl.prefillHint")}</p>
          <div className="use-grid">
            {prefillable.map(({ key, field }) => (
              <label key={key} className="field">
                <span>{field.label ?? t(`field.${field.type}`)}</span>
                {field.type === "dropdown" ? (
                  <select value={prefill[key] ?? field.value ?? ""} onChange={(e) => setPrefill((x) => ({ ...x, [key]: e.target.value }))}>
                    <option value="">—</option>
                    {(field.options ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={prefill[key] ?? field.value ?? ""}
                    inputMode={field.type === "number" ? "decimal" : undefined}
                    maxLength={2000}
                    onChange={(e) => setPrefill((x) => ({ ...x, [key]: e.target.value }))}
                  />
                )}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="card pad stack">
        <label className="field">
          <span>{t("edit.subject")}</span>
          <input required maxLength={300} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="field">
          <span>{t("edit.message")}</span>
          <textarea rows={3} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
      </div>

      <div className="wizard-nav">
        <button type="button" className="btn" disabled={busy} onClick={() => submit(false)}>
          {t("tpl.createDraft")}
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? t("edit.sending") : t("tpl.createAndSend")}
        </button>
      </div>
    </form>
  );
}
