// Operaciones de Fase 6 (acuerdos) para el OpenAPI.
import type { z } from "zod";
import {
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
  WorkflowInput,
} from "@calasign/shared";

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
};

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
  { method: "get", path: "/v1/agreements/{id}/file", tag: R, summary: "Descargar el PDF del acuerdo", response: "pdf" },
  { method: "get", path: "/v1/agreement-fields", tag: R, summary: "Campos propios" },
  { method: "post", path: "/v1/agreement-fields", tag: R, summary: "Crear un campo propio", body: AgreementFieldInput, status: 201 },
  { method: "delete", path: "/v1/agreement-fields/{id}", tag: R, summary: "Borrar un campo propio", response: "none", status: 204 },
  { method: "get", path: "/v1/agreement-views", tag: R, summary: "Vistas guardadas" },
  { method: "post", path: "/v1/agreement-views", tag: R, summary: "Guardar una vista", body: AgreementViewInput, status: 201 },
  { method: "delete", path: "/v1/agreement-views/{id}", tag: R, summary: "Borrar una vista", response: "none", status: 204 },

  { method: "get", path: "/v1/document-templates", tag: D, summary: "Plantillas de documentos" },
  { method: "post", path: "/v1/document-templates", tag: D, summary: "Crear una plantilla de documento", body: DocumentTemplateInput, status: 201 },
  { method: "get", path: "/v1/document-templates/{id}", tag: D, summary: "Ver una plantilla (con análisis de variables y roles)" },
  { method: "patch", path: "/v1/document-templates/{id}", tag: D, summary: "Editar una plantilla", body: UpdateDocumentTemplateInput },
  { method: "delete", path: "/v1/document-templates/{id}", tag: D, summary: "Archivar una plantilla", response: "none", status: 204 },
  { method: "post", path: "/v1/document-templates/{id}/preview", tag: D, summary: "Vista previa (bloques + variables faltantes)" },
  { method: "post", path: "/v1/document-templates/render", tag: D, summary: "PDF de prueba de una plantilla o de un texto", body: RenderDocumentInput, response: "pdf" },
  {
    method: "post",
    path: "/v1/document-templates/{id}/generate",
    tag: D,
    summary: "Generar el documento y crear el sobre",
    description: "Las marcas {{firma:Rol}} se convierten en campos del firmante de ese rol. 422 si faltan datos, cláusulas o firmantes.",
    body: GenerateDocumentInput,
    status: 201,
  },
  { method: "get", path: "/v1/clauses", tag: D, summary: "Biblioteca de cláusulas" },
  { method: "post", path: "/v1/clauses", tag: D, summary: "Crear una cláusula", body: ClauseInput, status: 201 },
  { method: "patch", path: "/v1/clauses/{id}", tag: D, summary: "Editar una cláusula" },
  { method: "delete", path: "/v1/clauses/{id}", tag: D, summary: "Borrar una cláusula", response: "none", status: 204 },

  { method: "get", path: "/v1/workflows", tag: W, summary: "Workflows" },
  { method: "post", path: "/v1/workflows", tag: W, summary: "Crear un workflow", body: WorkflowInput, status: 201 },
  { method: "get", path: "/v1/workflows/{id}", tag: W, summary: "Ver un workflow" },
  { method: "patch", path: "/v1/workflows/{id}", tag: W, summary: "Editar un workflow", body: UpdateWorkflowInput },
  { method: "delete", path: "/v1/workflows/{id}", tag: W, summary: "Borrar un workflow", response: "none", status: 204 },
  { method: "post", path: "/v1/workflows/{id}/runs", tag: W, summary: "Iniciar una ejecución", body: StartWorkflowInput, status: 201 },
  { method: "get", path: "/v1/workflow-runs", tag: W, summary: "Ejecuciones", description: "Query: workflowId, status." },
  { method: "get", path: "/v1/workflow-runs/{id}", tag: W, summary: "Ver una ejecución" },
  { method: "post", path: "/v1/workflow-runs/{id}/steps/{index}/decision", tag: W, summary: "Aprobar o rechazar un paso de aprobación", body: ApprovalDecisionInput },
  { method: "post", path: "/v1/workflow-runs/{id}/cancel", tag: W, summary: "Cancelar una ejecución (anula sus sobres en curso)" },
  { method: "post", path: "/v1/workflow-runs/{id}/retry", tag: W, summary: "Reintentar el paso fallido" },
  { method: "get", path: "/v1/public/workflows/{slug}", tag: W, summary: "Workflow con inicio público", auth: "none" },
  { method: "post", path: "/v1/public/workflows/{slug}/start", tag: W, summary: "Iniciar desde el link público", auth: "none", status: 201 },
  { method: "get", path: "/v1/public/workflow-runs/{token}", tag: W, summary: "Estado público de una ejecución", auth: "none" },
  { method: "post", path: "/v1/public/workflow-runs/{token}/steps/{index}", tag: W, summary: "Completar un paso de datos", body: SubmitCollectInput, auth: "none" },

  { method: "get", path: "/v1/negotiations", tag: N, summary: "Negociaciones" },
  { method: "post", path: "/v1/negotiations", tag: N, summary: "Compartir un borrador para negociar", body: CreateNegotiationInput, status: 201 },
  { method: "post", path: "/v1/negotiations/upload", tag: N, summary: "Negociar un PDF (solo comentarios)", multipart: true, status: 201, description: "415 si se sube un documento de Word." },
  { method: "get", path: "/v1/negotiations/{id}", tag: N, summary: "Ver una negociación" },
  { method: "get", path: "/v1/negotiations/{id}/diff", tag: N, summary: "Diff entre versiones", description: "Query: from, to." },
  { method: "get", path: "/v1/negotiations/{id}/pdf", tag: N, summary: "PDF de la versión actual", response: "pdf" },
  { method: "post", path: "/v1/negotiations/{id}/comments", tag: N, summary: "Comentar", body: NegotiationCommentInput, status: 201 },
  { method: "post", path: "/v1/negotiations/{id}/proposals/{proposalId}/decision", tag: N, summary: "Aceptar o rechazar una propuesta", body: ProposalDecisionInput },
  { method: "post", path: "/v1/negotiations/{id}/accept", tag: N, summary: "Aceptar y crear el sobre", body: AcceptNegotiationInput },
  { method: "post", path: "/v1/negotiations/{id}/cancel", tag: N, summary: "Cancelar la negociación" },
  { method: "get", path: "/v1/public/negotiations/{token}", tag: N, summary: "Vista de la contraparte", auth: "none" },
  { method: "post", path: "/v1/public/negotiations/{token}/comments", tag: N, summary: "Comentario de la contraparte", body: NegotiationCommentInput, auth: "none", status: 201 },
  { method: "post", path: "/v1/public/negotiations/{token}/proposals", tag: N, summary: "Propuesta de cambio de la contraparte", body: NegotiationProposalInput, auth: "none", status: 201 },
];
