// Fase 6 — IA: detección de campos, resumen y preguntas del firmante, metadatos del contrato y
// revisión contra el playbook de la organización. Todo es opt-in por organización.
import { z } from "zod";

export const AI_FEATURES = ["detect_fields", "summary", "ask", "extract_metadata", "playbook_review"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/**
 * Versión del aviso de tratamiento de datos que la organización acepta al habilitar la IA. Al cambiarla, la IA queda
 * suspendida (403 ai_notice_required) hasta que la organización acepte la versión vigente.
 * v2: aclara que el texto del documento se envía tal cual (puede contener datos personales) y que no se envía nada más
 * del sobre.
 */
export const AI_NOTICE_VERSION = "ai-notice-v2";

export const UpdateAiSettingsInput = z.object({
  enabled: z.boolean().optional(),
  /** Obligatorio (true) la primera vez que se habilita: acepta el aviso de tratamiento de datos. */
  acceptNotice: z.boolean().optional(),
  /** Presupuesto propio de la organización; no puede superar el tope de tokens de IA del plan (402 plan_limit). */
  monthlyTokenBudget: z.number().int().min(0).max(1_000_000_000).optional(),
  /** Extraer metadatos automáticamente al completarse un sobre. */
  autoExtractMetadata: z.boolean().optional(),
  /** Avisar al remitente N días antes del vencimiento/renovación detectados (0 = no avisar). */
  renewalAlertDays: z.number().int().min(0).max(365).optional(),
  /** Reglas del playbook en lenguaje natural. */
  playbook: z.array(z.string().trim().min(3).max(500)).max(50).optional(),
});
export type UpdateAiSettingsInput = z.infer<typeof UpdateAiSettingsInput>;

export interface AiUsageSummary {
  month: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  byFeature: { feature: AiFeature; requests: number; tokens: number }[];
}

export interface AiSettings {
  enabled: boolean;
  /**
   * "anthropic" si hay clave configurada en el servidor; "mock" si no (respuestas deterministas sin red, solo fuera de
   * producción); "none" en producción sin clave: la IA no está disponible (503 ai_unavailable).
   */
  provider: "anthropic" | "mock" | "none";
  model: string;
  /** Presupuesto que fijó la organización. */
  monthlyTokenBudget: number;
  /** Tope de tokens de IA por mes del plan vigente (null = sin tope del plan; 0 = el plan no incluye IA). */
  planTokenCap: number | null;
  /** Lo que efectivamente se aplica: min(presupuesto de la organización, tope del plan). */
  effectiveTokenBudget: number;
  autoExtractMetadata: boolean;
  renewalAlertDays: number;
  playbook: string[];
  noticeVersion: string;
  noticeAcceptedAt: string | null;
  noticeAcceptedBy: string | null;
  /** Versión aceptada; si no coincide con noticeVersion hay que volver a aceptar el aviso. */
  noticeAcceptedVersion: string | null;
  usage: AiUsageSummary;
}

/** Lo que efectivamente se envía al modelo (transparencia: nada se redacta en silencio). */
export interface AiSentSummary {
  documents: { id: string; name: string; pages: number }[];
  characters: number;
}

export interface AiUsageInfo {
  provider: "anthropic" | "mock";
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AiCitation {
  /** 1-based, como se muestra al usuario. */
  page: number;
  documentId: string | null;
  quote: string;
  /** true si la cita aparece literalmente en el texto del documento. */
  verified: boolean;
}

// ───────── Detección de campos ─────────

export const DetectFieldsInput = z.object({ documentId: z.string().uuid().optional() });
export type DetectFieldsInput = z.infer<typeof DetectFieldsInput>;

export type SuggestedFieldType = "signature" | "initials" | "date_signed" | "name";

export interface FieldSuggestion {
  id: string;
  documentId: string;
  /** 0-based. */
  page: number;
  /** Coordenadas normalizadas 0..1 desde arriba a la izquierda (igual que los campos). */
  x: number;
  y: number;
  width: number;
  height: number;
  type: SuggestedFieldType;
  /** Rol sugerido tal como aparece en el documento ("cliente", "proveedor", "locador"…). */
  roleHint: string | null;
  /** Índice 0-based del firmante sugerido según el orden de aparición de los roles. */
  signerIndex: number;
  label: string | null;
  confidence: number;
  source: "heuristic" | "ai";
  /** Texto de la línea en la que se basa la sugerencia. */
  context: string;
}

export interface DetectFieldsResponse {
  suggestions: FieldSuggestion[];
  sent: AiSentSummary | null;
  usage: AiUsageInfo | null;
}

// ───────── Resumen y preguntas (firmante) ─────────

export const AiAskInput = z.object({ question: z.string().trim().min(3).max(1000) });
export type AiAskInput = z.infer<typeof AiAskInput>;

export interface AiSummaryResponse {
  summary: string;
  keyPoints: string[];
  citations: AiCitation[];
  disclaimer: string;
  usage: AiUsageInfo;
}

export interface AiAnswerResponse {
  answer: string;
  citations: AiCitation[];
  /** false si el documento no contiene la respuesta. */
  answered: boolean;
  disclaimer: string;
  usage: AiUsageInfo;
}

export interface SignerAiInfo {
  enabled: boolean;
  disclaimer: string;
  notice: string;
}

export const UpdateEnvelopeAiInput = z.object({ signerAssist: z.boolean() });
export type UpdateEnvelopeAiInput = z.infer<typeof UpdateEnvelopeAiInput>;

// ───────── Metadatos del contrato ─────────

// La fecha tiene que existir en el calendario: "2027-02-31" pasaba la expresión regular y la alerta de renovación
// se calculaba sobre el 3 de marzo, con la fecha imposible en el correo.
const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "fecha inexistente")
  .nullable();

export const ContractMetadataSchema = z.object({
  parties: z.array(z.object({ name: z.string().max(300), role: z.string().max(100).nullable() })).max(20),
  effectiveDate: IsoDate,
  expiryDate: IsoDate,
  renewalDate: IsoDate,
  autoRenewal: z.boolean().nullable(),
  amounts: z.array(z.object({ value: z.number(), currency: z.string().max(10).nullable(), description: z.string().max(300).nullable() })).max(30),
  governingLaw: z.string().max(300).nullable(),
  noticePeriodDays: z.number().int().min(0).max(3650).nullable(),
});
export type ContractMetadata = z.infer<typeof ContractMetadataSchema>;

export const PutContractMetadataInput = z.object({ metadata: ContractMetadataSchema });
export type PutContractMetadataInput = z.infer<typeof PutContractMetadataInput>;

export interface EnvelopeAiMetadata {
  metadata: ContractMetadata | null;
  /** Confianza 0..1 por campo (solo para lo extraído por IA). */
  confidence: Partial<Record<keyof ContractMetadata, number>>;
  source: "ai" | "manual" | null;
  updatedAt: string | null;
  /** Fecha en que se avisará la renovación/vencimiento (si aplica). */
  renewalAlertAt: string | null;
  renewalAlertSentAt: string | null;
  signerAssist: boolean;
  usage: AiUsageInfo | null;
  /** updatedAt del sobre (el editor lo usa para su control de edición concurrente tras cambiar signerAssist). */
  envelopeUpdatedAt: string | null;
}

// ───────── Revisión contra el playbook ─────────

export const PlaybookReviewInput = z.object({
  /** Reglas ad hoc; si falta se usa el playbook de la organización. */
  rules: z.array(z.string().trim().min(3).max(500)).max(50).optional(),
});
export type PlaybookReviewInput = z.infer<typeof PlaybookReviewInput>;

export interface PlaybookFinding {
  rule: string;
  status: "ok" | "violation" | "not_found";
  severity: "low" | "medium" | "high";
  explanation: string;
  citation: AiCitation | null;
}

export interface PlaybookReviewResponse {
  findings: PlaybookFinding[];
  reviewedAt: string;
  sent: AiSentSummary;
  usage: AiUsageInfo;
}

/** Texto exacto que se enviaría al modelo para un sobre (transparencia). */
export interface AiPreviewResponse {
  sent: AiSentSummary;
  text: string;
}
