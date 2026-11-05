// Aislamiento entre organizaciones en los ids que viajan en el CUERPO o en la QUERY (SEG-11; los del path los recorre
// tenant-isolation-routes.test.ts). Misma app real sobre PGlite con dos organizaciones, A y B, sembradas con
// tenant-isolation-fixtures.ts.
//
// Los campos se enumeran desde el OpenAPI (buildOpenApi): todo campo del cuerpo o parámetro de query que por nombre
// (`id`, `…Id`, `…Ids`, `…_id`) o por formato (uuid) es un id. Cada uno tiene que estar en una prueba de PROBES o en
// EXEMPT con el motivo; uno nuevo sin ninguna de las dos hace fallar el test y dice qué agregar.
//
// Cada prueba pega con las credenciales de A, sobre recursos de A, con el id de B en ese campo. Esperado: la MISMA
// respuesta que con un uuid que no existe (status, código de error, status de cada elemento de un lote y cantidad de
// elementos de un listado), así el id de B no dice ni que existe; y además:
// - `lookup` (el campo nombra un recurso de la organización): un 4xx. No se exige 404: varias rutas contestan 400 con
//   un código propio (invalid_role, invalid_brand…) para cualquier id que no sea de la organización, y eso ya no
//   distingue a B.
// - `local` (nombra algo del mismo sobre o plantilla: un firmante, un documento, un campo): un 4xx, o un 2xx si el id
//   se ignora o se reemplaza.
// - `filter` (filtra un listado): 2xx o 404.
// `acceptedOracle`: los ids que elige el cliente y son la clave de la fila (firmantes, roles de plantilla); uno en uso
// en otra organización da id_in_use. Ahí no se puede exigir la respuesta de un id libre sin romper el contrato.
// Y siempre: B no cambia (hash de cada tabla), ninguna fila de A queda con un id de B (el caso que el path no ve: un
// sobre de A creado con la plantilla de B se lleva su PDF) y la respuesta no trae ids ni la marca de B.
// Al final, el control positivo: el mismo pedido con el id de A responde 2xx (si no, el 404 podía ser de un cuerpo mal
// armado y no del filtro de tenant). Las rutas que no figuran en el OpenAPI (sesión web, SCIM) van en EXTRA_PROBES.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Fixtures } from "./tenant-isolation-fixtures";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-tenant-refs-"));
delete process.env.DATABASE_URL;

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
type CredName = "cookie" | "apiKey" | "scim" | "signer";
interface Org {
  fx: Fixtures;
  cookie: string;
  apiKey: string;
}

// ───────── Campos id del OpenAPI ─────────

const { buildOpenApi } = await import("../src/modules/openapi");

const ID_NAME = /(^id$|Id$|Ids$|_id$)/;

/** "POST /v1/envelopes body.recipients[].inPerson.hostUserId", "GET /v1/envelopes ?template_id"… */
function idFieldsFromOpenApi(): string[] {
  const doc = buildOpenApi() as any;
  const ref = (s: any): any => (s?.$ref ? ref(doc.components.schemas[s.$ref.split("/").pop()]) : s);
  const out = new Set<string>();
  const walk = (route: string, s: any, path: string, depth: number) => {
    s = ref(s);
    if (!s || depth > 8) return;
    for (const k of ["allOf", "oneOf", "anyOf"]) for (const x of s[k] ?? []) walk(route, x, path, depth + 1);
    if (s.items) walk(route, s.items, `${path}[]`, depth + 1);
    for (const [k, v] of Object.entries<any>(s.properties ?? {})) {
      const r = ref(v);
      if (ID_NAME.test(k) || r?.format === "uuid" || ref(r?.items)?.format === "uuid") out.add(`${route} ${path}.${k}`);
      walk(route, v, `${path}.${k}`, depth + 1);
    }
  };
  for (const [p, ops] of Object.entries<any>(doc.paths)) {
    for (const [m, op] of Object.entries<any>(ops)) {
      const route = `${m.toUpperCase()} ${p}`;
      for (const prm of op.parameters ?? []) {
        const q = prm.$ref ? doc.components.parameters[prm.$ref.split("/").pop()] : prm;
        if (q.in === "query" && (ID_NAME.test(q.name) || q.schema?.format === "uuid")) out.add(`${route} ?${q.name}`);
      }
      const content = op.requestBody?.content ?? {};
      for (const type of ["application/json", "multipart/form-data"]) if (content[type]?.schema) walk(route, content[type].schema, "body", 0);
    }
  }
  return [...out].sort();
}

/**
 * Campos id que no nombran un recurso de una organización de CalaSign, con el motivo. Una ruta entera se exceptúa con
 * la clave sin campo ("GET /v1/events/stream").
 */
const EXEMPT: Record<string, string> = {
  // Ids que inventa el cliente para referirse a algo dentro del mismo pedido (o que el servidor reemplaza).
  "POST /v1/envelopes body.fields[].conditions[].fieldId": "condición sobre otro campo del mismo pedido",
  "PUT /v1/envelopes/{id}/fields body.fields[].conditions[].fieldId": "condición sobre otro campo del mismo sobre",
  "POST /v1/envelopes/{id}/corrections body.addFields[].conditions[].fieldId": "condición sobre otro campo del mismo sobre",
  "PUT /v1/templates/{id}/fields body.fields[].conditions[].fieldId": "condición sobre otro campo de la misma plantilla",
  "POST /v1/workflows body.steps[].id": "id del paso dentro de la definición del workflow (lo elige el cliente)",
  "PATCH /v1/workflows/{id} body.steps[].id": "id del paso dentro de la definición del workflow (lo elige el cliente)",
  // Ids de otro sistema (proveedor, IdP, canal), no de CalaSign.
  "POST /v1/envelopes body.recipients[].telegramChatId": "chat de Telegram del firmante",
  "PUT /v1/envelopes/{id}/recipients body.recipients[].telegramChatId": "chat de Telegram del firmante",
  "POST /v1/envelopes/{id}/corrections body.addRecipients[].telegramChatId": "chat de Telegram del firmante",
  "POST /v1/envelopes/from-template body.recipients[].telegramChatId": "chat de Telegram del firmante",
  "POST /v1/storage/connections/s3 body.accessKeyId": "credencial de AWS del cliente",
  "PUT /v1/settings/sso body.oidc.clientId": "client id de la app en el IdP del cliente",
  "POST /v1/crm/connections body.tenantId": "tenant de Azure AD de Dynamics 365 (del CRM, no de CalaSign)",
  "GET /v1/crm/mappings ?companyId": "empresa del lado del CRM (Bitrix24)",
  "POST /v1/crm/mappings/{id}/send body.objectId": "registro del lado del CRM",
  "POST /v1/crm/mappings/{id}/send body.companyId": "empresa del lado del CRM (Bitrix24)",
  "POST /v1/crm/links body.objectId": "registro del lado del CRM",
  "POST /v1/connectors/flows/{id}/send body.recordId": "registro del lado del sistema conectado",
  "POST /v1/settings/brands body.config.sms.senderId": "remitente alfanumérico del SMS",
  "PUT /v1/settings/brands/{id} body.config.sms.senderId": "remitente alfanumérico del SMS",
  "POST /v1/settings/brands/{id}/preview body.config.sms.senderId": "remitente alfanumérico del SMS",
  "POST /v1/oauth/authorize/decision body.client_id":
    "client_id público de OAuth: autorizar la app de otra organización es el propósito del consentimiento (la app no ve datos de su dueña)",
  // Otros.
  "GET /v1/audit-log.csv ?beforeId": "cursor numérico de paginación de la misma consulta, que ya filtra por tenant (no es un uuid de un recurso)",
  "GET /v1/events/stream": "stream SSE abierto hasta max_seconds; el mismo filtro (envelope_id) lo prueba GET /v1/events",
};

// ───────── Pruebas ─────────

type Kind = "lookup" | "filter" | "local";
interface Probe {
  /** Campos (como los da idFieldsFromOpenApi) que esta prueba cubre. */
  fields: string[];
  kind: Kind;
  cred?: CredName;
  method: "GET" | "POST" | "PUT" | "PATCH";
  /** URL con la query; `ref` es el id que se prueba (el de B en el ataque, el de A en el control). */
  url: (a: Org, ref: string) => string;
  body?: (a: Org, ref: string) => unknown;
  /** De qué fixture sale el id (de B en el ataque, de A en el control). */
  ref: (f: Fixtures) => string;
  /** El control positivo no se puede hacer (con el motivo). */
  noControl?: string;
  /** Status esperado en vez del de `kind` (con el motivo en un comentario). */
  status?: number;
  /**
   * La respuesta con el id de B no puede ser la de un id libre (con el motivo): el id lo elige el cliente y es la clave
   * de la fila, así que uno en uso da 409. Dice que el id existe, nada más: B sin cambios, A sin el id y la respuesta
   * sin datos de B se controlan igual.
   */
  acceptedOracle?: string;
}

const ID_IN_USE =
  "id elegido por el cliente y clave de la fila en una tabla de todas las organizaciones: uno en uso da 409 (id_in_use, del contrato del OpenAPI, o conflict de la clave única); confirma que existe un id que el atacante ya tenía que conocer, sin datos ni acceso";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const fieldBox = { type: "signature", page: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05 };
const ids = (k: string) => (f: Fixtures) => f.ids[k];
/** Campo de firma para el firmante del sobre enviado (las fixtures sólo le dan uno de adjunto). */
const sentSignature = (a: Org) => ({ ...fieldBox, documentId: a.fx.ids.doc_sent, recipientId: a.fx.ids.rec_sent });
const NEW_RECIPIENT = "0199aaaa-0000-7000-8000-000000000001";
const STEP_ID = "0199aaaa-0000-7000-8000-000000000002";
const signer = (name: string) => ({ name, email: `${name.toLowerCase()}@example.com` });

const PROBES: Probe[] = [
  // Sobres
  {
    fields: ["GET /v1/envelopes ?template_id"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/envelopes?template_id=${ref}`,
    ref: ids("template"),
  },
  {
    fields: ["POST /v1/envelopes body.brandId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/envelopes`,
    body: (_a, ref) => ({ subject: "Con marca", brandId: ref }),
    ref: ids("brand"),
  },
  {
    fields: ["POST /v1/envelopes body.recipients[].inPerson.hostUserId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/envelopes`,
    body: (_a, ref) => ({ subject: "En persona", recipients: [{ ...signer("Ana"), authMethod: "in_person", inPerson: { hostUserId: ref } }] }),
    ref: ids("member"),
  },
  {
    fields: ["POST /v1/envelopes body.recipients[].id"],
    kind: "local",
    method: "POST",
    url: () => `/v1/envelopes`,
    body: (_a, ref) => ({ subject: "Con id de firmante", recipients: [{ id: ref, ...signer("Ana") }] }),
    ref: ids("rec_draft"),
    acceptedOracle: ID_IN_USE,
    noControl: "el id propio ya lo usa el borrador sembrado (id_in_use); un id libre lo prueba la corrida contra un id que no existe",
  },
  {
    fields: ["POST /v1/envelopes body.fields[].id"],
    kind: "local",
    method: "POST",
    url: () => `/v1/envelopes`,
    body: (_a, ref) => ({ subject: "Con id de campo", recipients: [signer("Ana")], fields: [{ ...fieldBox, id: ref, recipient: 0 }] }),
    ref: ids("field_draft"),
    noControl: "un campo sin documento en el pedido no es válido; el id de campo propio lo prueba PUT fields",
  },
  {
    fields: ["POST /v1/envelopes body.fields[].recipientId"],
    kind: "local",
    method: "POST",
    url: () => `/v1/envelopes`,
    body: (_a, ref) => ({ subject: "Campo", recipients: [signer("Ana")], fields: [{ ...fieldBox, recipientId: ref }] }),
    ref: ids("rec_draft"),
    noControl: "un firmante de otro sobre nunca es válido acá: en el mismo pedido se nombra con recipient (índice o ref)",
  },
  {
    fields: ["PATCH /v1/envelopes/{id} body.brandId"],
    kind: "lookup",
    method: "PATCH",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_draft}`,
    body: (_a, ref) => ({ brandId: ref }),
    ref: ids("brand"),
  },
  {
    fields: ["PUT /v1/envelopes/{id}/recipients body.recipients[].inPerson.hostUserId"],
    kind: "lookup",
    method: "PUT",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_draft}/recipients`,
    body: (_a, ref) => ({ recipients: [{ ...signer("Ana"), authMethod: "in_person", inPerson: { hostUserId: ref } }] }),
    ref: ids("member"),
  },
  {
    fields: ["PUT /v1/envelopes/{id}/recipients body.recipients[].id"],
    kind: "local",
    method: "PUT",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_draft}/recipients`,
    body: (_a, ref) => ({ recipients: [{ id: ref, ...signer("Ana") }] }),
    ref: ids("rec_draft"),
    acceptedOracle: ID_IN_USE,
  },
  {
    fields: ["PUT /v1/envelopes/{id}/fields body.fields[].documentId"],
    kind: "local",
    method: "PUT",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_draft}/fields`,
    body: (a, ref) => ({ fields: [{ ...fieldBox, documentId: ref, recipientId: a.fx.ids.rec_draft }] }),
    ref: ids("doc_draft"),
  },
  {
    fields: ["PUT /v1/envelopes/{id}/fields body.fields[].recipientId"],
    kind: "local",
    method: "PUT",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_draft}/fields`,
    body: (a, ref) => ({ fields: [{ ...fieldBox, documentId: a.fx.ids.doc_draft, recipientId: ref }] }),
    ref: ids("rec_draft"),
  },
  {
    fields: ["PUT /v1/envelopes/{id}/fields body.fields[].id"],
    kind: "local",
    method: "PUT",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_draft}/fields`,
    body: (a, ref) => ({ fields: [{ ...fieldBox, id: ref, documentId: a.fx.ids.doc_draft, recipientId: a.fx.ids.rec_draft }] }),
    ref: ids("field_draft"),
  },
  {
    fields: ["POST /v1/envelopes/{id}/corrections body.updateRecipients[].id"],
    kind: "local",
    method: "POST",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_sent}/corrections`,
    body: (a, ref) => ({ updateRecipients: [{ id: ref, name: "Corregida" }], addFields: [sentSignature(a)] }),
    ref: ids("rec_sent"),
  },
  {
    fields: ["POST /v1/envelopes/{id}/corrections body.removeRecipientIds"],
    kind: "local",
    method: "POST",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_sent}/corrections`,
    body: (_a, ref) => ({ addRecipients: [signer("Nueva")], removeRecipientIds: [ref] }),
    ref: ids("rec_sent"),
    noControl: "quitar al único firmante propio deja el sobre sin firmantes; el camino propio lo cubre corrections.test.ts",
  },
  {
    fields: ["POST /v1/envelopes/{id}/corrections body.removeFieldIds"],
    kind: "local",
    method: "POST",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_sent}/corrections`,
    body: (a, ref) => ({ removeFieldIds: [ref], addFields: [sentSignature(a)] }),
    ref: ids("field_sent"),
  },
  {
    fields: ["POST /v1/envelopes/{id}/corrections body.addFields[].documentId"],
    kind: "local",
    method: "POST",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_sent}/corrections`,
    body: (a, ref) => ({ addFields: [{ ...fieldBox, documentId: ref, recipientId: a.fx.ids.rec_sent }] }),
    ref: ids("doc_sent"),
  },
  {
    fields: ["POST /v1/envelopes/{id}/corrections body.addFields[].recipientId"],
    kind: "local",
    method: "POST",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_sent}/corrections`,
    body: (a, ref) => ({ addFields: [{ ...fieldBox, documentId: a.fx.ids.doc_sent, recipientId: ref }] }),
    ref: ids("rec_sent"),
  },
  {
    fields: ["POST /v1/envelopes/{id}/corrections body.addRecipients[].inPerson.hostUserId"],
    kind: "lookup",
    method: "POST",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_sent}/corrections`,
    body: (a, ref) => ({
      addRecipients: [{ id: NEW_RECIPIENT, ...signer("Nueva"), authMethod: "in_person", inPerson: { hostUserId: ref } }],
      addFields: [sentSignature(a), { ...fieldBox, documentId: a.fx.ids.doc_sent, recipientId: NEW_RECIPIENT }],
    }),
    ref: ids("member"),
  },
  {
    fields: ["POST /v1/envelopes/{id}/corrections body.addRecipients[].id"],
    kind: "local",
    method: "POST",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_sent}/corrections`,
    body: (a, ref) => ({
      addRecipients: [{ id: ref, ...signer("Nueva") }],
      addFields: [sentSignature(a), { ...fieldBox, documentId: a.fx.ids.doc_sent, recipientId: ref }],
    }),
    ref: ids("rec_sent"),
    acceptedOracle: ID_IN_USE,
    noControl: "el id propio es el de un firmante que ya está en el sobre (id_in_use)",
  },
  {
    fields: ["POST /v1/envelopes/{id}/corrections body.addFields[].id"],
    kind: "local",
    method: "POST",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_sent}/corrections`,
    body: (a, ref) => ({ addFields: [{ ...sentSignature(a), id: ref }] }),
    ref: ids("field_sent"),
    acceptedOracle: ID_IN_USE,
    noControl: "el id propio es el de un campo que ya está en el sobre",
  },
  {
    fields: ["PUT /v1/envelopes/{id}/payment body.payerRecipientId"],
    kind: "local",
    method: "PUT",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_draft}/payment`,
    body: (_a, ref) => ({ amount: 10, currency: "USD", description: "Pago", payerRecipientId: ref, provider: "mock" }),
    ref: ids("rec_draft"),
  },
  {
    fields: ["PUT /v1/envelopes/{id}/seal-options body.companySealCertificateId"],
    kind: "lookup",
    method: "PUT",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_draft}/seal-options`,
    body: (_a, ref) => ({ companySealCertificateId: ref }),
    ref: ids("certificate"),
  },
  {
    fields: ["PUT /v1/envelopes/{id}/shares body.groupIds"],
    kind: "lookup",
    method: "PUT",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_draft}/shares`,
    body: (_a, ref) => ({ groupIds: [ref] }),
    ref: ids("group"),
  },
  {
    fields: ["GET /v1/envelopes/{id}/ai/preview ?documentId"],
    kind: "local",
    method: "GET",
    url: (a, ref) => `/v1/envelopes/${a.fx.ids.env_draft}/ai/preview?feature=detect_fields&documentId=${ref}`,
    ref: ids("doc_draft"),
  },
  {
    fields: ["POST /v1/envelopes/{id}/ai/detect-fields body.documentId"],
    kind: "local",
    method: "POST",
    url: (a) => `/v1/envelopes/${a.fx.ids.env_draft}/ai/detect-fields`,
    body: (_a, ref) => ({ documentId: ref }),
    ref: ids("doc_draft"),
    noControl: "llama al proveedor de IA (sin red en el test)",
  },
  {
    fields: ["POST /v1/envelopes/batch body.ids"],
    kind: "local",
    method: "POST",
    url: () => `/v1/envelopes/batch`,
    body: (_a, ref) => ({ action: "get", ids: [ref] }),
    ref: ids("env_sent"),
    // El lote responde 200 con un resultado por id: el de B viene como el de un id que no existe (signature compara el
    // status de cada elemento).
    status: 200,
  },
  {
    fields: ["GET /v1/events ?envelope_id"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/events?envelope_id=${ref}`,
    ref: ids("env_sent"),
  },
  // Plantillas
  {
    fields: ["PUT /v1/templates/{id}/roles body.roles[].id"],
    kind: "local",
    method: "PUT",
    url: (a) => `/v1/templates/${a.fx.ids.template}/roles`,
    body: (_a, ref) => ({ roles: [{ id: ref, name: "Firmante" }] }),
    ref: ids("template_role"),
    acceptedOracle: ID_IN_USE,
    noControl: "reemplazar el rol propio choca con el formulario sembrado sobre la plantilla (409 template_has_forms)",
  },
  {
    fields: ["PUT /v1/templates/{id}/fields body.fields[].documentId"],
    kind: "local",
    method: "PUT",
    url: (a) => `/v1/templates/${a.fx.ids.template}/fields`,
    body: (a, ref) => ({ fields: [{ ...fieldBox, documentId: ref, roleId: a.fx.ids.template_role }] }),
    ref: ids("template_doc"),
  },
  {
    fields: ["PUT /v1/templates/{id}/fields body.fields[].roleId"],
    kind: "local",
    method: "PUT",
    url: (a) => `/v1/templates/${a.fx.ids.template}/fields`,
    body: (a, ref) => ({ fields: [{ ...fieldBox, documentId: a.fx.ids.template_doc, roleId: ref }] }),
    ref: ids("template_role"),
  },
  {
    fields: ["PUT /v1/templates/{id}/fields body.fields[].id"],
    kind: "local",
    method: "PUT",
    url: (a) => `/v1/templates/${a.fx.ids.template}/fields`,
    body: (a, ref) => ({ fields: [{ ...fieldBox, id: ref, documentId: a.fx.ids.template_doc, roleId: a.fx.ids.template_role }] }),
    ref: ids("field_draft"),
    noControl: "la plantilla sembrada no tiene campos propios para reusar su id",
  },
  {
    fields: ["PUT /v1/templates/{id}/shares body.groupIds"],
    kind: "lookup",
    method: "PUT",
    url: (a) => `/v1/templates/${a.fx.ids.template}/shares`,
    body: (_a, ref) => ({ groupIds: [ref] }),
    ref: ids("group"),
  },
  {
    fields: ["POST /v1/envelopes/from-template body.templateId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/envelopes/from-template`,
    body: (_a, ref) => ({ templateId: ref, recipients: [{ role: "Firmante", ...signer("Ana") }] }),
    ref: ids("template"),
  },
  {
    fields: ["POST /v1/envelopes/from-template body.recipients[].roleId"],
    kind: "local",
    method: "POST",
    url: () => `/v1/envelopes/from-template`,
    body: (a, ref) => ({ templateId: a.fx.ids.template, recipients: [{ roleId: ref, ...signer("Ana") }] }),
    ref: ids("template_role"),
  },
  {
    fields: ["POST /v1/bulk-sends/validate body.templateId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/bulk-sends/validate`,
    body: (_a, ref) => ({ templateId: ref, rows: [{ recipients: [{ role: "Firmante", ...signer("Ana") }] }] }),
    ref: ids("template"),
  },
  {
    fields: ["POST /v1/bulk-sends/validate body.rows[].recipients[].roleId"],
    kind: "local",
    method: "POST",
    url: () => `/v1/bulk-sends/validate`,
    body: (a, ref) => ({ templateId: a.fx.ids.template, rows: [{ recipients: [{ roleId: ref, ...signer("Ana") }] }] }),
    ref: ids("template_role"),
  },
  {
    fields: ["POST /v1/bulk-sends body.templateId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/bulk-sends`,
    body: (_a, ref) => ({ templateId: ref, rows: [{ recipients: [{ role: "Firmante", ...signer("Ana") }] }] }),
    ref: ids("template"),
  },
  {
    fields: ["POST /v1/bulk-sends body.rows[].recipients[].roleId"],
    kind: "local",
    method: "POST",
    url: () => `/v1/bulk-sends`,
    body: (a, ref) => ({ templateId: a.fx.ids.template, rows: [{ recipients: [{ roleId: ref, ...signer("Ana") }] }] }),
    ref: ids("template_role"),
  },
  {
    fields: ["POST /v1/web-forms body.templateId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/web-forms`,
    body: (a, ref) => ({ templateId: ref, name: "Formulario", signerRoleId: a.fx.ids.template_role }),
    ref: ids("template"),
  },
  {
    fields: ["POST /v1/web-forms body.signerRoleId"],
    kind: "local",
    method: "POST",
    url: () => `/v1/web-forms`,
    body: (a, ref) => ({ templateId: a.fx.ids.template, name: "Formulario", signerRoleId: ref }),
    ref: ids("template_role"),
  },
  {
    fields: ["POST /v1/web-forms body.fixedRecipients[].roleId"],
    kind: "local",
    method: "POST",
    url: () => `/v1/web-forms`,
    body: (a, ref) => ({
      templateId: a.fx.ids.template,
      name: "Formulario",
      signerRoleId: a.fx.ids.template_role,
      fixedRecipients: [{ roleId: ref, ...signer("Fija") }],
    }),
    ref: ids("template_role"),
    noControl: "el rol fijo y el del firmante no pueden ser el mismo, y la plantilla sembrada tiene uno solo",
  },
  {
    fields: ["PATCH /v1/web-forms/{id} body.signerRoleId"],
    kind: "local",
    method: "PATCH",
    url: (a) => `/v1/web-forms/${a.fx.ids.web_form}`,
    body: (_a, ref) => ({ signerRoleId: ref }),
    ref: ids("template_role"),
  },
  {
    fields: ["PATCH /v1/web-forms/{id} body.fixedRecipients[].roleId"],
    kind: "local",
    method: "PATCH",
    url: (a) => `/v1/web-forms/${a.fx.ids.web_form}`,
    body: (_a, ref) => ({ fixedRecipients: [{ roleId: ref, ...signer("Fija") }] }),
    ref: ids("template_role"),
    noControl: "el rol fijo y el del firmante no pueden ser el mismo, y la plantilla sembrada tiene uno solo",
  },
  // Firma (credencial: el link de un firmante de A)
  {
    fields: ["POST /v1/signing/{token}/complete body.fields[].id"],
    kind: "local",
    cred: "signer",
    method: "POST",
    url: (a) => `/v1/signing/${a.fx.signerToken}/complete`,
    body: (_a, ref) => ({ fields: [{ id: ref, value: "x" }], signature: { kind: "drawn", imagePng: PNG } }),
    ref: ids("field_sent"),
    noControl: "completar la firma propia la cierra; el camino propio lo cubre signing.test.ts",
  },
  {
    fields: ["POST /v1/signing/{token}/complete body.signature.handoffId", "POST /v1/signing/{token}/complete body.initials.handoffId"],
    kind: "local",
    cred: "signer",
    method: "POST",
    url: (a) => `/v1/signing/${a.fx.signerToken}/complete`,
    body: (a, ref) => ({ fields: [{ id: a.fx.ids.field_sent, value: "x" }], signature: { kind: "drawn", imagePng: PNG, handoffId: ref } }),
    ref: ids("handoff"),
    noControl: "completar la firma propia la cierra; el pase al celular propio lo cubre signature-handoff.test.ts",
  },
  // Certificados
  {
    fields: ["POST /v1/xml/sign body.certificateId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/xml/sign`,
    body: (_a, ref) => ({ xml: "<Factura><Total>1</Total></Factura>", profile: "xades-bes", certificateId: ref }),
    ref: ids("certificate"),
    noControl: "el certificado sembrado no tiene clave privada real",
  },
  // Equipo y accesos
  {
    fields: ["POST /v1/api-keys body.roleId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/api-keys`,
    body: (_a, ref) => ({ name: "Clave con rol", role: "custom", roleId: ref }),
    ref: ids("role"),
  },
  {
    fields: ["PATCH /v1/api-keys/{id}/role body.roleId"],
    kind: "lookup",
    method: "PATCH",
    url: (a) => `/v1/api-keys/${a.fx.ids.api_key}/role`,
    body: (_a, ref) => ({ role: "custom", roleId: ref }),
    ref: ids("role"),
  },
  {
    fields: ["PATCH /v1/members/{userId} body.roleId"],
    kind: "lookup",
    method: "PATCH",
    url: (a) => `/v1/members/${a.fx.ids.member}`,
    body: (_a, ref) => ({ role: "custom", roleId: ref }),
    ref: ids("role"),
  },
  {
    fields: ["POST /v1/invitations body.roleId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/invitations`,
    body: (_a, ref) => ({ email: `invitada-rol-${ref.slice(-6)}@example.com`, role: "custom", roleId: ref }),
    ref: ids("role"),
  },
  {
    fields: ["POST /v1/oauth/apps body.roleId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/oauth/apps`,
    body: (_a, ref) => ({ name: "App con rol", grantTypes: ["client_credentials"], scopes: ["envelopes:read"], role: "custom", roleId: ref }),
    ref: ids("role"),
  },
  {
    fields: ["POST /v1/groups body.memberIds"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/groups`,
    body: (_a, ref) => ({ name: `Grupo ${ref.slice(-6)}`, memberIds: [ref] }),
    ref: ids("member"),
  },
  {
    fields: ["PATCH /v1/groups/{id} body.memberIds"],
    kind: "lookup",
    method: "PATCH",
    url: (a) => `/v1/groups/${a.fx.ids.group}`,
    body: (_a, ref) => ({ memberIds: [ref] }),
    ref: ids("member"),
  },
  // Acuerdos y workflows
  {
    fields: ["GET /v1/agreements ?viewId"],
    kind: "lookup",
    method: "GET",
    url: (_a, ref) => `/v1/agreements?viewId=${ref}`,
    ref: ids("agreement_view"),
  },
  {
    fields: ["GET /v1/agreements/export.csv ?viewId"],
    kind: "lookup",
    method: "GET",
    url: (_a, ref) => `/v1/agreements/export.csv?viewId=${ref}`,
    ref: ids("agreement_view"),
  },
  {
    fields: ["POST /v1/workflows body.steps[].config.approverUserId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/workflows`,
    body: (_a, ref) => ({ name: "Aprobación", steps: [{ id: STEP_ID, name: "Aprobar", type: "approval", config: { approverUserId: ref } }] }),
    ref: ids("member"),
  },
  {
    fields: ["POST /v1/workflows body.steps[].config.documentTemplateId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/workflows`,
    body: (_a, ref) => ({
      name: "Generar",
      steps: [{ id: STEP_ID, name: "Generar", type: "generate_document", config: { documentTemplateId: ref, output: "doc" } }],
    }),
    ref: ids("document_template"),
  },
  {
    fields: ["PATCH /v1/workflows/{id} body.steps[].config.approverUserId"],
    kind: "lookup",
    method: "PATCH",
    url: (a) => `/v1/workflows/${a.fx.ids.workflow}`,
    body: (_a, ref) => ({ steps: [{ id: STEP_ID, name: "Aprobar", type: "approval", config: { approverUserId: ref } }] }),
    ref: ids("member"),
  },
  {
    fields: ["PATCH /v1/workflows/{id} body.steps[].config.documentTemplateId"],
    kind: "lookup",
    method: "PATCH",
    url: (a) => `/v1/workflows/${a.fx.ids.workflow}`,
    body: (_a, ref) => ({ steps: [{ id: STEP_ID, name: "Generar", type: "generate_document", config: { documentTemplateId: ref, output: "doc" } }] }),
    ref: ids("document_template"),
  },
  {
    fields: ["GET /v1/workflow-runs ?workflowId"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/workflow-runs?workflowId=${ref}`,
    ref: ids("workflow"),
  },
  {
    fields: ["POST /v1/negotiations body.documentTemplateId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/negotiations`,
    body: (_a, ref) => ({ title: "Negociación", documentTemplateId: ref, participants: [signer("Contraparte")] }),
    ref: ids("document_template"),
  },
  // CRM y conectores
  {
    fields: ["GET /v1/crm/mappings ?connectionId"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/crm/mappings?connectionId=${ref}`,
    ref: ids("crm_connection"),
  },
  {
    fields: ["POST /v1/crm/mappings body.connectionId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/crm/mappings`,
    body: (a, ref) => ({ connectionId: ref, name: "Mapeo", objectType: "deal", templateId: a.fx.ids.template }),
    ref: ids("crm_connection"),
  },
  {
    fields: ["POST /v1/crm/mappings body.templateId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/crm/mappings`,
    body: (a, ref) => ({ connectionId: a.fx.ids.crm_connection, name: "Mapeo", objectType: "deal", templateId: ref }),
    ref: ids("template"),
  },
  {
    fields: ["POST /v1/crm/mappings body.triggerConfig.templateId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/crm/mappings`,
    body: (a, ref) => ({
      connectionId: a.fx.ids.crm_connection,
      name: "Mapeo",
      objectType: "deal",
      templateId: a.fx.ids.template,
      trigger: "webhook",
      triggerConfig: { property: "dealstage", value: "won", templateId: ref },
    }),
    ref: ids("template"),
  },
  {
    fields: ["PATCH /v1/crm/mappings/{id} body.templateId"],
    kind: "lookup",
    method: "PATCH",
    url: (a) => `/v1/crm/mappings/${a.fx.ids.crm_mapping}`,
    body: (_a, ref) => ({ templateId: ref }),
    ref: ids("template"),
  },
  {
    fields: ["PATCH /v1/crm/mappings/{id} body.triggerConfig.templateId"],
    kind: "lookup",
    method: "PATCH",
    url: (a) => `/v1/crm/mappings/${a.fx.ids.crm_mapping}`,
    body: (_a, ref) => ({ trigger: "webhook", triggerConfig: { property: "dealstage", value: "won", templateId: ref } }),
    ref: ids("template"),
  },
  {
    fields: ["POST /v1/crm/links body.connectionId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/crm/links`,
    body: (a, ref) => ({ connectionId: ref, envelopeId: a.fx.ids.env_sent, objectType: "deal", objectId: "123" }),
    ref: ids("crm_connection"),
  },
  {
    fields: ["POST /v1/crm/links body.envelopeId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/crm/links`,
    body: (a, ref) => ({ connectionId: a.fx.ids.crm_connection, envelopeId: ref, objectType: "deal", objectId: "124" }),
    // El completado: el enviado de A ya queda vinculado por la prueba de connectionId (409 crm_link_exists).
    ref: ids("env_completed"),
  },
  {
    fields: ["GET /v1/crm/links ?envelopeId"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/crm/links?envelopeId=${ref}`,
    ref: ids("env_sent"),
  },
  {
    fields: ["GET /v1/crm/runs ?connectionId"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/crm/runs?connectionId=${ref}`,
    ref: ids("crm_connection"),
  },
  {
    fields: ["GET /v1/crm/runs ?envelopeId"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/crm/runs?envelopeId=${ref}`,
    ref: ids("env_sent"),
  },
  {
    fields: ["GET /v1/connectors/flows ?connectionId"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/connectors/flows?connectionId=${ref}`,
    ref: ids("connector_connection"),
  },
  {
    fields: ["POST /v1/connectors/flows body.connectionId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/connectors/flows`,
    body: (a, ref) => ({ connectionId: ref, name: "Flujo", objectType: "employee", templateId: a.fx.ids.template }),
    ref: ids("connector_connection"),
  },
  {
    fields: ["POST /v1/connectors/flows body.templateId"],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/connectors/flows`,
    body: (a, ref) => ({ connectionId: a.fx.ids.connector_connection, name: "Flujo", objectType: "employee", templateId: ref }),
    ref: ids("template"),
  },
  {
    fields: ["PATCH /v1/connectors/flows/{id} body.templateId"],
    kind: "lookup",
    method: "PATCH",
    url: (a) => `/v1/connectors/flows/${a.fx.ids.connector_flow}`,
    body: (_a, ref) => ({ templateId: ref }),
    ref: ids("template"),
  },
  {
    fields: ["GET /v1/connectors/links ?envelopeId"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/connectors/links?envelopeId=${ref}`,
    ref: ids("env_sent"),
  },
  {
    fields: ["GET /v1/connectors/runs ?connectionId"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/connectors/runs?connectionId=${ref}`,
    ref: ids("connector_connection"),
  },
  {
    fields: ["GET /v1/connectors/runs ?envelopeId"],
    kind: "filter",
    method: "GET",
    url: (_a, ref) => `/v1/connectors/runs?envelopeId=${ref}`,
    ref: ids("env_sent"),
  },
];

/** Rutas fuera del OpenAPI con un id en el cuerpo (no las enumera idFieldsFromOpenApi: se agregan a mano). */
const EXTRA_PROBES: Probe[] = [
  {
    fields: [],
    kind: "lookup",
    method: "POST",
    url: () => `/v1/auth/switch-tenant`,
    body: (_a, ref) => ({ tenantId: ref }),
    ref: (f) => f.tenantId,
    noControl: "cambiar a la organización propia no es un cambio (y mueve la sesión de las pruebas que siguen)",
  },
  {
    fields: [],
    kind: "local",
    cred: "scim",
    method: "POST",
    url: () => `/scim/v2/Groups`,
    body: (_a, ref) => ({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
      displayName: `SCIM ${ref.slice(-6)}`,
      members: [{ value: ref }],
    }),
    ref: ids("member"),
    // Un miembro que no es de la organización se ignora (scim.ts addGroupMembers); el grupo se crea sin él.
    status: 201,
  },
  {
    fields: [],
    kind: "local",
    cred: "scim",
    method: "PATCH",
    url: (a) => `/scim/v2/Groups/${a.fx.ids.group}`,
    body: (_a, ref) => ({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "add", path: "members", value: [{ value: ref }] }],
    }),
    ref: ids("member"),
    // Ídem: el miembro ajeno se ignora.
    status: 204,
  },
];

// ───────── App y organizaciones (igual que en tenant-isolation-routes.test.ts) ─────────

const { createDb, migrate } = await import("../src/infra/db");
const { createBlobStore } = await import("../src/infra/storage");
const { buildApp } = await import("../src/app");
const { seedTenant } = await import("./tenant-isolation-fixtures");
const util = await import("../src/lib/util");
const db: Db = await createDb();
await migrate(db);
const blobs = createBlobStore();
const app: App = await buildApp({ db, blobs, logger: false });
await app.ready();
let A: Org;
let B: Org;

async function signup(tag: string): Promise<Org> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email: `duena-${tag.toLowerCase()}@example.com`, password: "una-clave-larga-123", name: `Dueña ${tag}`, organization: `Org ${tag}` },
  });
  expect(res.statusCode).toBe(201);
  const cookie = res.cookies.find((x) => x.name === "cs_session")!.value;
  const tenantId = res.json().tenant.id as string;
  const ownerId = res.json().user.id as string;
  // El plan más alto: si no, un 402 plan_limit llega antes que la búsqueda y el campo no se ejercita.
  await db.query(`UPDATE tenants SET billing_plan = 'enterprise', ai_enabled = true WHERE id = $1`, [tenantId]);
  const apiKey = `cs_test_${util.randomToken(16)}`; // calidad:permitir-secreto (clave de prueba generada en el test)
  await db.query(`INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, created_by, role) VALUES ($1,$2,'admin','cs_test',$3,$4,'admin')`, [
    util.uuidv7(),
    tenantId,
    util.sha256Hex(apiKey),
    ownerId,
  ]);
  return { fx: await seedTenant(db, blobs, tenantId, ownerId, tag), cookie, apiKey };
}

beforeAll(async () => {
  A = await signup("RefsRoja");
  B = await signup("RefsAzul");
  // La plantilla sembrada no tiene campos: sin uno de firma, el envío masivo y el formulario propios no son válidos.
  for (const o of [A, B]) {
    const res = await app.inject({
      method: "PUT",
      url: `/v1/templates/${o.fx.ids.template}/fields`,
      headers: { ...headers(o, "cookie"), "content-type": "application/json" },
      payload: JSON.stringify({ fields: [{ ...fieldBox, documentId: o.fx.ids.template_doc, roleId: o.fx.ids.template_role }] }),
    });
    expect(res.statusCode, res.body).toBe(200);
  }
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

function headers(org: Org, cred: CredName): Record<string, string> {
  if (cred === "cookie") return { cookie: `cs_session=${org.cookie}`, origin: "http://localhost:5173" };
  if (cred === "apiKey") return { authorization: `Bearer ${org.apiKey}` };
  if (cred === "scim") return { authorization: `Bearer ${org.fx.scimToken}`, "content-type": "application/scim+json" };
  return {};
}

function call(org: Org, p: Probe, ref: string) {
  const body = p.body?.(org, ref);
  const h = headers(org, p.cred ?? "cookie");
  if (body === undefined) return app.inject({ method: p.method, url: p.url(org, ref), headers: h });
  return app.inject({ method: p.method, url: p.url(org, ref), headers: { "content-type": "application/json", ...h }, payload: JSON.stringify(body) });
}

/** Ids de las fixtures → nombre legible ("B.env_sent"), para los mensajes de falla. */
function label(text: string): string {
  let out = text;
  for (const org of [A, B]) for (const [name, v] of Object.entries(org.fx.ids)) out = out.split(v).join(`${org === A ? "A" : "B"}.${name}`);
  return out.split(B.fx.tenantId).join("B.tenant").split(A.fx.tenantId).join("A.tenant");
}

// ───────── Fotos de la base ─────────

const CHILD_TABLES: Record<string, string> = {
  users: `id IN (SELECT user_id FROM memberships WHERE tenant_id = $1)`,
  group_members: `group_id IN (SELECT id FROM groups WHERE tenant_id = $1)`,
  envelope_shares: `envelope_id IN (SELECT id FROM envelopes WHERE tenant_id = $1)`,
  template_shares: `template_id IN (SELECT id FROM templates WHERE tenant_id = $1)`,
  negotiation_comments: `negotiation_id IN (SELECT id FROM negotiations WHERE tenant_id = $1)`,
  negotiation_proposals: `negotiation_id IN (SELECT id FROM negotiations WHERE tenant_id = $1)`,
  negotiation_versions: `negotiation_id IN (SELECT id FROM negotiations WHERE tenant_id = $1)`,
  workflow_run_steps: `run_id IN (SELECT id FROM workflow_runs WHERE tenant_id = $1)`,
  signer_sessions: `recipient_id IN (SELECT id FROM recipients WHERE tenant_id = $1)`,
  telegram_link_tokens: `recipient_id IN (SELECT id FROM recipients WHERE tenant_id = $1)`,
};
let tablesSql: [string, string][] = [];
async function tables(): Promise<[string, string][]> {
  if (!tablesSql.length) {
    const rows = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name`,
    );
    tablesSql = [...rows.map((t): [string, string] => [t.table_name, "tenant_id = $1"]), ...Object.entries(CHILD_TABLES)];
  }
  return tablesSql;
}

/** Hash de cada tabla de la organización: B no puede cambiar por un pedido de A. */
async function snapshot(tenantId: string): Promise<Map<string, string>> {
  const sql = (await tables())
    .map(([t, where]) => `SELECT '${t}' AS t, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x WHERE ${where}`)
    .join(" UNION ALL ");
  const rows = await db.query<{ t: string; h: string }>(sql, [tenantId]);
  return new Map(rows.map((r) => [r.t, r.h]));
}
const changedTables = (a: Map<string, string>, b: Map<string, string>) => [...a].filter(([t, h]) => b.get(t) !== h).map(([t]) => t);

/** Tablas de A que guardan un id de B (en cualquier columna: también dentro de un JSON). */
async function tablesHolding(tenantId: string, foreign: string[]): Promise<string[]> {
  const sql = (await tables())
    .map(([t, where]) => `SELECT '${t}' AS t, coalesce(string_agg(x::text, '|'), '') AS v FROM ${t} x WHERE ${where}`)
    .join(" UNION ALL ");
  const rows = await db.query<{ t: string; v: string }>(sql, [tenantId]);
  const out: string[] = [];
  for (const r of rows) {
    const v = r.v.toLowerCase();
    const hit = foreign.find((id) => v.includes(id));
    if (hit) out.push(`${r.t} (${label(hit)})`);
  }
  return out;
}

/** Ids y marca de una organización: si aparecen en una respuesta de la otra, es una fuga. */
function markersOf(o: Org, except: string): string[] {
  return [o.fx.tag.toLowerCase(), o.fx.tenantId, o.fx.ownerId, ...Object.values(o.fx.ids).map((v) => v.toLowerCase())].filter((m) => m !== except);
}

function expectedStatus(p: Probe, status: number): boolean {
  if (p.status !== undefined) return status === p.status;
  if (p.kind === "filter") return status === 404 || (status >= 200 && status < 300);
  if (p.kind === "lookup") return status >= 400 && status < 500;
  // local: un id ajeno que el servidor ignora o reemplaza da 2xx; lo que importa es que sea igual que uno libre y que no
  // quede guardado (lo miran signature y tablesHolding).
  return status < 500;
}

/** Lo que tiene que coincidir con la respuesta a un id que no existe. */
function signature(res: { statusCode: number; body: string }): string {
  let j: any;
  try {
    j = JSON.parse(res.body);
  } catch {
    j = undefined;
  }
  const list = Array.isArray(j) ? j : (j?.items ?? j?.data ?? j?.Resources);
  return [
    res.statusCode,
    j?.error?.code ?? "",
    Array.isArray(j?.results) ? j.results.map((r: any) => `${r.status}:${r.error?.code ?? ""}`).join(",") : "",
    Array.isArray(list) ? `${list.length} elementos` : "",
    // CSV: cantidad de líneas.
    res.body.startsWith("\ufeff") || /^[^{[]/.test(res.body) ? `${res.body.split("\n").length} líneas` : "",
  ].join(" ");
}

/** Un uuid v7 que no es de nadie. */
const nobody = () => util.uuidv7();

const describeProbe = (p: Probe) => `${p.method} ${p.url(A, "{ref}").replace(/[?].*/, "")} [${p.fields.join(", ") || "fuera del OpenAPI"}]`;

// ───────── Tests ─────────

describe("aislamiento entre organizaciones en los ids del cuerpo y de la query (SEG-11)", () => {
  it("todo campo id del OpenAPI tiene una prueba o está en las excepciones (con el motivo)", () => {
    const fields = idFieldsFromOpenApi();
    expect(fields.length).toBeGreaterThan(100);
    const covered = new Set(PROBES.flatMap((p) => p.fields));
    const exempt = (f: string) => f in EXEMPT || f.split(" ").slice(0, 2).join(" ") in EXEMPT;
    expect(fields.filter((f) => !covered.has(f) && !exempt(f))).toEqual([]);
    // Ni pruebas ni excepciones de campos que ya no existen.
    const known = new Set(fields);
    expect([...covered].filter((f) => !known.has(f))).toEqual([]);
    expect(Object.keys(EXEMPT).filter((k) => !known.has(k) && ![...known].some((f) => f.startsWith(`${k} `)))).toEqual([]);
  });

  it("con credenciales de A, el id de B en el cuerpo o la query da 404 (o nada), B no cambia y A no se queda con él", async () => {
    const problems: string[] = [];
    const foreign = markersOf(B, "").filter((m) => /^[0-9a-f-]{36}$/.test(m));
    for (const p of [...PROBES, ...EXTRA_PROBES]) {
      const ref = p.ref(B.fx);
      expect(ref, describeProbe(p)).toBeTruthy();
      const what = `${describeProbe(p)} con ${label(ref)}`;
      const missing = signature(await call(A, p, nobody()));
      const heldBefore = new Set(await tablesHolding(A.fx.tenantId, foreign));
      const before = await snapshot(B.fx.tenantId);
      const res = await call(A, p, ref);
      if (!expectedStatus(p, res.statusCode)) problems.push(`${what}: ${res.statusCode} ${label(res.body.slice(0, 200))}`);
      if (!p.acceptedOracle && signature(res) !== missing) problems.push(`${what}: «${signature(res)}» y con un id que no existe «${missing}»`);
      const changed = changedTables(before, await snapshot(B.fx.tenantId));
      if (changed.length) problems.push(`${what}: cambió B en ${changed.join(", ")}`);
      const held = (await tablesHolding(A.fx.tenantId, foreign)).filter((t) => !heldBefore.has(t));
      if (held.length) problems.push(`${what}: A quedó con un id de B en ${held.join(", ")}`);
      const body = res.body.toLowerCase();
      const leaked = markersOf(B, ref.toLowerCase()).filter((m) => body.includes(m));
      if (leaked.length) problems.push(`${what}: la respuesta trae ${leaked.map(label).join(", ")}`);
    }
    // Y nada quedó de antes: si una prueba deja un id de B en A, las siguientes no lo verían como nuevo.
    for (const t of await tablesHolding(A.fx.tenantId, foreign)) problems.push(`al final, A tiene un id de B en ${t}`);
    expect(problems).toEqual([]);
  }, 300_000);

  it("control: el mismo pedido con el id de A responde 2xx (los cuerpos son válidos)", async () => {
    const problems: string[] = [];
    for (const p of [...PROBES, ...EXTRA_PROBES]) {
      if (p.noControl) continue;
      const ref = p.ref(A.fx);
      const res = await call(A, p, ref);
      if (res.statusCode < 200 || res.statusCode >= 300)
        problems.push(`${describeProbe(p)} con ${label(ref)}: ${res.statusCode} ${label(res.body.slice(0, 200))}`);
    }
    expect(problems).toEqual([]);
  }, 300_000);
});
