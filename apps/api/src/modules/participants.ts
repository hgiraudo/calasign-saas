// Delegación (la hace el firmante), reasignación (la hace el remitente) y configuración del sobre
// (recordatorios automáticos, aviso de vencimiento, delegación permitida).
import type { FastifyInstance } from "fastify";
import { DelegateInput, ReassignInput } from "@calasign/shared";
import type { Db } from "../infra/db";
import { appendEvent, type Actor } from "../infra/evidence";
import { conflict, forbidden, notFound } from "../lib/errors";
import { encrypt, maskDestination, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { authenticate, type Services } from "./context";
import { activateRecipient, lockEnvelope } from "./envelopes";
import { loadDetail } from "./mappers";
import { recipientActor, resolveToken } from "./signing";
import { inheritIdentityRequirement } from "./identity/kyc";

/** Aplica los campos opcionales de recordatorios/delegación de Create/UpdateEnvelopeInput (solo los presentes). */
export async function applyEnvelopeSettings(
  db: Db,
  envelopeId: string,
  input: { reminderEveryDays?: number | null; expiryWarningDays?: number | null; allowDelegation?: boolean },
) {
  const sets: string[] = [];
  const params: unknown[] = [envelopeId];
  const add = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.reminderEveryDays !== undefined) add("reminder_every_days", input.reminderEveryDays);
  if (input.expiryWarningDays !== undefined) add("expiry_warning_days", input.expiryWarningDays);
  if (input.allowDelegation !== undefined) add("allow_delegation", input.allowDelegation);
  if (sets.length) await db.query(`UPDATE envelopes SET ${sets.join(", ")} WHERE id = $1`, params);
}

interface NewContact {
  name: string;
  email?: string | null;
  phone?: string | null;
  channels?: ("email" | "whatsapp" | "telegram")[];
  locale?: string | null;
  reason?: string | null;
}

/**
 * Reemplaza un destinatario pendiente por otro: el nuevo hereda rol, orden y campos; el anterior queda
 * 'delegated' o 'reassigned' con su link revocado. Debe correr con el sobre bloqueado.
 */
export async function replaceRecipient(
  db: Db,
  e: any,
  old: any,
  c: NewContact,
  kind: "delegated" | "reassigned",
  actor: Actor,
) {
  if (!["signer", "approver"].includes(old.role)) throw conflict("not_replaceable", "Solo se reemplazan firmantes o aprobadores");
  if (!["created", "sent", "viewed"].includes(old.status)) throw conflict("not_replaceable", "Este destinatario ya no está pendiente");
  const channels = c.channels?.length ? c.channels : [...(c.email ? (["email"] as const) : []), ...(!c.email && c.phone ? (["whatsapp"] as const) : [])];
  if (channels.includes("email") && !c.email) throw conflict("invalid_channels", "El canal email requiere email");
  if (channels.includes("whatsapp") && !c.phone) throw conflict("invalid_channels", "El canal WhatsApp requiere teléfono");
  // El reemplazo hereda la verificación que pidió el remitente: no se baja a "solo link" en silencio.
  const auth = old.auth_method ?? "link";
  if (auth === "otp_email" && !c.email) throw conflict("otp_destination_required", "Este firmante se verifica con un código por correo: indicá el correo de la persona");
  if ((auth === "otp_sms" || auth === "otp_whatsapp") && !c.phone)
    throw conflict("otp_destination_required", "Este firmante se verifica con un código por SMS/WhatsApp: indicá el teléfono de la persona");

  const id = uuidv7();
  const token = randomToken();
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, phone, locale, channels, auth_method, replaces,
       access_token_hash, access_token_enc)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      e.tenant_id,
      e.id,
      old.role,
      old.routing_order,
      c.name,
      c.email ?? null,
      c.phone ?? null,
      c.locale ?? old.locale,
      channels,
      auth,
      old.id,
      sha256Hex(token),
      encrypt(token),
    ],
  );
  await db.query(`UPDATE fields SET recipient_id = $2 WHERE recipient_id = $1`, [old.id, id]);
  // El cobro pendiente pasa al reemplazo (si no, el sobre queda trabado o se firma sin pagar).
  await db.query(`UPDATE envelope_payments SET recipient_id = $2, updated_at = now() WHERE recipient_id = $1 AND status <> 'paid'`, [old.id, id]);
  await inheritIdentityRequirement(db, old, id);
  // El reemplazo también firma con certificado si el original debía hacerlo.
  await db.query(`UPDATE recipients SET signature_type = $2, certificate_requirements = $3 WHERE id = $1`, [
    id,
    old.signature_type ?? "electronic",
    old.certificate_requirements ? JSON.stringify(old.certificate_requirements) : null,
  ]);
  await db.query(
    `UPDATE recipients SET status = $2, replaced_by = $3, replace_reason = $4, access_token_hash = NULL, access_token_enc = NULL WHERE id = $1`,
    [old.id, kind, id, c.reason ?? null],
  );
  await db.query(`DELETE FROM signer_sessions WHERE recipient_id = $1`, [old.id]);
  await appendEvent(db, {
    tenantId: e.tenant_id,
    envelopeId: e.id,
    type: kind === "delegated" ? "recipient.delegated" : "recipient.reassigned",
    actor,
    data: {
      from: { id: old.id, name: old.name },
      to: { id, name: c.name, email: c.email ? maskDestination(c.email) : null, phone: c.phone ? maskDestination(c.phone) : null },
      reason: c.reason ?? null,
    },
  });
  // Si el anterior ya estaba invitado, el nuevo recibe la invitación ahora; si no, cuando llegue su turno.
  if (["sent", "viewed"].includes(old.status)) {
    const fresh = await db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [id]);
    await activateRecipient(db, e.tenant_id, e.id, fresh);
  }
  return id;
}

export async function participantRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  app.post<{ Params: { id: string; recipientId: string } }>(
    "/v1/envelopes/:id/recipients/:recipientId/reassign",
    { preHandler: auth },
    async (req) => {
      const a = req.auth!;
      const input = ReassignInput.parse(req.body);
      await s.db.tx(async (t) => {
        const e = await lockEnvelope(t, a.tenantId, req.params.id);
        if (e.status !== "sent") throw conflict("not_in_progress", "Solo se reasigna en un sobre en curso");
        const old = await t.one<any>(`SELECT * FROM recipients WHERE id = $1 AND envelope_id = $2`, [req.params.recipientId, e.id]);
        if (!old) throw notFound("Destinatario");
        await replaceRecipient(t, e, old, input, "reassigned", a.actor);
      });
      return loadDetail(s.db, a.tenantId, req.params.id);
    },
  );

  app.post<{ Params: { token: string } }>(
    "/v1/signing/:token/delegate",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const input = DelegateInput.parse(req.body);
      const { recipient: r0, envelope: e0 } = await resolveToken(s.db, req.params.token);
      let newName = "";
      await s.db.tx(async (t) => {
        const e = await lockEnvelope(t, e0.tenant_id, e0.id);
        if (e.status !== "sent") throw conflict("envelope_closed", "El sobre ya no está disponible");
        if (!(e.allow_delegation ?? true)) throw forbidden("El remitente no permite delegar este sobre");
        const old = await t.one<any>(`SELECT * FROM recipients WHERE id = $1`, [r0.id]);
        if (old.email && input.email && old.email.toLowerCase() === input.email.toLowerCase())
          throw conflict("same_person", "No podés delegar en vos mismo");
        await replaceRecipient(t, e, old, input, "delegated", recipientActor(req, old));
        newName = input.name;
      });
      return { delegated: true, to: newName };
    },
  );
}
