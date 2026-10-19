// Marca de la organización: color, logo y pie de correo, con vista previa.
import { useEffect, useRef, useState } from "react";
import type { Branding } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useI18n } from "../lib/i18n";
import { ErrorBox, Logo, Spinner } from "../components/ui";

const DEFAULT_COLOR = "#0b1f3a";

export function BrandingPage() {
  const { t } = useI18n();
  const { me, refresh } = useAuth();
  const [b, setB] = useState<Branding | null>(null);
  const [color, setColor] = useState<string>("");
  const [footer, setFooter] = useState("");
  const [orgName, setOrgName] = useState(me?.tenant.name ?? "");
  const tenantName = me?.tenant.name;
  useEffect(() => {
    if (tenantName) setOrgName(tenantName);
  }, [tenantName]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const apply = (x: Branding) => {
    setB(x);
    setColor(x.primaryColor ?? "");
    setFooter(x.emailFooter ?? "");
  };

  useEffect(() => {
    api<Branding>("/v1/settings/branding")
      .then(apply)
      .catch((e) => setError(errorText(e)));
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const name = orgName.trim();
      apply(
        await api<Branding>("/v1/settings/branding", {
          method: "PATCH",
          body: { primaryColor: color || null, emailFooter: footer.trim() || null, ...(name && name !== me?.tenant.name ? { organizationName: name } : {}) },
        }),
      );
      if (name && name !== me?.tenant.name) await refresh();
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      // Solo el logo: no pisar color ni pie que el usuario esté editando sin guardar.
      setB(await api<Branding>("/v1/settings/branding/logo", { method: "POST", form }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeLogo = async () => {
    setBusy(true);
    setError(null);
    try {
      setB(await api<Branding>("/v1/settings/branding/logo", { method: "DELETE" }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!b) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  const valid = (color === "" || /^#[0-9a-fA-F]{6}$/.test(color)) && orgName.trim().length !== 1;
  const preview = valid && color ? color : DEFAULT_COLOR;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t("brand.title")}</h1>
          <p className="muted">{t("brand.intro")}</p>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="brand-layout">
        <div className="card pad stack">
          <label className="field">
            <span>{t("brand.orgName")}</span>
            <input value={orgName} maxLength={120} onChange={(e) => setOrgName(e.target.value)} />
            <span className="muted small">{t("brand.orgNameHint")}</span>
          </label>
          <label className="field">
            <span>{t("brand.color")}</span>
            <div className="row-wrap">
              <input
                type="color"
                className="color-input"
                value={valid && color ? color : DEFAULT_COLOR}
                onChange={(e) => {
                  setColor(e.target.value);
                  setSaved(false);
                }}
                aria-label={t("brand.color")}
              />
              <input
                className="color-text"
                value={color}
                placeholder={DEFAULT_COLOR}
                maxLength={7}
                onChange={(e) => {
                  setColor(e.target.value.trim());
                  setSaved(false);
                }}
              />
              {color && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setColor("")}>
                  {t("brand.reset")}
                </button>
              )}
            </div>
          </label>

          <div className="field">
            <span>{t("brand.logo")}</span>
            <div className="row-wrap">
              {b.logoUrl ? <img className="logo-thumb" src={b.logoUrl} alt={t("brand.logo")} /> : <span className="muted small">—</span>}
              <label className="btn btn-sm">
                {t("brand.uploadLogo")}
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  accept="image/png,image/jpeg,image/svg+xml"
                  disabled={busy}
                  onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
                />
              </label>
              {b.logoUrl && (
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={removeLogo}>
                  {t("brand.removeLogo")}
                </button>
              )}
            </div>
            <small className="muted">{t("brand.logoHint")}</small>
          </div>

          <label className="field">
            <span>{t("brand.footer")}</span>
            <textarea
              rows={2}
              maxLength={500}
              value={footer}
              onChange={(e) => {
                setFooter(e.target.value);
                setSaved(false);
              }}
            />
            <small className="muted">{t("brand.footerHint")}</small>
          </label>

          <div className="row-wrap">
            <button type="button" className="btn btn-primary" disabled={busy || !valid} onClick={save}>
              {busy ? t("common.saving") : t("common.save")}
            </button>
            {saved && <span className="muted small">✓ {t("edit.saved")}</span>}
          </div>
        </div>

        <div className="stack">
          <h3>{t("brand.previewSigner")}</h3>
          <div className="brand-preview card">
            <div className="brand-preview-bar" style={{ background: preview }}>
              {b.logoUrl ? (
                <span className="signer-brand">
                  <img className="signer-logo" src={b.logoUrl} alt="" />
                </span>
              ) : (
                <strong>{me?.tenant.name}</strong>
              )}
            </div>
            <div className="pad stack">
              <p className="muted small">{me?.tenant.name}</p>
              <div className="brand-preview-doc" />
              <span className="btn btn-primary btn-sm brand-preview-btn" style={{ background: preview, borderColor: preview }}>
                ✍
              </span>
              {footer.trim() && <p className="muted small brand-preview-footer">{footer}</p>}
              <p className="muted small">
                <Logo />
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
