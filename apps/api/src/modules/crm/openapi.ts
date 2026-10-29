// Operaciones de CRM y ERP para el OpenAPI.
import { z } from "zod";
import {
  CRM_OBJECT_TYPES,
  CRM_PROVIDERS,
  CRM_TRIGGERS,
  CreateCrmLinkInput,
  CreateCrmMappingInput,
  CreateCrmTokenConnectionInput,
  CrmPrefillMapping,
  CrmRoleMapping,
  CrmTriggerConfig,
  CrmWriteBack,
  SendFromCrmRecordInput,
  StartCrmOAuthInput,
  UpdateCrmConnectionInput,
  UpdateCrmMappingInput,
} from "@calasign/shared";
import { named } from "../openapi-schemas";

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
  /** Códigos del catálogo ERRORS (openapi-extra.ts). */
  errors?: string[];
};

const iso = z.string().datetime();

/** Espejo de CrmMapping (packages/shared/src/crm.ts). */
const CrmMappingSchema = named(
  "CrmMapping",
  z.object({
    id: z.string().uuid(),
    connectionId: z.string().uuid(),
    name: z.string(),
    objectType: z.enum(CRM_OBJECT_TYPES),
    templateId: z.string().uuid().nullable(),
    roles: z.array(CrmRoleMapping),
    prefill: z.array(CrmPrefillMapping),
    writeBack: CrmWriteBack,
    trigger: z.enum(CRM_TRIGGERS),
    triggerConfig: CrmTriggerConfig,
    send: z.boolean(),
    active: z.boolean(),
    createdAt: iso,
    updatedAt: iso,
  }),
);

/** Espejo de CrmMappingList (GET /v1/crm/mappings). */
const CrmMappingListSchema = named(
  "CrmMappingList",
  z.object({
    items: z.array(CrmMappingSchema),
    connectionsWithoutAccount: z
      .array(z.object({ id: z.string().uuid(), name: z.string(), provider: z.enum(CRM_PROVIDERS) }))
      .describe(
        "Conexiones activas de Pipedrive/Kommo sin su cuenta guardada: sus mapeos no se pueden enviar (409 crm_account_unknown) hasta probar la conexión.",
      ),
  }),
);

const C = "CRM y ERP";

export const CRM_OPS: Op[] = [
  {
    method: "get",
    path: "/v1/crm/providers",
    tag: C,
    summary: "Proveedores disponibles",
    description:
      "HubSpot, Salesforce, Zoho CRM / Bigin, Pipedrive, RD Station CRM, Kommo (CRM) y Siigo, Alegra (ERP); si OAuth está configurado en el servidor; URIs de redirección de cada proveedor OAuth y URL del webhook de HubSpot.",
  },
  { method: "get", path: "/v1/crm/connections", tag: C, summary: "Conexiones" },
  {
    method: "post",
    path: "/v1/crm/connections",
    tag: C,
    summary: "Conectar con token",
    description: "HubSpot (token de app privada), Siigo (usuario + access key) o Alegra (correo + token). Se prueba antes de guardar.",
    body: CreateCrmTokenConnectionInput,
    status: 201,
  },
  {
    method: "post",
    path: "/v1/crm/oauth/{provider}/start",
    tag: C,
    summary: "Iniciar OAuth (HubSpot, Salesforce, Zoho, Pipedrive, RD Station CRM, Kommo)",
    description:
      "Devuelve authorizeUrl. Salesforce y Zoho usan PKCE S256. Zoho: `region` (com, eu, in, com.au, jp, ca, sa, uk, com.cn; por defecto com, que redirige al centro de datos de la cuenta) y `product` (crm o bigin). Pipedrive guarda el api_domain de la compañía que devuelve el token. RD Station CRM usa OAuth de la App Store (API v2). Kommo canjea el código en el subdominio de la cuenta que vuelve en `referer` (solo *.kommo.com) y lo guarda. Requiere sesión web.",
    body: StartCrmOAuthInput,
  },
  { method: "patch", path: "/v1/crm/connections/{id}", tag: C, summary: "Renombrar o desactivar una conexión", body: UpdateCrmConnectionInput },
  {
    method: "delete",
    path: "/v1/crm/connections/{id}",
    tag: C,
    summary: "Quitar una conexión",
    description:
      "Borra la conexión y después revoca los tokens OAuth en el proveedor cuando tiene endpoint (HubSpot, Salesforce, Zoho, Pipedrive; si falla, se desconecta igual), salvo que otra conexión (de cualquier organización) use la misma cuenta del CRM. Borra mapeos y vínculos; la actividad (ejecuciones) se conserva y las pendientes pasan a failed.",
    response: "none",
    status: 204,
  },
  { method: "post", path: "/v1/crm/connections/{id}/test", tag: C, summary: "Probar una conexión" },
  {
    method: "get",
    path: "/v1/crm/mappings",
    tag: C,
    summary: "Mapeos",
    description:
      "`connectionsWithoutAccount`: conexiones activas de Pipedrive/Kommo sin su cuenta guardada (conexiones viejas): sus mapeos no se pueden enviar (409 crm_account_unknown) ni se listan con `companyId` hasta probar la conexión (POST /v1/crm/connections/{id}/test), que la guarda. Alcanza con el permiso de crear sobres; sin settings:manage, solo los mapeos cuya plantilla puede usar la credencial.",
    response: CrmMappingListSchema,
  },
  {
    method: "post",
    path: "/v1/crm/mappings",
    tag: C,
    summary: "Crear un mapeo registro → plantilla",
    body: CreateCrmMappingInput,
    status: 201,
    response: CrmMappingSchema,
  },
  { method: "get", path: "/v1/crm/mappings/{id}", tag: C, summary: "Ver un mapeo", response: CrmMappingSchema },
  { method: "patch", path: "/v1/crm/mappings/{id}", tag: C, summary: "Editar un mapeo", body: UpdateCrmMappingInput, response: CrmMappingSchema },
  { method: "delete", path: "/v1/crm/mappings/{id}", tag: C, summary: "Borrar un mapeo", response: "none", status: 204 },
  {
    method: "post",
    path: "/v1/crm/mappings/{id}/send",
    tag: C,
    summary: "Crear (y enviar) un sobre desde un registro",
    description:
      "Lee el registro (Deal de HubSpot, Zoho o Pipedrive, Opportunity de Salesforce, Contact de Zoho, Person de Pipedrive con objectType contact; en Bigin, Pipeline; Negociação de RD Station CRM —id de 24 caracteres—; Lead de Kommo con objectType deal) y sus contactos (en Pipedrive: persona principal y participantes del deal; en RD Station, los contatos de la negociação; en Kommo, el contacto principal y los demás del lead), arma el sobre con la plantilla del mapeo y lo vincula: el estado y el PDF firmado vuelven al registro. 409 crm_reauth_required si la conexión perdió acceso. `companyId` (opcional, Pipedrive/Kommo): la cuenta desde la que se envía; si la conexión del mapeo es de otra, 409 company_mismatch; sin él se usa la cuenta guardada en la conexión. Si la conexión no tiene su cuenta guardada, 409 crm_account_unknown (probarla la guarda). Acepta Idempotency-Key.",
    body: SendFromCrmRecordInput,
    status: 201,
    idempotent: true,
    errors: ["crm_account_unknown", "company_mismatch"],
  },
  {
    method: "post",
    path: "/v1/crm/links",
    tag: C,
    summary: "Vincular un sobre a un registro",
    description: "Para ERP (cliente, contacto o factura) o CRM. Si el sobre ya está completo, se adjunta el PDF enseguida.",
    body: CreateCrmLinkInput,
    status: 201,
  },
  { method: "get", path: "/v1/crm/links", tag: C, summary: "Vínculos de un sobre", description: "Query: envelopeId (obligatorio)." },
  {
    method: "get",
    path: "/v1/crm/runs",
    tag: C,
    summary: "Actividad (envíos, write-backs, adjuntos)",
    description: "Query: connectionId, envelopeId, status, limit.",
  },
  { method: "post", path: "/v1/crm/runs/{id}/retry", tag: C, summary: "Reintentar una ejecución fallida", status: 202 },
  {
    method: "post",
    path: "/v1/integrations/crm/hubspot/webhook",
    tag: C,
    summary: "Webhook de HubSpot (deal.propertyChange)",
    description:
      "Firma X-HubSpot-Signature-v3 con el client secret de la app; timestamp de hasta 5 minutos. Dispara los mapeos con trigger webhook cuya propiedad y valor coinciden.",
    auth: "none",
  },
];
