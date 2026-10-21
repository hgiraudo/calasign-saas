// Certificado de evidencia "portable" que acompaña al PDF sellado cuando se lo deja en un sistema externo (gestor
// documental, legajo del HRIS, registro del CLM). El PDF sellado ya lleva el certificado de finalización en sus
// últimas páginas; este JSON agrega la cadena de eventos con sus hashes para que el sistema de origen conserve la
// evidencia sin depender de CalaSign: cada evento trae todo lo que cubre su hash (y el cuerpo canónico exacto), así
// que la cadena se puede recalcular afuera (receta en "howToVerify"). El PDF se verifica subiéndolo a /verify (o POST /v1/verify).
import type { Db } from "../../infra/db";
import type { BlobStore } from "../../infra/storage";
import { GENESIS_HASH } from "../../infra/evidence";
import { canonicalJson, iso } from "../../lib/util";
import { brandForEnvelope, rebrands } from "../white-label/brand";

export interface SignedBundle {
  subject: string;
  sha256: string;
  pdf: Uint8Array;
  /** Nombre base sin extensión ("Contrato ACME - 0190ab12-…", con el id completo del sobre). */
  baseName: string;
}

const safeSubject = (subject: string) => subject.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "documento";

/**
 * Nombre base del archivo exportado: asunto + id COMPLETO del sobre. Con solo los primeros 8 caracteres (el prefijo
 * de tiempo de un uuidv7, que se repite durante ~65 s) dos sobres con el mismo asunto completados casi juntos (un
 * envío masivo) compartían nombre, y un destino que escribe por nombre (S3, Dropbox) pisaba el PDF de otro sobre.
 */
export function safeBaseName(subject: string, envelopeId: string) {
  return `${safeSubject(subject)} - ${envelopeId}`;
}

/** Nombre que se usaba antes (8 caracteres del id): solo para reconocer lo que subió un intento previo al cambio. */
export function legacySafeBaseName(subject: string, envelopeId: string) {
  return `${safeSubject(subject)} - ${envelopeId.slice(0, 8)}`;
}

/** PDF sellado del sobre (null si todavía no está completo). */
export async function loadSignedBundle(db: Db, blobs: BlobStore, envelopeId: string): Promise<SignedBundle | null> {
  const e = await db.one<any>(
    `SELECT e.subject, e.status, f.storage_key, f.sha256 FROM envelopes e JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1`,
    [envelopeId],
  );
  if (!e || e.status !== "completed") return null;
  return { subject: e.subject, sha256: e.sha256, pdf: await blobs.get(e.storage_key), baseName: safeBaseName(e.subject, envelopeId) };
}

/** JSON del certificado de evidencia (bytes UTF-8). */
/** opts.signedSha256: el hash del PDF que acompaña a este JSON (el que se subió, aunque después se haya renovado). */
export async function evidenceCertificate(db: Db, envelopeId: string, opts: { signedSha256?: string | null } = {}): Promise<Uint8Array> {
  const e = await db.one<any>(
    `SELECT e.id, e.tenant_id, e.brand_id, e.subject, e.status, e.created_at, e.completed_at, f.sha256
       FROM envelopes e LEFT JOIN files f ON f.id = e.signed_file_id WHERE e.id = $1`,
    [envelopeId],
  );
  if (!e) throw new Error("sobre inexistente");
  const recipients = await db.query<any>(
    `SELECT name, email, phone, role, routing_order, status, auth_method, id_document_type, id_document_number, sent_at, viewed_at, signed_at, declined_at, signed_ip
       FROM recipients WHERE envelope_id = $1 ORDER BY routing_order, created_at`,
    [envelopeId],
  );
  // Eventos hasta el cierre del sobre (envelope.completed incluido): los posteriores (descargas, exportaciones,
  // renovaciones del sello…) cambiaban los bytes en cada reintento y el destino guardaba otra copia. La cadena sigue
  // siendo verificable: es un prefijo de la del sobre. Sin evento de cierre, todos.
  const events = await db.query<any>(
    `SELECT seq, type, actor_type, actor_id, actor_label, ip, user_agent, data, occurred_at, prev_hash, hash FROM envelope_events
      WHERE envelope_id = $1
        AND seq <= COALESCE((SELECT min(seq) FROM envelope_events WHERE envelope_id = $1 AND type = 'envelope.completed'), 9223372036854775807)
      ORDER BY seq`,
    [envelopeId],
  );
  // Mismo link que el certificado del PDF (jobs.ts): dominio de la marca del sobre y ?b= si aplica una submarca.
  const wl = await brandForEnvelope(db, e);
  const verifyUrl = rebrands(wl) || e.brand_id ? `${wl.baseUrl}/verify?b=${encodeURIComponent(wl.key)}` : `${wl.baseUrl}/verify`;
  const doc = {
    type: "calasign.evidence-certificate",
    version: 1,
    // No es la hora en que se generó el archivo sino la de corte de la evidencia que contiene (el cierre del sobre):
    // se conserva el nombre del campo por compatibilidad con quienes ya leen este JSON.
    // Determinista: con la hora actual, cada reintento de una exportación generaba bytes distintos y los destinos que
    // deduplican por contenido (Dropbox: content_hash; Drive: sha256 en appProperties) dejaban una copia por intento.
    // Es el cierre del sobre (las exportaciones y los conectores solo corren con el sobre completado); si no lo tuviera,
    // el último evento de la cadena y, sin eventos, la creación.
    generatedAt: iso(e.completed_at) ?? (events.length ? iso(events[events.length - 1].occurred_at) : null) ?? iso(e.created_at),
    envelope: { id: e.id, subject: e.subject, status: e.status, createdAt: iso(e.created_at), completedAt: iso(e.completed_at) },
    signedPdf: { sha256: opts.signedSha256 ?? e.sha256 ?? null, algorithm: "SHA-256", note: "El PDF sellado (PAdES) incluye el certificado de finalización." },
    recipients: recipients.map((r) => ({
      name: r.name,
      email: r.email,
      phone: r.phone,
      role: r.role,
      routingOrder: r.routing_order,
      status: r.status,
      authMethod: r.auth_method,
      idDocument: r.id_document_number ? { type: r.id_document_type, number: r.id_document_number } : null,
      sentAt: iso(r.sent_at),
      viewedAt: iso(r.viewed_at),
      signedAt: iso(r.signed_at),
      declinedAt: iso(r.declined_at),
      ip: r.signed_ip,
    })),
    events: events.map((v) => {
      // Exactamente lo que cubre el hash (infra/evidence.ts): actor_label no entra.
      const body = {
        seq: v.seq,
        type: v.type,
        actor_type: v.actor_type,
        actor_id: v.actor_id ?? null,
        ip: v.ip ?? null,
        user_agent: v.user_agent ?? null,
        data: v.data ?? {},
        occurred_at: iso(v.occurred_at),
      };
      return {
        seq: v.seq,
        type: v.type,
        actorType: v.actor_type,
        actorId: body.actor_id,
        actor: v.actor_label,
        ip: v.ip,
        userAgent: v.user_agent,
        data: body.data,
        occurredAt: iso(v.occurred_at),
        prevHash: v.prev_hash,
        hash: v.hash,
        canonicalBody: canonicalJson(body),
      };
    }),
    chain: { algorithm: "SHA-256", genesisHash: GENESIS_HASH, head: events.length ? events[events.length - 1].hash : GENESIS_HASH },
    howToVerify:
      "Para cada evento en orden de seq: hash = SHA-256 (hex en minúsculas) del texto UTF-8 `prevHash + \"\\n\" + canonicalBody`. " +
      "prevHash del primer evento es genesisHash; el de cada uno de los siguientes es el hash del anterior. canonicalBody es el JSON " +
      "canónico (claves ordenadas alfabéticamente, sin espacios) de { seq, type, actor_type, actor_id, ip, user_agent, data, occurred_at } " +
      "con los valores de ese evento (actorType, actorId, ip, userAgent, data, occurredAt). Si algún hash no coincide, el registro fue alterado.",
    verify: { url: verifyUrl, howTo: "Subí el PDF sellado para validar firmas, sello de tiempo y la cadena de eventos." },
  };
  return new TextEncoder().encode(JSON.stringify(doc, null, 2));
}
