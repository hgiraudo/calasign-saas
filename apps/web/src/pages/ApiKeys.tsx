import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiKey, CreateApiKeyResponse, Permission } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { canManagePerms, PlanNotice, useAccess } from "../lib/access";
import { formatDateTime, useI18n, confirmAction, placeholderText } from "../lib/i18n";
import { ErrorBox, Spinner } from "../components/ui";
import { useRoleLabel, useTeamsText } from "../lib/i18n-teams";

interface KeyRole {
  id: string;
  role: string;
  roleId: string | null;
  roleName: string;
}
/** Rol de una opción, sin traducir: la etiqueta se arma al dibujar (si no, quedaba en el idioma del momento de la carga). */
interface RoleOption {
  value: string;
  role: string;
  name: string | null;
  permissions: Permission[];
}

export function ApiKeysPage() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tm = useTeamsText();
  const roleLabel = useRoleLabel();
  const [role, setRole] = useState("admin");
  const [roleOptions, setRoleOptions] = useState<RoleOption[]>([]);
  const [keyRoles, setKeyRoles] = useState<Record<string, KeyRole>>({});
  const { access, hasFeature } = useAccess();
  const inPlan = hasFeature("api");
  // Como la API (assertCanGrant / assertCanManageApiKey): solo roles o keys con permisos que quien está en la sesión tiene.
  const canGrant = (perms: readonly string[] | null | undefined) => canManagePerms(access, perms);
  const keyPerms = (k: KeyRole | undefined) =>
    !k ? null : roleOptions.find((o) => o.value === (k.role === "custom" ? `custom:${k.roleId}` : k.role))?.permissions ?? null;

  const load = () =>
    Promise.all([api<{ items: ApiKey[] }>("/v1/api-keys"), api<{ items: KeyRole[] }>("/v1/api-keys/roles")])
      .then(([r, kr]) => {
        setItems(r.items);
        setKeyRoles(Object.fromEntries(kr.items.map((k) => [k.id, k])));
      })
      .catch((e) => setError(errorText(e)));

  useEffect(() => {
    api<{ items: { id: string; name: string; permissions: Permission[] }[]; builtin: { role: string; name: string; permissions: Permission[] }[] }>("/v1/roles")
      .then((r) =>
        setRoleOptions([
          ...r.builtin.filter((b) => b.role !== "owner").map((b) => ({ value: b.role, role: b.role, name: null, permissions: b.permissions })),
          ...r.items.map((x) => ({ value: `custom:${x.id}`, role: "custom", name: x.name, permissions: x.permissions })),
        ]),
      )
      .catch(() => undefined);
  }, []);

  // Una key no puede tener permisos que quien la crea no tiene (403): con "admin" preelegido, alguien con un rol
  // personalizado que incluye api_keys:manage no podía crear ninguna sin cambiar antes el rol. Se preelige el primero
  // que puede otorgar.
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || !access || roleOptions.length === 0) return;
    defaulted.current = true;
    if (access.role === "owner") return;
    const grantable = (o: RoleOption) => o.permissions.every((p) => access.permissions.includes(p));
    const admin = roleOptions.find((o) => o.value === "admin");
    if (admin && grantable(admin)) return;
    const first = roleOptions.find(grantable);
    if (first) setRole((cur) => (cur === "admin" ? first.value : cur));
  }, [access, roleOptions]);

  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const roleBody = role.startsWith("custom:") ? { role: "custom", roleId: role.slice(7) } : { role };
      const r = await api<CreateApiKeyResponse>("/v1/api-keys", { method: "POST", body: { name, ...roleBody } });
      setSecret(r.secret);
      setCopied(false);
      setName("");
      await load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    if (!confirmAction()) return;
    setError(null);
    try {
      await api(`/v1/api-keys/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      /* el usuario puede copiar a mano */
    }
  };

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>{t("keys.title")}</h1>
      </div>
      <p className="muted">{t("keys.intro")}</p>
      <PlanNotice feature="api" />

      <form onSubmit={create} className="card pad row-wrap">
        <label className="field grow">
          <span>{t("keys.name")}</span>
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholderText("integration")} />
        </label>
        {roleOptions.length > 0 && (
          <label className="field">
            <span>{tm("keys.role")}</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {roleOptions.map((o) => (
                <option key={o.value} value={o.value} disabled={!canGrant(o.permissions)}>
                  {o.name ?? roleLabel(o.role)}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="btn btn-primary" disabled={busy || !name.trim() || !inPlan || !canGrant(roleOptions.find((o) => o.value === role)?.permissions)}>
          {t("keys.create")}
        </button>
      </form>

      {secret && (
        <div className="alert alert-success stack">
          <strong>{t("keys.secretOnce")}</strong>
          <div className="secret-row">
            <code className="secret">{secret}</code>
            <button type="button" className="btn btn-sm" onClick={copy}>
              {copied ? t("common.copied") : t("common.copy")}
            </button>
          </div>
        </div>
      )}

      <ErrorBox error={error} />

      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{t("keys.empty")}</div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{t("keys.name")}</th>
                <th>{tm("keys.prefix")}</th>
                <th className="hide-sm">{tm("keys.role")}</th>
                <th className="hide-sm">{t("keys.lastUsed")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((k) => (
                <tr key={k.id} className={k.revokedAt ? "muted" : ""}>
                  <td>{k.name}</td>
                  <td>
                    <code>{k.prefix}…</code>
                  </td>
                  <td className="hide-sm">{keyRoles[k.id] ? roleLabel(keyRoles[k.id].role, keyRoles[k.id].roleName) : "—"}</td>
                  <td className="hide-sm">{formatDateTime(k.lastUsedAt, locale)}</td>
                  <td className="right">
                    {k.revokedAt ? (
                      <span className="badge badge-voided">{t("keys.revoked")}</span>
                    ) : canGrant(keyPerms(keyRoles[k.id])) ? (
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => revoke(k.id)}>
                        {t("keys.revoke")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
