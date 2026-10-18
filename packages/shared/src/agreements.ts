// Fase 6 — Plataforma de acuerdos: repositorio, generación de documentos, workflows y negociación.
import { z } from "zod";
import { CHANNELS, LOCALES } from "./api";
import type { DiffPart, ResolvedBlock, TemplateAnalysis } from "./agreements-engine";

export * from "./agreements-engine";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "fecha AAAA-MM-DD")
  .nullable()
  .optional();

// ───────────────────────────── Repositorio ─────────────────────────────

export const AGREEMENT_STATUSES = ["active", "expired", "terminated"] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];
export const AGREEMENT_SOURCES = ["envelope", "external"] as const;
export type AgreementSource = (typeof AGREEMENT_SOURCES)[number];

export const Counterparty = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  role: z.string().trim().max(80).nullable().optional(),
});
export type Counterparty = z.infer<typeof Counterparty>;

export const AgreementMetaInput = z.object({
  title: z.string().trim().min(1).max(300),
  counterparties: z.array(Counterparty).max(50).optional(),
  status: z.enum(AGREEMENT_STATUSES).optional(),
  effectiveDate: isoDate,
  expiryDate: isoDate,
  renewalDate: isoDate,
  /** Días antes del vencimiento para avisar al responsable (default 30). */
  noticeDays: z.number().int().min(0).max(3650).nullable().optional(),
  value: z.number().finite().nullable().optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "código ISO 4217")
    .nullable()
    .optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  metadata: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).optional(),
});
export type AgreementMetaInput = z.infer<typeof AgreementMetaInput>;
export const UpdateAgreementInput = AgreementMetaInput.partial();
export type UpdateAgreementInput = z.infer<typeof UpdateAgreementInput>;

export interface Agreement {
  id: string;
  source: AgreementSource;
  envelopeId: string | null;
  title: string;
  counterparties: Counterparty[];
  status: AgreementStatus;
  effectiveDate: string | null;
  expiryDate: string | null;
  renewalDate: string | null;
  noticeDays: number | null;
  value: number | null;
  currency: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  fileName: string;
  sha256: string;
  signatures: number;
  ownerUserId: string | null;
  ownerName: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Fragmento del texto que coincide con la búsqueda (solo en listados con q). */
  excerpt?: string | null;
}

export const AGREEMENT_FIELD_TYPES = ["text", "number", "date", "select"] as const;
export const AgreementFieldInput = z
  .object({
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, "minúsculas, números y _"),
    label: z.string().trim().min(1).max(100),
    type: z.enum(AGREEMENT_FIELD_TYPES),
    options: z.array(z.string().trim().min(1).max(100)).max(50).nullable().optional(),
  })
  .refine((f) => f.type !== "select" || (f.options?.length ?? 0) > 0, { message: "un campo de lista necesita opciones" });
export type AgreementFieldInput = z.infer<typeof AgreementFieldInput>;
export interface AgreementFieldDef {
  id: string;
  key: string;
  label: string;
  type: (typeof AGREEMENT_FIELD_TYPES)[number];
  options: string[] | null;
}

export const AgreementFilters = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(AGREEMENT_STATUSES).optional(),
  source: z.enum(AGREEMENT_SOURCES).optional(),
  tag: z.string().max(50).optional(),
  counterparty: z.string().max(200).optional(),
  expiresWithinDays: z.number().int().min(0).max(3650).optional(),
  fields: z.record(z.string(), z.string().max(200)).optional(),
});
export type AgreementFilters = z.infer<typeof AgreementFilters>;

export const AgreementViewInput = z.object({
  name: z.string().trim().min(1).max(100),
  filters: AgreementFilters,
  shared: z.boolean().default(false),
});
export type AgreementViewInput = z.input<typeof AgreementViewInput>;
export interface AgreementView {
  id: string;
  name: string;
  filters: AgreementFilters;
  shared: boolean;
  mine: boolean;
}

export interface ListAgreementsResponse {
  items: Agreement[];
  nextCursor: string | null;
  total: number;
}

// ───────────────────────────── Documentos ─────────────────────────────

export const AgreementMapping = z.object({
  /** Texto con variables, ej. "Contrato con {{cliente.nombre}}". */
  title: z.string().max(300).nullable().optional(),
  value: z.string().max(200).nullable().optional(),
  currency: z.string().max(10).nullable().optional(),
  effectiveDate: z.string().max(200).nullable().optional(),
  expiryDate: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).nullable().optional(),
});
export type AgreementMapping = z.infer<typeof AgreementMapping>;

export const DocumentTemplateInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  locale: z.enum(LOCALES).optional(),
  source: z.string().max(200_000),
  sampleData: z.record(z.string(), z.unknown()).nullable().optional(),
  agreementMapping: AgreementMapping.nullable().optional(),
});
export type DocumentTemplateInput = z.infer<typeof DocumentTemplateInput>;
export const UpdateDocumentTemplateInput = DocumentTemplateInput.partial();

export interface DocumentTemplate {
  id: string;
  name: string;
  description: string | null;
  locale: string;
  source: string;
  sampleData: Record<string, unknown> | null;
  agreementMapping: AgreementMapping | null;
  analysis: TemplateAnalysis | null;
  syntaxError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const ClauseInput = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9_-]{0,59}$/, "minúsculas, números, - y _"),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(50_000),
  category: z.string().trim().max(80).nullable().optional(),
});
export type ClauseInput = z.infer<typeof ClauseInput>;
export interface Clause {
  id: string;
  slug: string;
  title: string;
  body: string;
  category: string | null;
  updatedAt: string;
}

export const GenerateRecipientInput = z.object({
  /** Rol de las marcas {{firma:Rol}} del documento. */
  role: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/)
    .nullable()
    .optional(),
  channels: z.array(z.enum(CHANNELS)).min(1).optional(),
  locale: z.enum(LOCALES).nullable().optional(),
  routingOrder: z.number().int().min(1).max(100).optional(),
  /** Recibe copia, no firma. */
  cc: z.boolean().optional(),
});
export type GenerateRecipientInput = z.infer<typeof GenerateRecipientInput>;

export const GenerateDocumentInput = z.object({
  data: z.record(z.string(), z.unknown()).default({}),
  subject: z.string().trim().min(1).max(300).optional(),
  message: z.string().max(5000).nullable().optional(),
  locale: z.enum(LOCALES).optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  recipients: z.array(GenerateRecipientInput).min(1).max(30),
  send: z.boolean().default(true),
  /** Permite generar aunque falten variables (quedan vacías). */
  allowMissing: z.boolean().default(false),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type GenerateDocumentInput = z.input<typeof GenerateDocumentInput>;
export interface GenerateDocumentResponse {
  envelopeId: string;
  status: string;
  missing: string[];
  pages: number;
}

export const RenderDocumentInput = z.object({
  source: z.string().max(200_000).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  locale: z.enum(LOCALES).optional(),
  title: z.string().max(300).optional(),
});
export interface RenderPreviewResponse {
  blocks: ResolvedBlock[];
  missing: string[];
  missingClauses: string[];
  analysis: TemplateAnalysis;
}

// ───────────────────────────── Workflows ─────────────────────────────

export const WORKFLOW_STEP_TYPES = [
  "collect_data",
  "approval",
  "generate_document",
  "send_for_signature",
  "wait_for_completion",
  "http_request",
  "update_repository",
] as const;
export type WorkflowStepType = (typeof WORKFLOW_STEP_TYPES)[number];

const stepBase = { id: z.string().uuid(), name: z.string().trim().min(1).max(120) };
const key = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/, "letras, números y _");

export const CollectField = z.object({
  key: key,
  label: z.string().trim().min(1).max(150),
  type: z.enum(["text", "textarea", "email", "number", "date", "select"]),
  required: z.boolean().default(true),
  options: z.array(z.string().trim().min(1).max(100)).max(50).nullable().optional(),
})
  // Sin opciones, la lista sale vacía y la validación del envío rechaza cualquier valor: el run quedaba trabado.
  .refine((f) => f.type !== "select" || (f.options?.length ?? 0) > 0, { message: "un campo de lista necesita opciones" });
export type CollectField = z.infer<typeof CollectField>;

export const WorkflowStep = z.discriminatedUnion("type", [
  z.object({
    ...stepBase,
    type: z.literal("collect_data"),
    config: z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().max(2000).nullable().optional(),
      /** Prefijo dentro de los datos del run, ej. "cliente" → data.cliente.nombre. */
      target: key.nullable().optional(),
      fields: z.array(CollectField).min(1).max(40),
    }),
  }),
  z.object({
    ...stepBase,
    type: z.literal("approval"),
    config: z.object({ approverUserId: z.string().uuid(), message: z.string().max(2000).nullable().optional() }),
  }),
  z.object({
    ...stepBase,
    type: z.literal("generate_document"),
    config: z.object({ documentTemplateId: z.string().uuid(), output: key, allowMissing: z.boolean().default(false) }),
  }),
  z.object({
    ...stepBase,
    type: z.literal("send_for_signature"),
    config: z.object({
      document: key,
      envelopeKey: key,
      subject: z.string().trim().min(1).max(300),
      message: z.string().max(5000).nullable().optional(),
      recipients: z
        .array(
          z.object({
            role: z.string().trim().min(1).max(80),
            /** Admiten variables: "{{cliente.nombre}}". */
            name: z.string().trim().min(1).max(300),
            email: z.string().trim().max(300).nullable().optional(),
            phone: z.string().trim().max(300).nullable().optional(),
            channels: z.array(z.enum(CHANNELS)).min(1).optional(),
            cc: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(20),
    }),
  }),
  z.object({ ...stepBase, type: z.literal("wait_for_completion"), config: z.object({ envelopeKey: key }) }),
  z.object({
    ...stepBase,
    type: z.literal("http_request"),
    config: z.object({
      url: z.string().url().max(2000),
      method: z.enum(["POST", "PUT"]).default("POST"),
      headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,60}$/), z.string().max(500)).nullable().optional(),
      /** JSON con {{variables}} (se insertan como valores JSON). Vacío: se manda el contexto del run. */
      bodyTemplate: z.string().max(20_000).nullable().optional(),
      saveAs: key.nullable().optional(),
    }),
  }),
  z.object({
    ...stepBase,
    type: z.literal("update_repository"),
    config: z.object({
      envelopeKey: key,
      title: z.string().max(300).nullable().optional(),
      tags: z.array(z.string().trim().min(1).max(50)).max(20).nullable().optional(),
      expiryDate: z.string().max(200).nullable().optional(),
      value: z.string().max(200).nullable().optional(),
      currency: z.string().max(10).nullable().optional(),
      metadata: z.record(z.string(), z.string().max(500)).nullable().optional(),
    }),
  }),
]);
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  active: z.boolean().default(true),
  /** Permite iniciar el workflow desde un link público. */
  publicStart: z.boolean().default(false),
  steps: z.array(WorkflowStep).min(1).max(30),
});
export type WorkflowInput = z.input<typeof WorkflowInput>;
export const UpdateWorkflowInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  active: z.boolean().optional(),
  publicStart: z.boolean().optional(),
  steps: z.array(WorkflowStep).min(1).max(30).optional(),
});

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  publicStart: boolean;
  publicUrl: string | null;
  steps: WorkflowStep[];
  runs: { total: number; running: number };
  createdAt: string;
  updatedAt: string;
}

export const WORKFLOW_RUN_STATUSES = ["running", "waiting", "completed", "failed", "rejected", "cancelled"] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];
export const WORKFLOW_STEP_STATUSES = ["pending", "running", "waiting", "completed", "failed", "skipped", "cancelled"] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

export interface WorkflowRunStep {
  index: number;
  stepId: string;
  type: WorkflowStepType;
  name: string;
  status: WorkflowStepStatus;
  attempts: number;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** Para aprobaciones: si el usuario actual puede decidir. */
  canDecide?: boolean;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: WorkflowRunStatus;
  currentStep: number;
  context: { data: Record<string, unknown>; documents: Record<string, unknown>; envelopes: Record<string, unknown>; http: Record<string, unknown> };
  steps: WorkflowRunStep[];
  startedBy: string | null;
  /** Link para completar pasos de datos (solo si el run tiene pasos de recolección). */
  collectUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export const StartWorkflowInput = z.object({ data: z.record(z.string(), z.unknown()).default({}) });
export const ApprovalDecisionInput = z.object({ approve: z.boolean(), comment: z.string().max(2000).nullable().optional() });
export const SubmitCollectInput = z.object({
  values: z.record(z.string(), z.string().max(5000)),
  /** Campo trampa: los humanos lo dejan vacío. */
  website: z.string().max(200).optional(),
});

export interface PublicWorkflowRun {
  runId: string;
  workflowName: string;
  organizationName: string;
  status: WorkflowRunStatus;
  step: { index: number; name: string; title: string; description: string | null; fields: CollectField[] } | null;
  /** Link de firma cuando el siguiente paso es firmar y el firmante es quien completó el formulario. */
  signingUrl: string | null;
}

export interface PublicWorkflowStart {
  workflowName: string;
  organizationName: string;
  description: string | null;
}

// ───────────────────────────── Negociación ─────────────────────────────

export const NegotiationParticipantInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  /** Rol de firma en el documento ({{firma:Rol}}). */
  role: z.string().trim().max(80).nullable().optional(),
  canPropose: z.boolean().default(true),
});

export const CreateNegotiationInput = z.object({
  title: z.string().trim().min(1).max(300),
  documentTemplateId: z.string().uuid(),
  data: z.record(z.string(), z.unknown()).default({}),
  /** Variables que las contrapartes pueden proponer cambiar (vacío: todas las del documento). */
  negotiableVariables: z.array(z.string().max(200)).max(200).optional(),
  participants: z.array(NegotiationParticipantInput).min(1).max(20),
  message: z.string().max(5000).nullable().optional(),
});
export type CreateNegotiationInput = z.input<typeof CreateNegotiationInput>;

export const NEGOTIATION_STATUSES = ["open", "accepted", "cancelled"] as const;
export type NegotiationStatus = (typeof NEGOTIATION_STATUSES)[number];

export interface NegotiationParticipant {
  id: string;
  name: string;
  email: string;
  role: string | null;
  canPropose: boolean;
  lastSeenAt: string | null;
}

export interface NegotiationSummary {
  id: string;
  title: string;
  status: NegotiationStatus;
  source: "template" | "pdf";
  currentVersion: number;
  participants: NegotiationParticipant[];
  pendingProposals: number;
  openComments: number;
  envelopeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NegotiationAuthor {
  type: "user" | "participant";
  name: string;
}

export interface NegotiationVersion {
  version: number;
  author: NegotiationAuthor;
  summary: string;
  createdAt: string;
}

export interface NegotiationComment {
  id: string;
  version: number;
  author: NegotiationAuthor;
  quote: string | null;
  start: number | null;
  end: number | null;
  body: string;
  resolved: boolean;
  createdAt: string;
}

export interface NegotiationProposal {
  id: string;
  version: number;
  author: NegotiationAuthor;
  kind: "variable" | "clause";
  key: string;
  oldValue: string;
  newValue: string;
  comment: string | null;
  status: "pending" | "accepted" | "rejected";
  createdAt: string;
  decidedAt: string | null;
}

export interface NegotiationView {
  negotiation: NegotiationSummary;
  /** Documento de la versión actual. */
  blocks: ResolvedBlock[];
  text: string;
  versions: NegotiationVersion[];
  comments: NegotiationComment[];
  proposals: NegotiationProposal[];
  /** Variables negociables con su valor actual. */
  variables: { path: string; value: string }[];
  clauses: { slug: string; title: string; text: string }[];
  /** Solo en la vista de la contraparte. */
  me?: NegotiationParticipant;
}

export const NegotiationCommentInput = z.object({
  body: z.string().trim().min(1).max(5000),
  quote: z.string().max(2000).nullable().optional(),
  start: z.number().int().min(0).nullable().optional(),
  end: z.number().int().min(0).nullable().optional(),
});
export const NegotiationProposalInput = z.object({
  kind: z.enum(["variable", "clause"]),
  key: z.string().trim().min(1).max(200),
  newValue: z.string().max(50_000),
  comment: z.string().max(2000).nullable().optional(),
});
export const ProposalDecisionInput = z.object({ accept: z.boolean() });
export const AcceptNegotiationInput = z.object({
  subject: z.string().trim().min(1).max(300).optional(),
  message: z.string().max(5000).nullable().optional(),
  send: z.boolean().default(true),
});

export interface NegotiationDiff {
  from: number;
  to: number;
  parts: DiffPart[];
}
