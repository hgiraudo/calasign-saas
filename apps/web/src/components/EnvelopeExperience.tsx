// Acciones del detalle del sobre: firma en persona, corrección en vuelo y reenvío de copias.
import { useMemo, useState } from "react";
import type { CorrectEnvelopeInput, EnvelopeDetail, InPersonSessionResponse, Recipient, RecipientContactPatch } from "@calasign/shared";
import { api, errorText, uuid } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useExpText } from "../lib/i18n-experience";
import { ErrorBox, Modal, OrderInput } from "./ui";

/** Abre la ceremonia de firma en persona en este mismo navegador (el dispositivo del anfitrión). */
export function InPersonButton({ envelopeId, recipient, onError }: { envelopeId: string; recipient: Recipient; onError: (e: string) => void }) {
  const x = useExpText();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api<InPersonSessionResponse>(`/v1/envelopes/${envelopeId}/recipients/${recipient.id}/in-person`, { method: "POST", body: {} });
      window.location.assign(r.url);
    } catch (e) {
      onError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn btn-accent btn-sm" disabled={busy} onClick={start}>
      🤝 {busy ? x("inperson.starting") : x("inperson.start")}
    </button>
  );
}

export function ResendCopyButton({
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
  const x = useExpText();
  const [busy, setBusy] = useState(false);
  const resend = async () => {
    setBusy(true);
    try {
      await api(`/v1/envelopes/${envelopeId}/recipients/${recipient.id}/resend-copy`, { method: "POST" });
      onDone(x("copy.resent", { name: recipient.name }));
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={resend}>
      ✉ {x("copy.resend")}
    </button>
  );
}

interface ContactDraft {
  id: string;
  name: string;
  email: string;
  phone: string;
  remove: boolean;
  status: Recipient["status"];
  viewed: boolean;
  original: Recipient;
}

interface NewDraft {
  id: string;
  name: string;
  email: string;
  role: "signer" | "cc";
  routingOrder: number;
}

const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Corrección del sobre en curso: mensaje, vencimiento, contactos, altas y bajas. */
export function CorrectionModal({ detail, onClose, onDone }: { detail: EnvelopeDetail; onClose: () => void; onDone: (d: EnvelopeDetail) => void }) {
  const x = useExpText();
  const { t } = useI18n();
  const env = detail.envelope;
  const [message, setMessage] = useState(env.message ?? "");
  const [expires, setExpires] = useState(toLocalInput(env.expiresAt));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = useMemo(
    () => detail.recipients.filter((r) => !["delegated", "reassigned"].includes(r.status)),
    [detail.recipients],
  );
  const [contacts, setContacts] = useState<ContactDraft[]>(() =>
    editable.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email ?? "",
      phone: r.phone ?? "",
      remove: false,
      status: r.status,
      viewed: Boolean(r.viewedAt),
      original: r,
    })),
  );
  const [added, setAdded] = useState<NewDraft[]>([]);
  const maxOrder = detail.recipients.reduce((m, r) => Math.max(m, r.routingOrder), 1);

  const setContact = (i: number, p: Partial<ContactDraft>) => setContacts((cs) => cs.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const setNew = (i: number, p: Partial<NewDraft>) => setAdded((as) => as.map((a, j) => (j === i ? { ...a, ...p } : a)));

  const save = async () => {
    // Una fila nueva a medio completar se descartaba sin aviso: el remitente creía haber sumado al destinatario.
    if (added.some((a) => Boolean(a.name.trim()) !== Boolean(a.email.trim()))) {
      setError(x("correct.newIncomplete"));
      return;
    }
    // La API no permite quitar el vencimiento (solo cambiarlo por una fecha futura): borrar la fecha se ignoraba sin aviso
    // y la corrección se guardaba como si el sobre hubiera quedado sin vencimiento.
    if (!expires && env.expiresAt) {
      setError(x("correct.expiryRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    const body: CorrectEnvelopeInput = { reason: reason.trim() || null };
    if ((env.message ?? "") !== message) body.message = message.trim() || null;
    if (expires && toLocalInput(env.expiresAt) !== expires) body.expiresAt = new Date(expires).toISOString();
    const updates: RecipientContactPatch[] = [];
    for (const c of contacts) {
      if (c.remove) continue;
      const o = c.original;
      const p: RecipientContactPatch = { id: c.id };
      if (c.name.trim() !== o.name) p.name = c.name.trim();
      if (c.email.trim() !== (o.email ?? "")) p.email = c.email.trim() || null;
      if (c.phone.trim() !== (o.phone ?? "")) p.phone = c.phone.trim() || null;
      if (Object.keys(p).length > 1) updates.push(p);
    }
    if (updates.length) body.updateRecipients = updates;
    const removeIds = contacts.filter((c) => c.remove).map((c) => c.id);
    if (removeIds.length) body.removeRecipientIds = removeIds;
    const newOnes = added.filter((a) => a.name.trim() && a.email.trim());
    if (newOnes.length) {
      body.addRecipients = newOnes.map((a) => ({
        id: a.id,
        name: a.name.trim(),
        email: a.email.trim(),
        role: a.role,
        routingOrder: a.routingOrder,
        channels: ["email"],
      }));
      // Un firmante nuevo recibe un campo de firma al final del último documento.
      const lastDoc = [...detail.documents].sort((a, b) => a.position - b.position).at(-1);
      if (lastDoc)
        body.addFields = newOnes
          .filter((a) => a.role === "signer")
          .map((a, i) => ({
            documentId: lastDoc.id,
            recipientId: a.id,
            type: "signature" as const,
            page: lastDoc.pageCount - 1,
            x: 0.55,
            y: Math.max(0.05, 0.86 - i * 0.09),
            width: 0.35,
            height: 0.07,
          }));
    }
    try {
      const d = await api<EnvelopeDetail>(`/v1/envelopes/${env.id}/corrections`, { method: "POST", body });
      onDone(d);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={x("correct.title")}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
            {x("correct.save")}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="muted small">{x("correct.intro")}</p>
        <label className="field">
          <span>{x("correct.message")}</span>
          <textarea rows={2} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <label className="field">
          <span>{x("correct.expires")}</span>
          <input type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
        <fieldset className="field correction-recipients">
          <legend>{x("correct.recipients")}</legend>
          {contacts.map((c, i) => {
            const locked = ["signed", "declined", "completed"].includes(c.status);
            return (
              <div key={c.id} className={`correction-row ${c.remove ? "removing" : ""}`}>
                <input
                  aria-label={`${t("edit.name")} — ${c.original.name}`}
                  value={c.name}
                  disabled={locked || c.remove}
                  maxLength={200}
                  onChange={(e) => setContact(i, { name: e.target.value })}
                />
                <input
                  aria-label={`${t("auth.email")} — ${c.original.name}`}
                  type="email"
                  value={c.email}
                  disabled={locked || c.remove}
                  onChange={(e) => setContact(i, { email: e.target.value })}
                />
                <input
                  aria-label={`${t("edit.phone")} — ${c.original.name}`}
                  type="tel"
                  value={c.phone}
                  placeholder="+5730012345678"
                  disabled={locked || c.remove}
                  onChange={(e) => setContact(i, { phone: e.target.value.replace(/[^\d+]/g, "") })}
                />
                {locked ? (
                  <span className="muted small">{x("correct.locked")}</span>
                ) : c.viewed ? (
                  <span className="muted small">{x("correct.viewed")}</span>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setContact(i, { remove: !c.remove })}>
                    {c.remove ? x("correct.undoRemove") : x("correct.remove")}
                  </button>
                )}
              </div>
            );
          })}
        </fieldset>
        {added.map((a, i) => (
          <div key={a.id} className="correction-row correction-new">
            <input aria-label={x("correct.newName")} placeholder={x("correct.newName")} value={a.name} onChange={(e) => setNew(i, { name: e.target.value })} />
            <input
              aria-label={x("correct.newEmail")}
              placeholder={x("correct.newEmail")}
              type="email"
              value={a.email}
              onChange={(e) => setNew(i, { email: e.target.value })}
            />
            <select aria-label={x("correct.newRole")} value={a.role} onChange={(e) => setNew(i, { role: e.target.value as "signer" | "cc" })}>
              <option value="signer">{t("edit.role.signer")}</option>
              <option value="cc">{t("edit.role.cc")}</option>
            </select>
            <OrderInput aria-label={x("correct.newOrder")} value={a.routingOrder} onChange={(n) => setNew(i, { routingOrder: n })} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdded((as) => as.filter((_, j) => j !== i))}>
              {t("common.delete")}
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setAdded((as) => [...as, { id: uuid(), name: "", email: "", role: "signer", routingOrder: maxOrder }])}
          >
            + {x("correct.add")}
          </button>
          <p className="muted small">{x("correct.addHint")}</p>
        </div>
        <label className="field">
          <span>{x("correct.reason")}</span>
          <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
        </label>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}
