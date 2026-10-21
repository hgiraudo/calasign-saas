// Delegación (la hace el firmante), reasignación (la hace el remitente) y configuración del sobre
// (recordatorios automáticos, aviso de vencimiento, delegación permitida).
import type { FastifyInstance } from "fastify";
import { DelegateInput, ReassignInput } from "@calasign/shared";
import type { Db } from "../infra/db";
import { appendEvent, type Actor } from "../infra/evidence";
import { AppError, conflict, forbidden, notFound } from "../lib/errors";
import { encrypt, maskDestination, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { authenticate, type Services } from "./context";
import { activateRecipient, lockEnvelope, pastExpiry } from "./envelopes";
import { DISCARD_CHECKOUT_SET } from "./billing/payments";
import { loadDetail } from "./mappers";
import { isEmbeddedSigner, isUnverifiedSelfRegistered } from "./otp";
import { assertLinkCurrent, recipientActor, resolveToken } from "./signing";
import { inheritIdentityRequirement, maskDocNumber } from "./identity/kyc";
import { deleteBlobsQuietly, discardRecipientAttachments } from "./file-cleanup";
import { downgradeIdMatchSql, explicitRequirements, normalizeRequirements } from "./certsign-requirements";

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
  idDocumentNumber?: string | null;
  idDocumentType?: string | null;
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
  // Cada delegación suma un destinatario, una invitación y una línea en el certificado: con tope por sobre.
  const reps = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM recipients WHERE envelope_id = $1 AND replaces IS NOT NULL`, [e.id]);
  if ((reps?.n ?? 0) >= 20) throw conflict("too_many_replacements", "Este sobre ya tuvo demasiadas delegaciones o reasignaciones");
  const channels = c.channels?.length ? c.channels : [...(c.email ? (["email"] as const) : []), ...(!c.email && c.phone ? (["whatsapp"] as const) : [])];
  if (channels.includes("email") && !c.email) throw conflict("invalid_channels", "El canal email requiere email");
  if (channels.includes("whatsapp") && !c.phone) throw conflict("invalid_channels", "El canal WhatsApp requiere teléfono");
  // El reemplazo hereda la verificación que pidió el remitente: no se baja a "solo link" en silencio.
  // En persona: el reemplazo firma con el mismo anfitrión (sin anfitrión nadie podría abrirlo y no recibe invitación).
  // Si el anfitrión ya no es miembro de la organización (no puede abrir la sesión en persona), el reemplazo firma por link.
  const hostId = old.auth_method === "in_person" ? (old.in_person_host_user_id ?? null) : null;
  const host =
    hostId && (await db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [e.tenant_id, hostId])) ? hostId : null;
  const auth = old.auth_method === "in_person" && !host ? "link" : (old.auth_method ?? "link");
  if (auth === "otp_email" && !c.email) throw conflict("otp_destination_required", "Este firmante se verifica con un código por correo: indicá el correo de la persona");
  if ((auth === "otp_sms" || auth === "otp_whatsapp") && !c.phone)
    throw conflict("otp_destination_required", "Este firmante se verifica con un código por SMS/WhatsApp: indicá el teléfono de la persona");

  // Firma con certificado que tiene que corresponder al documento: el firmante no puede delegar en alguien sin
  // documento, porque el reemplazo bajaría el control y cualquiera firmaría con cualquier certificado válido. Si indica
  // el documento de la persona nueva, el control se mantiene contra ese número. La reasignación la decide el remitente:
  // ahí sí se baja (con la marca para la evidencia) si no trae documento.
  const idDocumentNumber = c.idDocumentNumber?.trim() || null;
  if (
    kind === "delegated" &&
    !idDocumentNumber &&
    old.signature_type === "certificate" &&
    normalizeRequirements(old.certificate_requirements, String(old.id_document_number ?? "").trim() !== "").matchIdDocument
  )
    throw conflict(
      "delegation_requires_id_match",
      "Este firmante tiene que firmar con un certificado que corresponda a su documento de identidad: para delegar, indicá el número de documento de la persona",
    );

  const id = uuidv7();
  const token = randomToken();
  await db.query(
    `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, phone, locale, channels, auth_method, replaces,
       access_token_hash, access_token_enc, in_person_host_user_id, id_document_number, id_document_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
      host,
      idDocumentNumber,
      // El tipo lo indica quien delega o reasigna (la persona nueva puede tener otro documento que la original): no se
      // hereda. Sin indicarlo, queda sin tipo (el control del certificado compara el número).
      idDocumentNumber ? (c.idDocumentType ?? null) : null,
    ],
  );
  // Los adjuntos que subió el anterior no pasan al reemplazo; el llamador borra los archivos después de confirmar.
  const discardedKeys = await discardRecipientAttachments(db, old.id);
  await db.query(`UPDATE fields SET recipient_id = $2 WHERE recipient_id = $1`, [old.id, id]);
  // El cobro pendiente pasa al reemplazo (si no, el sobre queda trabado o se firma sin pagar).
  // El checkout abierto se armó con el correo y el link (ya revocado) del anterior: se descarta y el reemplazo arma uno
  // nuevo al pagar (si no, volvía a un link muerto y el pago figuraba a nombre de quien no pagó).
  await db.query(
    `UPDATE envelope_payments SET recipient_id = $2, ${DISCARD_CHECKOUT_SET}, updated_at = now() WHERE recipient_id = $1 AND status NOT IN ('paid','refunded')`,
    [old.id, id],
  );
  await inheritIdentityRequirement(db, old, id);
  // El reemplazo también firma con certificado si el original debía hacerlo. Si no trae número de documento (solo en una
  // reasignación: la delegación lo exige arriba) y se pedía que el certificado corresponda al documento, el control se
  // baja (con la marca para la evidencia) en vez de trabar un sobre en curso.
  // Si el documento lo indicó quien delegó (no el remitente), queda la procedencia (idDocumentSource: "delegator") para
  // la evidencia y el certificado de firma.
  const inherited = explicitRequirements(old.certificate_requirements);
  const { idDocumentSource: _prevSource, ...inheritedReqs } = inherited ?? {};
  const delegatorDoc = kind === "delegated" && idDocumentNumber !== null;
  const reqs = inherited || delegatorDoc ? { ...inheritedReqs, ...(delegatorDoc ? { idDocumentSource: "delegator" } : {}) } : null;
  await db.query(`UPDATE recipients SET signature_type = $2, certificate_requirements = ${downgradeIdMatchSql("$3::jsonb", "id_document_number")} WHERE id = $1`, [
    id,
    old.signature_type ?? "electronic",
    reqs ? JSON.stringify(reqs) : null,
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
      ...(idDocumentNumber
        ? { idDocument: maskDocNumber(idDocumentNumber), idDocumentSource: kind === "delegated" ? "delegator" : "sender" }
        : {}),
    },
  });
  // Si el anterior ya estaba invitado, el nuevo recibe la invitación ahora; si no, cuando llegue su turno.
  if (["sent", "viewed"].includes(old.status)) {
    const fresh = await db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [id]);
    await activateRecipient(db, e.tenant_id, e.id, fresh);
  }
  return { id, discardedKeys };
}

export async function participantRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);

  app.post<{ Params: { id: string; recipientId: string } }>(
    "/v1/envelopes/:id/recipients/:recipientId/reassign",
    { preHandler: auth },
    async (req) => {
      const a = req.auth!;
      const input = ReassignInput.parse(req.body);
      const { discardedKeys } = await s.db.tx(async (t) => {
        const e = await lockEnvelope(t, a.tenantId, req.params.id);
        if (e.status !== "sent" || pastExpiry(e)) throw conflict("not_in_progress", "Solo se reasigna en un sobre en curso");
        const old = await t.one<any>(`SELECT * FROM recipients WHERE id = $1 AND envelope_id = $2`, [req.params.recipientId, e.id]);
        if (!old) throw notFound("Destinatario");
        return replaceRecipient(t, e, old, input, "reassigned", a.actor);
      });
      await deleteBlobsQuietly(s.blobs, discardedKeys);
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
      let discardedKeys: string[] = [];
      await s.db.tx(async (t) => {
        const e = await lockEnvelope(t, e0.tenant_id, e0.id);
        // 410, como el resto de la superficie del firmante (firmar, OTP, adjuntos, identidad).
        if (e.status !== "sent" || pastExpiry(e)) throw new AppError(410, "envelope_closed", "El sobre ya no está disponible");
        if (!(e.allow_delegation ?? true)) throw forbidden("El remitente no permite delegar este sobre");
        const old = await t.one<any>(`SELECT * FROM recipients WHERE id = $1`, [r0.id]);
        assertLinkCurrent(old, r0);
        // Quien se registró solo en un formulario web (correo sin validar) no recibe correos: tampoco puede usar la
        // delegación para que la plataforma le escriba a un tercero.
        if (isUnverifiedSelfRegistered(old)) throw forbidden("Para delegar, validá primero tu correo");
        if (await isEmbeddedSigner(t, old)) throw forbidden("Un firmante embebido no puede delegar: lo decide la aplicación que lo integra");
        if (old.email && input.email && old.email.toLowerCase() === input.email.toLowerCase())
          throw conflict("same_person", "No podés delegar en vos mismo");
        ({ discardedKeys } = await replaceRecipient(t, e, old, input, "delegated", recipientActor(req, old)));
        newName = input.name;
      });
      await deleteBlobsQuietly(s.blobs, discardedKeys);
      return { delegated: true, to: newName };
    },
  );
}
