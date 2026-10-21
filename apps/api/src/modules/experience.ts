// Experiencia (Fase 4): firma en persona (modo anfitrión), correcciones en vuelo, reportes y reenvío de copias.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CorrectEnvelopeInput,
  FieldInput,
  InPersonConfirmInput,
  RecipientInput,
  type CopyQueuedResponse,
  type InPersonSessionResponse,
  type ReportsMonth,
  type ReportsSummary,
  type SigningInPerson,
} from "@calasign/shared";
import { config } from "../config";
import type { Db } from "../infra/db";
import { appendEvent } from "../infra/evidence";
import { enqueue } from "../infra/queue";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { BUMP_UPDATED_AT, decrypt, encrypt, maskDestination, randomToken, sha256Hex, uuidv7 } from "../lib/util";
import { authenticate, clientInfo, type AuthContext, type Services } from "./context";
import { hasPerm } from "./access";
import {
  activateRecipient,
  advanceRouting,
  currentSignerGroup,
  danglingFormulaProblems,
  envelopeLogicOrderProblems,
  lockEnvelope,
  newLogicOrderProblems,
  pastExpiry,
  problemsError,
  signerWithoutSignature,
  type Problem,
} from "./envelopes";
import { DISCARD_CHECKOUT_SET } from "./billing/payments";
import { checkSenderValue, insertEnvelopeField } from "./fieldvalues";
import { pruneDanglingConditions, saveFieldLogic } from "./logic";
import { csvCell } from "./agreements/common";
import { auditFromRequest } from "./audit";
import { csvBody, csvSep, localTsSql, resolveTimeZone } from "../lib/csv";
import { loadDetail } from "./mappers";
import { SIGNER_COOKIE, isUnverifiedSelfRegistered } from "./otp";
import { assertLinkCurrent, recipientActor, resolveToken } from "./signing";
import { applyIdentityFlags, maskDocNumber } from "./identity/kyc";
import { normalizeDocumentNumber } from "./identity/namematch";
import { applyCertificateFlags, missingIdDocument } from "./certsign";
import { deleteBlobsQuietly, discardRecipientAttachments } from "./file-cleanup";

const IN_PERSON_SESSION_MIN = 60;
const PENDING = ["created", "sent", "viewed"];
const IMMUTABLE = ["signed", "declined", "completed", "delegated", "reassigned"];

// ───────────────────────────── Firma en persona ─────────────────────────────

/**
 * Aplica `inPerson` de PUT /recipients (y de correcciones). Ausente = sin cambios; null = quitar.
 * Corre después del upsert, que deja auth_method = authMethod ?? "link": acá se restaura "in_person".
 */
export async function applyInPersonFlags(
  db: Db,
  envelopeId: string,
  list: { id: string; role?: string; authMethod?: string; inPerson?: { hostUserId?: string | null } | null }[],
  a: AuthContext,
) {
  for (const r of list) {
    // Sin inPerson pero con otro authMethod explícito (o como copia): se pidió dejar la firma en persona; antes el
    // anfitrión guardado volvía a poner "in_person" y el cambio se descartaba en silencio.
    const leavesInPerson = r.inPerson === undefined && (r.role === "cc" || (r.authMethod !== undefined && r.authMethod !== "in_person"));
    if (r.inPerson === null || leavesInPerson) {
      await db.query(
        `UPDATE recipients SET in_person_host_user_id = NULL, auth_method = CASE WHEN auth_method = 'in_person' THEN 'link' ELSE auth_method END
         WHERE id = $1 AND envelope_id = $2`,
        [r.id, envelopeId],
      );
      continue;
    }
    if (r.inPerson === undefined) continue;
    const host = r.inPerson.hostUserId ?? a.userId;
    if (!host) throw badRequest("host_required", "inPerson.hostUserId es obligatorio cuando se usa una API key");
    const member = await db.one(`SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2`, [a.tenantId, host]);
    if (!member) throw badRequest("invalid_host", "El anfitrión tiene que ser un usuario de la organización");
    await db.query(`UPDATE recipients SET in_person_host_user_id = $3 WHERE id = $1 AND envelope_id = $2`, [r.id, envelopeId, host]);
  }
  await db.query(`UPDATE recipients SET auth_method = 'in_person' WHERE envelope_id = $1 AND in_person_host_user_id IS NOT NULL`, [envelopeId]);
}

const IN_PERSON_LABEL: Record<string, (host: string) => string> = {
  es: (h) => `En persona, presentado por ${h} (identidad confirmada en el dispositivo del anfitrión)`,
  "pt-BR": (h) => `Presencial, apresentado por ${h} (identidade confirmada no dispositivo do anfitrião)`,
  en: (h) => `In person, presented by ${h} (identity confirmed on the host's device)`,
};

/** Sin la confirmación de identidad (p. ej. delegó o lo reasignaron antes de confirmarla): el certificado no la afirma. */
const IN_PERSON_UNCONFIRMED_LABEL: Record<string, (host: string) => string> = {
  es: (h) => `En persona, presentado por ${h}`,
  "pt-BR": (h) => `Presencial, apresentado por ${h}`,
  en: (h) => `In person, presented by ${h}`,
};

/** Etiquetas de autenticación "en persona" para el certificado, por id de destinatario. */
export async function inPersonAuthLabels(db: Db, recips: any[], locale: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(recips.map((r) => r.in_person_host_user_id).filter(Boolean))];
  if (!ids.length) return out;
  const users = new Map((await db.query<any>(`SELECT id, name, email FROM users WHERE id = ANY($1)`, [ids])).map((u) => [u.id, u]));
  const fmt = IN_PERSON_LABEL[locale] ?? IN_PERSON_LABEL.es;
  const fmtUnconfirmed = IN_PERSON_UNCONFIRMED_LABEL[locale] ?? IN_PERSON_UNCONFIRMED_LABEL.es;
  for (const r of recips) {
    if (r.auth_method !== "in_person" || !r.in_person_host_user_id) continue;
    const u = users.get(r.in_person_host_user_id);
    const host = u ? `${u.name} <${u.email}>` : "—";
    out.set(r.id, r.identity_confirmed_at ? fmt(host) : fmtUnconfirmed(host));
  }
  return out;
}

/** Datos de la sesión en persona para la página del firmante. */
export async function inPersonSessionInfo(db: Db, r: any, authed: boolean): Promise<SigningInPerson | null> {
  if (r.auth_method !== "in_person" || !r.in_person_host_user_id) return null;
  const u = await db.one<any>(`SELECT name FROM users WHERE id = $1`, [r.in_person_host_user_id]);
  return { hostName: u?.name ?? "", identityConfirmed: Boolean(r.identity_confirmed_at), active: authed };
}

// ───────────────────────────── Correcciones ─────────────────────────────

const MAX_RECIPIENTS = 50;
const MAX_FIELDS = 500;

function newToken() {
  const token = randomToken();
  return { hash: sha256Hex(token), enc: encrypt(token) };
}

function checkContact(
  c: { email?: string | null; phone?: string | null; channels: string[]; auth_method?: string; in_person?: boolean; embedded?: boolean; telegram_chat_id?: string | null },
  who: string,
) {
  if (c.in_person) return;
  // Solo Telegram sin un chat vinculado (o con uno que se desvincula al cambiar el contacto): no le llegaba nada.
  if (!c.embedded && c.channels.length && c.channels.every((x) => x === "telegram") && !c.telegram_chat_id) {
    throw badRequest("invalid_contact", `${who}: con solo Telegram no le llega el aviso (no tiene un chat vinculado): agregá email o WhatsApp`);
  }
  // Embebido: no recibe invitaciones, así que (como en RecipientInput) no necesita correo ni teléfono para sus canales.
  if (!c.embedded) {
    if (!c.email && !c.phone) throw badRequest("invalid_contact", `${who}: hace falta correo o teléfono`);
    if (c.channels.includes("email") && !c.email) throw badRequest("invalid_contact", `${who}: el canal email requiere correo`);
    if (c.channels.includes("whatsapp") && !c.phone) throw badRequest("invalid_contact", `${who}: el canal WhatsApp requiere teléfono`);
  }
  if (c.auth_method === "otp_email" && !c.email) throw badRequest("invalid_contact", `${who}: el código por correo requiere correo`);
  if ((c.auth_method === "otp_sms" || c.auth_method === "otp_whatsapp") && !c.phone)
    throw badRequest("invalid_contact", `${who}: el código por SMS/WhatsApp requiere teléfono`);
}

const masked = (v: string | null | undefined) => (v ? maskDestination(v) : null);

export async function correctEnvelope(db: Db, a: AuthContext, envelopeId: string, body: unknown) {
  const input = CorrectEnvelopeInput.parse(body);
  const e = await lockEnvelope(db, a.tenantId, envelopeId);
  if (e.status !== "sent") throw conflict("not_in_progress", "Solo se corrige un sobre enviado y en curso");
  // Vencido aunque el barrido no lo haya marcado: corregirlo (p. ej. extender el vencimiento) no lo revive.
  if (pastExpiry(e)) throw new AppError(410, "envelope_closed", "El sobre ya venció");
  const diff: Record<string, unknown> = {};
  const recips = new Map((await db.query<any>(`SELECT * FROM recipients WHERE envelope_id = $1`, [e.id])).map((r) => [r.id, r]));
  const groupBefore = await currentSignerGroup(db, e.id);
  // Problemas de orden de la lógica que el sobre ya tenía (enviado antes de la regla): una corrección solo se frena por
  // los que agrega.
  const logicBefore = await envelopeLogicOrderProblems(db, e.id);

  const requireUntouched = (r: any, what: string) => {
    if (IMMUTABLE.includes(r.status)) throw conflict("recipient_immutable", `${r.name} ya firmó o terminó su participación: no se puede modificar`);
    if (r.viewed_at || !["created", "sent"].includes(r.status))
      throw conflict("recipient_viewed", `${r.name} ya abrió el sobre: no se puede ${what}`);
  };

  // Mensaje y vencimiento.
  if (input.message !== undefined && (input.message ?? null) !== (e.message ?? null)) {
    await db.query(`UPDATE envelopes SET message = $2 WHERE id = $1`, [e.id, input.message ?? null]);
    diff.message = { from: e.message ?? null, to: input.message ?? null };
  }
  if (input.expiresAt !== undefined) {
    const exp = input.expiresAt ? new Date(input.expiresAt) : null;
    // Una fecha inválida (p. ej. un desfase horario fuera de rango) no pasa como "futura": NaN no se compara.
    if (exp && Number.isNaN(exp.getTime())) throw badRequest("invalid_expiry", "Fecha de vencimiento inválida");
    if (exp && exp <= new Date()) throw badRequest("invalid_expiry", "La fecha de vencimiento tiene que ser futura");
    await db.query(`UPDATE envelopes SET expires_at = $2, expiry_warning_sent_at = NULL WHERE id = $1`, [e.id, input.expiresAt]);
    diff.expiresAt = { from: e.expires_at ? new Date(e.expires_at).toISOString() : null, to: new Date(input.expiresAt).toISOString() };
  }

  // Quitar campos y destinatarios.
  const removedFields: string[] = [];
  for (const id of input.removeFieldIds ?? []) {
    const f = await db.one<any>(`SELECT id, recipient_id, type FROM fields WHERE id = $1 AND envelope_id = $2`, [id, e.id]);
    if (!f) throw notFound("Campo");
    requireUntouched(recips.get(f.recipient_id), "cambiar sus campos");
    await db.query(`DELETE FROM fields WHERE id = $1`, [id]);
    removedFields.push(id);
  }
  const removedRecipients: { id: string; name: string }[] = [];
  for (const id of input.removeRecipientIds ?? []) {
    const r = recips.get(id);
    if (!r) throw notFound("Destinatario");
    requireUntouched(r, "quitarlo");
    // Borrarlo eliminaría en cascada el cobro pendiente: el sobre seguiría sin cobrar.
    if (await db.one(`SELECT 1 FROM envelope_payments WHERE recipient_id = $1 AND status NOT IN ('paid','refunded')`, [id]))
      throw conflict("recipient_is_payer", `${r.name} tiene un cobro pendiente: no se puede quitar`);
    await db.query(`DELETE FROM recipients WHERE id = $1`, [id]);
    recips.delete(id);
    removedRecipients.push({ id, name: r.name });
  }
  // Una condición que cita un campo quitado dejaría oculto para siempre al campo que la tiene (p. ej. una firma
  // obligatoria) y el firmante completaría sin firmar.
  if (removedFields.length || removedRecipients.length) await pruneDanglingConditions(db, "fields", e.id);

  // Cambios de contacto: link nuevo y el anterior revocado.
  const updated: Record<string, unknown>[] = [];
  const discardedKeys: string[] = [];
  // Un mismo destinatario dos veces rotaba el link dos veces y mandaba dos invitaciones.
  const updIds = (input.updateRecipients ?? []).map((p) => p.id);
  if (new Set(updIds).size !== updIds.length) throw badRequest("duplicate_recipient", "Un destinatario aparece más de una vez en updateRecipients");
  for (const p of input.updateRecipients ?? []) {
    const r = recips.get(p.id);
    if (!r) throw notFound("Destinatario");
    if (IMMUTABLE.includes(r.status)) throw conflict("recipient_immutable", `${r.name} ya firmó o terminó su participación: no se puede modificar`);
    const next = {
      name: p.name ?? r.name,
      email: p.email !== undefined ? p.email : r.email,
      phone: p.phone !== undefined ? p.phone : r.phone,
      channels: p.channels ?? r.channels,
      locale: p.locale !== undefined ? p.locale : r.locale,
      idDocumentNumber: p.idDocumentNumber !== undefined ? p.idDocumentNumber?.trim() || null : (r.id_document_number ?? null),
    };
    const contactMoved = (next.email ?? null) !== (r.email ?? null) || (next.phone ?? null) !== (r.phone ?? null);
    checkContact(
      {
        ...next,
        auth_method: r.auth_method,
        in_person: r.auth_method === "in_person",
        embedded: Boolean(r.embedded),
        telegram_chat_id: contactMoved ? null : r.telegram_chat_id,
      },
      next.name,
    );
    const changes: Record<string, unknown> = {};
    if (next.name !== r.name) changes.name = { from: r.name, to: next.name };
    if ((next.email ?? null) !== (r.email ?? null)) changes.email = { from: masked(r.email), to: masked(next.email) };
    if ((next.phone ?? null) !== (r.phone ?? null)) changes.phone = { from: masked(r.phone), to: masked(next.phone) };
    if (JSON.stringify(next.channels) !== JSON.stringify(r.channels)) changes.channels = { from: r.channels, to: next.channels };
    if ((next.locale ?? null) !== (r.locale ?? null)) changes.locale = { from: r.locale, to: next.locale };
    // Mismo número escrito distinto ("20.123.456" / "20123456") no es un cambio.
    const idDocChanged = normalizeDocumentNumber(next.idDocumentNumber) !== normalizeDocumentNumber(r.id_document_number);
    if (idDocChanged) {
      changes.idDocumentNumber = { from: r.id_document_number ? maskDocNumber(r.id_document_number) : null, to: next.idDocumentNumber ? maskDocNumber(next.idDocumentNumber) : null };
    }
    if (!Object.keys(changes).length) continue;
    // Firma con certificado que exige corresponder al documento: no se le puede quitar el número.
    if (changes.idDocumentNumber && !next.idDocumentNumber && r.role === "signer" && r.signature_type === "certificate" && r.certificate_requirements?.matchIdDocument === true) {
      throw missingIdDocument(r.name, 400);
    }
    const contactChanged = Boolean(changes.email || changes.phone || changes.channels);
    // Otro correo o teléfono puede ser otra persona; cambiar solo los canales (p. ej. sumar WhatsApp) no.
    const destinationChanged = Boolean(changes.email || changes.phone);
    await db.query(`UPDATE recipients SET name = $2, email = $3, phone = $4, channels = $5, locale = $6, id_document_number = $7 WHERE id = $1`, [
      r.id,
      next.name,
      next.email ?? null,
      next.phone ?? null,
      next.channels,
      next.locale ?? null,
      next.idDocumentNumber ?? null,
    ]);
    // Si cambió la persona (nombre o contacto), su verificación de identidad previa ya no la representa: ni la
    // aprobada ni las fallidas. Se anulan y la verificación empieza de nuevo, con todos los intentos. Si no, el caso
    // típico (el nombre estaba mal tipeado, la verificación falló por name_mismatch hasta agotar los intentos y el
    // remitente lo corrige) dejaba al firmante sin intentos y el sobre trabado.
    // Lo mismo con otro número de documento: la verificación se contrastó con el anterior.
    if ((changes.name || destinationChanged || idDocChanged) && r.id_verification_provider) {
      const canceled = await db.query(
        `UPDATE identity_verifications SET status = 'canceled', updated_at = now() WHERE recipient_id = $1 AND status IN ('created','pending','verified','failed') RETURNING id`,
        [r.id],
      );
      if (canceled.length || (r.identity_status ?? "pending") !== "pending") {
        await db.query(`UPDATE recipients SET identity_status = 'pending', identity_verified_at = NULL, identity_failure_reason = NULL WHERE id = $1`, [r.id]);
        changes.identityReset = true;
      }
    }
    // El contacto lo cargó ahora el remitente: deja de ser el correo sin validar de un formulario web (si no, la
    // invitación al contacto corregido no saldría nunca).
    if (contactChanged && r.self_registered) await db.query(`UPDATE recipients SET self_registered = false WHERE id = $1`, [r.id]);
    // En persona: la confirmación de identidad en el dispositivo del anfitrión era para el nombre anterior; con la
    // sesión todavía abierta se completaba la firma con el nombre nuevo sin volver a confirmar.
    if (changes.name && r.auth_method === "in_person" && r.identity_confirmed_at) {
      await db.query(`UPDATE recipients SET identity_confirmed_at = NULL WHERE id = $1`, [r.id]);
      changes.identityConfirmationReset = true;
    }
    let tokenRotated = false;
    // Con solo un cambio de canales es la misma persona en los mismos destinos: el link sigue siendo suyo (no se
    // revoca, no se le cierra la sesión ni se desvincula su Telegram) y no pierde lo que ya hizo.
    if (destinationChanged && r.access_token_hash) {
      const t = newToken();
      // sent_at: el contacto nuevo recibe la invitación ahora (los recordatorios y el aviso de vencimiento cuentan desde ahí).
      await db.query(
        `UPDATE recipients SET access_token_hash = $2, access_token_enc = $3, telegram_chat_id = NULL, auto_reminders_sent = 0,
           sent_at = CASE WHEN sent_at IS NOT NULL AND auth_method <> 'in_person' AND NOT embedded THEN now() ELSE sent_at END WHERE id = $1`,
        [r.id, t.hash, t.enc],
      );
      // El checkout de un cobro pendiente se armó con el contacto y el link anteriores: se descarta.
      await db.query(`UPDATE envelope_payments SET ${DISCARD_CHECKOUT_SET}, updated_at = now() WHERE recipient_id = $1 AND status NOT IN ('paid','refunded')`, [r.id]);
      // Un código de embed sin usar emitido para el contacto anterior abriría el link nuevo: se vence.
      await db.query(`UPDATE embed_sessions SET expires_at = LEAST(expires_at, now()) WHERE recipient_id = $1 AND used_at IS NULL`, [r.id]);
      await db.query(`DELETE FROM signer_sessions WHERE recipient_id = $1`, [r.id]);
      tokenRotated = true;
      // El link nuevo va a otro contacto (quizá otra persona): el consentimiento y los adjuntos de quien tenía el
      // anterior no pasan, como al reasignar. Si no, firmaba sin aceptar el uso de medios electrónicos y el PDF final
      // anexaba, a su nombre, los archivos (p. ej. la foto de un documento) que subió el otro.
      const keys = await discardRecipientAttachments(db, r.id);
      if (keys.length) {
        discardedKeys.push(...keys);
        changes.attachmentsDiscarded = keys.length;
      }
      if (r.consented_at) {
        await db.query(`UPDATE recipients SET consented_at = NULL WHERE id = $1`, [r.id]);
        changes.consentReset = true;
      }
      // Tampoco lo que vio o validó quien tenía el link anterior: si no, el certificado decía que el contacto nuevo vio
      // el sobre antes de recibirlo (y la apertura real no quedaba registrada, porque solo se marca desde 'sent').
      if (r.viewed_at || r.status === "viewed" || r.authenticated_at) {
        await db.query(
          `UPDATE recipients SET viewed_at = NULL, authenticated_at = NULL, status = CASE WHEN status = 'viewed' THEN 'sent' ELSE status END WHERE id = $1`,
          [r.id],
        );
        changes.viewReset = true;
      }
    }
    // Contacto o canales nuevos: la invitación vuelve a salir (por los canales nuevos, con el link vigente).
    if (contactChanged && r.access_token_hash && ["sent", "viewed"].includes(r.status) && r.auth_method !== "in_person" && !r.embedded) {
      await enqueue(db, "notify", { kind: "invite", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id });
    }
    updated.push({ id: r.id, changes, tokenRotated });
  }

  // Destinatarios nuevos.
  const added: { id: string; name: string; role: string; routingOrder: number }[] = [];
  for (const [i, raw] of (input.addRecipients ?? []).entries()) {
    const r = RecipientInput.parse(raw);
    const id = r.id ?? uuidv7();
    if (recips.has(id) || (await db.one(`SELECT 1 FROM recipients WHERE id = $1`, [id]))) throw conflict("id_in_use", "Id de destinatario en uso");
    if (groupBefore.order !== null && (r.role === "signer" || r.role === "approver") && r.routingOrder < groupBefore.order)
      throw conflict("routing_passed", `Destinatario nuevo ${i + 1}: el grupo de firma ${r.routingOrder} ya terminó`);
    await db.query(
      `INSERT INTO recipients (id, tenant_id, envelope_id, role, routing_order, name, email, phone, locale, channels, telegram_chat_id,
         id_document_type, id_document_number, auth_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id,
        e.tenant_id,
        e.id,
        r.role,
        r.routingOrder,
        r.name,
        r.email ?? null,
        r.phone ?? null,
        r.locale ?? null,
        r.channels,
        r.telegramChatId ?? null,
        r.idDocumentType ?? null,
        r.idDocumentNumber ?? null,
        r.authMethod && r.authMethod !== "in_person" ? r.authMethod : "link",
      ],
    );
    if (r.embedded !== undefined) await db.query(`UPDATE recipients SET embedded = $2 WHERE id = $1`, [id, r.embedded]);
    if (r.inPerson !== undefined) await applyInPersonFlags(db, e.id, [{ id, inPerson: r.inPerson }], a);
    // Lo que pidió el remitente para esta persona (verificación de identidad, firma con certificado) también aplica acá.
    await applyIdentityFlags(db, e.id, [{ id, role: r.role, idVerification: r.idVerification }]);
    await applyCertificateFlags(db, e.id, [{ id, role: r.role, signatureType: r.signatureType, certificateRequirements: r.certificateRequirements }]);
    // Token ya (los CC lo usan al final); la invitación sale cuando llega su turno.
    const t = newToken();
    await db.query(`UPDATE recipients SET access_token_hash = $2, access_token_enc = $3 WHERE id = $1`, [id, t.hash, t.enc]);
    const row = await db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [id]);
    recips.set(id, row);
    added.push({ id, name: r.name, role: r.role, routingOrder: r.routingOrder });
  }

  // Campos nuevos.
  const addedFields: string[] = [];
  const addedLogic: Parameters<typeof saveFieldLogic>[2] = [];
  if (input.addFields?.length) {
    const docs = new Map((await db.query<any>(`SELECT id, page_count FROM documents WHERE envelope_id = $1`, [e.id])).map((d) => [d.id, d]));
    for (const [i, raw] of input.addFields.entries()) {
      const f = FieldInput.parse(raw);
      const r = recips.get(f.recipientId);
      if (!r || r.role !== "signer") throw badRequest("invalid_field", `Campo ${i + 1}: el destinatario no es firmante de este sobre`);
      requireUntouched(r, "cambiar sus campos");
      const d = docs.get(f.documentId);
      if (!d) throw badRequest("invalid_field", `Campo ${i + 1}: documento inexistente`);
      if (f.page >= d.page_count) throw badRequest("invalid_field", `Campo ${i + 1}: página fuera de rango`);
      let value: string | null;
      try {
        value = checkSenderValue({ ...f, label: f.label ?? null }, `Campo ${i + 1}`);
      } catch (err) {
        throw badRequest("invalid_field", (err as Error).message);
      }
      const id = f.id ?? uuidv7();
      await insertEnvelopeField(db, {
        id,
        tenantId: e.tenant_id,
        envelopeId: e.id,
        documentId: f.documentId,
        recipientId: f.recipientId,
        type: f.type,
        page: f.page,
        x: f.x,
        y: f.y,
        width: f.width,
        height: f.height,
        required: f.required,
        label: f.label ?? null,
        value,
        readOnly: Boolean(f.readOnly && value),
        options: f.options ?? null,
        min: f.min ?? null,
        max: f.max ?? null,
      });
      addedFields.push(id);
      addedLogic.push({ id, type: f.type, label: f.label ?? null, conditions: f.conditions ?? null, formula: f.formula ?? null });
    }
    // Condiciones y fórmulas de los campos nuevos (se validan contra todos los campos del sobre). Sin esto se
    // descartaban: un total calculado quedaba como número a completar a mano y un campo condicional, siempre visible.
    const others = await db.query<any>(`SELECT id, type, label, conditions, formula FROM fields WHERE envelope_id = $1 AND NOT (id = ANY($2::uuid[]))`, [
      e.id,
      addedFields,
    ]);
    await saveFieldLogic(db, "fields", [
      ...others.map((x) => ({ id: x.id, type: x.type, label: x.label, conditions: Array.isArray(x.conditions) && x.conditions.length ? x.conditions : null, formula: x.formula })),
      ...addedLogic,
    ]);
  }

  // Invariantes: cada firmante pendiente sigue teniendo un campo de firma; queda alguien que firme o apruebe.
  const now = await db.query<any>(`SELECT * FROM recipients WHERE envelope_id = $1`, [e.id]);
  const sigFields = await db.query<any>(`SELECT DISTINCT recipient_id FROM fields WHERE envelope_id = $1 AND type = 'signature'`, [e.id]);
  const withSig = new Set(sigFields.map((x) => x.recipient_id));
  // Como al enviar: quien firma con certificado puede no tener firma visual (su firma va en el certificado).
  const problems: Problem[] = now
    .filter((r) => r.role === "signer" && r.signature_type !== "certificate" && PENDING.includes(r.status) && !withSig.has(r.id))
    .map((r) => signerWithoutSignature(r.name));
  if (!now.some((r) => (r.role === "signer" || r.role === "approver") && !["delegated", "reassigned"].includes(r.status)))
    problems.push({ code: "no_active_signer", params: {}, message: "Tiene que quedar al menos un firmante o aprobador" });
  // Quitar un campo número que cita una fórmula dejaría el total en 0 en el PDF firmado.
  problems.push(...danglingFormulaProblems(await db.query<any>(`SELECT type, label, formula FROM fields WHERE envelope_id = $1`, [e.id])));
  // Los mismos topes que al armar el sobre (las correcciones suman de a tandas y no tenían total).
  const active = now.filter((r) => !["delegated", "reassigned"].includes(r.status)).length;
  if (active > MAX_RECIPIENTS)
    problems.push({ code: "too_many_recipients", params: { max: MAX_RECIPIENTS }, message: `El sobre admite hasta ${MAX_RECIPIENTS} destinatarios` });
  const nFields = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM fields WHERE envelope_id = $1`, [e.id]);
  if ((nFields?.n ?? 0) > MAX_FIELDS)
    problems.push({ code: "too_many_fields", params: { max: MAX_FIELDS }, message: `El sobre admite hasta ${MAX_FIELDS} campos` });
  // Solo para campos de quien todavía no completó: los de quien ya firmó ya se evaluaron y no se pueden corregir (si no,
  // un sobre en curso con esa lógica no admitía ninguna corrección).
  // Y solo si la corrección agrega campos o destinatarios: cambiar un correo o el vencimiento no se frena por lógica que
  // ya venía así.
  if (input.addFields?.length || input.addRecipients?.length) {
    const pendingIds = new Set(now.filter((r) => PENDING.includes(r.status)).map((r) => r.id));
    const all = await db.query<any>(`SELECT id, recipient_id, label, conditions, read_only, type, formula FROM fields WHERE envelope_id = $1`, [e.id]);
    const live = now.filter((r) => !["delegated", "reassigned"].includes(r.status));
    problems.push(...newLogicOrderProblems(all.map((f) => (pendingIds.has(f.recipient_id) ? f : { ...f, conditions: null })), live, logicBefore));
  }
  if (problems.length) throw problemsError("envelope_incomplete", problems);

  if (removedFields.length) diff.fieldsRemoved = removedFields;
  if (addedFields.length) diff.fieldsAdded = addedFields;
  if (removedRecipients.length) diff.recipientsRemoved = removedRecipients;
  if (added.length) diff.recipientsAdded = added;
  if (updated.length) diff.recipientsUpdated = updated;
  if (!Object.keys(diff).length) throw badRequest("no_changes", "No hay cambios para aplicar");

  await db.query(`UPDATE envelopes SET updated_at = ${BUMP_UPDATED_AT}, version = version + 1 WHERE id = $1`, [e.id]);
  await appendEvent(db, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.corrected", actor: a.actor, data: { ...diff, reason: input.reason ?? null } });

  // Ruteo: si se agregó alguien al grupo actual (o se vació), avanzar.
  const group = await currentSignerGroup(db, e.id);
  if (group.order === null) {
    await advanceRouting(db, e.tenant_id, e.id, a.actor);
  } else {
    for (const r of group.recipients) {
      if (r.status !== "created") continue;
      if (r.auth_method === "in_person" || r.embedded) await db.query(`UPDATE recipients SET status = 'sent', sent_at = now() WHERE id = $1`, [r.id]);
      else await activateRecipient(db, e.tenant_id, e.id, r);
    }
  }
  // Adjuntos descartados (ya marcados como purgados): el llamador los borra del almacenamiento después de confirmar.
  return { discardedKeys };
}

// ───────────────────────────── Reportes ─────────────────────────────

/**
 * Rango del reporte. Sin `from`: el comienzo del mes, cinco meses antes del de `to`, en la zona `tz` (el primer mes del
 * gráfico, que también va agrupado en esa zona). Calculado en UTC, al oeste de Greenwich el rango empezaba el día 1 a
 * las 00:00 UTC (la tarde del último día del mes anterior en la zona) y el gráfico sumaba un mes casi vacío al principio.
 */
async function parseRange(db: Db, q: { from?: string; to?: string }, tz: string) {
  const to = q.to ? new Date(q.to) : new Date();
  if (Number.isNaN(to.getTime())) throw badRequest("invalid_range", "Fechas inválidas (usar ISO 8601)");
  let from: Date;
  if (q.from) from = new Date(q.from);
  else {
    const r = await db.one<{ f: Date | string }>(
      `SELECT (date_trunc('month', $1::timestamptz AT TIME ZONE $2::text) - interval '5 months') AT TIME ZONE $2::text AS f`,
      [to.toISOString(), tz],
    );
    from = new Date(r!.f);
  }
  if (Number.isNaN(from.getTime())) throw badRequest("invalid_range", "Fechas inválidas (usar ISO 8601)");
  if (from > to) throw badRequest("invalid_range", "'from' es posterior a 'to'");
  if (to.getTime() - from.getTime() > 3 * 366 * 86400_000) throw badRequest("invalid_range", "El rango máximo es de 3 años");
  return { from, to };
}

/**
 * Resumen de reportes. Los meses (byMonth) son meses calendario en `tz` (zona IANA, validada; UTC por defecto): en
 * UTC, lo creado la noche del último día del mes en América caía en el mes siguiente.
 */
export async function reportsSummary(db: Db, tenantId: string, q: { from?: string; to?: string; tz?: string }): Promise<ReportsSummary> {
  const tz = (await resolveTimeZone(db, q.tz)) ?? "UTC";
  const { from, to } = await parseRange(db, q, tz);
  const p = [tenantId, from.toISOString(), to.toISOString()];
  // Cada conteo filtra por la columna de fecha que le corresponde, con su índice (tenant_id, created_at / sent_at /
  // completed_at): antes era una sola pasada por TODOS los sobres de la organización con FILTER por fecha.
  const [created, sent, done, inProgress, months, monthList, senders, notif] = await Promise.all([
    db.one<any>(`SELECT count(*)::int AS n FROM envelopes WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3`, p),
    db.one<any>(
      `SELECT count(*)::int AS sent,
         (count(*) FILTER (WHERE status = 'completed'))::int AS completed_of_sent,
         (count(*) FILTER (WHERE status = 'declined'))::int AS declined,
         (count(*) FILTER (WHERE status = 'voided'))::int AS voided,
         (count(*) FILTER (WHERE status = 'expired'))::int AS expired
       FROM envelopes WHERE tenant_id = $1 AND sent_at BETWEEN $2 AND $3`,
      p,
    ),
    db.one<any>(
      `SELECT count(*)::int AS completed, (avg(extract(epoch FROM (completed_at - sent_at))) FILTER (WHERE sent_at IS NOT NULL))::float8 AS avg_secs
       FROM envelopes WHERE tenant_id = $1 AND completed_at BETWEEN $2 AND $3`,
      p,
    ),
    // En curso ahora, sin importar el rango (índice tenant_id, status).
    db.one<any>(`SELECT count(*)::int AS n FROM envelopes WHERE tenant_id = $1 AND status IN ('sent','awaiting_certificates','finalizing')`, [tenantId]),
    db.query<any>(
      `SELECT to_char(date_trunc('month', created_at AT TIME ZONE $4::text), 'YYYY-MM') AS month, status, count(*)::int AS n
       FROM envelopes WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3 GROUP BY 1, 2`,
      [...p, tz],
    ),
    // Los meses del rango, también en la zona pedida.
    db.query<{ month: string }>(
      `SELECT to_char(m, 'YYYY-MM') AS month FROM generate_series(date_trunc('month', $1::timestamptz AT TIME ZONE $3::text),
         date_trunc('month', $2::timestamptz AT TIME ZONE $3::text), interval '1 month') AS m ORDER BY m`,
      [from.toISOString(), to.toISOString(), tz],
    ),
    db.query<any>(
      `SELECT e.created_by AS user_id, u.name, u.email, count(*)::int AS sent, (count(*) FILTER (WHERE e.status = 'completed'))::int AS completed
       FROM envelopes e LEFT JOIN users u ON u.id = e.created_by
       WHERE e.tenant_id = $1 AND e.sent_at BETWEEN $2 AND $3
       GROUP BY e.created_by, u.name, u.email ORDER BY sent DESC, completed DESC LIMIT 10`,
      p,
    ),
    db.query<any>(
      `SELECT channel, (count(*) FILTER (WHERE status IN ('sent','complained')))::int AS sent, (count(*) FILTER (WHERE status IN ('failed','bounced')))::int AS failed
       FROM notifications WHERE tenant_id = $1 AND created_at BETWEEN $2 AND $3 GROUP BY channel ORDER BY channel`,
      p,
    ),
  ]);
  const tot = {
    created: created?.n ?? 0,
    sent: sent?.sent ?? 0,
    completed: done?.completed ?? 0,
    declined: sent?.declined ?? 0,
    voided: sent?.voided ?? 0,
    expired: sent?.expired ?? 0,
    in_progress: inProgress?.n ?? 0,
    avg_secs: done?.avg_secs ?? null,
  };
  const rate = { sent: tot.sent, completed: sent?.completed_of_sent ?? 0 };
  const byMonth: ReportsMonth[] = monthList.map(({ month }) => ({
    month,
    created: 0,
    draft: 0,
    inProgress: 0,
    completed: 0,
    declined: 0,
    voided: 0,
    expired: 0,
  }));
  const idx = new Map(byMonth.map((m) => [m.month, m]));
  for (const r of months) {
    const m = idx.get(r.month);
    if (!m) continue;
    m.created += r.n;
    if (r.status === "draft") m.draft += r.n;
    else if (r.status === "sent" || r.status === "awaiting_certificates" || r.status === "finalizing") m.inProgress += r.n;
    else if (r.status in m) (m as unknown as Record<string, number>)[r.status] += r.n;
  }
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    timeZone: tz,
    totals: {
      created: tot.created,
      sent: tot.sent,
      completed: tot.completed,
      declined: tot.declined,
      voided: tot.voided,
      expired: tot.expired,
      inProgress: tot.in_progress,
      completionRate: rate.sent ? Math.round((rate.completed / rate.sent) * 1000) / 1000 : null,
      avgHoursToComplete: tot.avg_secs == null ? null : Math.round((Number(tot.avg_secs) / 3600) * 10) / 10,
    },
    byMonth,
    topSenders: senders.map((s) => ({
      userId: s.user_id,
      name: s.name ?? "API",
      email: s.email ?? null,
      sent: s.sent,
      completed: s.completed,
    })),
    notifications: notif.map((n) => ({ channel: n.channel, sent: n.sent, failed: n.failed })),
  };
}

/** Celda CSV: comillas, y prefijo ' contra inyección de fórmulas en planillas (la misma que el repositorio y el envío masivo). */
export { csvCell };

/** Máximo de filas del CSV de sobres (se pide una más para saber si se cortó). */
export const ENVELOPES_CSV_MAX = 50_000;

/**
 * CSV de sobres del rango. `sep`: "," o ";" (Excel en es/pt). `tz`: si viene, se agregan columnas *_local con la fecha y
 * hora en esa zona (las columnas ISO en UTC quedan como estaban, por compatibilidad).
 */
async function envelopesCsv(db: Db, tenantId: string, q: { from?: string; to?: string; sep?: string; tz?: string }) {
  const sep = csvSep(q.sep);
  const tz = await resolveTimeZone(db, q.tz);
  const { from, to } = await parseRange(db, q, tz ?? "UTC");
  const params: unknown[] = [tenantId, from.toISOString(), to.toISOString()];
  let local = "";
  if (tz) {
    params.push(tz);
    const z = `$${params.length}::text`;
    local = `, ${localTsSql("e.created_at", z)} AS created_local, ${localTsSql("e.sent_at", z)} AS sent_local,
       ${localTsSql("e.completed_at", z)} AS completed_local, ${localTsSql("e.expires_at", z)} AS expires_local`;
  }
  const all = await db.query<any>(
    `SELECT e.id, e.subject, e.status, e.created_via, e.created_at, e.sent_at, e.completed_at, e.expires_at,
       COALESCE(u.name, 'API') AS sender, u.email AS sender_email,
       (SELECT string_agg(r.name || COALESCE(' <' || r.email || '>', '') || ' [' || r.role || ': ' || r.status || ']', '; ' ORDER BY r.routing_order, r.created_at)
          FROM recipients r WHERE r.envelope_id = e.id) AS recipients${local}
     FROM envelopes e LEFT JOIN users u ON u.id = e.created_by
     WHERE e.tenant_id = $1 AND e.created_at BETWEEN $2 AND $3
     ORDER BY e.created_at DESC, e.id DESC LIMIT ${ENVELOPES_CSV_MAX + 1}`,
    params,
  );
  // Una fila de más para saber si se cortó: el corte se avisa (header X-Truncated y fila final), no es silencioso.
  const truncated = all.length > ENVELOPES_CSV_MAX;
  const rows = truncated ? all.slice(0, ENVELOPES_CSV_MAX) : all;
  const head = ["id", "asunto", "estado", "origen", "creado", "enviado", "completado", "vence", "remitente", "correo_remitente", "destinatarios"];
  if (tz) head.push("creado_local", "enviado_local", "completado_local", "vence_local");
  const lines = [head.join(sep)];
  for (const r of rows) {
    const cells = [r.id, r.subject, r.status, r.created_via, r.created_at, r.sent_at, r.completed_at, r.expires_at, r.sender, r.sender_email, r.recipients];
    if (tz) cells.push(r.created_local, r.sent_local, r.completed_local, r.expires_local);
    lines.push(cells.map(csvCell).join(sep));
  }
  if (truncated) {
    const last = rows[rows.length - 1];
    lines.push(
      ["", `TRUNCADO: se exportaron los ${ENVELOPES_CSV_MAX} sobres más recientes del rango; hay más. Acotá el rango (to=${new Date(last.created_at).toISOString()}) para el resto.`]
        .map(csvCell)
        .join(sep),
    );
  }
  return { body: csvBody(lines), rows: rows.length, truncated, timeZone: tz };
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function experienceRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  type EP = { Params: { id: string; recipientId: string } };
  type TP = { Params: { token: string } };

  // ───────── En persona: el anfitrión abre la sesión en su dispositivo ─────────

  app.post<EP>("/v1/envelopes/:id/recipients/:recipientId/in-person", { preHandler: auth }, async (req, reply): Promise<InPersonSessionResponse> => {
    const a = A(req);
    if (!a.userId) throw forbidden("La firma en persona la abre un usuario de la organización, no una API key");
    const session = randomToken();
    const expiresAt = new Date(Date.now() + IN_PERSON_SESSION_MIN * 60_000);
    let path = "";
    let token = "";
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      if (e.status !== "sent") throw conflict("not_in_progress", "El sobre no está en curso");
      const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1 AND envelope_id = $2`, [req.params.recipientId, e.id]);
      if (!r) throw notFound("Destinatario");
      if (r.auth_method !== "in_person") throw conflict("not_in_person", "Este destinatario no firma en persona");
      // Además del anfitrión, quien administra todos los sobres (envelopes:manage_all): si el anfitrión dejó la organización
      // o no está, la firma en persona no queda bloqueada hasta corregir el sobre.
      const asHost = r.in_person_host_user_id === a.userId;
      if (!asHost && !hasPerm(a, "envelopes:manage_all")) throw forbidden("Solo el anfitrión asignado puede abrir la firma en persona");
      if (!["sent", "viewed"].includes(r.status)) throw conflict("not_signable", "Este destinatario ya no está pendiente");
      const group = await currentSignerGroup(t, e.id);
      if (group.order !== r.routing_order) throw conflict("not_your_turn", "Todavía no es el turno de este firmante");
      if (!r.access_token_enc) throw conflict("not_available", "El destinatario todavía no está activo");
      token = decrypt(r.access_token_enc);
      const { ip, userAgent } = clientInfo(req);
      await t.query(`DELETE FROM signer_sessions WHERE recipient_id = $1`, [r.id]);
      await t.query(`UPDATE recipients SET identity_confirmed_at = NULL WHERE id = $1`, [r.id]);
      await t.query(
        `INSERT INTO signer_sessions (token_hash, recipient_id, method, ip, expires_at) VALUES ($1,$2,'in_person',$3,$4)`,
        [sha256Hex(session), r.id, ip, expiresAt.toISOString()],
      );
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.in_person_started",
        actor: a.actor,
        data: {
          recipientId: r.id,
          recipientName: r.name,
          hostUserId: a.userId,
          ...(asHost ? {} : { assignedHostUserId: r.in_person_host_user_id ?? null, openedByAdmin: true }),
          device: userAgent,
          ip,
        },
      });
      path = `/s/${token}?inperson=1`;
    });
    reply.setCookie(SIGNER_COOKIE, session, {
      path: `/v1/signing/${token}`,
      httpOnly: true,
      sameSite: "strict",
      secure: config.cookieSecure,
      maxAge: IN_PERSON_SESSION_MIN * 60,
    });
    reply.header("cache-control", "no-store");
    return { url: path, expiresAt: expiresAt.toISOString() };
  });

  // El firmante confirma, en el dispositivo del anfitrión, que es la persona indicada.
  app.post<TP>("/v1/signing/:token/in-person/confirm", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const input = InPersonConfirmInput.parse(req.body);
    const { recipient: r0, envelope: e0 } = await resolveToken(s.db, req.params.token);
    if (r0.auth_method !== "in_person") throw conflict("not_in_person", "Este link no es de firma en persona");
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, e0.tenant_id, e0.id);
      if (e.status !== "sent") throw new AppError(410, "envelope_closed", "El sobre ya no está disponible");
      const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1`, [r0.id]);
      assertLinkCurrent(r, r0);
      // Una corrección del nombre confirmada mientras tanto anuló la confirmación: la de ahora fue para el nombre que se
      // mostraba antes y no vale para el corregido.
      if (r.name !== r0.name) throw conflict("recipient_changed", "Los datos del firmante cambiaron: volvé a cargar la página");
      if (r.identity_confirmed_at) return;
      // Quien abrió la sesión en su dispositivo: el anfitrión asignado o un administrador (envelopes:manage_all).
      const opened = await t.one<{ host: string | null }>(
        `SELECT data->>'hostUserId' AS host FROM envelope_events
          WHERE envelope_id = $1 AND type = 'recipient.in_person_started' AND data->>'recipientId' = $2 ORDER BY seq DESC LIMIT 1`,
        [e.id, r.id],
      );
      const hostUserId = opened?.host ?? r.in_person_host_user_id;
      const host = await t.one<any>(`SELECT name, email FROM users WHERE id = $1`, [hostUserId]);
      await t.query(`UPDATE recipients SET identity_confirmed_at = now(), authenticated_at = now() WHERE id = $1`, [r.id]);
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.identity_confirmed",
        actor: recipientActor(req, r),
        data: {
          method: "in_person",
          hostUserId,
          host: host ? `${host.name} <${host.email}>` : null,
          idDocumentDeclared: input.idDocumentNumber ? maskDestination(input.idDocumentNumber) : null,
          idDocumentMatches:
            input.idDocumentNumber && r.id_document_number
              ? normalizeDocumentNumber(input.idDocumentNumber) === normalizeDocumentNumber(r.id_document_number)
              : null,
        },
      });
    });
    return { confirmed: true };
  });

  // Fin de la sesión en persona: el dispositivo vuelve al anfitrión.
  app.post<TP>("/v1/signing/:token/in-person/end", async (req, reply) => {
    const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
    const del = await s.db.query(`DELETE FROM signer_sessions WHERE recipient_id = $1 AND method = 'in_person' RETURNING token_hash`, [r.id]);
    if (del.length) {
      await s.db.tx(async (t) => {
        // La sesión se cierra igual; con el sobre anulado, rechazado o vencido no se suma el evento a su evidencia.
        const cur = await lockEnvelope(t, e.tenant_id, e.id);
        if (["voided", "declined", "expired"].includes(cur.status)) return;
        await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "recipient.in_person_ended", actor: recipientActor(req, r) });
      });
    }
    reply.clearCookie(SIGNER_COOKIE, { path: `/v1/signing/${req.params.token}` });
    return { ended: true };
  });

  // ───────── Correcciones en vuelo ─────────

  app.post<{ Params: { id: string } }>("/v1/envelopes/:id/corrections", { preHandler: auth }, async (req) => {
    const a = A(req);
    const { discardedKeys } = await s.db.tx((t) => correctEnvelope(t, a, req.params.id, req.body));
    await deleteBlobsQuietly(s.blobs, discardedKeys);
    return loadDetail(s.db, a.tenantId, req.params.id);
  });

  // ───────── Reportes ─────────

  app.get<{ Querystring: { from?: string; to?: string; tz?: string } }>("/v1/reports/summary", { preHandler: auth }, async (req) =>
    reportsSummary(s.db, A(req).tenantId, req.query),
  );

  app.get<{ Querystring: { from?: string; to?: string; sep?: string; tz?: string } }>("/v1/reports/envelopes.csv", { preHandler: auth }, async (req, reply: FastifyReply) => {
    const a = A(req);
    const csv = await envelopesCsv(s.db, a.tenantId, req.query);
    // Exportar todos los sobres de la organización (asuntos, destinatarios, correos) queda en la auditoría, como la
    // exportación de acuerdos y la de la auditoría misma.
    await auditFromRequest(s.db, req, a, "reports.exported", {
      targetType: "report",
      targetId: "envelopes.csv",
      data: { from: req.query.from ?? null, to: req.query.to ?? null, rows: csv.rows, truncated: csv.truncated },
    });
    if (csv.truncated) reply.header("x-truncated", "true");
    // Zona usada en las columnas *_local (una desconocida cae a UTC).
    if (csv.timeZone) reply.header("x-time-zone", csv.timeZone);
    const day = new Date().toISOString().slice(0, 10);
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="calasign-sobres-${day}.csv"`)
      .header("cache-control", "private, no-store");
    return reply.send(csv.body);
  });

  // ───────── Copias del documento final ─────────

  app.post<EP>("/v1/envelopes/:id/recipients/:recipientId/resend-copy", { preHandler: auth }, async (req): Promise<CopyQueuedResponse> => {
    const a = A(req);
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      if (e.status !== "completed") throw conflict("not_completed", "El sobre todavía no está completado");
      const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1 AND envelope_id = $2`, [req.params.recipientId, e.id]);
      if (!r) throw notFound("Destinatario");
      if (["delegated", "reassigned"].includes(r.status)) throw conflict("replaced", "Ese destinatario fue reemplazado");
      if (!r.email && !r.phone && !r.telegram_chat_id) throw conflict("no_destination", "El destinatario no tiene a dónde enviarle la copia");
      // Se registró solo en un formulario web y no validó su correo: el aviso no saldría (jobs.ts no le escribe).
      if (isUnverifiedSelfRegistered(r)) {
        throw conflict("unverified_recipient", "Ese destinatario se registró en un formulario web sin validar su correo: no se le envían copias (puede descargarla desde su link)");
      }
      await enqueue(t, "notify", { kind: "completed", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id });
      await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "envelope.copy_resent", actor: a.actor, data: { recipientId: r.id, recipientName: r.name } });
    });
    return { queued: true, recipientId: req.params.recipientId };
  });

  app.post<TP>("/v1/signing/:token/request-copy", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req): Promise<CopyQueuedResponse> => {
    const { recipient: r0, envelope: e0 } = await resolveToken(s.db, req.params.token);
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, e0.tenant_id, e0.id);
      if (e.status !== "completed") throw conflict("not_completed", "El documento final todavía no está disponible");
      const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1`, [r0.id]);
      if (!r.email && !r.phone && !r.telegram_chat_id) throw conflict("no_destination", "No hay a dónde enviarte la copia");
      // Autoregistrado en un formulario público sin correo validado: no se le manda la copia final (su correo no está
      // verificado); la descarga está en pantalla. Si no, el formulario más este pedido servían para mandar correos a
      // una dirección ajena.
      if (isUnverifiedSelfRegistered(r)) throw forbidden("Descargá la copia desde esta página");
      // Tope total por destinatario (además de uno cada 10 minutos).
      const total = await t.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.copy_requested' AND actor_id = $2`,
        [e.id, r.id],
      );
      if ((total?.n ?? 0) >= 5) throw new AppError(429, "copy_limit_reached", "Ya pediste varias copias. Descargá el documento desde esta página.");
      const recent = await t.one(
        `SELECT 1 FROM envelope_events WHERE envelope_id = $1 AND type = 'recipient.copy_requested' AND actor_id = $2 AND occurred_at > now() - interval '10 minutes'`,
        [e.id, r.id],
      );
      if (recent) throw new AppError(429, "copy_recently_requested", "Ya pediste una copia hace poco. Revisá tu correo o mensajes.");
      await enqueue(t, "notify", { kind: "completed", envelopeId: e.id, recipientId: r.id, tenantId: e.tenant_id });
      await appendEvent(t, { tenantId: e.tenant_id, envelopeId: e.id, type: "recipient.copy_requested", actor: recipientActor(req, r) });
    });
    return { queued: true, recipientId: r0.id };
  });
}

