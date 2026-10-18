// Sala de firma por videollamada (Fase 6, tipo Virtual Room).
//
// - WebRTC en malla para hasta 4 participantes (anfitrión + firmantes). El audio/video va entre navegadores;
//   la API solo hace de señalización (WebSocket) y no ve el contenido.
// - Co-navegación: quien tiene el control (por defecto el anfitrión) guía página, desplazamiento, zoom y campo
//   resaltado; el resto sigue. Cada firmante firma sus propios campos con el flujo de firma de siempre.
// - Grabación: la compone el navegador del anfitrión (MediaRecorder) y la sube en fragmentos. Solo se acepta
//   con el consentimiento de todos los participantes conectados; cada fragmento se guarda cifrado y el SHA-256
//   de la grabación completa queda en la evidencia y en el certificado de finalización.
// - Identidad: el anfitrión confirma en cámara el documento de cada firmante (evidencia; opcionalmente exigido
//   antes de finalizar la firma).
//
// El estado de cada sala (conexiones, control, co-navegación) vive en la memoria del proceso: con varias
// instancias, el WebSocket de una sala tiene que caer siempre en la misma (afinidad por id de sesión en el
// balanceador) o agregarse un bus pub/sub. Producción necesita además un servidor TURN (ver VIDEO_TURN_*).
import { createHash, createHmac } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  CreateVideoSessionInput,
  VIDEO_CHUNK_MAX_BYTES,
  VIDEO_MAX_CHUNKS,
  VIDEO_MAX_PARTICIPANTS,
  VideoIdentityInput,
  type CobrowseState,
  type IceServer,
  type SignerVideoInfo,
  type VideoClientMessage,
  type VideoPeer,
  type VideoServerMessage,
  type VideoSession,
} from "@calasign/shared";
import type { Db } from "../infra/db";
import { appendEvent, type Actor } from "../infra/evidence";
import type { BlobStore } from "../infra/storage";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { decrypt, decryptBytes, encryptBytes, iso, maskDestination, sha256Hex, uuidv7 } from "../lib/util";
import { deliver } from "../notifications/channels";
import { normLocale } from "../notifications/templates";
import { authenticate, clientInfo, type AuthContext, type Services } from "./context";
import { tenantBaseUrl } from "./custom-domains";
import { lockEnvelope } from "./envelopes";
import { recipientActor, resolveToken } from "./signing";

// ───────────────────────────── Configuración ─────────────────────────────

const DEFAULT_STUN: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

function parseIceServers(): IceServer[] {
  const raw = process.env.VIDEO_ICE_SERVERS;
  if (!raw) return DEFAULT_STUN;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v as IceServer[];
  } catch {
    // Valor inválido: se usa el STUN por defecto.
  }
  return DEFAULT_STUN;
}

/**
 * Servidores ICE para un participante. Con VIDEO_TURN_SECRET y VIDEO_TURN_URLS se agregan credenciales TURN
 * temporales con el esquema "use-auth-secret" de coturn (REST API for TURN):
 *   username = "<expira-unix>:<id>", credential = base64(HMAC-SHA1(secret, username)).
 */
export function iceServersFor(participantId: string, now = Date.now()): IceServer[] {
  const servers = [...parseIceServers()];
  const secret = process.env.VIDEO_TURN_SECRET;
  const urls = (process.env.VIDEO_TURN_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (secret && urls.length) {
    const ttl = Number(process.env.VIDEO_TURN_TTL ?? 3600);
    const username = `${Math.floor(now / 1000) + (Number.isFinite(ttl) && ttl > 0 ? ttl : 3600)}:${participantId}`;
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    servers.push({ urls, username, credential });
  }
  return servers;
}

// ───────────────────────────── Estado de las salas (memoria) ─────────────────────────────

interface Conn {
  id: string; // id de participante (estable entre reconexiones)
  kind: "host" | "recipient";
  name: string;
  recipientId: string | null;
  userId: string | null;
  socket: WebSocket;
  actor: Actor;
  consented: boolean;
  identityConfirmed: boolean;
}

interface Room {
  sessionId: string;
  envelopeId: string;
  tenantId: string;
  hostParticipantId: string | null;
  conns: Map<string, Conn>;
  controller: string | null;
  cobrowse: CobrowseState | null;
  recordingEnabled: boolean;
  requireIdentity: boolean;
}

const rooms = new Map<string, Room>();

function send(socket: WebSocket, msg: VideoServerMessage) {
  if (socket.readyState === 1) socket.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: VideoServerMessage, except?: string) {
  for (const c of room.conns.values()) if (c.id !== except) send(c.socket, msg);
}

function peerOf(c: Conn): VideoPeer {
  return { id: c.id, kind: c.kind, name: c.name, recipientId: c.recipientId, consented: c.consented, identityConfirmed: c.identityConfirmed };
}

/** Falta el consentimiento de alguien conectado: no se puede grabar (ni seguir recibiendo fragmentos). */
function consentMissing(room: Room) {
  return room.recordingEnabled && [...room.conns.values()].some((c) => !c.consented);
}

async function activeRecording(db: Db, sessionId: string) {
  return db.one<any>(`SELECT * FROM video_recordings WHERE session_id = $1 AND status = 'recording' ORDER BY started_at DESC LIMIT 1`, [sessionId]);
}

async function recordingStatusMsg(db: Db, room: Room): Promise<VideoServerMessage> {
  const rec = await activeRecording(db, room.sessionId);
  return { type: "recording", status: rec ? "recording" : "idle", consentRequired: consentMissing(room) };
}

/** Termina la sala en memoria: avisa y cierra las conexiones. */
function closeRoom(sessionId: string) {
  const room = rooms.get(sessionId);
  if (!room) return;
  broadcast(room, { type: "ended" });
  for (const c of room.conns.values()) {
    try {
      c.socket.close(4000, "ended");
    } catch {
      // ya cerrada
    }
  }
  rooms.delete(sessionId);
}

// ───────────────────────────── Evidencia ─────────────────────────────

async function evidence(db: Db, tenantId: string, envelopeId: string, type: string, actor: Actor, data: Record<string, unknown>) {
  await db.tx(async (t) => {
    await t.query(`SELECT id FROM envelopes WHERE id = $1 FOR UPDATE`, [envelopeId]);
    await appendEvent(t, { tenantId, envelopeId, type, actor, data });
  });
}

// ───────────────────────────── Lectura ─────────────────────────────

async function loadSession(db: Db, envelopeId: string, sid: string) {
  const s = await db.one<any>(`SELECT * FROM video_sessions WHERE id = $1 AND envelope_id = $2`, [sid, envelopeId]);
  if (!s) throw notFound("Sala de video");
  return s;
}

async function toSession(db: Db, s: any): Promise<VideoSession> {
  const [host, parts, recs] = await Promise.all([
    db.one<any>(`SELECT name FROM users WHERE id = $1`, [s.host_user_id]),
    db.query<any>(`SELECT * FROM video_participants WHERE session_id = $1 ORDER BY kind, joined_at NULLS LAST, display_name`, [s.id]),
    db.query<any>(`SELECT * FROM video_recordings WHERE session_id = $1 ORDER BY started_at`, [s.id]),
  ]);
  const room = rooms.get(s.id);
  return {
    id: s.id,
    envelopeId: s.envelope_id,
    status: s.status,
    hostUserId: s.host_user_id,
    hostName: host?.name ?? "",
    scheduledAt: iso(s.scheduled_at),
    startedAt: iso(s.started_at),
    endedAt: iso(s.ended_at),
    requireIdentityConfirmation: s.require_identity,
    recordingEnabled: s.recording_enabled,
    invitedRecipientIds: s.invited_recipient_ids ?? [],
    participants: parts.map((p) => ({
      id: p.id,
      kind: p.kind,
      recipientId: p.recipient_id,
      userId: p.user_id,
      name: p.display_name,
      joinedAt: iso(p.joined_at),
      leftAt: iso(p.left_at),
      consentedAt: iso(p.consented_at),
      identityConfirmedAt: iso(p.identity_confirmed_at),
      identityNote: p.identity_note,
      online: Boolean(room?.conns.has(p.id)),
    })),
    recordings: recs.map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: iso(r.started_at)!,
      finishedAt: iso(r.finished_at),
      chunks: r.chunks,
      bytes: Number(r.bytes),
      sha256: r.sha256,
      mimeType: r.mime_type,
    })),
    createdAt: iso(s.created_at)!,
  };
}

/** Sala abierta (programada o activa) a la que está invitado este destinatario. */
async function openSessionForRecipient(db: Db, r: any) {
  const s = await db.one<any>(`SELECT * FROM video_sessions WHERE envelope_id = $1 AND status IN ('scheduled','active') ORDER BY created_at DESC LIMIT 1`, [
    r.envelope_id,
  ]);
  if (!s) return null;
  const invited: string[] = s.invited_recipient_ids ?? [];
  if (!invited.includes(r.id)) return null;
  return s;
}

// ───────────────────────────── Certificado y retención ─────────────────────────────

export interface CertificateVideoSession {
  host: string;
  startedAt: string | null;
  endedAt: string | null;
  participants: { name: string; role: "host" | "recipient"; joinedAt: string | null; consentedAt: string | null; identityConfirmedAt: string | null }[];
  recordings: { sha256: string; bytes: number; startedAt: string; finishedAt: string | null }[];
}

/** Sesiones de video del sobre (las que llegaron a empezar), para el certificado de finalización. */
export async function videoForCertificate(db: Db, envelopeId: string): Promise<CertificateVideoSession[]> {
  const sessions = await db.query<any>(
    `SELECT vs.*, u.name AS host_name, u.email AS host_email FROM video_sessions vs JOIN users u ON u.id = vs.host_user_id
     WHERE vs.envelope_id = $1 AND vs.started_at IS NOT NULL ORDER BY vs.started_at`,
    [envelopeId],
  );
  const out: CertificateVideoSession[] = [];
  for (const s of sessions) {
    const parts = await db.query<any>(`SELECT * FROM video_participants WHERE session_id = $1 AND joined_at IS NOT NULL ORDER BY joined_at`, [s.id]);
    const recs = await db.query<any>(`SELECT * FROM video_recordings WHERE session_id = $1 AND sha256 IS NOT NULL ORDER BY started_at`, [s.id]);
    out.push({
      host: `${s.host_name} <${s.host_email}>`,
      startedAt: iso(s.started_at),
      endedAt: iso(s.ended_at),
      participants: parts.map((p) => ({
        name: p.display_name,
        role: p.kind,
        joinedAt: iso(p.joined_at),
        consentedAt: iso(p.consented_at),
        identityConfirmedAt: iso(p.identity_confirmed_at),
      })),
      recordings: recs.map((r) => ({ sha256: r.sha256, bytes: Number(r.bytes), startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at) })),
    });
  }
  return out;
}

const chunkKey = (prefix: string, seq: number) => `${prefix}${String(seq).padStart(6, "0")}.bin`;

/** Retención: borra los fragmentos de las grabaciones del sobre. Devuelve cuántos borrados fallaron. */
export async function purgeVideoRecordings(d: { db: Db; blobs: BlobStore; log: { error(o: object, m?: string): void } }, envelopeId: string): Promise<number> {
  const recs = await d.db.query<any>(`SELECT * FROM video_recordings WHERE envelope_id = $1 AND purged_at IS NULL AND status <> 'recording'`, [envelopeId]);
  let failed = 0;
  for (const r of recs) {
    const chunks = await d.db.query<any>(`SELECT seq FROM video_recording_chunks WHERE recording_id = $1`, [r.id]);
    let ok = true;
    for (const c of chunks) {
      try {
        await d.blobs.delete(chunkKey(r.storage_prefix, c.seq));
      } catch (err) {
        ok = false;
        d.log.error({ envelopeId, recordingId: r.id, seq: c.seq, err: String(err) }, "retención: no se pudo borrar un fragmento de video");
      }
    }
    if (ok) await d.db.query(`UPDATE video_recordings SET purged_at = now(), status = 'purged' WHERE id = $1`, [r.id]);
    else failed++;
  }
  return failed;
}

// ───────────────────────────── Grabación ─────────────────────────────

/** Cierra una grabación: calcula el SHA-256 de los fragmentos descifrados en orden y lo deja en la evidencia. */
async function finishRecording(s: Services, rec: any, actor: Actor) {
  const chunks = await s.db.query<any>(`SELECT seq, sha256, bytes FROM video_recording_chunks WHERE recording_id = $1 ORDER BY seq`, [rec.id]);
  if (!chunks.length) {
    await s.db.query(`UPDATE video_recordings SET status = 'failed', finished_at = now() WHERE id = $1`, [rec.id]);
    return null;
  }
  const h = createHash("sha256");
  let bytes = 0;
  for (const c of chunks) {
    const plain = decryptBytes(await s.blobs.get(chunkKey(rec.storage_prefix, c.seq)));
    if (sha256Hex(plain) !== c.sha256) throw new AppError(500, "recording_corrupt", `El fragmento ${c.seq} no coincide con su hash`);
    h.update(plain);
    bytes += plain.length;
  }
  const sha256 = h.digest("hex");
  await s.db.query(`UPDATE video_recordings SET status = 'stored', finished_at = now(), sha256 = $2, bytes = $3, chunks = $4 WHERE id = $1`, [
    rec.id,
    sha256,
    bytes,
    chunks.length,
  ]);
  await evidence(s.db, rec.tenant_id, rec.envelope_id, "video.recording_stored", actor, {
    sessionId: rec.session_id,
    recordingId: rec.id,
    sha256,
    bytes,
    chunks: chunks.length,
    mimeType: rec.mime_type,
  });
  return { sha256, bytes, chunks: chunks.length };
}

// ───────────────────────────── Invitaciones ─────────────────────────────

const INVITE = {
  es: {
    subject: (subj: string) => `Videollamada para firmar "${subj}"`,
    text: (host: string, subj: string, when: string | null, link: string) =>
      `${host} te invita a una videollamada para revisar y firmar "${subj}"${when ? ` (${when} UTC)` : ""}.\nEntrá desde este link: ${link}\nLa sesión puede grabarse: se te va a pedir tu consentimiento antes.`,
  },
  "pt-BR": {
    subject: (subj: string) => `Videochamada para assinar "${subj}"`,
    text: (host: string, subj: string, when: string | null, link: string) =>
      `${host} convida você para uma videochamada para revisar e assinar "${subj}"${when ? ` (${when} UTC)` : ""}.\nEntre por este link: ${link}\nA sessão pode ser gravada: seu consentimento será solicitado antes.`,
  },
  en: {
    subject: (subj: string) => `Video call to sign "${subj}"`,
    text: (host: string, subj: string, when: string | null, link: string) =>
      `${host} invites you to a video call to review and sign "${subj}"${when ? ` (${when} UTC)` : ""}.\nJoin from this link: ${link}\nThe session may be recorded: you will be asked for your consent first.`,
  },
};

async function sendInvites(s: Services, e: any, session: any, hostName: string) {
  const recips = await s.db.query<any>(`SELECT * FROM recipients WHERE id = ANY($1::uuid[])`, [session.invited_recipient_ids]);
  const base = await tenantBaseUrl(s.db, e.tenant_id);
  let sent = 0;
  for (const r of recips) {
    if (!r.access_token_enc || r.embedded || r.auth_method === "in_person") continue;
    const locale = normLocale(r.locale ?? e.locale);
    const t = INVITE[locale];
    const link = `${base}/s/${decrypt(r.access_token_enc)}?video=1`;
    const when = session.scheduled_at ? new Date(session.scheduled_at).toISOString().slice(0, 16).replace("T", " ") : null;
    for (const channel of (r.channels ?? ["email"]) as string[]) {
      const to = channel === "email" ? r.email : channel === "whatsapp" ? r.phone : channel === "telegram" ? r.telegram_chat_id : null;
      if (!to) continue;
      try {
        const res = await deliver({
          channel: channel as "email" | "whatsapp" | "telegram",
          to,
          subject: t.subject(e.subject),
          text: t.text(hostName, e.subject, when, link),
          link,
          locale,
          tenantId: e.tenant_id,
          templateParams: [hostName, e.subject, link],
        });
        await s.db.query(
          `INSERT INTO notifications (id, tenant_id, envelope_id, recipient_id, channel, template, destination, status, provider, provider_message_id, sent_at)
           VALUES ($1,$2,$3,$4,$5,'video_invite',$6,'sent',$7,$8,now())`,
          [uuidv7(), e.tenant_id, e.id, r.id, channel, to, res.provider, res.messageId],
        );
        sent++;
      } catch (err) {
        await s.db.query(
          `INSERT INTO notifications (id, tenant_id, envelope_id, recipient_id, channel, template, destination, status, error) VALUES ($1,$2,$3,$4,$5,'video_invite',$6,'failed',$7)`,
          [uuidv7(), e.tenant_id, e.id, r.id, channel, to, String(err).slice(0, 1000)],
        );
      }
    }
  }
  return sent;
}

// ───────────────────────────── WebSocket: alta de una conexión ─────────────────────────────

interface JoinSpec {
  session: any;
  kind: "host" | "recipient";
  recipientId: string | null;
  userId: string | null;
  name: string;
  actor: Actor;
  ip: string | null;
  userAgent: string | null;
}

async function joinRoom(s: Services, socket: WebSocket, spec: JoinSpec) {
  const { session } = spec;
  const fail = (code: string, message: string) => {
    send(socket, { type: "error", code, message });
    socket.close(4001, code);
  };
  if (session.status === "ended") return fail("session_ended", "La sala de video ya terminó");

  // Participante (persistente: el id sirve de id de par entre reconexiones).
  const existing = spec.kind === "host"
    ? await s.db.one<any>(`SELECT * FROM video_participants WHERE session_id = $1 AND kind = 'host' AND user_id = $2`, [session.id, spec.userId])
    : await s.db.one<any>(`SELECT * FROM video_participants WHERE session_id = $1 AND recipient_id = $2`, [session.id, spec.recipientId]);
  const pid = existing?.id ?? uuidv7();

  let room = rooms.get(session.id);
  if (!room) {
    room = {
      sessionId: session.id,
      envelopeId: session.envelope_id,
      tenantId: session.tenant_id,
      hostParticipantId: null,
      conns: new Map(),
      controller: null,
      cobrowse: null,
      recordingEnabled: session.recording_enabled,
      requireIdentity: session.require_identity,
    };
    rooms.set(session.id, room);
  }
  // Reconexión del mismo participante: se reemplaza la conexión anterior.
  const prev = room.conns.get(pid);
  if (prev) {
    room.conns.delete(pid);
    try {
      prev.socket.close(4002, "replaced");
    } catch {
      // ya cerrada
    }
  } else if (room.conns.size >= VIDEO_MAX_PARTICIPANTS) {
    return fail("room_full", `La sala admite hasta ${VIDEO_MAX_PARTICIPANTS} participantes`);
  }

  if (existing) {
    await s.db.query(`UPDATE video_participants SET joined_at = COALESCE(joined_at, now()), left_at = NULL, ip = $2, user_agent = $3 WHERE id = $1`, [
      pid,
      spec.ip,
      spec.userAgent,
    ]);
  } else {
    await s.db.query(
      `INSERT INTO video_participants (id, session_id, kind, recipient_id, user_id, display_name, joined_at, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8)`,
      [pid, session.id, spec.kind, spec.recipientId, spec.userId, spec.name, spec.ip, spec.userAgent],
    );
  }
  const row = await s.db.one<any>(`SELECT * FROM video_participants WHERE id = $1`, [pid]);

  // El anfitrión abre la sala: pasa a activa (una sola vez).
  if (spec.kind === "host") {
    room.hostParticipantId = pid;
    const started = await s.db.query(`UPDATE video_sessions SET status = 'active', started_at = now() WHERE id = $1 AND status = 'scheduled' RETURNING id`, [
      session.id,
    ]);
    if (started.length) {
      await evidence(s.db, session.tenant_id, session.envelope_id, "video.session_started", spec.actor, {
        sessionId: session.id,
        recordingEnabled: session.recording_enabled,
        requireIdentityConfirmation: session.require_identity,
      });
    }
  }

  const conn: Conn = {
    id: pid,
    kind: spec.kind,
    name: spec.name,
    recipientId: spec.recipientId,
    userId: spec.userId,
    socket,
    actor: spec.actor,
    consented: Boolean(row.consented_at),
    identityConfirmed: Boolean(row.identity_confirmed_at),
  };
  room.conns.set(pid, conn);
  // Control de la co-navegación: lo conserva quien lo tenga; si no hay nadie, lo toma el anfitrión.
  if (!room.controller || !room.conns.has(room.controller)) {
    room.controller = room.hostParticipantId && room.conns.has(room.hostParticipantId) ? room.hostParticipantId : null;
  }

  await evidence(s.db, session.tenant_id, session.envelope_id, "video.participant_joined", spec.actor, {
    sessionId: session.id,
    participantId: pid,
    kind: spec.kind,
    recipientId: spec.recipientId,
    name: spec.name,
  });

  const rec = await activeRecording(s.db, session.id);
  send(socket, {
    type: "welcome",
    you: peerOf(conn),
    peers: [...room.conns.values()].filter((c) => c.id !== pid).map(peerOf),
    iceServers: iceServersFor(pid),
    controller: room.controller,
    cobrowse: room.cobrowse,
    recording: { status: rec ? "recording" : "idle", consentRequired: consentMissing(room) },
    session: { id: session.id, envelopeId: session.envelope_id, requireIdentityConfirmation: session.require_identity, recordingEnabled: session.recording_enabled },
  });
  broadcast(room, { type: "peer_joined", peer: peerOf(conn) }, pid);
  broadcast(room, { type: "control", controller: room.controller ?? "" });
  broadcast(room, await recordingStatusMsg(s.db, room));

  const r = room;
  socket.on("message", (raw) => {
    void onMessage(s, r, conn, raw.toString()).catch((err) => send(socket, { type: "error", code: "internal", message: String(err).slice(0, 200) }));
  });
  socket.on("close", () => {
    void onClose(s, r, conn).catch(() => {});
  });
}

async function onMessage(s: Services, room: Room, me: Conn, raw: string) {
  if (raw.length > 200_000) return send(me.socket, { type: "error", code: "too_large", message: "Mensaje demasiado grande" });
  let msg: VideoClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return send(me.socket, { type: "error", code: "bad_json", message: "JSON inválido" });
  }
  if (room.conns.get(me.id) !== me) return; // conexión reemplazada
  switch (msg.type) {
    case "ping":
      return send(me.socket, { type: "pong" });
    case "signal": {
      const to = room.conns.get(String(msg.to));
      if (!to) return send(me.socket, { type: "error", code: "unknown_peer", message: "El participante no está conectado" });
      return send(to.socket, { type: "signal", from: me.id, data: msg.data });
    }
    case "cobrowse": {
      if (room.controller !== me.id) return send(me.socket, { type: "error", code: "not_controller", message: "Otro participante guía el documento" });
      const st = msg.state ?? ({} as CobrowseState);
      const clean: CobrowseState = {
        documentId: typeof st.documentId === "string" ? st.documentId.slice(0, 64) : null,
        page: Number.isFinite(st.page) ? Math.max(0, Math.min(10_000, Math.floor(st.page))) : 0,
        scroll: Number.isFinite(st.scroll) ? Math.max(0, Math.min(1, st.scroll)) : 0,
        zoom: Number.isFinite(st.zoom) ? Math.max(0.25, Math.min(4, st.zoom)) : 1,
        fieldId: typeof st.fieldId === "string" ? st.fieldId.slice(0, 64) : null,
      };
      room.cobrowse = clean;
      return broadcast(room, { type: "cobrowse", from: me.id, state: clean }, me.id);
    }
    case "control": {
      const target = String(msg.to);
      // El anfitrión da el control a cualquiera; quien lo tiene puede devolvérselo al anfitrión.
      const allowed = me.kind === "host" || (room.controller === me.id && target === room.hostParticipantId);
      if (!allowed) return send(me.socket, { type: "error", code: "forbidden", message: "Solo el anfitrión reparte el control" });
      if (!room.conns.has(target)) return send(me.socket, { type: "error", code: "unknown_peer", message: "El participante no está conectado" });
      room.controller = target;
      return broadcast(room, { type: "control", controller: target });
    }
    case "consent": {
      if (msg.granted !== true || me.consented) return;
      const upd = await s.db.query(`UPDATE video_participants SET consented_at = now() WHERE id = $1 AND consented_at IS NULL RETURNING id`, [me.id]);
      me.consented = true;
      if (upd.length) {
        await evidence(s.db, room.tenantId, room.envelopeId, "video.recording_consented", me.actor, {
          sessionId: room.sessionId,
          participantId: me.id,
          name: me.name,
        });
      }
      broadcast(room, { type: "peer_updated", peer: peerOf(me) });
      return broadcast(room, await recordingStatusMsg(s.db, room));
    }
    default:
      return send(me.socket, { type: "error", code: "unknown_type", message: "Tipo de mensaje desconocido" });
  }
}

async function onClose(s: Services, room: Room, me: Conn) {
  if (room.conns.get(me.id) !== me) return; // ya reemplazada por una reconexión
  room.conns.delete(me.id);
  await s.db.query(`UPDATE video_participants SET left_at = now() WHERE id = $1`, [me.id]);
  const session = await s.db.one<any>(`SELECT status FROM video_sessions WHERE id = $1`, [room.sessionId]);
  if (session?.status !== "ended") {
    await evidence(s.db, room.tenantId, room.envelopeId, "video.participant_left", me.actor, { sessionId: room.sessionId, participantId: me.id, name: me.name });
  }
  broadcast(room, { type: "peer_left", id: me.id });
  if (room.controller === me.id) {
    room.controller = room.hostParticipantId && room.conns.has(room.hostParticipantId) ? room.hostParticipantId : null;
    broadcast(room, { type: "control", controller: room.controller ?? "" });
  }
  if (room.conns.size === 0) rooms.delete(room.sessionId);
  else broadcast(room, await recordingStatusMsg(s.db, room));
}

// ───────────────────────────── Rutas ─────────────────────────────

export async function videoRoutes(app: FastifyInstance, s: Services) {
  const auth = authenticate(s);
  const A = (req: FastifyRequest) => req.auth as AuthContext;
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });

  type EP = { Params: { id: string; sid?: string; pid?: string; rid?: string; seq?: string } };
  type TP = { Params: { token: string } };

  // Firma con identidad confirmada en cámara: si la sala lo exige, /complete espera la confirmación del anfitrión.
  app.addHook("preHandler", async (req: FastifyRequest) => {
    if (req.routeOptions?.url !== "/v1/signing/:token/complete") return;
    const token = (req.params as { token?: string }).token ?? "";
    const { recipient: r } = await resolveToken(s.db, token);
    const need = await s.db.one<any>(
      `SELECT 1 FROM video_sessions vs WHERE vs.envelope_id = $1 AND vs.require_identity AND vs.status <> 'ended' AND $2 = ANY(vs.invited_recipient_ids)
         AND NOT EXISTS (SELECT 1 FROM video_participants vp WHERE vp.recipient_id = $2 AND vp.identity_confirmed_at IS NOT NULL)`,
      [r.envelope_id, r.id],
    );
    if (need) throw new AppError(403, "identity_confirmation_required", "El anfitrión tiene que confirmar tu identidad en la videollamada antes de firmar");
  });

  // ───────── Remitente ─────────

  app.post<EP>("/v1/envelopes/:id/video-sessions", { preHandler: auth }, async (req, reply) => {
    const a = A(req);
    if (!a.userId) throw forbidden("La sala de video la abre un usuario de la organización, no una API key");
    const input = CreateVideoSessionInput.parse(req.body ?? {});
    const id = uuidv7();
    let created: any;
    let envelope: any;
    await s.db.tx(async (t) => {
      const e = await lockEnvelope(t, a.tenantId, req.params.id);
      if (e.status !== "sent") throw conflict("not_in_progress", "La videollamada se abre con el sobre enviado y en curso");
      const open = await t.one(`SELECT 1 FROM video_sessions WHERE envelope_id = $1 AND status IN ('scheduled','active')`, [e.id]);
      if (open) throw conflict("session_open", "Ya hay una sala de video abierta para este sobre");
      const pending = await t.query<any>(
        `SELECT id FROM recipients WHERE envelope_id = $1 AND role IN ('signer','approver') AND status IN ('created','sent','viewed') ORDER BY routing_order, created_at`,
        [e.id],
      );
      let invited = input.recipientIds ?? pending.map((x) => x.id).slice(0, VIDEO_MAX_PARTICIPANTS - 1);
      invited = [...new Set(invited)];
      if (!invited.length) throw badRequest("no_recipients", "No hay firmantes pendientes para invitar");
      if (invited.length > VIDEO_MAX_PARTICIPANTS - 1) throw badRequest("too_many", `La sala admite hasta ${VIDEO_MAX_PARTICIPANTS - 1} firmantes además del anfitrión`);
      const valid = await t.query<any>(`SELECT id FROM recipients WHERE envelope_id = $1 AND id = ANY($2::uuid[])`, [e.id, invited]);
      if (valid.length !== invited.length) throw badRequest("invalid_recipient", "Hay destinatarios que no son de este sobre");
      created = await t.one<any>(
        `INSERT INTO video_sessions (id, tenant_id, envelope_id, host_user_id, scheduled_at, invited_recipient_ids, require_identity, recording_enabled, message)
         VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9) RETURNING *`,
        [id, a.tenantId, e.id, a.userId, input.scheduledAt ?? null, invited, input.requireIdentityConfirmation, input.recordingEnabled, input.message ?? null],
      );
      await appendEvent(t, {
        tenantId: a.tenantId,
        envelopeId: e.id,
        type: "video.session_scheduled",
        actor: a.actor,
        data: {
          sessionId: id,
          scheduledAt: input.scheduledAt ?? null,
          invitedRecipientIds: invited,
          requireIdentityConfirmation: input.requireIdentityConfirmation,
          recordingEnabled: input.recordingEnabled,
        },
      });
      envelope = e;
    });
    if (input.notify) {
      const host = await s.db.one<any>(`SELECT name FROM users WHERE id = $1`, [a.userId]);
      await sendInvites(s, envelope, created, host?.name ?? "");
    }
    reply.code(201);
    return toSession(s.db, created);
  });

  app.get<EP>("/v1/envelopes/:id/video-sessions", { preHandler: auth }, async (req) => {
    const a = A(req);
    const e = await s.db.one(`SELECT 1 FROM envelopes WHERE id = $1 AND tenant_id = $2`, [req.params.id, a.tenantId]);
    if (!e) throw notFound("Sobre");
    const rows = await s.db.query<any>(`SELECT * FROM video_sessions WHERE envelope_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    return { items: await Promise.all(rows.map((r) => toSession(s.db, r))) };
  });

  app.get<EP>("/v1/envelopes/:id/video-sessions/:sid", { preHandler: auth }, async (req) => {
    await assertTenantEnvelope(s.db, A(req), req.params.id);
    return toSession(s.db, await loadSession(s.db, req.params.id, req.params.sid!));
  });

  app.post<EP>("/v1/envelopes/:id/video-sessions/:sid/invite", { preHandler: auth }, async (req) => {
    const a = A(req);
    const e = await assertTenantEnvelope(s.db, a, req.params.id);
    const session = await loadSession(s.db, req.params.id, req.params.sid!);
    if (session.status === "ended") throw conflict("session_ended", "La sala de video ya terminó");
    const host = await s.db.one<any>(`SELECT name FROM users WHERE id = $1`, [session.host_user_id]);
    return { sent: await sendInvites(s, e, session, host?.name ?? "") };
  });

  app.post<EP>("/v1/envelopes/:id/video-sessions/:sid/end", { preHandler: auth }, async (req) => {
    const a = A(req);
    await assertTenantEnvelope(s.db, a, req.params.id);
    const session = await loadSession(s.db, req.params.id, req.params.sid!);
    if (session.status === "ended") return toSession(s.db, session);
    const rec = await activeRecording(s.db, session.id);
    if (rec) await finishRecording(s, rec, a.actor);
    await s.db.query(`UPDATE video_sessions SET status = 'ended', ended_at = now() WHERE id = $1`, [session.id]);
    await s.db.query(`UPDATE video_participants SET left_at = COALESCE(left_at, now()) WHERE session_id = $1`, [session.id]);
    const parts = await s.db.query<any>(`SELECT display_name, kind FROM video_participants WHERE session_id = $1 AND joined_at IS NOT NULL`, [session.id]);
    await evidence(s.db, session.tenant_id, session.envelope_id, "video.session_ended", a.actor, {
      sessionId: session.id,
      participants: parts.map((p) => ({ name: p.display_name, kind: p.kind })),
    });
    closeRoom(session.id);
    return toSession(s.db, await loadSession(s.db, req.params.id, req.params.sid!));
  });

  // Identidad confirmada en cámara por el anfitrión.
  app.post<EP>("/v1/envelopes/:id/video-sessions/:sid/participants/:pid/identity", { preHandler: auth }, async (req) => {
    const a = A(req);
    const input = VideoIdentityInput.parse(req.body);
    await assertTenantEnvelope(s.db, a, req.params.id);
    const session = await loadSession(s.db, req.params.id, req.params.sid!);
    if (session.status !== "active") throw conflict("session_not_active", "La sala de video no está activa");
    if (session.host_user_id !== a.userId) throw forbidden("Solo el anfitrión de la sala confirma identidades");
    const p = await s.db.one<any>(`SELECT * FROM video_participants WHERE id = $1 AND session_id = $2`, [req.params.pid, session.id]);
    if (!p || p.kind !== "recipient") throw notFound("Participante");
    const r = await s.db.one<any>(`SELECT * FROM recipients WHERE id = $1`, [p.recipient_id]);
    const host = await s.db.one<any>(`SELECT name, email FROM users WHERE id = $1`, [a.userId]);
    await s.db.query(`UPDATE video_participants SET identity_confirmed_at = $2, identity_note = $3 WHERE id = $1`, [
      p.id,
      input.confirmed ? new Date().toISOString() : null,
      input.note ?? null,
    ]);
    await evidence(s.db, session.tenant_id, session.envelope_id, input.confirmed ? "recipient.identity_confirmed" : "recipient.identity_rejected", a.actor, {
      method: "video",
      sessionId: session.id,
      recipientId: p.recipient_id,
      recipientName: r?.name ?? p.display_name,
      host: host ? `${host.name} <${host.email}>` : null,
      note: input.note ?? null,
      idDocumentDeclared: input.idDocumentNumber ? maskDestination(input.idDocumentNumber) : null,
      idDocumentMatches:
        input.idDocumentNumber && r?.id_document_number
          ? input.idDocumentNumber.replace(/\W/g, "").toUpperCase() === String(r.id_document_number).replace(/\W/g, "").toUpperCase()
          : null,
    });
    const room = rooms.get(session.id);
    const conn = room?.conns.get(p.id);
    if (room && conn) {
      conn.identityConfirmed = input.confirmed;
      broadcast(room, { type: "peer_updated", peer: peerOf(conn) });
    }
    return toSession(s.db, session);
  });

  // ───────── Grabación (la sube el navegador del anfitrión) ─────────

  app.post<EP>("/v1/envelopes/:id/video-sessions/:sid/recording/start", { preHandler: auth }, async (req) => {
    const a = A(req);
    await assertTenantEnvelope(s.db, a, req.params.id);
    const session = await loadSession(s.db, req.params.id, req.params.sid!);
    if (session.host_user_id !== a.userId) throw forbidden("Solo el anfitrión graba la sesión");
    if (session.status !== "active") throw conflict("session_not_active", "La sala de video no está activa");
    if (!session.recording_enabled) throw conflict("recording_disabled", "Esta sala se creó sin grabación");
    const room = rooms.get(session.id);
    if (!room || !room.hostParticipantId || !room.conns.has(room.hostParticipantId)) throw conflict("host_offline", "El anfitrión tiene que estar conectado a la sala");
    if (room.conns.size < 2) throw conflict("alone", "Hace falta al menos otro participante conectado");
    if (consentMissing(room)) throw conflict("consent_required", "Falta el consentimiento de grabación de algún participante", {
      missing: [...room.conns.values()].filter((c) => !c.consented).map((c) => c.name),
    });
    if (await activeRecording(s.db, session.id)) throw conflict("already_recording", "Ya se está grabando");
    const rid = uuidv7();
    const mime = typeof (req.body as any)?.mimeType === "string" && /^video\/webm(;.*)?$/.test((req.body as any).mimeType) ? (req.body as any).mimeType : "video/webm";
    const prefix = `tenants/${session.tenant_id}/envelopes/${session.envelope_id}/video/${session.id}/${rid}/`;
    await s.db.query(`INSERT INTO video_recordings (id, session_id, tenant_id, envelope_id, mime_type, storage_prefix) VALUES ($1,$2,$3,$4,$5,$6)`, [
      rid,
      session.id,
      session.tenant_id,
      session.envelope_id,
      mime,
      prefix,
    ]);
    await evidence(s.db, session.tenant_id, session.envelope_id, "video.recording_started", a.actor, {
      sessionId: session.id,
      recordingId: rid,
      consentedBy: [...room.conns.values()].map((c) => c.name),
    });
    broadcast(room, await recordingStatusMsg(s.db, room));
    return { recordingId: rid };
  });

  // Fragmentos: cuerpo binario (video/webm u octet-stream), en orden.
  await app.register(async (sub) => {
    sub.addContentTypeParser(["video/webm", "application/octet-stream"], { parseAs: "buffer", bodyLimit: VIDEO_CHUNK_MAX_BYTES }, (_req, body, done) =>
      done(null, body),
    );
    sub.put<EP>("/v1/envelopes/:id/video-sessions/:sid/recording/chunks/:seq", { preHandler: auth, bodyLimit: VIDEO_CHUNK_MAX_BYTES }, async (req) => {
      const a = A(req);
      await assertTenantEnvelope(s.db, a, req.params.id);
      const session = await loadSession(s.db, req.params.id, req.params.sid!);
      if (session.host_user_id !== a.userId) throw forbidden("Solo el anfitrión sube la grabación");
      const rec = await activeRecording(s.db, session.id);
      if (!rec) throw conflict("not_recording", "No hay una grabación en curso");
      const room = rooms.get(session.id);
      if (!room || consentMissing(room)) throw conflict("consent_required", "Falta el consentimiento de grabación de algún participante conectado");
      const seq = Number(req.params.seq);
      if (!Number.isInteger(seq) || seq < 0 || seq >= VIDEO_MAX_CHUNKS) throw badRequest("invalid_seq", "Número de fragmento inválido");
      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("empty_chunk", "Fragmento vacío");
      const hash = sha256Hex(body);
      const prev = await s.db.one<any>(`SELECT sha256 FROM video_recording_chunks WHERE recording_id = $1 AND seq = $2`, [rec.id, seq]);
      if (prev) {
        if (prev.sha256 === hash) return { seq, sha256: hash, duplicate: true }; // reintento idempotente
        throw conflict("chunk_exists", "Ese fragmento ya se subió con otro contenido");
      }
      if (seq !== rec.chunks) throw conflict("out_of_order", `Se esperaba el fragmento ${rec.chunks}`, { expected: rec.chunks });
      await s.blobs.put(chunkKey(rec.storage_prefix, seq), encryptBytes(new Uint8Array(body)), "application/octet-stream");
      await s.db.tx(async (t) => {
        await t.query(`INSERT INTO video_recording_chunks (recording_id, seq, bytes, sha256) VALUES ($1,$2,$3,$4)`, [rec.id, seq, body.length, hash]);
        await t.query(`UPDATE video_recordings SET chunks = chunks + 1, bytes = bytes + $2 WHERE id = $1`, [rec.id, body.length]);
      });
      return { seq, sha256: hash };
    });
  });

  app.post<EP>("/v1/envelopes/:id/video-sessions/:sid/recording/stop", { preHandler: auth }, async (req) => {
    const a = A(req);
    await assertTenantEnvelope(s.db, a, req.params.id);
    const session = await loadSession(s.db, req.params.id, req.params.sid!);
    if (session.host_user_id !== a.userId) throw forbidden("Solo el anfitrión detiene la grabación");
    const rec = await activeRecording(s.db, session.id);
    if (!rec) throw conflict("not_recording", "No hay una grabación en curso");
    const res = await finishRecording(s, rec, a.actor);
    const room = rooms.get(session.id);
    if (room) broadcast(room, await recordingStatusMsg(s.db, room));
    if (!res) throw conflict("empty_recording", "La grabación no tenía fragmentos y se descartó");
    return { recordingId: rec.id, ...res };
  });

  app.get<EP>("/v1/envelopes/:id/video-sessions/:sid/recordings/:rid", { preHandler: auth }, async (req, reply: FastifyReply) => {
    await assertTenantEnvelope(s.db, A(req), req.params.id);
    const rec = await s.db.one<any>(`SELECT * FROM video_recordings WHERE id = $1 AND session_id = $2 AND envelope_id = $3`, [
      req.params.rid,
      req.params.sid,
      req.params.id,
    ]);
    if (!rec) throw notFound("Grabación");
    if (rec.status === "purged") throw new AppError(410, "purged", "La grabación se eliminó por la política de retención");
    if (rec.status !== "stored") throw conflict("not_ready", "La grabación todavía no está cerrada");
    const chunks = await s.db.query<any>(`SELECT seq FROM video_recording_chunks WHERE recording_id = $1 ORDER BY seq`, [rec.id]);
    const parts: Buffer[] = [];
    for (const c of chunks) parts.push(Buffer.from(decryptBytes(await s.blobs.get(chunkKey(rec.storage_prefix, c.seq)))));
    const data = Buffer.concat(parts);
    reply
      .header("content-type", rec.mime_type.split(";")[0])
      .header("content-disposition", `attachment; filename="sesion-video-${rec.id}.webm"`)
      .header("x-content-sha256", rec.sha256 ?? "")
      .header("cache-control", "private, no-store");
    return reply.send(data);
  });

  // WebSocket del anfitrión (cookie de sesión). El permiso de gestionar el sobre lo exige access.ts.
  app.get<EP>("/v1/envelopes/:id/video-sessions/:sid/ws", { websocket: true, preHandler: auth }, async (socket, req) => {
    const a = A(req);
    try {
      const session = await loadSession(s.db, req.params.id, req.params.sid!);
      if (session.tenant_id !== a.tenantId) throw notFound("Sala de video");
      if (!a.userId || session.host_user_id !== a.userId) {
        send(socket, { type: "error", code: "forbidden", message: "Solo el anfitrión de la sala entra como anfitrión" });
        return socket.close(4003, "forbidden");
      }
      const u = await s.db.one<any>(`SELECT name FROM users WHERE id = $1`, [a.userId]);
      const { ip, userAgent } = clientInfo(req);
      await joinRoom(s, socket, { session, kind: "host", recipientId: null, userId: a.userId, name: u?.name ?? "Anfitrión", actor: a.actor, ip, userAgent });
    } catch (err) {
      send(socket, { type: "error", code: (err as AppError).code ?? "internal", message: String((err as Error).message ?? err).slice(0, 200) });
      socket.close(4004, "error");
    }
  });

  // ───────── Firmante (link de firma; los hooks de OTP e identidad aplican a /v1/signing/:token/*) ─────────

  app.get<TP>("/v1/signing/:token/video", async (req): Promise<SignerVideoInfo> => {
    const { recipient: r } = await resolveToken(s.db, req.params.token);
    const session = await openSessionForRecipient(s.db, r);
    if (!session) return { session: null };
    const host = await s.db.one<any>(`SELECT name FROM users WHERE id = $1`, [session.host_user_id]);
    const part = await s.db.one<any>(`SELECT identity_confirmed_at FROM video_participants WHERE session_id = $1 AND recipient_id = $2`, [session.id, r.id]);
    return {
      session: {
        id: session.id,
        status: session.status,
        scheduledAt: iso(session.scheduled_at),
        hostName: host?.name ?? "",
        requireIdentityConfirmation: session.require_identity,
        recordingEnabled: session.recording_enabled,
        identityConfirmed: Boolean(part?.identity_confirmed_at),
      },
    };
  });

  app.get<TP>("/v1/signing/:token/video/ws", { websocket: true }, async (socket, req) => {
    try {
      const { recipient: r, envelope: e } = await resolveToken(s.db, req.params.token);
      if (e.status !== "sent") {
        send(socket, { type: "error", code: "envelope_closed", message: "El sobre ya no está en curso" });
        return socket.close(4005, "closed");
      }
      const session = await openSessionForRecipient(s.db, r);
      if (!session) {
        send(socket, { type: "error", code: "no_session", message: "No hay una sala de video abierta para vos" });
        return socket.close(4006, "no_session");
      }
      const { ip, userAgent } = clientInfo(req);
      await joinRoom(s, socket, { session, kind: "recipient", recipientId: r.id, userId: null, name: r.name, actor: recipientActor(req, r), ip, userAgent });
    } catch (err) {
      send(socket, { type: "error", code: (err as AppError).code ?? "internal", message: String((err as Error).message ?? err).slice(0, 200) });
      socket.close(4004, "error");
    }
  });
}

async function assertTenantEnvelope(db: Db, a: AuthContext, envelopeId: string) {
  const e = await db.one<any>(`SELECT * FROM envelopes WHERE id = $1 AND tenant_id = $2`, [envelopeId, a.tenantId]);
  if (!e) throw notFound("Sobre");
  return e;
}

/** Solo para pruebas: salas en memoria. */
export function _videoRoomsForTests() {
  return rooms;
}

