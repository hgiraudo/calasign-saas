// Operaciones de CRM y ERP para el OpenAPI.
import type { z } from "zod";
import { CreateCrmLinkInput, CreateCrmMappingInput, CreateCrmTokenConnectionInput, SendFromCrmRecordInput, StartCrmOAuthInput, UpdateCrmConnectionInput, UpdateCrmMappingInput } from "@calasign/shared";

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

const C = "CRM y ERP";

export const CRM_OPS: Op[] = [
  { method: "get", path: "/v1/crm/providers", tag: C, summary: "Proveedores disponibles", description: "HubSpot, Salesforce, Zoho CRM / Bigin, Pipedrive (CRM) y Siigo, Alegra (ERP); si OAuth está configurado en el servidor; URIs de redirección y URL del webhook de HubSpot." },
  { method: "get", path: "/v1/crm/connections", tag: C, summary: "Conexiones" },
  { method: "post", path: "/v1/crm/connections", tag: C, summary: "Conectar con token", description: "HubSpot (token de app privada), Siigo (usuario + access key) o Alegra (correo + token). Se prueba antes de guardar.", body: CreateCrmTokenConnectionInput, status: 201 },
  { method: "post", path: "/v1/crm/oauth/{provider}/start", tag: C, summary: "Iniciar OAuth (HubSpot, Salesforce, Zoho, Pipedrive)",
    description:
      "Devuelve authorizeUrl. Salesforce y Zoho usan PKCE S256. Zoho: `region` (com, eu, in, com.au, jp, ca, sa, uk, com.cn; por defecto com, que redirige al centro de datos de la cuenta) y `product` (crm o bigin). Pipedrive guarda el api_domain de la compañía que devuelve el token. Requiere sesión web.", body: StartCrmOAuthInput },
  { method: "patch", path: "/v1/crm/connections/{id}", tag: C, summary: "Renombrar o desactivar una conexión", body: UpdateCrmConnectionInput },
  { method: "delete", path: "/v1/crm/connections/{id}", tag: C, summary: "Quitar una conexión", response: "none", status: 204 },
  { method: "post", path: "/v1/crm/connections/{id}/test", tag: C, summary: "Probar una conexión" },
  { method: "get", path: "/v1/crm/mappings", tag: C, summary: "Mapeos", description: "Query: connectionId, provider (solo mapeos de conexiones activas de ese proveedor). Alcanza con el permiso de crear sobres." },
  { method: "post", path: "/v1/crm/mappings", tag: C, summary: "Crear un mapeo registro → plantilla", body: CreateCrmMappingInput, status: 201 },
  { method: "get", path: "/v1/crm/mappings/{id}", tag: C, summary: "Ver un mapeo" },
  { method: "patch", path: "/v1/crm/mappings/{id}", tag: C, summary: "Editar un mapeo", body: UpdateCrmMappingInput },
  { method: "delete", path: "/v1/crm/mappings/{id}", tag: C, summary: "Borrar un mapeo", response: "none", status: 204 },
  {
    method: "post",
    path: "/v1/crm/mappings/{id}/send",
    tag: C,
    summary: "Crear (y enviar) un sobre desde un registro",
    description: "Lee el registro (Deal de HubSpot, Zoho o Pipedrive, Opportunity de Salesforce, Contact de Zoho, Person de Pipedrive con objectType contact; en Bigin, Pipeline) y sus contactos (en Pipedrive: persona principal y participantes del deal), arma el sobre con la plantilla del mapeo y lo vincula: el estado y el PDF firmado vuelven al registro. 409 crm_reauth_required si la conexión perdió acceso.",
    body: SendFromCrmRecordInput,
    status: 201,
  },
  { method: "post", path: "/v1/crm/links", tag: C, summary: "Vincular un sobre a un registro", description: "Para ERP (cliente, contacto o factura) o CRM. Si el sobre ya está completo, se adjunta el PDF enseguida.", body: CreateCrmLinkInput, status: 201 },
  { method: "get", path: "/v1/crm/links", tag: C, summary: "Vínculos de un sobre", description: "Query: envelopeId (obligatorio)." },
  { method: "get", path: "/v1/crm/runs", tag: C, summary: "Actividad (envíos, write-backs, adjuntos)", description: "Query: connectionId, envelopeId, status, limit." },
  { method: "post", path: "/v1/crm/runs/{id}/retry", tag: C, summary: "Reintentar una ejecución fallida", status: 202 },
  {
    method: "post",
    path: "/v1/integrations/crm/hubspot/webhook",
    tag: C,
    summary: "Webhook de HubSpot (deal.propertyChange)",
    description: "Firma X-HubSpot-Signature-v3 con el client secret de la app; timestamp de hasta 5 minutos. Dispara los mapeos con trigger webhook cuya propiedad y valor coinciden.",
    auth: "none",
  },
];
