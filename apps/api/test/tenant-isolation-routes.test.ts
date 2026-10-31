// Aislamiento entre organizaciones en TODAS las rutas (SEG-11, IDOR/BOLA): la app real sobre PGlite con dos
// organizaciones, A y B, cada una con un recurso de cada tipo que tiene ruta con id (tenant-isolation-fixtures.ts).
// Las rutas se enumeran desde la app (hook onRoute enganchado al crear la instancia de Fastify), así que una ruta nueva
// entra sola: si tiene un parámetro sin fixture ni excepción, el test falla y dice qué agregar.
//
// Para cada ruta con parámetros se sustituyen los ids de B (y, en las rutas de dos ids, el padre de A con el hijo de B)
// y se le pega con las credenciales de A (cookie de sesión del dueño y API key admin; SCIM con el token SCIM de A; las
// rutas del link de firma con el link de un firmante de A). Esperado: 404. Después de cada ruta, los datos de B tienen
// que seguir idénticos (hash de cada tabla filtrada por tenant). Los listados sin parámetros no pueden contener ningún
// id ni la marca de B. Al final, el control positivo: con las credenciales de B, cada GET con id responde 2xx (si no,
// el 404 de A podía ser de un fixture mal armado y no del filtro de tenant).
//
// Criterio: el único resultado aceptado es el 404 de la ruta pedida (un 404 del router por una URL mal armada falla).
// Excepciones: CREDENTIAL_DENIALS (la credencial no tiene acceso a esa clase de ruta en absoluto, p. ej. una API key en
// las sesiones del usuario) y, solo en la variante mixta, un 409 por el estado del padre propio; la variante mixta en
// el estado que sí aplica tiene que llegar al 404. Un 400 nunca: se agrega un cuerpo válido en BODIES.
// Los listados corren después del barrido a propósito: también cazan lo que el barrido dejó en A (p. ej. el nombre de
// un recurso de B en la auditoría de A).
import diagnostics from "node:diagnostics_channel";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Fixtures } from "./tenant-isolation-fixtures";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-tenant-isolation-"));
delete process.env.DATABASE_URL;

// ───────── Rutas registradas ─────────

interface Route {
  method: string;
  url: string;
  /** Lleva authenticate() (sesión, API key u OAuth) en onRequest o preHandler. */
  authenticated: boolean;
}
const AUTHENTICATES = Symbol.for("calasign.authenticates");
const hasAuth = (h: unknown) =>
  (Array.isArray(h) ? h : [h]).some((f) => typeof f === "function" && (f as unknown as Record<symbol, unknown>)[AUTHENTICATES] === true);
const routesByInstance = new Map<object, Route[]>();
let lastMatched: string | undefined;
// Fastify publica la instancia nueva en este canal desde su constructor, antes de que buildApp registre las rutas.
diagnostics.channel("fastify.initialization").subscribe((msg) => {
  const instance = (msg as { fastify: { addHook: (name: string, fn: (o: any) => unknown) => void } }).fastify;
  const list: Route[] = [];
  routesByInstance.set(instance, list);
  // Qué ruta atendió el último pedido: un 404 del router (URL mal armada) no cuenta como 404 del recurso.
  instance.addHook("onRequest", async (req: { routeOptions?: { url?: string } }) => {
    lastMatched = req.routeOptions?.url;
  });
  instance.addHook("onRoute", (o: { method: string | string[]; url: string; onRequest?: unknown; preHandler?: unknown }) => {
    for (const method of [o.method].flat()) {
      if (method === "HEAD" || method === "OPTIONS") continue;
      list.push({ method, url: o.url, authenticated: hasAuth(o.onRequest) || hasAuth(o.preHandler) });
    }
  });
});

// ───────── Qué id va en cada parámetro ─────────

const STATES = ["draft", "sent", "completed"] as const;
type State = (typeof STATES)[number];
/** f: la organización dueña del recurso; own: la que pega (para el link de firma, que es una credencial suya). */
type Resolve = (f: Fixtures, s: State, own: Fixtures) => string;
const byId =
  (key: string): Resolve =>
  (f) =>
    f.ids[key];
const byState =
  (prefix: string): Resolve =>
  (f, s) =>
    f.ids[`${prefix}_${s}`];
const literal =
  (v: string): Resolve =>
  () =>
    v;

/**
 * Prefijo de la ruta hasta el parámetro (inclusive) → cómo se obtiene su valor. `stateful`: la ruta se prueba con el
 * sobre en cada estado (borrador, enviado, completado). Una ruta con un parámetro que no está acá ni en PUBLIC_ROUTES
 * hace fallar el test.
 */
const PARAMS: Record<string, { get: Resolve; stateful?: true; literal?: true }> = {
  "/v1/envelopes/:id": { get: byState("env"), stateful: true },
  "/v1/envelopes/:id/documents/:documentId": { get: byState("doc"), stateful: true },
  "/v1/envelopes/:id/recipients/:recipientId": { get: byState("rec"), stateful: true },
  "/v1/envelopes/:id/attachments/:fieldId": { get: byState("field"), stateful: true },
  "/v1/envelopes/from-template/:templateId": { get: byId("template") },
  "/v1/templates/from-envelope/:envelopeId": { get: byState("env"), stateful: true },
  "/v1/templates/:id": { get: byId("template") },
  "/v1/templates/:id/documents/:documentId": { get: byId("template_doc") },
  "/v1/agreement-fields/:id": { get: byId("agreement_field") },
  "/v1/agreement-views/:id": { get: byId("agreement_view") },
  "/v1/agreements/:id": { get: byId("agreement") },
  "/v1/api-keys/:id": { get: byId("api_key") },
  "/v1/bulk-sends/:id": { get: byId("bulk_send") },
  "/v1/certificates/:id": { get: byId("certificate") },
  "/v1/clauses/:id": { get: byId("clause") },
  "/v1/connectors/connections/:id": { get: byId("connector_connection") },
  "/v1/connectors/flows/:id": { get: byId("connector_flow") },
  "/v1/connectors/runs/:id": { get: byId("connector_run") },
  "/v1/crm/connections/:id": { get: byId("crm_connection") },
  "/v1/crm/mappings/:id": { get: byId("crm_mapping") },
  "/v1/crm/runs/:id": { get: byId("crm_run") },
  "/v1/document-templates/:id": { get: byId("document_template") },
  "/v1/groups/:id": { get: byId("group") },
  "/v1/invitations/:id": { get: byId("invitation") },
  "/v1/me/sessions/:id": { get: byId("session") },
  "/v1/members/:userId": { get: byId("member") },
  "/v1/negotiations/:id": { get: byId("negotiation") },
  "/v1/negotiations/:id/comments/:commentId": { get: byId("negotiation_comment") },
  "/v1/negotiations/:id/proposals/:proposalId": { get: byId("negotiation_proposal") },
  "/v1/notification-integrations/:id": { get: byId("notification_integration") },
  "/v1/oauth/apps/:id": { get: byId("oauth_client") },
  "/v1/oauth/connected-apps/:clientId": { get: byId("oauth_client_public") },
  "/v1/roles/:id": { get: byId("role") },
  "/v1/settings/brands/:id": { get: byId("brand") },
  "/v1/settings/brands/:id/assets/:kind": { get: literal("logo"), literal: true },
  "/v1/settings/email-domains/:domain": { get: byId("email_domain") },
  "/v1/settings/email-suppressions/:address": { get: byId("suppression") },
  "/v1/settings/scim/tokens/:id": { get: byId("scim_token") },
  "/v1/settings/sso/domains/:domain": { get: byId("sso_domain") },
  "/v1/storage/connections/:id": { get: byId("storage_connection") },
  "/v1/storage/exports/:id": { get: byId("storage_export") },
  "/v1/web-forms/:id": { get: byId("web_form") },
  "/v1/webhook-deliveries/:id": { get: byId("webhook_delivery") },
  "/v1/webhooks/:id": { get: byId("webhook") },
  "/v1/workflow-runs/:id": { get: byId("workflow_run") },
  "/v1/workflow-runs/:id/steps/:index": { get: literal("0"), literal: true },
  "/v1/workflows/:id": { get: byId("workflow") },
  // SCIM (con el token SCIM de A).
  "/scim/v2/Users/:id": { get: byId("member") },
  "/scim/v2/Groups/:id": { get: byId("group") },
  // Link de firma de un firmante de A con un id de B en el segundo parámetro.
  "/v1/signing/:token": { get: (_f, _s, own) => own.signerToken, literal: true },
  "/v1/signing/:token/documents/:documentId": { get: byState("doc"), stateful: true },
  "/v1/signing/:token/fields/:fieldId": { get: byState("field"), stateful: true },
  "/v1/signing/:token/signature-handoffs/:id": { get: byId("handoff") },
};

/**
 * Rutas con parámetros que no se prueban con credenciales de A, con el motivo. Son públicas a propósito: las autoriza
 * un secreto del path (link de firma, de invitación, de descarga, código de un solo uso) o no identifican un recurso
 * de una organización. Una ruta nueva sin authenticate() y con parámetros tiene que estar acá o en PARAMS.
 */
const PUBLIC_ROUTES: [RegExp, string][] = [
  [
    /^\/v1\/signing\/:token(\/[^:]*)?$/,
    "link de firma: lo autoriza el token del path (las que suman un id de documento, campo o pase van por PARAMS)",
  ],
  [/^\/v1\/signing\/:token\/identity\/captures\/:kind$/, "kind es el tipo de captura (frente, dorso, selfie), no un recurso"],
  [
    /^\/v1\/public\/(negotiations|signature-handoffs|workflow-runs)\/:token(\/|$)/,
    "link público de negociación, pase al celular o workflow: lo autoriza el token",
  ],
  [/^\/v1\/public\/(forms|workflows)\/:slug(\/|$)/, "formulario web y workflow públicos por slug: públicos por diseño"],
  [/^\/v1\/public\/brand-assets\/:key\/:kind$/, "imágenes de marca para correos y páginas públicas (clave opaca)"],
  [/^\/v1\/public\/trust-certificates\/:file$/, "certificados de confianza de la plataforma, públicos"],
  [/^\/v1\/branding\/logo\/:slug$/, "logo de la organización para correos y páginas públicas"],
  [/^\/v1\/auth\/sso\/saml\/:slug\/metadata$/, "metadatos SAML del proveedor de servicio: públicos por protocolo"],
  [/^\/v1\/integrations\//, "webhooks entrantes de proveedores (firma o token propio del proveedor) y SAML ACS"],
  [/^\/v1\/(crm|connectors|storage)\/oauth\/:provider\/callback$/, "vuelta de OAuth del proveedor (state firmado de un solo uso)"],
  [/^\/v1\/(crm|connectors|storage)\/oauth\/:provider\/start$/, "provider es el nombre del proveedor (hubspot, gdrive…), no un recurso"],
  [/^\/v1\/signature-providers\/:id\/test$/, "conectores CSC de la plataforma (compartidos por todas las organizaciones), no de una"],
  [/^\/v1\/(payments|identity)\/return\/:id$/, "vuelta del proveedor de pago o identidad: la autoriza la clave de la query"],
  [/^\/v1\/(payments|billing)\/mock\/checkout\/:id(\/|$)/, "checkout simulado (fuera de producción): lo autoriza el nonce de la query"],
  [/^\/v1\/invite\/:token(\/|$)/, "link de invitación: lo autoriza el token"],
  [/^\/v1\/downloads\/:token$/, "link de descarga firmado (MCP)"],
  [/^\/v1\/firmador\/download\/:file$/, "instaladores del Firmador, públicos"],
  [/^\/v1\/certsign\/sessions\/:code(\/|$)/, "sesión del Firmador: la autoriza el código de emparejamiento"],
  [/^\/embed\/:code$/, "canje del código de un solo uso de una sesión embebida"],
];

/**
 * Respuestas distintas de 404 que se aceptan para una credencial de A: solo cuando esa credencial no tiene acceso a la
 * clase de ruta en absoluto (el mismo pedido con un recurso propio daría lo mismo), así que no dicen nada del recurso
 * de B. Un 400 de validación NO entra acá: tapa el filtro de tenant; se arregla con un cuerpo válido en BODIES.
 */
const CREDENTIAL_DENIALS: { cred: CredName; route: RegExp; status: number; code: string; why: string }[] = [
  {
    cred: "apiKey",
    route: /^\/v1\/me\/sessions\/:id$/,
    status: 403,
    code: "session_required",
    why: "las sesiones abiertas son del usuario: una API key no tiene",
  },
  { cred: "apiKey", route: /^\/v1\/oauth\/connected-apps\//, status: 403, code: "session_required", why: "las apps conectadas son del usuario" },
  // Solo aparece en la variante mixta (sobre de A): con el sobre de B, el control de acceso al sobre da 404 antes.
  {
    cred: "apiKey",
    route: /\/recipients\/:recipientId\/in-person$/,
    status: 403,
    code: "forbidden",
    why: "la firma en persona la abre un usuario, nunca una API key",
  },
];

/** Cuerpo de los POST/PUT/PATCH (por defecto {}): uno que pase la validación, para que el pedido llegue a la búsqueda. */
const BODIES: Record<string, unknown> = {
  "POST /v1/envelopes/:id/recipients/:recipientId/reassign": { name: "Reemplazo", email: "reemplazo@example.com" },
  "POST /v1/signing/:token/signature-handoffs/:id/send": { channel: "telegram" },
  "PATCH /v1/members/:userId": { role: "member" },
  "PATCH /v1/api-keys/:id/role": { role: "member" },
  "POST /v1/document-templates/:id/generate": { recipients: [{ role: "Firmante", name: "Ana", email: "ana@example.com" }], send: false },
  "POST /v1/workflow-runs/:id/steps/:index/decision": { approve: true },
  "POST /v1/negotiations/:id/comments": { body: "Comentario de A" },
  "PATCH /v1/negotiations/:id/comments/:commentId": { resolved: true },
  "POST /v1/negotiations/:id/proposals/:proposalId/decision": { accept: true },
  "PUT /v1/settings/brands/:id": { config: {} },
};

/** Rutas que reciben un archivo (multipart): se manda una imagen PNG de 1×1. */
const MULTIPART = new Set([
  "POST /v1/signing/:token/fields/:fieldId/attachment",
  "POST /v1/settings/brands/:id/assets/:kind",
  "POST /v1/envelopes/:id/documents",
  "POST /v1/templates/:id/documents",
]);
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** Listados que no se piden (con el motivo). */
const LIST_SKIP: [string, string][] = [["/v1/events/stream", "stream SSE abierto al menos 60 s; el mismo contenido lo da GET /v1/events"]];

/** GET con id que no se pueden verificar con las credenciales de B (control positivo), con el motivo. */
const CONTROL_SKIP: [string, string][] = [
  ["/v1/connectors/connections/:id/records", "busca registros en el proveedor externo (BambooHR): sin red, no hay 2xx"],
];

// ───────── App y organizaciones ─────────

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
type CredName = "cookie" | "apiKey" | "scim" | "signer";
interface Org {
  fx: Fixtures;
  cookie: string;
  apiKey: string;
}

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
const ROUTES = routesByInstance.get(app) ?? [];
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
  // El plan más alto: si no, un 402 plan_limit llega antes que la búsqueda y la ruta no se ejercita.
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
  A = await signup("AislRoja");
  B = await signup("AislAzul");
}, 120_000);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

// ───────── Pedidos ─────────

function headers(org: Org, cred: CredName): Record<string, string> {
  if (cred === "cookie") return { cookie: `cs_session=${org.cookie}`, origin: "http://localhost:5173" };
  if (cred === "apiKey") return { authorization: `Bearer ${org.apiKey}` };
  if (cred === "scim") return { authorization: `Bearer ${org.fx.scimToken}` };
  return {};
}

function credsFor(r: Route): CredName[] {
  if (r.url.startsWith("/scim/v2/")) return ["scim"];
  if (r.url.startsWith("/v1/signing/:token/")) return ["signer"];
  if (r.authenticated) return ["cookie", "apiKey"];
  return [];
}

async function call(org: Org, cred: CredName, r: Route, url: string) {
  const key = `${r.method} ${r.url}`;
  const h = headers(org, cred);
  if (MULTIPART.has(key)) {
    const boundary = `aislamiento${util.randomToken(8)}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      PNG_1X1,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return app.inject({ method: r.method as "POST", url, headers: { ...h, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
  }
  const withBody = r.method === "POST" || r.method === "PUT" || r.method === "PATCH";
  return app.inject({ method: r.method as "GET", url, headers: h, ...(withBody ? { payload: (BODIES[key] ?? {}) as object } : {}) });
}

/** Ids de las fixtures → nombre legible ("B.env_sent"), para los mensajes de falla. */
function label(text: string): string {
  let out = text;
  for (const org of [A, B]) for (const [name, v] of Object.entries(org.fx.ids)) out = out.split(v).join(`${org === A ? "A" : "B"}.${name}`);
  return out.split(A.fx.signerToken).join("A.signerToken").split(B.fx.signerToken).join("B.signerToken");
}

/** Qué se hace con una ruta con parámetros: probarla con estas credenciales, saltearla (pública) o fallar. */
function classify(r: Route): { creds: CredName[]; skip?: true; problem?: string } {
  if (PUBLIC_ROUTES.some(([re]) => re.test(r.url))) return { creds: [], skip: true };
  const creds = credsFor(r);
  if (!creds.length)
    return { creds, problem: "sin authenticate() y fuera de PUBLIC_ROUTES (agregala con el motivo, o a PARAMS si es de una organización)" };
  const v = variants(r, B.fx, A.fx);
  if (v.missing) return { creds, problem: `falta el fixture de "${v.missing}" en PARAMS (y el recurso en tenant-isolation-fixtures.ts)` };
  return { creds };
}

const paramNames = (url: string) => [...url.matchAll(/:(\w+)/g)].map((m) => m[1]);
const prefixOf = (url: string, param: string) => url.slice(0, url.indexOf(`:${param}`) + param.length + 1);

interface Variant {
  url: string;
  /** El padre es de quien pega y el hijo de la otra organización (sobre de A con el documento de B). */
  mixed: boolean;
}

/** Ruta con parámetros → variantes de URL (con ids del dueño `owner`, pegando como `attacker`), o el parámetro que falta. */
function variants(r: Route, owner: Fixtures, attacker: Fixtures): { list: Variant[]; missing?: string } {
  const params = paramNames(r.url);
  const specs = params.map((p) => ({ p, spec: PARAMS[prefixOf(r.url, p)] }));
  const miss = specs.find((x) => !x.spec);
  if (miss) return { list: [], missing: prefixOf(r.url, miss.p) };
  const states: State[] = specs.some((x) => x.spec!.stateful) ? [...STATES] : ["draft"];
  const build = (vals: string[]) => r.url.replace(/:(\w+)/g, (_m, name: string) => encodeURIComponent(vals[params.indexOf(name)]));
  const out = new Map<string, Variant>();
  // Mixta: solo si el primero es un recurso y después hay otro recurso (no un literal como :kind o :index).
  const mixable = specs.length >= 2 && !specs[0].spec!.literal && specs.slice(1).some((x) => !x.spec!.literal);
  for (const s of states) {
    // Todo de la otra organización.
    const all = build(specs.map((x) => x.spec!.get(owner, s, attacker)));
    out.set(all, { url: all, mixed: false });
    if (mixable) {
      const mixed = build(specs.map((x, i) => x.spec!.get(i === 0 ? attacker : owner, s, attacker)));
      if (!out.has(mixed)) out.set(mixed, { url: mixed, mixed: true });
    }
  }
  return { list: [...out.values()] };
}

// ───────── Estado de B ─────────

/** Tablas sin tenant_id que cuelgan de una que lo tiene. */
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
let snapshotSql = "";
async function snapshot(tenantId: string): Promise<Map<string, string>> {
  if (!snapshotSql) {
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'tenant_id' ORDER BY table_name`,
    );
    const parts: [string, string][] = [...tables.map((t): [string, string] => [t.table_name, "tenant_id = $1"]), ...Object.entries(CHILD_TABLES)];
    snapshotSql = parts
      .map(([t, where]) => `SELECT '${t}' AS t, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x WHERE ${where}`)
      .join(" UNION ALL ");
  }
  const rows = await db.query<{ t: string; h: string }>(snapshotSql, [tenantId]);
  return new Map(rows.map((r) => [r.t, r.h]));
}
const changedTables = (a: Map<string, string>, b: Map<string, string>) => [...a].filter(([t, h]) => b.get(t) !== h).map(([t]) => t);

/** Ids y marca de una organización: si aparecen en una respuesta de la otra, es una fuga. */
function markersOf(o: Org): string[] {
  return [o.fx.tag.toLowerCase(), o.fx.tenantId, o.fx.ownerId, ...Object.values(o.fx.ids).map((v) => v.toLowerCase())];
}

// ───────── Tests ─────────

describe("aislamiento entre organizaciones en todas las rutas (SEG-11)", () => {
  it("enumera las rutas de la app", () => {
    expect(ROUTES.length).toBeGreaterThan(400);
    expect(ROUTES.filter((r) => r.url.includes(":")).length).toBeGreaterThan(200);
  });

  it("toda ruta con parámetros tiene fixture o está en las excepciones públicas", () => {
    const problems: string[] = [];
    for (const r of ROUTES.filter((x) => x.url.includes(":"))) {
      const c = classify(r);
      if (c.problem) problems.push(`${r.method} ${r.url}: ${c.problem}`);
    }
    expect(problems).toEqual([]);
  });

  it("con credenciales de A, cada ruta con id de B da 404 y B no cambia", async () => {
    const failures: string[] = [];
    const tested = { routes: 0, requests: 0 };
    let before = await snapshot(B.fx.tenantId);
    const jobsBefore = (await db.one<{ m: string | null }>(`SELECT max(id)::text AS m FROM jobs`))!.m ?? "0";
    for (const r of ROUTES.filter((x) => x.url.includes(":"))) {
      const { creds, skip, problem } = classify(r);
      if (skip || problem) continue;
      const v = variants(r, B.fx, A.fx);
      tested.routes++;
      let mixedReached404 = !v.list.some((x) => x.mixed);
      for (const { url, mixed } of v.list) {
        for (const cred of creds) {
          tested.requests++;
          lastMatched = undefined;
          const res = await call(A, cred, r, url);
          if (lastMatched !== r.url) {
            failures.push(label(`${r.method} ${url} [${cred}]: lo atendió ${lastMatched ?? "el 404 del router"}, no ${r.url} (URL mal armada)`));
            continue;
          }
          if (res.statusCode === 404) {
            if (mixed) mixedReached404 = true;
            continue;
          }
          let code = "";
          try {
            code = (res.json() as { error?: { code?: string } }).error?.code ?? "";
          } catch {
            code = "(no JSON)";
          }
          if (CREDENTIAL_DENIALS.some((d) => d.cred === cred && d.route.test(r.url) && d.status === res.statusCode && d.code === code)) continue;
          // Variante mixta: un 409 es por el estado del padre propio (p. ej. borrar un documento de un sobre de A ya
          // enviado), no dice nada del hijo de B. La del estado que sí aplica tiene que llegar al 404 (abajo).
          if (mixed && res.statusCode === 409) continue;
          failures.push(label(`${r.method} ${url} [${cred}] → ${res.statusCode} ${code} ${res.body.slice(0, 160)}`));
        }
      }
      if (!mixedReached404) failures.push(`${r.method} ${r.url}: ninguna variante mixta (padre de A, hijo de B) llegó al 404`);
      const after = await snapshot(B.fx.tenantId);
      const changed = changedTables(before, after);
      if (changed.length) failures.push(`${r.method} ${r.url}: cambió datos de B en ${changed.join(", ")}`);
      before = after;
    }
    const jobs = await db.query<{ queue: string; payload: unknown }>(`SELECT queue, payload FROM jobs WHERE id > $1::bigint`, [jobsBefore]);
    const bIds = markersOf(B);
    for (const j of jobs)
      if (bIds.some((m) => JSON.stringify(j.payload).toLowerCase().includes(m))) failures.push(`job ${j.queue} encolado con datos de B`);
    console.info(`aislamiento: ${tested.routes} rutas con id, ${tested.requests} pedidos`);
    expect(failures).toEqual([]);
  }, 300_000);

  it("los listados sin parámetros con credenciales de A no contienen ids ni datos de B", async () => {
    const failures: string[] = [];
    const markers = markersOf(B);
    const own = markersOf(A);
    let sawOwn = 0;
    for (const r of ROUTES.filter((x) => x.method === "GET" && !x.url.includes(":") && !x.url.includes("*"))) {
      if (LIST_SKIP.some(([u]) => u === r.url)) continue;
      const creds = r.url.startsWith("/scim/v2/") ? (["scim"] as CredName[]) : r.authenticated ? (["cookie", "apiKey"] as CredName[]) : [];
      for (const cred of creds) {
        const res = await call(A, cred, r, r.url);
        const body = res.body.toLowerCase();
        const leaked = markers.filter((m) => body.includes(m));
        if (leaked.length) {
          const at = body.indexOf(leaked[0]);
          const context = res.body.slice(Math.max(0, at - 120), at + 80);
          failures.push(label(`GET ${r.url} [${cred}] → ${res.statusCode} contiene datos de B (${leaked.slice(0, 3).join(", ")}): …${context}…`));
        }
        if (res.statusCode >= 500) failures.push(`GET ${r.url} [${cred}] → ${res.statusCode}`);
        if (own.some((m) => body.includes(m))) sawOwn++;
      }
    }
    // Control: los listados de A sí muestran lo de A (si todo diera vacío o error, no buscar a B no probaba nada).
    expect(sawOwn).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  }, 300_000);

  it("control: con credenciales de B, cada GET con id de B responde 2xx (los fixtures son reales)", async () => {
    const failures: string[] = [];
    for (const r of ROUTES.filter((x) => x.method === "GET" && x.url.includes(":"))) {
      const { creds, skip, problem } = classify(r);
      if (skip || problem || CONTROL_SKIP.some(([u]) => u === r.url)) continue;
      const v = variants(r, B.fx, B.fx);
      const statuses: string[] = [];
      for (const { url } of v.list) {
        const res = await call(B, creds[0], r, url);
        statuses.push(`${res.statusCode}`);
        if (res.statusCode < 300) break;
      }
      if (!statuses.some((s) => Number(s) < 300)) failures.push(`GET ${r.url} → ${statuses.join(", ")}`);
    }
    expect(failures).toEqual([]);
  }, 300_000);
});

// Las dos fugas que encontró el barrido (respondían 204 con un recurso de otra organización y dejaban su nombre en la
// auditoría de quien llamó): con lo propio siguen respondiendo 204.
describe("lo propio se sigue pudiendo borrar", () => {
  it("DELETE /v1/settings/email-domains/:domain del dominio propio: 204, y 404 la segunda vez", async () => {
    const url = `/v1/settings/email-domains/${A.fx.ids.email_domain}`;
    expect((await app.inject({ method: "DELETE", url, headers: headers(A, "cookie") })).statusCode).toBe(204);
    expect(await db.one(`SELECT 1 FROM email_domains WHERE domain = $1`, [A.fx.ids.email_domain])).toBeNull();
    expect((await app.inject({ method: "DELETE", url, headers: headers(A, "cookie") })).statusCode).toBe(404);
  });

  it("DELETE /v1/oauth/connected-apps/:clientId de una app conectada: 204 y borra el consentimiento; sin conexión, 404", async () => {
    const clientId = util.uuidv7();
    const publicId = `cli_externa_${util.randomToken(6)}`;
    await db.query(
      `INSERT INTO oauth_clients (id, tenant_id, client_id, name, redirect_uris, grant_types, scopes, registration) VALUES ($1,NULL,$2,'App externa','{https://x.example.com/cb}','{authorization_code}','{envelopes:read}','dynamic')`,
      [clientId, publicId],
    );
    await db.query(`INSERT INTO oauth_consents (client_id, user_id, tenant_id, scopes) VALUES ($1,$2,$3,'{envelopes:read}')`, [
      clientId,
      A.fx.ownerId,
      A.fx.tenantId,
    ]);
    const url = `/v1/oauth/connected-apps/${publicId}`;
    expect((await app.inject({ method: "DELETE", url, headers: headers(A, "cookie") })).statusCode).toBe(204);
    expect(await db.one(`SELECT 1 FROM oauth_consents WHERE client_id = $1`, [clientId])).toBeNull();
    expect((await app.inject({ method: "DELETE", url, headers: headers(A, "cookie") })).statusCode).toBe(404);
  });
});
