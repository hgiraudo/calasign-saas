// Compartir un sobre o una plantilla con grupos de la organización.
import { useEffect, useState } from "react";
import type { Group, SharesResponse } from "@calasign/shared";
import { api, errorText } from "../lib/api";
import { useTeamsText } from "../lib/i18n-teams";
import { ErrorBox, Modal } from "./ui";

/** `onSaved`: tras guardar (la visibilidad de una plantilla cambia su updatedAt; el editor lo vuelve a leer). */
export function ShareControl({ kind, id, canEdit, onSaved }: { kind: "envelopes" | "templates"; id: string; canEdit: boolean; onSaved?: () => void }) {
  const tt = useTeamsText();
  const [shares, setShares] = useState<SharesResponse | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<"organization" | "restricted">("organization");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<SharesResponse>(`/v1/${kind}/${id}/shares`)
      .then(setShares)
      .catch(() => setShares(null));
  }, [kind, id]);

  const openModal = async () => {
    setError(null);
    setSelected(shares?.groups.map((g) => g.id) ?? []);
    setVisibility(shares?.visibility ?? "organization");
    setOpen(true);
    try {
      setGroups((await api<{ items: Group[] }>("/v1/groups")).items);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = kind === "templates" ? { groupIds: selected, visibility } : { groupIds: selected };
      setShares(await api<SharesResponse>(`/v1/${kind}/${id}/shares`, { method: "PUT", body }));
      setOpen(false);
      onSaved?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!shares) return null;
  const label =
    kind === "templates" && shares.visibility === "organization"
      ? tt("share.visibility.organization")
      : shares.groups.map((g) => g.name).join(", ") || tt("share.none");
  return (
    <div className="row-wrap small">
      <span className="muted">{tt("share.title")}:</span>
      <span>{label}</span>
      {canEdit && (
        <button type="button" className="btn btn-sm" onClick={openModal}>
          {tt("share.edit")}
        </button>
      )}
      {open && (
        <Modal
          title={tt("share.title")}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                {tt("common.cancel")}
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
                {tt("common.save")}
              </button>
            </>
          }
        >
          <div className="stack">
            <p className="muted">{kind === "templates" ? tt("share.introTemplate") : tt("share.intro")}</p>
            {kind === "templates" && (
              <div className="stack" style={{ gap: "0.4rem" }}>
                {(["organization", "restricted"] as const).map((v) => (
                  <label key={v} className="row-wrap" style={{ fontWeight: 450 }}>
                    <input type="radio" name="visibility" checked={visibility === v} onChange={() => setVisibility(v)} />
                    <span>{tt(`share.visibility.${v}` as const)}</span>
                  </label>
                ))}
              </div>
            )}
            {!groups ? null : groups.length === 0 ? (
              <p className="muted">{tt("share.noGroups")}</p>
            ) : (
              <div className="stack" style={{ gap: "0.4rem" }}>
                {groups.map((g) => (
                  <label key={g.id} className="row-wrap" style={{ fontWeight: 450 }}>
                    <input
                      type="checkbox"
                      checked={selected.includes(g.id)}
                      onChange={(e) => setSelected(e.target.checked ? [...selected, g.id] : selected.filter((x) => x !== g.id))}
                    />
                    <span>{g.name}</span>
                    <span className="muted small">{g.members.length}</span>
                  </label>
                ))}
              </div>
            )}
            <ErrorBox error={error} />
          </div>
        </Modal>
      )}
    </div>
  );
}
