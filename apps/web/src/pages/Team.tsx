// Equipo: miembros, invitaciones, roles personalizados y grupos.
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  PERMISSIONS,
  type CreateInvitationResponse,
  type CustomRole,
  type Group,
  type Invitation,
  type Member,
  type Permission,
} from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAccess } from "../lib/access";
import { formatDateTime, useI18n, confirmAction } from "../lib/i18n";
import { useRoleLabel, useTeamsText } from "../lib/i18n-teams";
import { ErrorBox, Modal, Spinner } from "../components/ui";

type Tab = "members" | "invitations" | "roles" | "groups";
interface RolesResponse {
  items: CustomRole[];
  builtin: { role: "owner" | "admin" | "member"; name: string; permissions: Permission[] }[];
}

/** Opciones de rol para los selects: integrados + personalizados ("custom:<id>"). */
function RoleSelect({ value, onChange, roles, allowOwner }: { value: string; onChange: (v: string) => void; roles: RolesResponse | null; allowOwner: boolean }) {
  const label = useRoleLabel();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {(roles?.builtin ?? [])
        .filter((b) => allowOwner || b.role !== "owner")
        .map((b) => (
          <option key={b.role} value={b.role}>
            {label(b.role)}
          </option>
        ))}
      {(roles?.items ?? []).map((r) => (
        <option key={r.id} value={`custom:${r.id}`}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

function toAssignment(v: string) {
  return v.startsWith("custom:") ? { role: "custom", roleId: v.slice(7) } : { role: v, roleId: null };
}

export function TeamPage() {
  const tt = useTeamsText();
  const { can } = useAccess();
  const manage = can("members:manage");
  const [tab, setTab] = useState<Tab>("members");
  const [roles, setRoles] = useState<RolesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRoles = () => api<RolesResponse>("/v1/roles").then(setRoles).catch((e) => setError(errorText(e)));
  useEffect(() => {
    void loadRoles();
  }, []);

  const tabs: Tab[] = manage ? ["members", "invitations", "roles", "groups"] : ["members", "groups"];
  // Si la pestaña abierta deja de estar permitida (p. ej. al editar el propio rol personalizado y quitarle
  // members:manage), se vuelve a Miembros: si no, la página quedaba en blanco y sin ninguna pestaña marcada.
  const current: Tab = tabs.includes(tab) ? tab : "members";
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{tt("team.title")}</h1>
          <p className="muted">{tt("team.intro")}</p>
        </div>
      </div>
      <div className="tabs scroll" role="tablist" style={{ marginBottom: "1rem", display: "inline-flex" }}>
        {tabs.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={current === k} className={current === k ? "active" : ""} onClick={() => setTab(k)}>
            {tt(`team.tab.${k}` as const)}
          </button>
        ))}
      </div>
      <ErrorBox error={error} />
      {current === "members" && <MembersTab roles={roles} manage={manage} />}
      {current === "invitations" && <InvitationsTab roles={roles} />}
      {current === "roles" && <RolesTab roles={roles} reload={loadRoles} />}
      {current === "groups" && <GroupsTab manage={manage} />}
    </div>
  );
}

// ───────────────────────────── Miembros ─────────────────────────────

function MembersTab({ roles, manage }: { roles: RolesResponse | null; manage: boolean }) {
  const tt = useTeamsText();
  const { me } = useAuth();
  const { access, refresh: refreshAccess } = useAccess();
  const label = useRoleLabel();
  const [items, setItems] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  // Doble clic en "Quitar": el segundo DELETE respondía 404 y se mostraba un error aunque el miembro sí se quitó.
  const [removeBusy, setRemoveBusy] = useState(false);

  const load = () =>
    api<{ items: Member[] }>("/v1/members")
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  const changeRole = async (m: Member, v: string) => {
    setError(null);
    try {
      await api(`/v1/members/${m.userId}`, { method: "PATCH", body: toAssignment(v) });
      // El rol propio cambió: sin recargar los permisos, la pantalla seguía ofreciendo acciones que ya no tiene (403).
      if (m.userId === me?.user.id) await refreshAccess();
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const remove = async () => {
    if (!removing || removeBusy) return;
    setRemoveBusy(true);
    setError(null);
    try {
      await api(`/v1/members/${removing.userId}`, { method: "DELETE" });
      setRemoving(null);
      await load();
    } catch (e) {
      setRemoving(null);
      setError(errorText(e));
    } finally {
      setRemoveBusy(false);
    }
  };

  // Si la carga falla, se muestra el error (antes quedaba el spinner para siempre y el error nunca se veía).
  if (!items) return error ? <ErrorBox error={error} /> : <Spinner />;
  const isOwner = access?.role === "owner";
  return (
    <>
      <ErrorBox error={error} />
      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>{tt("team.name")}</th>
              <th>{tt("team.role")}</th>
              <th className="hide-sm">{tt("team.groups")}</th>
              <th className="hide-sm">{tt("team.2fa")}</th>
              {manage && <th />}
            </tr>
          </thead>
          <tbody>
            {items.map((m) => {
              const value = m.role === "custom" ? `custom:${m.roleId}` : m.role;
              const self = m.userId === me?.user.id;
              return (
                <tr key={m.userId}>
                  <td>
                    <strong>{m.name}</strong> {self && <span className="muted">({tt("team.you")})</span>}
                    <div className="muted small">{m.email}</div>
                  </td>
                  <td>
                    {manage && (isOwner || m.role !== "owner") ? (
                      <RoleSelect value={value} roles={roles} allowOwner={isOwner} onChange={(v) => changeRole(m, v)} />
                    ) : (
                      label(m.role, m.roleName)
                    )}
                  </td>
                  <td className="hide-sm">{m.groups.map((g) => g.name).join(", ") || "—"}</td>
                  <td className="hide-sm">{m.twoFactorEnabled ? "✓" : "—"}</td>
                  {manage && (
                    <td className="right">
                      {(isOwner || m.role !== "owner") && (
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => setRemoving(m)}>
                          {tt("team.remove")}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {removing && (
        <Modal
          title={tt("team.remove")}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoving(null)}>
                {tt("common.cancel")}
              </button>
              <button type="button" className="btn btn-danger" disabled={removeBusy} onClick={remove}>
                {tt("team.remove")}
              </button>
            </>
          }
        >
          <p>{tt("team.removeConfirm", { name: removing.name })}</p>
        </Modal>
      )}
    </>
  );
}

// ───────────────────────────── Invitaciones ─────────────────────────────

function InvitationsTab({ roles }: { roles: RolesResponse | null }) {
  const tt = useTeamsText();
  const { locale } = useI18n();
  const { access } = useAccess();
  const label = useRoleLabel();
  const [items, setItems] = useState<Invitation[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [sent, setSent] = useState<CreateInvitationResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Como en las API keys: no se puede invitar con permisos que uno no tiene (403). Con "Miembro" preelegido, alguien con
  // un rol personalizado que incluye members:manage pero no envelopes:create no podía invitar sin cambiar antes el rol.
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || !access || !roles) return;
    defaulted.current = true;
    if (access.role === "owner") return;
    const options = [
      ...roles.builtin.filter((b) => b.role !== "owner").map((b) => ({ value: b.role as string, permissions: b.permissions })),
      ...roles.items.map((r) => ({ value: `custom:${r.id}`, permissions: r.permissions })),
    ];
    const grantable = (o: { permissions: Permission[] }) => o.permissions.every((p) => access.permissions.includes(p));
    if (options.some((o) => o.value === "member" && grantable(o))) return;
    const first = options.find(grantable);
    if (first) setRole((cur) => (cur === "member" ? first.value : cur));
  }, [access, roles]);

  const load = () =>
    api<{ items: Invitation[] }>("/v1/invitations")
      .then((r) => setItems(r.items))
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
  }, []);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<CreateInvitationResponse>("/v1/invitations", { method: "POST", body: { email, locale, ...toAssignment(role) } });
      setSent(r);
      setEmail("");
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
      await api(`/v1/invitations/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(errorText(e));
      // Aceptada o revocada en otra pestaña (404): la lista se actualiza en lugar de dejar la fila "pendiente" con un
      // botón que vuelve a fallar.
      void load();
    }
  };

  return (
    <div className="stack">
      <form onSubmit={invite} className="card pad row-wrap">
        <label className="field grow">
          <span>{tt("team.email")}</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@empresa.com" />
        </label>
        <label className="field">
          <span>{tt("team.role")}</span>
          <RoleSelect value={role} onChange={setRole} roles={roles} allowOwner={access?.role === "owner"} />
        </label>
        <button className="btn btn-primary" disabled={busy || !email.trim()}>
          {tt("team.invite")}
        </button>
      </form>
      {sent && (
        <div className="alert alert-success stack">
          <span>{tt("team.inviteSent", { email: sent.invitation.email })}</span>
          <code className="secret">{sent.acceptUrl}</code>
        </div>
      )}
      <ErrorBox error={error} />
      {!items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <div className="empty">{tt("team.noInvitations")}</div>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{tt("team.email")}</th>
                <th>{tt("team.role")}</th>
                <th className="hide-sm">{tt("team.invitedBy")}</th>
                <th className="hide-sm">{tt("team.expires")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className={i.status === "pending" ? "" : "muted"}>
                  <td>{i.email}</td>
                  <td>{label(i.role, i.roleName)}</td>
                  <td className="hide-sm">{i.invitedBy ?? "—"}</td>
                  <td className="hide-sm">{formatDateTime(i.expiresAt, locale)}</td>
                  <td className="right">
                    {i.status === "pending" ? (
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => revoke(i.id)}>
                        {tt("team.revoke")}
                      </button>
                    ) : (
                      <span className="badge">{tt(`team.status.${i.status}` as const)}</span>
                    )}
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

// ───────────────────────────── Roles ─────────────────────────────

function PermissionChecklist({ value, onChange }: { value: Permission[]; onChange: (v: Permission[]) => void }) {
  const tt = useTeamsText();
  return (
    <fieldset className="field">
      <legend>{tt("roles.permissions")}</legend>
      <div className="stack" style={{ gap: "0.4rem" }}>
        {PERMISSIONS.map((p) => (
          <label key={p} className="row-wrap" style={{ fontWeight: 450 }}>
            <input
              type="checkbox"
              checked={value.includes(p)}
              onChange={(e) => onChange(e.target.checked ? [...value, p] : value.filter((x) => x !== p))}
            />
            <span>{tt(`perm.${p}` as const)}</span>
            <code className="muted small">{p}</code>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function RolesTab({ roles, reload }: { roles: RolesResponse | null; reload: () => Promise<unknown> }) {
  const tt = useTeamsText();
  const label = useRoleLabel();
  const { access, refresh: refreshAccess } = useAccess();
  // Con un rol personalizado propio, editarlo o borrarlo cambia los permisos de la sesión: sin recargarlos, la pantalla
  // seguía ofreciendo acciones que ya no tiene (403), igual que al cambiar el rol propio en Miembros.
  const refreshOwn = async () => {
    if (access?.role === "custom") await refreshAccess();
  };
  const [editing, setEditingRaw] = useState<Partial<CustomRole> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Al abrir o cerrar el modal se limpia el error del intento anterior (si no, aparecía en el modal siguiente).
  const setEditing = (v: Partial<CustomRole> | null) => {
    if ((v === null) !== (editing === null)) setError(null);
    setEditingRaw(v);
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: editing.name, description: editing.description ?? null, permissions: editing.permissions ?? [] };
      if (editing.id) await api(`/v1/roles/${editing.id}`, { method: "PATCH", body });
      else await api("/v1/roles", { method: "POST", body });
      setEditing(null);
      await reload();
      if (editing.id) await refreshOwn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirmAction()) return;
    setError(null);
    try {
      await api(`/v1/roles/${id}`, { method: "DELETE" });
      await reload();
      await refreshOwn();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!roles) return <Spinner />;
  return (
    <div className="stack">
      <ErrorBox error={editing ? null : error} />
      <div className="card pad stack">
        <h2>{tt("roles.builtin")}</h2>
        {roles.builtin.map((b) => (
          <div key={b.role}>
            <strong>{label(b.role)}</strong>
            <div className="muted small">{b.permissions.map((p) => tt(`perm.${p}` as const)).join(" · ")}</div>
          </div>
        ))}
      </div>
      <div className="row-between">
        <h2>{tt("roles.custom")}</h2>
        <button type="button" className="btn btn-primary" onClick={() => setEditing({ name: "", permissions: [] })}>
          {tt("roles.new")}
        </button>
      </div>
      {roles.items.length === 0 ? (
        <div className="empty">{tt("roles.none")}</div>
      ) : (
        <div className="card">
          <table className="table">
            <tbody>
              {roles.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                    <div className="muted small">{r.permissions.map((p) => tt(`perm.${p}` as const)).join(" · ") || "—"}</div>
                  </td>
                  <td className="hide-sm muted">
                    {tt("roles.members")}: {r.memberCount}
                  </td>
                  <td className="right">
                    <div className="row-end">
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>
                        {tt("roles.edit")}
                      </button>
                      <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(r.id)}>
                        {tt("roles.delete")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal
          title={editing.id ? tt("roles.edit") : tt("roles.new")}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                {tt("common.cancel")}
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || !editing.name?.trim()} onClick={save}>
                {tt("common.save")}
              </button>
            </>
          }
        >
          <div className="stack">
            <label className="field">
              <span>{tt("team.name")}</span>
              <input value={editing.name ?? ""} maxLength={80} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label className="field">
              <span>{tt("roles.description")}</span>
              <input value={editing.description ?? ""} maxLength={300} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <PermissionChecklist value={editing.permissions ?? []} onChange={(p) => setEditing({ ...editing, permissions: p })} />
            <ErrorBox error={error} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ───────────────────────────── Grupos ─────────────────────────────

function GroupsTab({ manage }: { manage: boolean }) {
  const tt = useTeamsText();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  type Draft = { id?: string; name: string; description: string; memberIds: string[] };
  const [editing, setEditingRaw] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setEditing = (v: Draft | null) => {
    if ((v === null) !== (editing === null)) setError(null);
    setEditingRaw(v);
  };

  const load = async () => {
    try {
      const [g, m] = await Promise.all([api<{ items: Group[] }>("/v1/groups"), api<{ items: Member[] }>("/v1/members")]);
      setGroups(g.items);
      setMembers(m.items);
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const body = { name: editing.name, description: editing.description || null, memberIds: editing.memberIds };
      if (editing.id) await api(`/v1/groups/${editing.id}`, { method: "PATCH", body });
      else await api("/v1/groups", { method: "POST", body });
      setEditing(null);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirmAction()) return;
    setError(null);
    try {
      await api(`/v1/groups/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  if (!groups) return error ? <ErrorBox error={error} /> : <Spinner />;
  return (
    <div className="stack">
      {manage && (
        <div className="row-end">
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ name: "", description: "", memberIds: [] })}>
            {tt("groups.new")}
          </button>
        </div>
      )}
      <ErrorBox error={editing ? null : error} />
      {groups.length === 0 ? (
        <div className="empty">{tt("groups.none")}</div>
      ) : (
        <div className="card">
          <table className="table">
            <tbody>
              {groups.map((g) => (
                <tr key={g.id}>
                  <td>
                    <strong>{g.name}</strong>
                    {g.description && <div className="muted small">{g.description}</div>}
                    <div className="muted small">{g.members.map((m) => m.name).join(", ") || "—"}</div>
                  </td>
                  {manage && (
                    <td className="right">
                      <div className="row-end">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setEditing({ id: g.id, name: g.name, description: g.description ?? "", memberIds: g.members.map((m) => m.userId) })}
                        >
                          {tt("groups.edit")}
                        </button>
                        <button type="button" className="btn btn-danger btn-sm" onClick={() => remove(g.id)}>
                          {tt("groups.delete")}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <Modal
          title={editing.id ? tt("groups.edit") : tt("groups.new")}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setEditing(null)}>
                {tt("common.cancel")}
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || !editing.name.trim()} onClick={save}>
                {tt("common.save")}
              </button>
            </>
          }
        >
          <div className="stack">
            <label className="field">
              <span>{tt("team.name")}</span>
              <input value={editing.name} maxLength={100} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </label>
            <label className="field">
              <span>{tt("roles.description")}</span>
              <input value={editing.description} maxLength={300} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <fieldset className="field">
              <legend>{tt("groups.members")}</legend>
              <div className="stack" style={{ gap: "0.4rem", maxHeight: 260, overflow: "auto" }}>
                {members.map((m) => (
                  <label key={m.userId} className="row-wrap" style={{ fontWeight: 450 }}>
                    <input
                      type="checkbox"
                      checked={editing.memberIds.includes(m.userId)}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          memberIds: e.target.checked ? [...editing.memberIds, m.userId] : editing.memberIds.filter((x) => x !== m.userId),
                        })
                      }
                    />
                    <span>{m.name}</span>
                    <span className="muted small">{m.email}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <ErrorBox error={error} />
          </div>
        </Modal>
      )}
    </div>
  );
}
