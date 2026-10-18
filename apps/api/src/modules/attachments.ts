// Adjuntos del firmante: sube un archivo (PDF/JPG/PNG) para un campo de tipo "attachment".
import type { FastifyInstance } from "fastify";
import { ATTACHMENT_MAX_BYTES } from "@calasign/shared";
import { assertEmbeddableImage, inspectPdf } from "@calasign/pdf";
import { appendEvent } from "../infra/evidence";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { sha256Hex, uuidv7 } from "../lib/util";
import { clientInfo, type Services } from "./context";
import { currentSignerGroup, lockEnvelope } from "./envelopes";
import { resolveToken } from "./signing";
import { toField } from "./mappers";

function sniff(buf: Buffer): "application/pdf" | "image/png" | "image/jpeg" | null {
  if (buf.subarray(0, 1024).indexOf("%PDF-") !== -1) return "application/pdf";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

export async function attachmentRoutes(app: FastifyInstance, s: Services) {
  type P = { Params: { token: string; fieldId: string } };
  const rl = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

  /** Verifica que el firmante pueda tocar ese campo ahora. Devuelve el campo. */
  async function guard(t: any, r0: any, e0: any, fieldId: string) {
    const e = await lockEnvelope(t, e0.tenant_id, e0.id);
    const r = await t.one(`SELECT * FROM recipients WHERE id = $1`, [r0.id]);
    if (e.status !== "sent") throw new AppError(410, "envelope_closed", "El sobre ya no está disponible para firmar");
    if (r.role !== "signer" || !["sent", "viewed"].includes(r.status)) throw conflict("not_signable", "No podés modificar este sobre");
    const group = await currentSignerGroup(t, e.id);
    if (group.order !== r.routing_order) throw conflict("not_your_turn", "Todavía no es tu turno de firmar");
    if (!r.consented_at) throw conflict("consent_required", "Primero hay que aceptar el uso de medios electrónicos");
    const f = await t.one(`SELECT * FROM fields WHERE id = $1 AND recipient_id = $2`, [fieldId, r.id]);
    if (!f || f.type !== "attachment") throw notFound("Campo de adjunto");
    return { e, r, f };
  }

  app.post<P>("/v1/signing/:token/fields/:fieldId/attachment", { ...rl, bodyLimit: ATTACHMENT_MAX_BYTES + 64 * 1024 }, async (req) => {
    const { recipient: r0, envelope: e0 } = await resolveToken(s.db, req.params.token);
    const file = await req.file({ limits: { fileSize: ATTACHMENT_MAX_BYTES } });
    if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new AppError(413, "file_too_large", "El archivo supera los 10 MB");
    const type = sniff(buf);
    if (!type) throw badRequest("invalid_attachment", "Solo se aceptan PDF, JPG o PNG");
    if (type === "application/pdf") {
      try {
        await inspectPdf(new Uint8Array(buf));
      } catch {
        throw badRequest("invalid_attachment", "El PDF está dañado o protegido con contraseña");
      }
    } else {
      // Una imagen con cabecera válida pero dañada haría fallar el sellado del sobre más adelante.
      try {
        await assertEmbeddableImage(new Uint8Array(buf), type);
      } catch {
        throw badRequest("invalid_attachment", "La imagen está dañada o no se puede leer");
      }
    }
    const name = (file.filename || "adjunto").replace(/[\r\n]/g, " ").slice(0, 200);
    const fileId = uuidv7();
    const ext = type === "application/pdf" ? "pdf" : type === "image/png" ? "png" : "jpg";
    const key = `tenants/${e0.tenant_id}/envelopes/${e0.id}/attachments/${fileId}.${ext}`;
    // Validar antes de subir, y de nuevo dentro de la transacción.
    await s.db.tx((t) => guard(t, r0, e0, req.params.fieldId));
    await s.blobs.put(key, buf, type);
    const sha = sha256Hex(buf);
    const { ip, userAgent } = clientInfo(req);
    const field = await s.db.tx(async (t) => {
      const { e, r, f } = await guard(t, r0, e0, req.params.fieldId);
      await t.query(`INSERT INTO files (id, tenant_id, kind, storage_key, content_type, size_bytes, sha256) VALUES ($1,$2,'attachment',$3,$4,$5,$6)`, [
        fileId,
        e.tenant_id,
        key,
        type,
        buf.length,
        sha,
      ]);
      await t.query(`UPDATE fields SET attachment_file_id = $2, value = $3, filled_at = now() WHERE id = $1`, [f.id, fileId, name]);
      await appendEvent(t, {
        tenantId: e.tenant_id,
        envelopeId: e.id,
        type: "recipient.attachment_uploaded",
        actor: { type: "recipient", id: r.id, label: r.email ? `${r.name} <${r.email}>` : r.name, ip, userAgent },
        data: { fieldId: f.id, name, contentType: type, sizeBytes: buf.length, sha256: sha },
      });
      return t.one(`SELECT * FROM fields WHERE id = $1`, [f.id]);
    });
    return toField(field);
  });

  app.delete<P>("/v1/signing/:token/fields/:fieldId/attachment", rl, async (req) => {
    const { recipient: r0, envelope: e0 } = await resolveToken(s.db, req.params.token);
    const field = await s.db.tx(async (t) => {
      const { f } = await guard(t, r0, e0, req.params.fieldId);
      await t.query(`UPDATE fields SET attachment_file_id = NULL, value = NULL, filled_at = NULL WHERE id = $1`, [f.id]);
      return t.one(`SELECT * FROM fields WHERE id = $1`, [f.id]);
    });
    return toField(field);
  });
}
