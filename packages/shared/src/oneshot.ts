// Contrato de la API v1 — sobre completo en una sola llamada: POST /v1/envelopes con documentos, destinatarios,
// campos y (opcionalmente) el envío. Todos los agregados son opcionales: sin ellos es el alta de un borrador vacío
// de siempre.
import { z } from "zod";
import { CreateEnvelopeInput, RecipientInput, type EnvelopeDetail } from "./api";
import { CreateSigningUrlInput, type SigningUrlResponse } from "./integrations";

/** Documentos por sobre en una sola llamada. */
export const ONE_SHOT_MAX_DOCUMENTS = 10;

/** Referencia de un campo a un destinatario o documento creado en la misma llamada: su posición (0 = el primero) o su `ref`. */
const InlineRef = z.union([z.number().int().min(0).max(499), z.string().trim().min(1).max(320)]);

/**
 * Un documento del sobre: uno (y solo uno) de `base64` (el PDF codificado), `url` (https pública, sin redirecciones)
 * o `file` (nombre de la parte del multipart/form-data que trae el archivo).
 */
export const InlineDocumentInput = z
  .object({
    /** Identificador libre para referirlo desde los campos (`document`). */
    ref: z.string().trim().min(1).max(100).optional(),
    /** Nombre del archivo. Por defecto, el de la parte del multipart o el final de la URL. */
    name: z.string().trim().min(1).max(200).optional(),
    base64: z.string().min(1).optional(),
    url: z.string().trim().url().max(2000).optional(),
    file: z.string().trim().min(1).max(100).optional(),
  })
  .refine((d) => [d.base64, d.url, d.file].filter((v) => v !== undefined).length === 1, {
    message: "cada documento lleva uno (y solo uno) de base64, url o file",
  });
export type InlineDocumentInput = z.input<typeof InlineDocumentInput>;

/** Un destinatario como en PUT /recipients, más un `ref` opcional para referirlo desde los campos. */
export const InlineRecipientInput = z.intersection(RecipientInput, z.object({ ref: z.string().trim().min(1).max(100).optional() }));
export type InlineRecipientInput = z.input<typeof InlineRecipientInput>;

/**
 * Un campo como en PUT /fields (con coordenadas o con `anchor`), pero el destinatario y el documento se indican con
 * `recipient` / `document` (posición en la lista o `ref`; para el destinatario también su email). Se pueden omitir
 * si hay un solo firmante / un solo documento (un campo con `anchor` sin `document` se busca en todos). También se
 * aceptan `recipientId` (si se le dio un `id` propio al destinatario) y los demás atributos de un campo.
 */
export const InlineFieldInput = z
  .object({
    recipient: InlineRef.optional(),
    document: InlineRef.optional(),
  })
  .passthrough();
export type InlineFieldInput = z.input<typeof InlineFieldInput>;

export const CreateEnvelopeRequest = CreateEnvelopeInput.extend({
  documents: z.array(InlineDocumentInput).max(ONE_SHOT_MAX_DOCUMENTS).optional(),
  recipients: z.array(InlineRecipientInput).max(50).optional(),
  fields: z.array(InlineFieldInput).max(500).optional(),
  /** true: lo envía en el mismo pedido (equivale a `status: "sent"`). */
  send: z.boolean().optional(),
  status: z.enum(["draft", "sent"]).optional(),
  /** Opciones de las URLs de firma embebida que se devuelven para los destinatarios `embedded` al enviar. */
  embeddedSigning: CreateSigningUrlInput.optional(),
}).refine((r) => r.send === undefined || r.status === undefined || r.send === (r.status === "sent"), {
  message: "send y status se contradicen",
});
export type CreateEnvelopeRequest = z.input<typeof CreateEnvelopeRequest>;

export interface EnvelopeSigningUrl extends SigningUrlResponse {
  recipientId: string;
}

/** Respuesta de POST /v1/envelopes: el detalle del sobre y, si se envió con firmantes embebidos, sus URLs de firma. */
export interface CreateEnvelopeResponse extends EnvelopeDetail {
  signingUrls?: EnvelopeSigningUrl[];
  /**
   * Solo al repetir un pedido con la misma Idempotency-Key: las URLs de firma no se guardan (llevan un código de un solo
   * uso) y se emiten de nuevo; las que ya no se pueden emitir (sobre cerrado, destinatario que ya firmó o fue
   * reemplazado) se omiten y este texto explica cómo pedirlas.
   */
  signingUrlsHint?: string;
}
