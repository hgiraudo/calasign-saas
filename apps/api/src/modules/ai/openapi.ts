// Operaciones de la Fase 6 (IA) para el documento OpenAPI.
import {
  AiAskInput,
  DetectFieldsInput,
  PlaybookReviewInput,
  PutContractMetadataInput,
  UpdateAiSettingsInput,
  UpdateEnvelopeAiInput,
} from "@calasign/shared";
import { EnvelopeAiMetadataSchema } from "../openapi-schemas";

const TAG = "IA";
const NOTE =
  "Requiere IA habilitada para la organización (403 ai_disabled) y presupuesto mensual disponible (429 ai_budget_exceeded). Un documento demasiado largo para el modelo responde 413 ai_input_too_large. Si los originales del sobre se borraron por la política de retención, 410 purged.";
const SIGNER_NOTE = `Requiere IA habilitada para la organización (403 ai_disabled) y presupuesto mensual disponible (429 ai_budget_exceeded). Un documento demasiado largo para el modelo responde 413 ai_input_too_large. Por firmante: hasta 30 consultas por día y 100 en total (resumen y preguntas juntos; después, 429 ai_signer_limit). Si el sobre exige verificar la identidad y todavía no se verificó, 403 identity_required.`;
const AI_ERRORS = ["ai_input_too_large", "purged"];
const SIGNER_ERRORS = ["ai_input_too_large", "ai_signer_limit", "identity_required"];

export const AI_OPS = [
  { method: "get", path: "/v1/settings/ai", tag: TAG, summary: "Configuración de IA, proveedor y consumo del mes" },
  {
    method: "patch",
    path: "/v1/settings/ai",
    tag: TAG,
    summary: "Habilitar IA, presupuesto, extracción automática, alertas de renovación y playbook",
    description: "Habilitar por primera vez exige acceptNotice: true (aviso de tratamiento de datos); si no, 422 ai_notice_required.",
    body: UpdateAiSettingsInput,
  },
  {
    method: "get",
    path: "/v1/envelopes/{id}/ai/preview",
    tag: TAG,
    summary: "Texto exacto que se enviaría al modelo (transparencia)",
    description: "Query: feature (detect_fields | summary | ask | extract_metadata | playbook_review), documentId opcional. Si los originales del sobre se borraron por la política de retención, 410 purged.",
    errors: ["purged"],
  },
  {
    method: "post",
    path: "/v1/envelopes/{id}/ai/detect-fields",
    tag: TAG,
    summary: "Sugerir campos (firma, iniciales, fecha, nombre) con su rol",
    description: "Sin IA habilitada devuelve solo sugerencias por análisis del texto (no se envía nada). Coordenadas normalizadas 0..1. Con IA, si no queda presupuesto o el documento es demasiado largo para el modelo, devuelve solo esas sugerencias (usage y sent en null). Si los originales del sobre se borraron por la política de retención, 410 purged.",
    body: DetectFieldsInput,
    errors: AI_ERRORS,
  },
  {
    method: "patch",
    path: "/v1/envelopes/{id}/ai/settings",
    tag: TAG,
    summary: "Permitir al firmante pedir resumen y hacer preguntas",
    description: "Cambia el `updatedAt` del sobre (devuelto en `envelopeUpdatedAt`).",
    body: UpdateEnvelopeAiInput,
    response: EnvelopeAiMetadataSchema,
    expectedUpdatedAt: true,
    errors: ["version_changed"],
  },
  { method: "get", path: "/v1/envelopes/{id}/ai/review", tag: TAG, summary: "Última revisión contra el playbook" },
  { method: "post", path: "/v1/envelopes/{id}/ai/review", tag: TAG, summary: "Revisar el documento contra el playbook (o reglas ad hoc)", description: NOTE, body: PlaybookReviewInput, errors: AI_ERRORS },
  { method: "get", path: "/v1/envelopes/{id}/ai/metadata", tag: TAG, summary: "Datos del contrato y alerta de renovación programada", response: EnvelopeAiMetadataSchema },
  { method: "post", path: "/v1/envelopes/{id}/ai/extract-metadata", tag: TAG, summary: "Extraer partes, fechas, montos, ley aplicable y preaviso", description: NOTE, response: EnvelopeAiMetadataSchema, errors: AI_ERRORS },
  { method: "put", path: "/v1/envelopes/{id}/ai/metadata", tag: TAG, summary: "Corregir los datos del contrato (reprograma la alerta)", body: PutContractMetadataInput, response: EnvelopeAiMetadataSchema },
  { method: "get", path: "/v1/signing/{token}/ai", tag: TAG, summary: "Firmante: disponibilidad del asistente, aviso y descargo", auth: "token" },
  { method: "post", path: "/v1/signing/{token}/ai/summary", tag: TAG, summary: "Firmante: resumen en lenguaje simple con citas", description: SIGNER_NOTE, auth: "token", errors: SIGNER_ERRORS },
  { method: "post", path: "/v1/signing/{token}/ai/ask", tag: TAG, summary: "Firmante: pregunta sobre el documento, respondida con citas y página", description: SIGNER_NOTE, body: AiAskInput, auth: "token", errors: SIGNER_ERRORS },
] as const;
