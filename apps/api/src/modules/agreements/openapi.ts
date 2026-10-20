// Operaciones de Fase 6 (acuerdos) para el OpenAPI.
import { z } from "zod";
import {
  AGREEMENT_FIELD_TYPES,
  AcceptNegotiationInput,
  AgreementFieldInput,
  AgreementViewInput,
  ApprovalDecisionInput,
  ClauseInput,
  CreateNegotiationInput,
  DocumentTemplateInput,
  GenerateDocumentInput,
  NegotiationCommentInput,
  NegotiationProposalInput,
  ProposalDecisionInput,
  RenderDocumentInput,
  StartWorkflowInput,
  SubmitCollectInput,
  UpdateAgreementInput,
  UpdateDocumentTemplateInput,
  UpdateWorkflowInput,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_STEP_TYPES,
  WorkflowInput,
} from "@calasign/shared";
import { named } from "../openapi-schemas";

type Op = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  tag: string;
  summary: string;
  description?: string;
  body?: z.ZodTypeAny;
  multipart?: boolean;
  response?: z.ZodTypeAny | "pdf" | "none";
  status?: number;
  auth?: "key" | "none";
  /** Códigos del catálogo ERRORS (openapi-extra.ts). */
  errors?: string[];
  /** Admite X-Expected-Updated-At (409 version_changed si el recurso cambió desde que se leyó). */
  expectedUpdatedAt?: boolean;
};

const iso = z.string().datetime();

/** Espejo de WorkflowRun (packages/shared/src/agreements.ts). */
const WorkflowRunSchema = named(
  "WorkflowRun",
  z.object({
    id: z.string().uuid(),
    workflowId: z.string().uuid(),
    workflowName: z.string(),
    status: z.enum(WORKFLOW_RUN_STATUSES),
    currentStep: z.number().int(),
    context: z
      .object({ data: z.record(z.string(), z.unknown()), documents: z.record(z.string(), z.unknown()), envelopes: z.record(z.string(), z.unknown()), http: z.record(z.string(), z.unknown()) })
      .describe("Datos acumulados de la ejecución (vacíos si redacted)."),
    steps: z.array(
      z.object({
        index: z.number().int(),
        stepId: z.string(),
        type: z.enum(WORKFLOW_STEP_TYPES),
        name: z.string(),
        status: z.enum(WORKFLOW_STEP_STATUSES),
        attempts: z.number().int(),
        output: z.record(z.string(), z.unknown()).nullable().describe("null si redacted."),
        error: z.string().nullable(),
        startedAt: iso.nullable(),
        finishedAt: iso.nullable(),
        canDecide: z.boolean().optional().describe("Aprobaciones: si quien consulta puede decidir."),
      }),
    ),
    startedBy: z.string().nullable(),
    collectUrl: z.string().nullable().describe("Link para completar pasos de datos (null si no tiene o si redacted)."),
    canManage: z.boolean().optional().describe("Si quien consulta puede cancelarla o reintentarla."),
    redacted: z
      .boolean()
      .optional()
      .describe("true si quien consulta administra plantillas pero no la inició, no aprueba ningún paso ni ve todos los sobres: context vacío, output null en los pasos, sin collectUrl. Ausente si no."),
    createdAt: iso,
    updatedAt: iso,
  }),
);

/** GET /v1/public/workflows/{slug} (PublicWorkflowStart). */
const PublicWorkflowStartSchema = z.object({
  workflowName: z.string(),
  organizationName: z.string(),
  description: z.string().nullable(),
  captchaSiteKey: z
    .string()
    .nullable()
    .describe("Clave pública de Cloudflare Turnstile si la plataforma exige el desafío: el inicio tiene que traer `captchaToken` (si no, 400 captcha_failed). null: sin desafío."),
});

const R = "Repositorio de acuerdos";
const D = "Documentos generados";
const W = "Workflows";
const N = "Negociación";

export const AGREEMENTS_OPS: Op[] = [
  { method: "get", path: "/v1/agreements", tag: R, summary: "Buscar acuerdos", description: "Query: q (texto completo, sin acentos), status, source, tag, counterparty, expiresWithinDays, f.<campo>=valor, viewId, cursor, limit." },
  { method: "get", path: "/v1/agreements/export.csv", tag: R, summary: "Exportar acuerdos a CSV", description: "Mismos filtros que la búsqueda." },
  { method: "post", path: "/v1/agreements/upload", tag: R, summary: "Subir un acuerdo externo", multipart: true, status: 201, description: "multipart: 'meta' (JSON con title, counterparties, fechas, value, currency, tags, metadata) y luego 'file' (PDF)." },
  { method: "get", path: "/v1/agreements/{id}", tag: R, summary: "Ver un acuerdo" },
  { method: "patch", path: "/v1/agreements/{id}", tag: R, summary: "Editar un acuerdo", body: UpdateAgreementInput },
  { method: "delete", path: "/v1/agreements/{id}", tag: R, summary: "Borrar un acuerdo externo", response: "none", status: 204 },
  { method: "get", path: "/v1/agreements/{id}/file", tag: R, summary: "Descargar el PDF del acuerdo", description: "Si el archivo se borró por la política de retención, 410 purged.", response: "pdf", errors: ["purged"] },
  { method: "get", path: "/v1/agreement-fields", tag: R, summary: "Campos propios" },
  { method: "post", path: "/v1/agreement-fields", tag: R, summary: "Crear un campo propio", body: AgreementFieldInput, status: 201 },
  {
    method: "patch",
    path: "/v1/agreement-fields/{id}",
    tag: R,
    summary: "Editar un campo propio",
    description: "Solo los atributos presentes (label, type, options). La clave (`key`) no se puede cambiar: 400 immutable_key. Un campo de lista (select) necesita opciones (400 validation_error).",
    body: z.object({
      label: z.string().min(1).max(100).optional(),
      type: z.enum(AGREEMENT_FIELD_TYPES).optional(),
      options: z.array(z.string().min(1).max(100)).max(50).nullable().optional(),
      key: z.string().optional().describe("Si viene, tiene que ser la clave actual."),
    }),
  },
  { method: "delete", path: "/v1/agreement-fields/{id}", tag: R, summary: "Borrar un campo propio", response: "none", status: 204 },
  { method: "get", path: "/v1/agreement-views", tag: R, summary: "Vistas guardadas" },
  { method: "post", path: "/v1/agreement-views", tag: R, summary: "Guardar una vista", body: AgreementViewInput, status: 201 },
  { method: "delete", path: "/v1/agreement-views/{id}", tag: R, summary: "Borrar una vista", response: "none", status: 204 },

  {
    method: "get",
    path: "/v1/document-templates",
    tag: D,
    summary: "Plantillas de documentos",
    description:
      "Listado sin la fuente: metadatos, datos de ejemplo y análisis (variables, roles, cláusulas). **Cambio:** los ítems ya no incluyen `source` (antes sí); quien lo leía del listado tiene que pedir cada plantilla con GET /v1/document-templates/{id}, que sí lo trae.",
  },
  { method: "post", path: "/v1/document-templates", tag: D, summary: "Crear una plantilla de documento", body: DocumentTemplateInput, status: 201 },
  { method: "get", path: "/v1/document-templates/{id}", tag: D, summary: "Ver una plantilla (con análisis de variables y roles)" },
  {
    method: "patch",
    path: "/v1/document-templates/{id}",
    tag: D,
    summary: "Editar una plantilla",
    description:
      "Con `X-Expected-Updated-At` (el updatedAt leído), 409 version_changed si otra persona la cambió mientras tanto. Un rol de firma de más de 80 caracteres es 400 template_syntax.",
    body: UpdateDocumentTemplateInput,
    expectedUpdatedAt: true,
    errors: ["version_changed", "template_syntax"],
  },
  { method: "delete", path: "/v1/document-templates/{id}", tag: D, summary: "Archivar una plantilla", response: "none", status: 204 },
  { method: "post", path: "/v1/document-templates/{id}/preview", tag: D, summary: "Vista previa (bloques + variables faltantes)" },
  { method: "post", path: "/v1/document-templates/render", tag: D, summary: "PDF de prueba de una plantilla o de un texto", body: RenderDocumentInput, response: "pdf" },
  {
    method: "post",
    path: "/v1/document-templates/{id}/generate",
    tag: D,
    summary: "Generar el documento y crear el sobre",
    description:
      "Las marcas {{firma:Rol}} se convierten en campos del firmante de ese rol. 422 si faltan datos, cláusulas o firmantes. Un firmante cuyo rol la plantilla declara pero no tiene ninguna marca en el documento generado (p. ej. una firma dentro de un {{#if}} que no se cumplió) no se agrega al sobre; un rol que la plantilla no declara da 422 unknown_roles y se informa en `warnings` (code signer_without_marks, roles); si no queda ningún firmante, 422 unknown_roles. La metadata del sobre guarda `documentProvenance` (sha256 de la fuente de la plantilla y de cada cláusula insertada). El documento generado admite hasta 300 000 caracteres y 500 marcas de firma o campos (si no, 400 template_syntax). Admite `Idempotency-Key`.",
    body: GenerateDocumentInput,
    status: 201,
  },
  { method: "get", path: "/v1/clauses", tag: D, summary: "Biblioteca de cláusulas" },
  { method: "post", path: "/v1/clauses", tag: D, summary: "Crear una cláusula", body: ClauseInput, status: 201 },
  {
    method: "get",
    path: "/v1/clauses/{id}/usage",
    tag: D,
    summary: "Dónde se usa una cláusula",
    description: "Plantillas de documentos no archivadas y otras cláusulas que la citan con {{clausula:codigo}} (en cualquier rama de un {{#if}} o {{#each}}): `{ templates: [{id, name}], clauses: [{id, slug, title}] }`.",
  },
  {
    method: "patch",
    path: "/v1/clauses/{id}",
    tag: D,
    summary: "Editar una cláusula",
    description:
      "Con `X-Expected-Updated-At`, 409 version_changed si cambió mientras tanto. 400 template_syntax si el texto tiene errores, si las cláusulas quedarían citándose en ciclo o con más de 8 niveles de cláusulas que citan cláusulas.",
    expectedUpdatedAt: true,
    errors: ["version_changed", "template_syntax"],
  },
  {
    method: "delete",
    path: "/v1/clauses/{id}",
    tag: D,
    summary: "Borrar una cláusula",
    description: "409 clause_in_use si la citan plantillas no archivadas u otras cláusulas (details con la misma forma que GET /v1/clauses/{id}/usage).",
    response: "none",
    status: 204,
    errors: ["clause_in_use"],
  },

  { method: "get", path: "/v1/workflows", tag: W, summary: "Workflows" },
  { method: "post", path: "/v1/workflows", tag: W, summary: "Crear un workflow", body: WorkflowInput, status: 201 },
  { method: "get", path: "/v1/workflows/{id}", tag: W, summary: "Ver un workflow" },
  { method: "patch", path: "/v1/workflows/{id}", tag: W, summary: "Editar un workflow", body: UpdateWorkflowInput },
  { method: "delete", path: "/v1/workflows/{id}", tag: W, summary: "Borrar un workflow", response: "none", status: 204 },
  { method: "post", path: "/v1/workflows/{id}/runs", tag: W, summary: "Iniciar una ejecución", body: StartWorkflowInput, status: 201 },
  {
    method: "get",
    path: "/v1/workflow-runs",
    tag: W,
    summary: "Ejecuciones",
    description:
      "Query: workflowId, status. Con templates:manage sin envelopes:view_all, las ejecuciones que no inició ni aprueba vienen con redacted: true (context vacío, output null, sin collectUrl).",
    response: z.object({ items: z.array(WorkflowRunSchema) }),
  },
  {
    method: "get",
    path: "/v1/workflow-runs/{id}",
    tag: W,
    summary: "Ver una ejecución",
    description: "redacted: true si quien consulta solo administra plantillas (no la inició, no aprueba un paso ni ve todos los sobres): se omiten context, salidas de los pasos y collectUrl.",
    response: WorkflowRunSchema,
  },
  { method: "post", path: "/v1/workflow-runs/{id}/steps/{index}/decision", tag: W, summary: "Aprobar o rechazar un paso de aprobación", description: "Rechazar deja la ejecución en rejected y anula sus sobres en curso.", body: ApprovalDecisionInput },
  { method: "post", path: "/v1/workflow-runs/{id}/cancel", tag: W, summary: "Cancelar una ejecución (anula sus sobres en curso)", description: "También una ejecución fallida: es la forma de anular los sobres que dejó en firma." },
  { method: "post", path: "/v1/workflow-runs/{id}/retry", tag: W, summary: "Reintentar el paso fallido" },
  { method: "get", path: "/v1/public/workflows/{slug}", tag: W, summary: "Workflow con inicio público", auth: "none", response: PublicWorkflowStartSchema },
  {
    method: "post",
    path: "/v1/public/workflows/{slug}/start",
    tag: W,
    summary: "Iniciar desde el link público",
    description:
      "Cuerpo: { website?, captchaToken? } (captchaToken obligatorio si GET devuelve captchaSiteKey; si no, 400 captcha_failed). Exige la funcionalidad web_forms del plan (si no, 404). Hasta 60 ejecuciones públicas por hora por workflow y un tope por organización compartido con los formularios web (después, 429 workflow_rate_limited, sin Retry-After). Los destinatarios cuyo correo o teléfono escribió quien completó el formulario quedan autorregistrados: no reciben invitaciones ni recordatorios hasta validar su correo.",
    auth: "none",
    status: 201,
    errors: ["workflow_rate_limited", "captcha_failed"],
  },
  { method: "get", path: "/v1/public/workflow-runs/{token}", tag: W, summary: "Estado público de una ejecución", auth: "none" },
  {
    method: "post",
    path: "/v1/public/workflow-runs/{token}/steps/{index}",
    tag: W,
    summary: "Completar un paso de datos",
    description:
      "410 workflow_inactive si el workflow se desactivó (o, en una ejecución pública, se despublicó o el plan ya no incluye web_forms); 422 too_fast si se envía menos de 2,5 s después de mostrarse; 429 form_recent_submission si el mismo correo desde la misma IP completó otra ejecución del workflow hace poco. Las ejecuciones que esperan un formulario vencen (cancelled) a los 7 días sin actividad.",
    body: SubmitCollectInput,
    auth: "none",
    errors: ["workflow_inactive", "too_fast", "form_recent_submission"],
  },

  { method: "get", path: "/v1/negotiations", tag: N, summary: "Negociaciones" },
  {
    method: "post",
    path: "/v1/negotiations",
    tag: N,
    summary: "Compartir un borrador para negociar",
    body: CreateNegotiationInput,
    status: 201,
    description:
      "participants[].role es un rol de firma del documento ({{firma:Rol}}): 400 unknown_role si no existe, duplicate_role si se repite, missing_roles si falta más de uno. Para contrapartes que no firman (copia), observer: true: su role es una etiqueta libre (400 observer_signing_role si coincide con un rol de firma).",
  },
  { method: "post", path: "/v1/negotiations/upload", tag: N, summary: "Negociar un PDF (solo comentarios)", multipart: true, status: 201, description: "415 si se sube un documento de Word." },
  { method: "get", path: "/v1/negotiations/{id}", tag: N, summary: "Ver una negociación" },
  { method: "get", path: "/v1/negotiations/{id}/diff", tag: N, summary: "Diff entre versiones", description: "Query: from, to." },
  { method: "get", path: "/v1/negotiations/{id}/pdf", tag: N, summary: "PDF de la versión actual", response: "pdf" },
  {
    method: "patch",
    path: "/v1/negotiations/{id}",
    tag: N,
    summary: "Editar el borrador (versión nueva)",
    description:
      "Edición directa del remitente: `data` reemplaza los datos de la plantilla y `clauseOverrides` cambia el texto de cláusulas (se combinan con los cambios anteriores). Crea una versión nueva y avisa a las contrapartes. 409 closed si la negociación ya se cerró; 409 pdf_source si es un PDF subido (no se edita: subir otro como negociación nueva).",
    body: z.object({
      data: z.record(z.string(), z.unknown()).optional(),
      clauseOverrides: z.record(z.string(), z.string().max(50_000)).optional().describe("Clave de la cláusula → texto nuevo."),
      summary: z.string().max(500).optional().describe("Resumen del cambio (por defecto \"Edición del remitente\")."),
    }),
  },
  {
    method: "patch",
    path: "/v1/negotiations/{id}/comments/{commentId}",
    tag: N,
    summary: "Marcar un comentario como resuelto (o reabrirlo)",
    body: z.object({ resolved: z.boolean() }),
  },
  {
    method: "post",
    path: "/v1/negotiations/{id}/comments",
    tag: N,
    summary: "Comentar",
    description: "Hasta 500 comentarios por negociación (429 too_many_comments). Si mientras tanto hay una versión nueva, 409 version_changed.",
    body: NegotiationCommentInput,
    status: 201,
    errors: ["too_many_comments", "version_changed_negotiation"],
  },
  {
    method: "post",
    path: "/v1/negotiations/{id}/proposals/{proposalId}/decision",
    tag: N,
    summary: "Aceptar o rechazar una propuesta",
    description: "Aceptar una propuesta cuyo texto cambió desde que se hizo responde 409 proposal_outdated: rechazarla y pedir otra.",
    body: ProposalDecisionInput,
    errors: ["proposal_outdated"],
  },
  {
    method: "post",
    path: "/v1/negotiations/{id}/accept",
    tag: N,
    summary: "Aceptar y crear el sobre",
    description: "`expectedVersion` (opcional): la versión que se revisó; si ya hay otra, 409 version_changed en vez de aceptar algo que no se vio.",
    body: AcceptNegotiationInput,
    errors: ["version_changed_negotiation"],
  },
  { method: "post", path: "/v1/negotiations/{id}/cancel", tag: N, summary: "Cancelar la negociación" },
  { method: "get", path: "/v1/public/negotiations/{token}", tag: N, summary: "Vista de la contraparte", auth: "none" },
  { method: "get", path: "/v1/public/negotiations/{token}/diff", tag: N, summary: "Diff entre versiones (contraparte)", auth: "none" },
  { method: "get", path: "/v1/public/negotiations/{token}/pdf", tag: N, summary: "PDF de la versión actual (contraparte)", response: "pdf", auth: "none" },
  {
    method: "post",
    path: "/v1/public/negotiations/{token}/comments",
    tag: N,
    summary: "Comentario de la contraparte",
    description: "Hasta 500 comentarios por negociación (429 too_many_comments); 409 version_changed si hay una versión nueva.",
    body: NegotiationCommentInput,
    auth: "none",
    status: 201,
    errors: ["too_many_comments", "version_changed_negotiation"],
  },
  {
    method: "post",
    path: "/v1/public/negotiations/{token}/proposals",
    tag: N,
    summary: "Propuesta de cambio de la contraparte",
    description: "Hasta 20 propuestas sin decidir por participante (429 too_many_proposals); 409 version_changed si hay una versión nueva.",
    body: NegotiationProposalInput,
    auth: "none",
    status: 201,
    errors: ["too_many_proposals", "version_changed_negotiation"],
  },
];
