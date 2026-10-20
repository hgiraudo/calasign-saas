// Operaciones de los conectores HRIS y CLM para el OpenAPI.
import type { z } from "zod";
import {
  CreateConnectorConnectionInput,
  CreateConnectorFlowInput,
  SendFromConnectorInput,
  StartConnectorOAuthInput,
  UpdateConnectorConnectionInput,
  UpdateConnectorFlowInput,
} from "@calasign/shared";

type Op = {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  tag: string;
  summary: string;
  description?: string;
  body?: z.ZodTypeAny;
  response?: z.ZodTypeAny | "pdf" | "none";
  status?: number;
  auth?: "key" | "none";
};

export const CONNECTOR_TAG = "RR. HH. y contratos";
const C = CONNECTOR_TAG;

export const CONNECTOR_OPS: Op[] = [
  {
    method: "get",
    path: "/v1/connectors/providers",
    tag: C,
    summary: "Conectores disponibles",
    description: "BambooHR, HiBob, Factorial (RR. HH.), Ironclad y Juro (contratos): tipos de registro, campos de credenciales, si OAuth está configurado y las URIs de redirección.",
  },
  { method: "get", path: "/v1/connectors/connections", tag: C, summary: "Conexiones", description: "Cada una con su URL de webhook (lleva un secreto)." },
  {
    method: "post",
    path: "/v1/connectors/connections",
    tag: C,
    summary: "Conectar con clave de API",
    description: "credentials según el proveedor (ver /v1/connectors/providers). Se prueba antes de guardar; los secretos quedan cifrados.",
    body: CreateConnectorConnectionInput,
    status: 201,
  },
  { method: "post", path: "/v1/connectors/oauth/{provider}/start", tag: C, summary: "Iniciar OAuth (Ironclad, Factorial)", description: "Devuelve authorizeUrl (PKCE S256). Requiere sesión web.", body: StartConnectorOAuthInput },
  { method: "patch", path: "/v1/connectors/connections/{id}", tag: C, summary: "Renombrar o desactivar una conexión", body: UpdateConnectorConnectionInput },
  {
    method: "delete",
    path: "/v1/connectors/connections/{id}",
    tag: C,
    summary: "Quitar una conexión",
    description: "Borra la conexión y después revoca el token OAuth en el proveedor cuando tiene endpoint (Factorial; si falla, se desconecta igual), salvo que otra conexión use la misma compañía. Borra flujos y vínculos; la actividad se conserva y las ejecuciones pendientes pasan a failed.",
    response: "none",
    status: 204,
  },
  { method: "post", path: "/v1/connectors/connections/{id}/test", tag: C, summary: "Probar una conexión" },
  { method: "post", path: "/v1/connectors/connections/{id}/rotate-webhook", tag: C, summary: "Regenerar la URL de webhook", description: "La URL anterior deja de funcionar." },
  { method: "get", path: "/v1/connectors/connections/{id}/records", tag: C, summary: "Buscar empleados o contratos en el sistema de origen", description: "Query: q (texto), objectType. Hasta 25 resultados." },
  { method: "get", path: "/v1/connectors/flows", tag: C, summary: "Flujos", description: "Query: connectionId." },
  {
    method: "post",
    path: "/v1/connectors/flows",
    tag: C,
    summary: "Crear un flujo registro → plantilla",
    description:
      "Destinatarios por rol (empleado, su jefe, la contraparte del contrato, propiedades o datos fijos), prellenado, documento de origen (record: el contrato del CLM más la hoja de firmas de la plantilla) y qué devolver al completarse (PDF sellado, certificado de evidencia, estado).",
    body: CreateConnectorFlowInput,
    status: 201,
  },
  { method: "get", path: "/v1/connectors/flows/{id}", tag: C, summary: "Ver un flujo" },
  { method: "patch", path: "/v1/connectors/flows/{id}", tag: C, summary: "Editar un flujo", body: UpdateConnectorFlowInput },
  { method: "delete", path: "/v1/connectors/flows/{id}", tag: C, summary: "Borrar un flujo", response: "none", status: 204 },
  {
    method: "post",
    path: "/v1/connectors/flows/{id}/send",
    tag: C,
    summary: "Crear (y enviar) un sobre desde un empleado o contrato",
    description: "Lee el registro, arma el sobre y lo vincula: al completarse, el PDF firmado (y la evidencia) vuelven al legajo o registro. 409 connector_reauth_required si la conexión perdió acceso. Admite `Idempotency-Key`.",
    body: SendFromConnectorInput,
    status: 201,
  },
  { method: "get", path: "/v1/connectors/links", tag: C, summary: "Vínculos de un sobre", description: "Query: envelopeId (obligatorio)." },
  { method: "get", path: "/v1/connectors/runs", tag: C, summary: "Actividad (envíos y devoluciones)", description: "Query: connectionId, envelopeId, status, limit." },
  { method: "post", path: "/v1/connectors/runs/{id}/retry", tag: C, summary: "Reintentar una ejecución fallida", status: 202 },
  {
    method: "post",
    path: "/v1/integrations/connectors/hook/{token}",
    tag: C,
    summary: "Webhook del sistema de origen",
    description:
      "URL secreta por conexión (connection.webhookUrl). Entiende los eventos de BambooHR (employees[].id), HiBob, Factorial, Ironclad (payload.workflowID / recordId) y Juro (contract.id), o un cuerpo genérico {recordId, event}. Dispara los flujos con trigger webhook (filtrando por triggerConfig.event); un registro con un sobre en curso no genera otro. La misma entrega repetida dentro de 10 minutos (CONNECTOR_WEBHOOK_DEDUPE_MINUTES) no duplica. Un flujo con webhookSecret solo se dispara con `X-CalaSign-Signature: sha256=<hex HMAC-SHA256(secreto, cuerpo crudo)>` (o Bob-Signature de HiBob / x-factorial-wh-challenge de Factorial); si todos los flujos que coinciden la exigen y no verifica, 401 invalid_signature.",
    auth: "none",
  },
];
