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
  idempotent?: boolean;
};

const C = "CRM y ERP";

export const CRM_OPS: Op[] = [
  { method: "get", path: "/v1/crm/providers", tag: C, summary: "Proveedores disponibles", description: "HubSpot, Salesforce, Zoho CRM / Bigin, Pipedrive, RD Station CRM, Kommo (CRM) y Siigo, Alegra (ERP); si OAuth está configurado en el servidor; URIs de redirección de cada proveedor OAuth y URL del webhook de HubSpot." },
  { method: "get", path: "/v1/crm/connections", tag: C, summary: "Conexiones" },
  { method: "post", path: "/v1/crm/connections", tag: C, summary: "Conectar con token", description: "HubSpot (token de app privada), Siigo (usuario + access key) o Alegra (correo + token). Se prueba antes de guardar.", body: CreateCrmTokenConnectionInput, status: 201 },
  { method: "post", path: "/v1/crm/oauth/{provider}/start", tag: C, summary: "Iniciar OAuth (HubSpot, Salesforce, Zoho, Pipedrive, RD Station CRM, Kommo)",
    description:
      "Devuelve authorizeUrl. Salesforce y Zoho usan PKCE S256. Zoho: `region` (com, eu, in, com.au, jp, ca, sa, uk, com.cn; por defecto com, que redirige al centro de datos de la cuenta) y `product` (crm o bigin). Pipedrive guarda el api_domain de la compañía que devuelve el token. RD Station CRM usa OAuth de la App Store (API v2). Kommo canjea el código en el subdominio de la cuenta que vuelve en `referer` (solo *.kommo.com) y lo guarda. Requiere sesión web.", body: StartCrmOAuthInput },
  { method: "patch", path: "/v1/crm/connections/{id}", tag: C, summary: "Renombrar o desactivar una conexión", body: UpdateCrmConnectionInput },
  {
    method: "delete",
    path: "/v1/crm/connections/{id}",
    tag: C,
    summary: "Quitar una conexión",
    description: "Borra la conexión y después revoca los tokens OAuth en el proveedor cuando tiene endpoint (HubSpot, Salesforce, Zoho, Pipedrive; si falla, se desconecta igual), salvo que otra conexión (de cualquier organización) use la misma cuenta del CRM. Borra mapeos y vínculos; la actividad (ejecuciones) se conserva y las pendientes pasan a failed.",
    response: "none",
    status: 204,
  },
  { method: "post", path: "/v1/crm/connections/{id}/test", tag: C, summary: "Probar una conexión" },
  { method: "get", path: "/v1/crm/mappings", tag: C, summary: "Mapeos", description: "Query: connectionId, provider (solo mapeos de conexiones activas de ese proveedor), companyId (con provider pipedrive o kommo: solo conexiones de esa cuenta del CRM —company_id de Pipedrive, id de cuenta de Kommo—; las que no la tienen guardada no se incluyen). La respuesta trae connectionsWithoutAccount: conexiones activas de Pipedrive/Kommo sin su cuenta guardada (sus mapeos no se pueden enviar hasta probar la conexión). Alcanza con el permiso de crear sobres." },
  { method: "post", path: "/v1/crm/mappings", tag: C, summary: "Crear un mapeo registro → plantilla", body: CreateCrmMappingInput, status: 201 },
  { method: "get", path: "/v1/crm/mappings/{id}", tag: C, summary: "Ver un mapeo" },
  { method: "patch", path: "/v1/crm/mappings/{id}", tag: C, summary: "Editar un mapeo", body: UpdateCrmMappingInput },
  { method: "delete", path: "/v1/crm/mappings/{id}", tag: C, summary: "Borrar un mapeo", response: "none", status: 204 },
  {
    method: "post",
    path: "/v1/crm/mappings/{id}/send",
    tag: C,
    summary: "Crear (y enviar) un sobre desde un registro",
    description: "Lee el registro (Deal de HubSpot, Zoho o Pipedrive, Opportunity de Salesforce, Contact de Zoho, Person de Pipedrive con objectType contact; en Bigin, Pipeline; Negociação de RD Station CRM —id de 24 caracteres—; Lead de Kommo con objectType deal) y sus contactos (en Pipedrive: persona principal y participantes del deal; en RD Station, los contatos de la negociação; en Kommo, el contacto principal y los demás del lead), arma el sobre con la plantilla del mapeo y lo vincula: el estado y el PDF firmado vuelven al registro. 409 crm_reauth_required si la conexión perdió acceso. `companyId` (opcional, Pipedrive/Kommo): la cuenta desde la que se envía; si la conexión del mapeo es de otra, 409 company_mismatch; sin él se usa la cuenta guardada en la conexión. Si la conexión no tiene su cuenta guardada, 409 crm_account_unknown (probarla la guarda). Acepta Idempotency-Key.",
    body: SendFromCrmRecordInput,
    status: 201,
    idempotent: true,
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
