// Anclas de texto: en PUT /v1/envelopes/:id/fields un campo puede venir con `anchor` en lugar de
// page/x/y. Antes de validar, se buscan las apariciones del texto en los PDF y cada una se convierte
// en un campo concreto con coordenadas normalizadas.
import { AnchorFieldInput } from "@calasign/shared";
import { findTextAnchors, InvalidPdfError, PdfReaderBusyError, type AnchorMatch } from "@calasign/pdf";
import { AppError, badRequest } from "../lib/errors";
import { uuidv7 } from "../lib/util";
import type { Services } from "./context";
import { loadDocuments } from "./mappers";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Tope de campos por sobre (el de PutFieldsInput y del sobre completo de POST /v1/envelopes). */
const MAX_FIELDS = 500;

// Atributos de un campo que no dependen de la posición: pasan tal cual a cada campo que genera el ancla (los valida
// después FieldInput). Sin esto, un desplegable por ancla perdía sus opciones (400) y un valor de solo lectura, el
// rango o las condiciones se descartaban sin aviso.
const PASS_THROUGH = ["value", "readOnly", "options", "min", "max", "conditions", "formula"] as const;

export async function expandAnchorFields(s: Services, tenantId: string, envelopeId: string, body: unknown): Promise<unknown> {
  const fields = (body as { fields?: unknown[] } | null)?.fields;
  if (!Array.isArray(fields) || !fields.some((f) => f && typeof f === "object" && "anchor" in (f as object))) return body;

  const docs = await loadDocuments(s.db, envelopeId);
  if (docs.length && docs[0].tenant_id !== tenantId) return body; // el handler devuelve 404 al bloquear el sobre
  return expandAnchors(
    docs.map((d) => ({ id: d.id, load: () => s.blobs.get(d.storage_key) })),
    body,
  );
}

/** Documento donde buscar anclas: su id y cómo obtener sus bytes (del almacenamiento o ya en memoria). */
export interface AnchorDocument {
  id: string;
  load: () => Promise<Uint8Array>;
}

/**
 * Expande los campos con `anchor` de `body.fields` buscando el texto en `docs` (en orden). La usan PUT fields (con los
 * documentos guardados) y POST /v1/envelopes con el sobre completo (con los PDF todavía en memoria, antes de guardar
 * nada: si un ancla no aparece, no queda un sobre a medias).
 */
export async function expandAnchors(docs: AnchorDocument[], body: unknown): Promise<unknown> {
  const fields = (body as { fields?: unknown[] } | null)?.fields;
  if (!Array.isArray(fields) || !fields.some((f) => f && typeof f === "object" && "anchor" in (f as object))) return body;
  // Mismo tope que PutFieldsInput, antes de leer los PDF: la validación corre después de expandir, y PUT fields no
  // acota la lista antes. Sin esto, miles de anclas distintas (cada una lee el texto del PDF con pdf.js) retenían el
  // pedido y los lectores de PDF compartidos durante horas.
  if (fields.length > MAX_FIELDS) throw badRequest("too_many_fields", `Máximo ${MAX_FIELDS} campos por sobre`);
  const bytesCache = new Map<string, Uint8Array>();
  const matchCache = new Map<string, AnchorMatch[]>();
  const find = async (doc: AnchorDocument, text: string, caseSensitive: boolean) => {
    const docId = doc.id;
    const key = `${docId}\u0000${caseSensitive}\u0000${text}`;
    if (!matchCache.has(key)) {
      if (!bytesCache.has(docId)) bytesCache.set(docId, await doc.load());
      try {
        matchCache.set(key, await findTextAnchors(bytesCache.get(docId)!, text, { caseSensitive }));
      } catch (e) {
        // PDF demasiado pesado para leer su texto (tope de pdf.js): 422, no un error interno.
        if (e instanceof InvalidPdfError) throw new AppError(422, "pdf_too_heavy", e.message);
        if (e instanceof PdfReaderBusyError) throw new AppError(503, "pdf_reader_busy", e.message);
        throw e;
      }
    }
    return matchCache.get(key)!;
  };

  const out: unknown[] = [];
  for (const [i, raw] of fields.entries()) {
    if (!raw || typeof raw !== "object" || !("anchor" in (raw as object))) {
      out.push(raw);
      continue;
    }
    const f = AnchorFieldInput.parse(raw);
    const targets = f.documentId ? docs.filter((d) => d.id === f.documentId) : docs;
    if (f.documentId && targets.length === 0) throw badRequest("invalid_field", `Campo ${i + 1}: documento inexistente`);
    let found = 0;
    for (const d of targets) {
      for (const m of await find(d, f.anchor.text, f.anchor.caseSensitive)) {
        const W = m.pageWidth;
        const H = m.pageHeight;
        const width = clamp(f.anchor.width / W, 0.001, 1);
        const height = clamp(f.anchor.height / H, 0.001, 1);
        out.push({
          id: found === 0 && f.id ? f.id : uuidv7(),
          documentId: d.id,
          recipientId: f.recipientId,
          type: f.type,
          page: m.page,
          x: clamp((m.x + f.anchor.offsetX) / W, 0, 1 - width),
          y: clamp((m.y + f.anchor.offsetY) / H, 0, 1 - height),
          width,
          height,
          required: f.required,
          label: f.label ?? null,
          ...Object.fromEntries(PASS_THROUGH.filter((k) => k in (raw as object)).map((k) => [k, (raw as Record<string, unknown>)[k]])),
        });
        found++;
      }
      // Un ancla frecuente (p. ej. una letra) genera un campo por aparición: se corta apenas supera el tope.
      if (out.length > MAX_FIELDS) throw badRequest("too_many_fields", `Las anclas generan más de ${MAX_FIELDS} campos`);
    }
    if (found === 0 && !f.anchor.ignoreIfNotPresent) {
      throw badRequest("anchor_not_found", `Campo ${i + 1}: no se encontró el texto ancla "${f.anchor.text}"`, { anchor: f.anchor.text });
    }
  }
  return { ...(body as object), fields: out };
}
