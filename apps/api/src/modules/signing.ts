// Experiencia del firmante: autenticado por el token del link, sin cuenta.
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AUTO_FIELD_TYPES, CompleteSigningInput, DeclineInput, formatSigningDate, normalizeTimeZone, type SigningSession } from "@calasign/shared";
import { appendEvent, type Actor } from "../infra/evidence";
import { enqueue } from "../infra/queue";
import type { Db } from "../infra/db";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { BUMP_UPDATED_AT, sha256Hex, uuidv7 } from "../lib/util";
import { telegramLinkFor } from "./telegram";
import { resolveSessionToken, SIGNER_TOKEN_RE } from "./signer-token";
import { noteSettledPaymentOnClose } from "./billing/payment-close";
import { clientInfo, type Services } from "./context";
import { advanceRouting, currentSignerGroup, lockEnvelope, pastExpiry, receivesSignerNotices, sendPdf } from "./envelopes";
import { recordSignerDownload } from "./download-evidence";
import { toDocument, toField, loadDocuments } from "./mappers";
import { loadSignatureImages, loadSigningMoments, toStampFields } from "./stamp-fields";
import { pngInkPixels, renderProgressCopyPdf } from "@calasign/pdf";
import { canDelegate, isEmbeddedSigner, isSignerAuthenticated, isUnverifiedSelfRegistered, otpDestinationFor } from "./otp";
import { checkValue, VALUE_FIELD_TYPES } from "./fieldvalues";
import { brandForEnvelope, productLabel, publicTheme, rebrands } from "./white-label/brand";
import { inPersonSessionInfo } from "./experience";
import { prepareCompletionLogic, signerLogicFields } from "./logic";
import { identityBlocking, signingIdentityFor } from "./identity/kyc";
import { certificateStepFor } from "./certsign";
import { deleteBlobsQuietly } from "./file-cleanup";
import { purgedOriginal } from "./retention";
import { tenantTimeZone } from "./organization-settings";

/** Tope de píxeles de la imagen de firma o iniciales (el lienzo de la web es mucho menor). */
const SIGNATURE_MAX_PIXELS = 2000 * 1000;
/** Píxeles con tinta mínimos de una firma o iniciales: menos es un lienzo vacío, blanco o un toque suelto. */
const SIGNATURE_MIN_INK_PIXELS = 24;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface SubmittedHandoffRow {
  id: string;
  submitted_ip: string | null;
  submitted_user_agent: string | null;
  submitted_at: string | Date;
}

interface Resolved {
  recipient: any;
  envelope: any;
  /** true si el token de la URL es un token de sesión derivado (canje embebido), no el link permanente. */
  sessionToken: boolean;
}

/**
 * Destinatario y sobre de un token de la URL del firmante (/s/:token, /v1/signing/:token/*). Acepta el link permanente
 * y los tokens de sesión del canje embebido: los dos atribuyen todo al mismo destinatario.
 */
export async function resolveToken(db: Db, token: string): Promise<Resolved> {
  if (!SIGNER_TOKEN_RE.test(token)) throw notFound("Link");
  const hash = sha256Hex(token);
  let recipient = await db.one<any>(`SELECT * FROM recipients WHERE access_token_hash = $1`, [hash]);
  let sessionToken = false;
  if (!recipient) {
    const st = await resolveSessionToken(db, hash);
    if (st) {
      recipient = await db.one<any>(`SELECT * FROM recipients WHERE id = $1 AND access_token_hash = $2`, [st.recipient_id, st.access_token_hash]);
      sessionToken = true;
    }
  }
  if (!recipient) throw notFound("Link");
  const envelope = await db.one<any>(`SELECT * FROM envelopes WHERE id = $1`, [recipient.envelope_id]);
  if (!envelope || envelope.status === "draft") throw notFound("Link");
  return { recipient, envelope, sessionToken };
}

/**
 * Con el sobre bloqueado: el link del pedido sigue siendo el vigente del destinatario. Una corrección del contacto
 * (link nuevo, consentimiento y apertura reiniciados) o un reemplazo pudo confirmarse entre resolveToken y el bloqueo;
 * sin esto, quien tenía el link anterior rechazaba, delegaba, consentía o "abría" en nombre del contacto corregido.
 * `resolved` es el destinatario que devolvió resolveToken (su access_token_hash es el link con el que se entró, o del
 * que deriva el token de sesión): no el token crudo de la URL, que para un token de sesión no coincide nunca.
 */
export function assertLinkCurrent(r: any, resolved: { access_token_hash?: string | null }) {
  if (!r || !resolved.access_token_hash || r.access_token_hash !== resolved.access_token_hash) throw notFound("Link");
}

/** Estado del sobre y del destinatario que permite completar; `groupOrder`: el turno de firma en curso. */
export function assertCanComplete(e: any, r: any, groupOrder: number | null) {
  if (e.status !== "sent" || pastExpiry(e)) throw new AppError(410, "envelope_closed", "El sobre ya no está disponible para firmar");
  if (r.role !== "signer" && r.role !== "approver") throw conflict("not_signer", "Este destinatario no firma");
  if (r.status === "signed") throw conflict("already_signed", "Ya firmaste este sobre");
  if (!["sent", "viewed"].includes(r.status)) throw conflict("not_signable", "No podés firmar este sobre");
  if (groupOrder !== r.routing_order) throw conflict("not_your_turn", "Todavía no es tu turno de firmar");
  if (!r.consented_at) throw conflict("consent_required", "Primero hay que aceptar el uso de medios electrónicos");
}

/** Tope del PNG de una firma o iniciales (en bytes, ya decodificado el base64). */
export const SIGNATURE_PNG_MAX_BYTES = 700 * 1024;

/**
 * PNG de una firma o iniciales (base64 sin prefijo), con el mismo criterio para la dibujada, la escrita, la importada y
 * la que llega del celular: firma PNG, tope de bytes y de píxeles (un PNG dañado o que declara dimensiones enormes haría
 * fallar, o tumbar, el sellado después de que el firmante ya figura como firmado) y trazo visible (una imagen
 * transparente, toda blanca o de un punto no es una firma). `what`: "Firma" / "Iniciales", para el mensaje.
 */
export async function decodeSignaturePng(b64: string, what: string): Promise<Buffer> {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 67 || !buf.subarray(0, 8).equals(PNG_MAGIC)) throw badRequest("invalid_image", `${what}: se esperaba una imagen PNG`);
  if (buf.length > SIGNATURE_PNG_MAX_BYTES) throw badRequest("invalid_image", `${what}: imagen demasiado grande`);
  let ink: number;
  try {
    ink = await pngInkPixels(new Uint8Array(buf), SIGNATURE_MAX_PIXELS);
  } catch {
    throw badRequest("invalid_image", `${what}: la imagen está dañada o es demasiado grande`);
  }
  if (ink < SIGNATURE_MIN_INK_PIXELS) throw badRequest("blank_signature", `${what}: la imagen no tiene trazo visible`);
  return buf;
}

export function recipientActor(req: FastifyRequest, r: any): Actor {
  const { ip, userAgent } = clientInfo(req);
  return { type: "recipient", id: r.id, label: r.email ? `${r.name} <${r.email}>` : `${r.name} (${r.phone ?? "sin contacto"})`, ip, userAgent };
}

export { formatSigningDate };

/**
 * Actor y datos del rechazo. Se puede rechazar sin haber pasado la verificación de identidad (quien no quiere hacer
 * el KYC tiene que poder rechazar) ni la confirmación presencial, pero la evidencia lo dice: `identityVerified` (KYC:
 * true/false, o null si el destinatario no la requiere) e `inPersonConfirmed` (sólo en persona). En persona sin
 * identidad confirmada no consta quién tocó "Rechazar" en el dispositivo del anfitrión: el actor es el anfitrión
 * (sesión abierta por él), no el firmante; `recipientId`/`recipient` dicen de quién era el lugar.
 */
export async function declineEvidence(db: Db, req: FastifyRequest, r: any, envelopeId: string, reason: string | null | undefined) {
  const identityVerified = r.id_verification_provider ? r.identity_status === "verified" : null;
  const inPerson = r.auth_method === "in_person";
  const inPersonConfirmed = inPerson ? Boolean(r.identity_confirmed_at) : null;
  const signer = recipientActor(req, r);
  const data: Record<string, unknown> = { reason, recipientId: r.id, identityVerified };
  if (inPerson) data.inPersonConfirmed = inPersonConfirmed;
  if (inPerson && !inPersonConfirmed) {
    const opened = await db.one<{ host: string | null }>(
      `SELECT data->>'hostUserId' AS host FROM envelope_events
        WHERE envelope_id = $1 AND type = 'recipient.in_person_started' AND data->>'recipientId' = $2 ORDER BY seq DESC LIMIT 1`,
      [envelopeId, r.id],
    );
    const hostUserId = opened?.host ?? r.in_person_host_user_id ?? null;
    const host = hostUserId ? await db.one<any>(`SELECT name, email FROM users WHERE id = $1`, [hostUserId]) : null;
    if (hostUserId) {
      data.recipient = signer.label;
      data.actorRole = "in_person_host";
      return {
        actor: {
          type: "user",
          id: hostUserId,
          label: host ? `${host.name} <${host.email}>` : "Anfitrión (usuario eliminado)",
          ip: signer.ip,
          userAgent: signer.userAgent,
        } as Actor,
        data,
      };
    }
  }
  return { actor: signer, data };
}

/** Copia en curso: el destinatario ya firmó (o es copia) y el sobre todavía no tiene su PDF final. */
function copyAllowed(r: any, e: any): boolean {
  const open = ["sent", "awaiting_certificates", "finalizing"].includes(e.status);
  return open && (r.role === "cc" || r.status === "signed" || r.status === "completed");
}

/**
 * Los PDFs del firmante piden lo mismo que la sesión para mostrar documentos. El código OTP ya lo exige el hook de
 * otp.ts para todo /v1/signing/:token/*; acá falta la identidad verificada (KYC).
 */
function assertCanReadDocuments(r: any, e: any) {
  if (identityBlocking(r)) throw new AppError(403, "identity_required", "Hace falta verificar tu identidad para continuar");
  if (closedForSigner(e)) throw new AppError(410, "envelope_closed", "Este sobre se anuló o venció: sus documentos ya no están disponibles");
}

/**
 * Sobre anulado o vencido: el link ya no muestra ni descarga los documentos. Si no, quien recibió el link por error
 * (p. ej. un correo equivocado, el motivo típico para anular) seguía bajando el contrato para siempre.
 */
function closedForSigner(e: any): boolean {
  return e.status === "voided" || e.status === "expired" || (e.status === "sent" && pastExpiry(e));
}

export async function buildSession(db: Db, token: string, r: any, e: any, authed = true): Promise<SigningSession> {
  const otpRequired = r.auth_method !== "link" && !authed;
  // KYC (Fase 5): sin identidad verificada tampoco se muestran documentos ni campos.
  const blocked = otpRequired || identityBlocking(r) || closedForSigner(e);
  const [docs, fields, org, sender, group] = await Promise.all([
    loadDocuments(db, e.id),
    db.query(`SELECT * FROM fields WHERE recipient_id = $1 ORDER BY page, y, x`, [r.id]),
    db.one<any>(`SELECT name, time_zone FROM tenants WHERE id = $1`, [e.tenant_id]),
    e.created_by ? db.one<any>(`SELECT name FROM users WHERE id = $1`, [e.created_by]) : Promise.resolve(null),
    currentSignerGroup(db, e.id),
  ]);
  const purgedDocs = new Set(docs.filter((d: any) => d.purged_at).map((d: any) => d.id));
  // Marca blanca: tema, textos y nombre del producto de la marca del sobre (white-label/brand.ts).
  const wl = await brandForEnvelope(db, e);
  const theme = publicTheme(wl);
  const canSign =
    e.status === "sent" &&
    !pastExpiry(e) &&
    (r.role === "signer" || r.role === "approver") &&
    ["sent", "viewed"].includes(r.status) &&
    group.order === r.routing_order;
  return {
    envelope: {
      id: e.id,
      subject: e.subject,
      message: e.message,
      // Vencido sin barrer todavía: la página muestra el cierre por vencimiento, no un sobre firmable a medias.
      status: e.status === "sent" && pastExpiry(e) ? "expired" : e.status,
      // Sin usuario remitente (API key): el nombre de la marca, como en los correos (jobs.ts); no el de la organización.
      senderName: sender?.name ?? (rebrands(wl) || e.brand_id ? wl.name : org?.name) ?? productLabel(wl),
      organizationName: rebrands(wl) || e.brand_id ? wl.name : (org?.name ?? ""),
      expiresAt: e.expires_at ? new Date(e.expires_at).toISOString() : null,
      locale: e.locale ?? "es",
      timeZone: normalizeTimeZone(org?.time_zone),
    },
    recipient: {
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      status: r.status,
      locale: r.locale ?? e.locale,
      consented: Boolean(r.consented_at),
      // Token de vinculación propio y de vida corta (no el de firma: el link t.me pasa por Telegram). Solo con la página
      // habilitada (código validado, sobre abierto).
      telegramLink: r.channels?.includes("telegram") && !r.telegram_chat_id && !blocked ? await telegramLinkFor(db, r) : null,
      authMethod: r.auth_method ?? "link",
    },
    // Un original borrado por retención no se puede abrir (410 purged): no se lista, ni sus campos.
    documents: blocked ? [] : docs.filter((d: any) => !d.purged_at).map(toDocument),
    fields: blocked ? [] : fields.filter((f: any) => !purgedDocs.has(f.document_id)).map(toField),
    canSign,
    signedAvailable: !blocked && e.status === "completed" && Boolean(e.signed_file_id),
    copyAvailable: !blocked && copyAllowed(r, e),
    // Autorregistrado sin correo validado: la copia se descarga desde esta página (no puede pedir reenvíos); al
    // completarse recibe solo un aviso por correo, sin link, que le dice que la descargue desde esta página (jobs.ts).
    finalCopyByMessage: !isUnverifiedSelfRegistered(r),
    otpRequired,
    otpDestination: otpRequired ? otpDestinationFor(r) : null,
    canDelegate: canDelegate(r, e, await isEmbeddedSigner(db, r)),
    logicFields: blocked ? [] : await signerLogicFields(db, e.id, r.id),
    branding: theme.theme.primaryColor || theme.logoUrl ? { primaryColor: theme.theme.primaryColor, logoUrl: theme.logoUrl } : null,
    theme,
    inPerson: await inPersonSessionInfo(db, r, !otpRequired),
    identity: await signingIdentityFor(db, r, e, { revealSession: !otpRequired }),
    certificateSigning: blocked ? null : await certificateStepFor(db, r, e),
  };
}

const MAX_COPIES_IN_FLIGHT = 2;
let copiesInFlight = 0;

export async function signingRoutes(app: FastifyInstance, s: Services) {
  type P = { Params: { token: string; documentId?: string } };
  const rl = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } };

  app.get<P>("/v1/signing/:token", rl, async (req) => {
    const { recipient: r0, envelope: e0 } = await resolveToken(s.db, req.params.token);
    const authed = await isSignerAuthenticated(s.db, req, r0);
    if (authed && r0.status === "sent" && e0.status === "sent" && !pastExpiry(e0)) {
      await s.db.tx(async (t) => {
        // El estado y el link se vuelven a mirar con el sobre bloqueado: un sobre anulado, rechazado o vencido mientras
        // tanto no suma la apertura, y el link revocado por una corrección no marca como "visto" al contacto nuevo.
        const cur = await lockEnvelope(t, e0.tenant_id, e0.id);
        if (cur.status !== "sent" || pastExpiry(cur)) return;
        const upd = await t.query(
          `UPDATE recipients SET status = 'viewed', viewed_at = now() WHERE id = $1 AND status = 'sent' AND access_token_hash = $2 RETURNING id`,
          [r0.id, r0.access_token_hash],
        );
        if (upd.length) await appendEvent(t, { tenantId: e0.tenant_id, envelopeId: e0.id, type: "recipient.viewed", actor: recipientActor(req, r0) });
      });
    }
    const { recipient, envelope } = await resolveToken(s.db, req.params.token);
    return buildSession(s.db, req.params.token, recipient, envelope, authed);
  });

  app.get<P & { Querystring: { download?: string } }>("/v1/signing/:token/documents/:documentId/file", rl, async (req, reply) => {
    const { envelope, recipient } = await resolveToken(s.db, req.params.token);
    assertCanReadDocuments(recipient, envelope);
    const d = await s.db.one<any>(
      `SELECT f.storage_key, f.purged_at FROM documents d JOIN files f ON f.id = d.file_id WHERE d.id = $1 AND d.envelope_id = $2`,
      [req.params.documentId, envelope.id],
    );
    if (!d) throw notFound("Documento");
    // Original borrado por retención (también con el sobre anulado o vencido, que el hook de retention.ts deja pasar):
    // 410, no un 500 al no encontrar el archivo.
    if (d.purged_at) throw purgedOriginal(envelope.status);
    const bytes = await s.blobs.get(d.storage_key);
    // Solo la descarga explícita (?download=1, el botón de la página): el visor pide el archivo en cada apertura.
    if (req.query.download === "1")
      await recordSignerDownload(s.db, req.log, envelope, recipientActor(req, recipient), "document", req.params.documentId);
    reply.header("content-type", "application/pdf").header("cache-control", "private, no-store");
    return reply.send(Buffer.from(bytes));
  });

  app.post<P>("/v1/signing/:token/consent", rl, async (req) => {
    const { recipient: r0, envelope: e0 } = await resolveToken(s.db, req.params.token);
    // Solo con el sobre en curso: un sobre cerrado (completado, anulado, vencido) no admite eventos nuevos de
    // consentimiento, que quedarían en la cadena de evidencia después del certificado de finalización.
    if (!r0.consented_at && e0.status === "sent") {
      await s.db.tx(async (t) => {
        const e = await lockEnvelope(t, e0.tenant_id, e0.id);
        if (e.status !== "sent" || pastExpiry(e)) return;
        // Solo con el link vigente: el consentimiento de quien tenía el link anterior no pasa al contacto corregido.
        const upd = await t.query(
          `UPDATE recipients SET consented_at = now() WHERE id = $1 AND consented_at IS NULL AND access_token_hash = $2 RETURNING id`,
          [r0.id, r0.access_token_hash],
        );
        if (upd.length)
          await appendEvent(t, {
            tenantId: e0.tenant_id,
            envelopeId: e0.id,
            type: "recipient.consented",
            actor: recipientActor(req, r0),
            data: { disclosure: "electronic-records-v1", locale: r0.locale ?? e0.locale },
          });
      });
    }
    const { recipient, envelope } = await resolveToken(s.db, req.params.token);
    return buildSession(s.db, req.params.token, recipient, envelope);
  });

  app.post<P>("/v1/signing/:token/complete", { ...rl, bodyLimit: 4 * 1024 * 1024 }, async (req) => {
    const input = CompleteSigningInput.parse(req.body);
    const { recipient: r0, envelope: e0 } = await resolveToken(s.db, req.params.token);
    const actor = recipientActor(req, r0);
    // Chequeo previo sin bloqueo (se repite con el sobre bloqueado): un pedido que igual va a fallar no decodifica ni
    // sube imágenes de firma.
    assertCanComplete(e0, r0, e0.status === "sent" ? (await currentSignerGroup(s.db, e0.id)).order : null);

    // Se decodifica ahora (con tope de píxeles y de trazo): ver decodeSignaturePng.
    const sigPng = input.signature ? await decodeSignaturePng(input.signature.imagePng, "Firma") : null;
    const iniPng = input.initials ? await decodeSignaturePng(input.initials.imagePng, "Iniciales") : null;

    // Subir imágenes antes de la transacción (no se bloquea el sobre durante I/O externa).
    const stored: { purpose: "signature" | "initials"; kind: string; text: string | null; fileId: string; key: string; png: Buffer }[] = [];
    // Si la firma no se completa (faltan campos, no es su turno, el sobre cerró…), las imágenes ya subidas no las
    // referencia nada: sin fila en `files` la retención nunca las borra y la firma del titular quedaba guardada para
    // siempre, una copia por cada intento fallido.
    const discardStored = () =>
      deleteBlobsQuietly(
        s.blobs,
        stored.map((x) => x.key),
      );
    try {
      for (const [purpose, png, meta] of [
        ["signature", sigPng, input.signature],
        ["initials", iniPng, input.initials],
      ] as const) {
        if (!png || !meta) continue;
        const fileId = uuidv7();
        const key = `tenants/${e0.tenant_id}/envelopes/${e0.id}/signatures/${fileId}.png`;
        await s.blobs.put(key, png, "image/png");
        // El texto es informativo (no se estampa: va la imagen) y solo tiene sentido en una firma escrita con teclado.
        const text = meta.kind === "typed" ? meta.text?.trim() || null : null;
        stored.push({ purpose, kind: meta.kind, text, fileId, key, png });
      }
    } catch (err) {
      // Falló la subida de las iniciales con la firma ya subida: esa firma tampoco la referencia nada.
      await discardStored();
      throw err;
    }
    await s.db
      .tx(async (t) => {
        const e = await lockEnvelope(t, e0.tenant_id, e0.id);
        const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1`, [r0.id]);
        assertLinkCurrent(r, r0);
        assertCanComplete(e, r, (await currentSignerGroup(t, e.id)).order);
        // En persona: el certificado dice "identidad confirmada en el dispositivo del anfitrión"; sin la confirmación
        // (POST …/in-person/confirm) la firma no puede completarse aunque la sesión del anfitrión esté abierta.
        if (r.auth_method === "in_person" && !r.identity_confirmed_at)
          throw conflict("identity_confirmation_required", "Primero hay que confirmar la identidad en el dispositivo del anfitrión");
        // KYC: el hook de identidad miró al destinatario antes de subir las imágenes, sin bloqueo. Una corrección del nombre
        // confirmada mientras tanto (el link no rota) anula la verificación; sin esto se firmaba sin identidad verificada.
        if (identityBlocking(r)) throw new AppError(403, "identity_required", "Hace falta verificar tu identidad para continuar");

        const fields = await t.query<any>(`SELECT * FROM fields WHERE recipient_id = $1`, [r.id]);
        const values = new Map(input.fields.map((f) => [f.id, f.value]));
        for (const id of values.keys()) if (!fields.some((f) => f.id === id)) throw badRequest("invalid_field", "Campo desconocido");
        const now = new Date();
        const locale = r.locale ?? e.locale;
        // La fecha de firma, en el huso de la organización (no en el del navegador del firmante: no es evidencia).
        const timeZone = await tenantTimeZone(t, e.tenant_id);
        const missing: string[] = [];
        // Ids y tipos de los campos que faltan o son inválidos: la web los ubica y los nombra en el idioma del firmante.
        const missingFields: { id: string; type: string; label: string | null }[] = [];
        const invalidFields: { id: string; type: string; label: string | null; error: string }[] = [];
        const miss = (f: any, fallback: string) => {
          missing.push(f.label ?? fallback);
          missingFields.push({ id: f.id, type: f.type, label: f.label ?? null });
        };
        const hasSig = stored.some((x) => x.purpose === "signature");
        const hasIni = stored.some((x) => x.purpose === "initials");

        const invalid: string[] = [];
        // Lógica (Fase 4): campos ocultos por sus condiciones no se exigen ni se estampan; los calculados los fija el servidor.
        const autoValue = (type: string) =>
          type === "name" ? r.name : type === "email" ? (r.email ?? "") : formatSigningDate(now, locale, timeZone);
        const logic = await prepareCompletionLogic(t, e.id, r.id, values, { hasSig, hasIni, autoValue });
        for (const f of fields) {
          if (logic.hidden.has(f.id)) continue;
          if (logic.computed.has(f.id)) {
            await t.query(`UPDATE fields SET value = $2, filled_at = now() WHERE id = $1`, [f.id, logic.computed.get(f.id)]);
            continue;
          }
          let v: string | null = null;
          if (f.read_only) {
            v = f.value;
          } else if (f.type === "attachment") {
            v = f.attachment_file_id ? f.value : null;
            if (f.required && !f.attachment_file_id) miss(f, "Adjunto");
          } else if (VALUE_FIELD_TYPES.includes(f.type) && f.type !== "text") {
            const res = checkValue(
              { type: f.type, required: f.required, label: f.label, options: f.options, min: f.min_value, max: f.max_value },
              values.has(f.id) ? values.get(f.id) : f.value,
            );
            if ("error" in res) {
              if (res.error === "obligatorio") miss(f, f.type);
              else {
                invalid.push(`${f.label ?? f.type}: ${res.error}`);
                invalidFields.push({ id: f.id, type: f.type, label: f.label ?? null, error: res.error });
              }
            } else v = res.value;
          } else if ((AUTO_FIELD_TYPES as string[]).includes(f.type)) {
            v = autoValue(f.type);
          } else if (f.type === "signature") {
            if (!hasSig) miss(f, "Firma");
            v = "signed";
          } else if (f.type === "initials") {
            if (!hasIni && !hasSig) miss(f, "Iniciales");
            v = "signed";
          } else if (f.type === "checkbox") {
            v = values.get(f.id) === "true" ? "true" : "false";
            if (f.required && v !== "true") miss(f, "Casilla");
          } else {
            v = (values.has(f.id) ? (values.get(f.id) ?? "") : (f.value ?? "")).trim() || null;
            if (f.required && !v) miss(f, "Texto");
          }
          await t.query(`UPDATE fields SET value = $2, filled_at = now() WHERE id = $1`, [f.id, v]);
        }
        if (missing.length)
          throw new AppError(422, "fields_incomplete", `Faltan completar: ${[...new Set(missing)].join(", ")}`, { missing, fields: missingFields });
        if (invalid.length) throw new AppError(422, "fields_invalid", `Valores inválidos: ${invalid.join("; ")}`, { invalid, fields: invalidFields });

        // Firma dibujada en el celular: el pase es de este destinatario y sobre, se pidió con su link vigente (una
        // corrección del contacto lo revoca), ya recibió la firma y la imagen es exactamente la que llegó (si no,
        // cualquiera podía decir que su firma se dibujó en otro dispositivo).
        const devices = new Map<string, { handoffId: string; ip: string | null; userAgent: string | null; submittedAt: string }>();
        for (const x of stored) {
          const meta = x.purpose === "signature" ? input.signature : input.initials;
          if (!meta?.handoffId) continue;
          const h = await t.one<SubmittedHandoffRow>(
            `SELECT id, submitted_ip, submitted_user_agent, submitted_at FROM signature_handoffs
              WHERE id = $1 AND recipient_id = $2 AND envelope_id = $3 AND purpose = $4 AND submitted_at IS NOT NULL AND image_sha256 = $5
                AND access_token_hash = $6`,
            [meta.handoffId, r.id, e.id, x.purpose, sha256Hex(x.png), r.access_token_hash],
          );
          if (!h || meta.kind !== "drawn")
            throw badRequest("invalid_handoff", "La firma del celular no corresponde a este pase: volvé a dibujarla o pedí otro link");
          devices.set(x.purpose, {
            handoffId: h.id,
            ip: h.submitted_ip,
            userAgent: h.submitted_user_agent,
            submittedAt: new Date(h.submitted_at).toISOString(),
          });
          // La imagen ya queda en el archivo de la firma adoptada: el pase no la guarda más.
          await t.query(`UPDATE signature_handoffs SET image_png = NULL WHERE id = $1`, [h.id]);
        }

        for (const x of stored) {
          await t.query(
            `INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'signature_image',$3,'image/png',$4,$5)`,
            [x.fileId, e.tenant_id, x.key, x.png.length, sha256Hex(x.png)],
          );
          await t.query(
            `INSERT INTO adopted_signatures (id, tenant_id, recipient_id, purpose, kind, text, image_file_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (recipient_id, purpose) DO UPDATE SET kind = EXCLUDED.kind, text = EXCLUDED.text, image_file_id = EXCLUDED.image_file_id`,
            [uuidv7(), e.tenant_id, r.id, x.purpose, x.kind, x.text, x.fileId],
          );
        }
        await t.query(`UPDATE recipients SET status = 'signed', signed_at = now(), signed_ip = $2, signed_user_agent = $3 WHERE id = $1`, [
          r.id,
          actor.ip,
          actor.userAgent,
        ]);
        const docs = await loadDocuments(t, e.id);
        await appendEvent(t, {
          tenantId: e.tenant_id,
          envelopeId: e.id,
          type: r.role === "approver" ? "recipient.approved" : "recipient.signed",
          actor,
          data: {
            documents: docs.map((d) => ({ id: d.id, sha256: d.sha256 })),
            fields: fields.length,
            // Huso en el que se escribió la fecha de firma: el sellado la rotula con él aunque la organización lo cambie.
            timeZone,
            // `device`: se dibujó en otro dispositivo (el celular del pase), con su IP y navegador; sin el token del pase.
            signature: stored.map((x) => ({
              purpose: x.purpose,
              kind: x.kind,
              sha256: sha256Hex(x.png),
              ...(devices.has(x.purpose) ? { device: devices.get(x.purpose) } : {}),
            })),
          },
        });
        await advanceRouting(t, e.tenant_id, e.id, { type: "system", label: "Sistema" });
      })
      .catch(async (err) => {
        await discardStored();
        throw err;
      });
    const { recipient, envelope } = await resolveToken(s.db, req.params.token);
    return buildSession(s.db, req.params.token, recipient, envelope);
  });

  app.post<P>("/v1/signing/:token/decline", rl, async (req) => {
    const input = DeclineInput.parse(req.body);
    const { recipient: r0, envelope: e0 } = await resolveToken(s.db, req.params.token);
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, e0.tenant_id, e0.id);
      const r = await t.one<any>(`SELECT * FROM recipients WHERE id = $1`, [r0.id]);
      assertLinkCurrent(r, r0);
      if (e.status !== "sent" || pastExpiry(e)) throw new AppError(410, "envelope_closed", "El sobre ya no está disponible");
      if ((r.role !== "signer" && r.role !== "approver") || !["sent", "viewed"].includes(r.status))
        throw conflict("not_signable", "No podés rechazar este sobre");
      await t.query(`UPDATE recipients SET status = 'declined', declined_at = now(), decline_reason = $2 WHERE id = $1`, [r.id, input.reason]);
      await t.query(`UPDATE envelopes SET status = 'declined', updated_at = ${BUMP_UPDATED_AT}, version = version + 1 WHERE id = $1`, [e.id]);
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.declined",
        ...(await declineEvidence(t, req, r, e.id, input.reason)),
      });
      await noteSettledPaymentOnClose(t, e.id, "declined", recipientActor(req, r));
      await enqueue(t, "notify", { kind: "sender_declined", envelopeId: e.id, tenantId: e.tenant_id, declinedBy: r.id });
      const others = (
        await t.query<any>(`SELECT * FROM recipients WHERE envelope_id = $1 AND id <> $2 AND status IN ('sent','viewed','signed')`, [e.id, r.id])
      ).filter(
        // Embebidos, en persona y autorregistrados sin correo validado no reciben avisos (ver receivesSignerNotices).
        receivesSignerNotices,
      );
      for (const o of others)
        await enqueue(t, "notify", { kind: "declined", envelopeId: e.id, recipientId: o.id, tenantId: e.tenant_id, declinedBy: r.id });
    });
    const { recipient, envelope } = await resolveToken(s.db, req.params.token);
    return buildSession(s.db, req.params.token, recipient, envelope);
  });

  app.get<P>("/v1/signing/:token/signed.pdf", rl, async (req, reply) => {
    const { envelope, recipient } = await resolveToken(s.db, req.params.token);
    assertCanReadDocuments(recipient, envelope);
    if (envelope.status !== "completed" || !envelope.signed_file_id) throw notFound("Documento firmado");
    const f = await s.db.one<any>(`SELECT storage_key FROM files WHERE id = $1`, [envelope.signed_file_id]);
    const bytes = await s.blobs.get(f.storage_key);
    await recordSignerDownload(s.db, req.log, envelope, recipientActor(req, recipient), "signed");
    return sendPdf(reply, bytes, envelope.subject);
  });

  // Copia con lo firmado hasta ahora, para quien ya firmó y espera al resto (sin certificado ni sello).
  // Arma el PDF entero en este proceso (pdf-lib, CPU): tope propio más bajo que el resto de las rutas del firmante.
  app.get<P>("/v1/signing/:token/copy.pdf", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { envelope: e, recipient: r } = await resolveToken(s.db, req.params.token);
    assertCanReadDocuments(r, e);
    if (!copyAllowed(r, e)) throw notFound("Copia del documento");
    // Copias armándose a la vez en este proceso: cada una carga todos los documentos del sobre en memoria.
    if (copiesInFlight >= MAX_COPIES_IN_FLIGHT) {
      reply.header("retry-after", "5");
      throw new AppError(503, "busy", "Estamos armando otras copias: probá de nuevo en unos segundos");
    }
    copiesInFlight++;
    try {
      const [docs, fields, sigImages] = await Promise.all([
        loadDocuments(s.db, e.id),
        // Solo lo ya firmado (y los valores fijos del remitente): lo precargado para quien todavía no firmó no va.
        s.db.query<any>(
          `SELECT f.* FROM fields f JOIN recipients rr ON rr.id = f.recipient_id
            WHERE f.envelope_id = $1 AND NOT f.hidden AND f.value IS NOT NULL AND f.type <> 'attachment'
              AND (f.read_only OR rr.status IN ('signed', 'completed'))`,
          [e.id],
        ),
        loadSignatureImages(s.db, s.blobs, e.id),
      ]);
      const pdf = await renderProgressCopyPdf({
        documents: await Promise.all(docs.map(async (d) => ({ name: d.name, bytes: await s.blobs.get(d.storage_key) }))),
        fields: toStampFields(fields, docs, sigImages, await tenantTimeZone(s.db, e.tenant_id), await loadSigningMoments(s.db, e.id)),
        envelopeId: e.id,
        subject: e.subject,
        locale: r.locale ?? e.locale ?? "es",
        productName: await brandForEnvelope(s.db, e).then((b) => (rebrands(b) ? productLabel(b) : undefined)),
      });
      await recordSignerDownload(s.db, req.log, e, recipientActor(req, r), "copy");
      return sendPdf(reply, pdf, `${e.subject} (copia)`);
    } finally {
      copiesInFlight--;
    }
  });
}
