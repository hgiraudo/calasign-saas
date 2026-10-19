// Clientes HTTP de cada proveedor CRM/ERP. Las URLs base salen de variables de entorno (las pruebas apuntan a
// servidores simulados); nunca del usuario, salvo el instance_url de Salesforce, que se valida.
//
// Supuestos tomados de la documentación pública de cada API (ver docs/CRM.md):
//  · HubSpot   CRM v3 (deals, contacts, associations), Files v3 y notes con hs_attachment_ids.
//  · Salesforce REST v60 (sobjects, SOQL OpportunityContactRole, ContentVersion con FirstPublishLocationId).
//  · Siigo     API v1 (POST /auth con username + access_key y Partner-Id; /v1/customers). Siigo no publica un
//              endpoint de adjuntos: la referencia al documento se agrega al campo comments del cliente.
//  · Alegra    API v1 (Basic email:token; /contacts y /invoices con POST …/{id}/attachment).
import type { CrmObjectType, CrmProvider, CrmRecord } from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { decrypt, encrypt } from "../../lib/util";

const env = process.env;

export const BASES = {
  hubspotApi: () => (env.HUBSPOT_API_BASE ?? "https://api.hubapi.com").replace(/\/$/, ""),
  hubspotAuthorize: () => env.HUBSPOT_AUTHORIZE_URL ?? "https://app.hubspot.com/oauth/authorize",
  salesforceLogin: () => (env.SALESFORCE_LOGIN_URL ?? "https://login.salesforce.com").replace(/\/$/, ""),
  siigoApi: () => (env.SIIGO_API_BASE ?? "https://api.siigo.com").replace(/\/$/, ""),
  alegraApi: () => (env.ALEGRA_API_BASE ?? "https://api.alegra.com/api/v1").replace(/\/$/, ""),
};

const SF_API_VERSION = "v60.0";

export interface OAuthAppCfg {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  pkce: boolean;
}

export function oauthApp(p: "hubspot" | "salesforce"): OAuthAppCfg {
  if (p === "hubspot")
    return {
      clientId: env.HUBSPOT_CLIENT_ID,
      clientSecret: env.HUBSPOT_CLIENT_SECRET,
      authorizeUrl: BASES.hubspotAuthorize(),
      tokenUrl: `${BASES.hubspotApi()}/oauth/v1/token`,
      scope: "crm.objects.deals.read crm.objects.deals.write crm.objects.contacts.read files oauth",
      pkce: false,
    };
  return {
    clientId: env.SALESFORCE_CLIENT_ID,
    clientSecret: env.SALESFORCE_CLIENT_SECRET,
    authorizeUrl: `${BASES.salesforceLogin()}/services/oauth2/authorize`,
    tokenUrl: `${BASES.salesforceLogin()}/services/oauth2/token`,
    scope: "api refresh_token",
    pkce: true,
  };
}

export const oauthConfigured = (p: CrmProvider) =>
  (p === "hubspot" || p === "salesforce") && Boolean(oauthApp(p).clientId && oauthApp(p).clientSecret);
export const tokenSupported = (p: CrmProvider) => p !== "salesforce";
export const crmRedirectUri = (p: "hubspot" | "salesforce") => `${config.appUrl}/v1/crm/oauth/${p}/callback`;

export class CrmError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    /** El token fue revocado o las credenciales ya no sirven: hay que reconectar. */
    readonly authFailed = false,
  ) {
    super(message);
  }
}

// ───────────────────────────── Credenciales ─────────────────────────────

export interface OAuthCreds {
  access_token: string;
  refresh_token?: string;
  /** ms epoch; Salesforce no informa vencimiento: se refresca ante un 401. */
  expires_at?: number | null;
}
export interface HubspotTokenCreds {
  token: string;
}
export interface SiigoCreds {
  username: string;
  accessKey: string;
  access_token?: string;
  expires_at?: number;
}
export interface AlegraCreds {
  email: string;
  token: string;
}

export interface ConnRow {
  id: string;
  provider: CrmProvider;
  auth_type: "oauth" | "token";
  credentials_enc: string;
  config: Record<string, any>;
}

/** Conexión abierta: cachea credenciales y persiste las que se renuevan. */
export class CrmConn {
  creds: any;
  constructor(
    readonly row: ConnRow,
    private db: Db | null,
  ) {
    this.creds = JSON.parse(decrypt(row.credentials_enc));
  }
  get provider() {
    return this.row.provider;
  }
  get cfg() {
    return this.row.config ?? {};
  }
  async persist(configPatch?: Record<string, unknown>) {
    if (!this.db) return;
    this.row.credentials_enc = encrypt(JSON.stringify(this.creds));
    await this.db.query(`UPDATE crm_connections SET credentials_enc = $2, config = config || $3::jsonb, updated_at = now() WHERE id = $1`, [
      this.row.id,
      this.row.credentials_enc,
      JSON.stringify(configPatch ?? {}),
    ]);
  }
}

// ───────────────────────────── OAuth ─────────────────────────────

export async function oauthTokenRequest(p: "hubspot" | "salesforce", params: Record<string, string>): Promise<any> {
  const app = oauthApp(p);
  const res = await fetch(app.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: app.clientId!, client_secret: app.clientSecret!, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const invalid = body.error === "invalid_grant" || res.status === 400 || res.status === 401;
    throw new CrmError(`token ${p}: HTTP ${res.status} ${body.error_description ?? body.error ?? body.message ?? ""}`.trim(), res.status, invalid);
  }
  return body;
}

/** Valida el instance_url que devuelve Salesforce (es la única URL que viene del proveedor). */
export function validateSalesforceInstance(raw: string): string {
  const u = new URL(raw);
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  if (local && config.environment === "local") return u.origin;
  if (u.protocol !== "https:" || !/(\.salesforce\.com|\.force\.com|\.salesforce-setup\.com)$/i.test(u.hostname)) {
    throw new CrmError(`instance_url inesperado: ${u.hostname}`);
  }
  return u.origin;
}

async function refreshOAuth(c: CrmConn) {
  const p = c.provider as "hubspot" | "salesforce";
  if (!c.creds.refresh_token) throw new CrmError("la conexión venció: hay que volver a conectarla", 401, true);
  const b = await oauthTokenRequest(p, { grant_type: "refresh_token", refresh_token: c.creds.refresh_token });
  c.creds = {
    access_token: b.access_token,
    refresh_token: b.refresh_token ?? c.creds.refresh_token,
    expires_at: b.expires_in ? Date.now() + Number(b.expires_in) * 1000 : null,
  };
  const patch: Record<string, unknown> = {};
  if (p === "salesforce" && b.instance_url) patch.instanceUrl = validateSalesforceInstance(b.instance_url);
  await c.persist(patch);
}

// ───────────────────────────── HTTP con autenticación ─────────────────────────────

interface Req {
  method?: string;
  path: string;
  /** Si no se indica, la base del proveedor. */
  base?: string;
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
}

async function authHeader(c: CrmConn): Promise<Record<string, string>> {
  if (c.provider === "alegra") {
    const cr = c.creds as AlegraCreds;
    return { authorization: `Basic ${Buffer.from(`${cr.email}:${cr.token}`).toString("base64")}` };
  }
  if (c.provider === "siigo") {
    const cr = c.creds as SiigoCreds;
    if (!cr.access_token || (cr.expires_at ?? 0) - 60_000 < Date.now()) await siigoLogin(c);
    return { authorization: `Bearer ${c.creds.access_token}`, "Partner-Id": env.SIIGO_PARTNER_ID ?? "CalaSign" };
  }
  if (c.row.auth_type === "token") return { authorization: `Bearer ${(c.creds as HubspotTokenCreds).token}` };
  const cr = c.creds as OAuthCreds;
  if (cr.expires_at && cr.expires_at - 60_000 < Date.now()) await refreshOAuth(c);
  return { authorization: `Bearer ${c.creds.access_token}` };
}

function baseFor(c: CrmConn): string {
  switch (c.provider) {
    case "hubspot":
      return BASES.hubspotApi();
    case "salesforce":
      if (!c.cfg.instanceUrl) throw new CrmError("conexión de Salesforce sin instance_url");
      return validateSalesforceInstance(c.cfg.instanceUrl);
    case "siigo":
      return BASES.siigoApi();
    case "alegra":
      return BASES.alegraApi();
  }
}

export async function crmFetch(c: CrmConn, r: Req, retried = false): Promise<any> {
  const headers: Record<string, string> = { accept: "application/json", ...(await authHeader(c)), ...(r.headers ?? {}) };
  let body: BodyInit | undefined;
  if (r.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(r.json);
  } else if (r.form) body = r.form;
  const res = await fetch(`${r.base ?? baseFor(c)}${r.path}`, { method: r.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 && !retried) {
    // Token vencido o revocado: se intenta renovar una vez (OAuth con refresh, o login de Siigo).
    if (c.provider === "siigo") {
      await siigoLogin(c);
      return crmFetch(c, r, true);
    }
    if (c.row.auth_type === "oauth" && c.creds.refresh_token) {
      await refreshOAuth(c);
      return crmFetch(c, r, true);
    }
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = typeof data === "object" && data ? data.message ?? data[0]?.message ?? data.error_description ?? data.error ?? JSON.stringify(data).slice(0, 200) : String(data).slice(0, 200);
    throw new CrmError(`${c.provider} ${r.method ?? "GET"} ${r.path}: HTTP ${res.status} ${msg}`, res.status, res.status === 401 || res.status === 403);
  }
  return data;
}

async function siigoLogin(c: CrmConn) {
  const cr = c.creds as SiigoCreds;
  const res = await fetch(`${BASES.siigoApi()}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "Partner-Id": env.SIIGO_PARTNER_ID ?? "CalaSign" },
    body: JSON.stringify({ username: cr.username, access_key: cr.accessKey }),
    signal: AbortSignal.timeout(15_000),
  });
  const b: any = await res.json().catch(() => ({}));
  // Solo credenciales rechazadas piden reconectar: un /auth caído (5xx, 429) es transitorio y el trabajo se reintenta.
  if (!res.ok || !b.access_token) {
    const rejected = res.ok || res.status === 400 || res.status === 401 || res.status === 403;
    throw new CrmError(`siigo /auth: HTTP ${res.status} ${b.Errors?.[0]?.Message ?? b.message ?? ""}`.trim(), res.status, rejected);
  }
  c.creds = { ...cr, access_token: b.access_token, expires_at: Date.now() + Number(b.expires_in ?? 86_400) * 1000 };
  await c.persist();
}

// ───────────────────────────── Operaciones por proveedor ─────────────────────────────

const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));

/** Prueba de las credenciales; devuelve una etiqueta de la cuenta y datos para guardar en config. */
export async function testConnection(c: CrmConn): Promise<{ label: string | null; config?: Record<string, unknown> }> {
  switch (c.provider) {
    case "hubspot": {
      if (c.row.auth_type === "oauth") {
        const info = await crmFetch(c, { path: `/oauth/v1/access-tokens/${encodeURIComponent(c.creds.access_token)}` });
        return { label: info?.hub_domain ?? info?.user ?? null, config: { portalId: str(info?.hub_id) } };
      }
      const info = await crmFetch(c, { path: "/account-info/v3/details" }).catch(() => null);
      await crmFetch(c, { path: "/crm/v3/objects/deals?limit=1" });
      return { label: info?.uiDomain ?? (info?.portalId ? `portal ${info.portalId}` : null), config: { portalId: str(info?.portalId) } };
    }
    case "salesforce": {
      await crmFetch(c, { path: `/services/data/${SF_API_VERSION}/limits` });
      return { label: new URL(baseFor(c)).host, config: {} };
    }
    case "siigo": {
      await crmFetch(c, { path: "/v1/customers?page_size=1" });
      return { label: (c.creds as SiigoCreds).username };
    }
    case "alegra": {
      await crmFetch(c, { path: "/contacts?limit=1" });
      return { label: (c.creds as AlegraCreds).email };
    }
  }
}

/** Lee un registro y sus contactos, normalizado para los mapeos. */
export async function fetchRecord(c: CrmConn, objectType: CrmObjectType, id: string, properties: string[]): Promise<CrmRecord> {
  const enc = encodeURIComponent(id);
  if (c.provider === "hubspot" && objectType === "deal") {
    const props = [...new Set(["dealname", "amount", "closedate", "dealstage", ...properties])].join(",");
    const deal = await crmFetch(c, { path: `/crm/v3/objects/deals/${enc}?properties=${encodeURIComponent(props)}&associations=contacts` });
    const ids: string[] = (deal?.associations?.contacts?.results ?? []).map((x: any) => String(x.id));
    const contacts: CrmRecord["contacts"] = [];
    if (ids.length) {
      const batch = await crmFetch(c, {
        method: "POST",
        path: "/crm/v3/objects/contacts/batch/read",
        json: { inputs: ids.map((i) => ({ id: i })), properties: ["firstname", "lastname", "email", "phone", "mobilephone"] },
      });
      const byId = new Map<string, any>((batch?.results ?? []).map((r: any) => [String(r.id), r]));
      ids.forEach((cid, i) => {
        const p = byId.get(cid)?.properties ?? {};
        const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || p.email || `Contacto ${cid}`;
        contacts.push({ id: cid, name, email: str(p.email), phone: str(p.mobilephone ?? p.phone), role: null, primary: i === 0 });
      });
    }
    return { id: String(deal.id), objectType, properties: deal.properties ?? {}, contacts };
  }
  if (c.provider === "salesforce" && objectType === "opportunity") {
    const opp = await crmFetch(c, { path: `/services/data/${SF_API_VERSION}/sobjects/Opportunity/${enc}` });
    const q = `SELECT ContactId, Role, IsPrimary, Contact.Name, Contact.Email, Contact.MobilePhone, Contact.Phone FROM OpportunityContactRole WHERE OpportunityId = '${String(id).replace(/[^A-Za-z0-9]/g, "")}'`;
    const roles = await crmFetch(c, { path: `/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(q)}` });
    const contacts: CrmRecord["contacts"] = (roles?.records ?? []).map((r: any) => ({
      id: String(r.ContactId),
      name: r.Contact?.Name ?? `Contacto ${r.ContactId}`,
      email: str(r.Contact?.Email),
      phone: str(r.Contact?.MobilePhone ?? r.Contact?.Phone),
      role: str(r.Role),
      primary: Boolean(r.IsPrimary),
    }));
    const { attributes: _a, ...properties } = opp ?? {};
    return { id: String(opp.Id ?? id), objectType, properties, contacts };
  }
  throw new CrmError(`${c.provider} no admite enviar desde registros de tipo ${objectType}`);
}

/** Escribe el estado del sobre en una propiedad del registro. */
export async function writeStatus(c: CrmConn, objectType: CrmObjectType, id: string, property: string, value: string) {
  const enc = encodeURIComponent(id);
  if (c.provider === "hubspot") return crmFetch(c, { method: "PATCH", path: `/crm/v3/objects/deals/${enc}`, json: { properties: { [property]: value } } });
  if (c.provider === "salesforce") return crmFetch(c, { method: "PATCH", path: `/services/data/${SF_API_VERSION}/sobjects/Opportunity/${enc}`, json: { [property]: value } });
  throw new CrmError(`${c.provider} no admite escribir estados (${objectType})`);
}

export interface AttachInput {
  fileName: string;
  pdf: Uint8Array;
  subject: string;
  envelopeId: string;
  sha256: string;
  url: string;
}

/** Adjunta el PDF sellado (o su referencia) al registro. Devuelve una referencia remota. */
export async function attachSigned(c: CrmConn, objectType: CrmObjectType, id: string, a: AttachInput): Promise<string> {
  const enc = encodeURIComponent(id);
  const note = `CalaSign: "${a.subject}" firmado. Sobre ${a.envelopeId} · SHA-256 ${a.sha256} · ${a.url}`;
  if (c.provider === "hubspot") {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(a.pdf)], { type: "application/pdf" }), a.fileName);
    form.append("folderPath", "/CalaSign");
    form.append("options", JSON.stringify({ access: "PRIVATE", overwrite: false }));
    const file = await crmFetch(c, { method: "POST", path: "/files/v3/files", form });
    const created = await crmFetch(c, {
      method: "POST",
      path: "/crm/v3/objects/notes",
      json: {
        properties: { hs_timestamp: new Date().toISOString(), hs_note_body: note, hs_attachment_ids: String(file.id) },
        // 214 = nota → deal (asociación definida por HubSpot).
        associations: [{ to: { id: String(id) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] }],
      },
    });
    return `file:${file.id} note:${created.id}`;
  }
  if (c.provider === "salesforce") {
    const created = await crmFetch(c, {
      method: "POST",
      path: `/services/data/${SF_API_VERSION}/sobjects/ContentVersion`,
      json: { Title: a.subject.slice(0, 255), PathOnClient: a.fileName, VersionData: Buffer.from(a.pdf).toString("base64"), FirstPublishLocationId: id, Description: note.slice(0, 1000) },
    });
    return `ContentVersion:${created.id}`;
  }
  if (c.provider === "alegra") {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(a.pdf)], { type: "application/pdf" }), a.fileName);
    const path = objectType === "invoice" ? `/invoices/${enc}/attachment` : `/contacts/${enc}/attachment`;
    const r = await crmFetch(c, { method: "POST", path, form });
    return `attachment:${r?.id ?? r?.name ?? a.fileName}`;
  }
  // Siigo: sin endpoint de adjuntos; se agrega la referencia al campo comments del cliente sin pisar lo que había.
  const customer = await crmFetch(c, { path: `/v1/customers/${enc}` });
  const comments = [customer?.comments, note].filter(Boolean).join("\n").slice(0, 4000);
  const { id: _id, metadata: _m, ...rest } = customer ?? {};
  await crmFetch(c, { method: "PUT", path: `/v1/customers/${enc}`, json: { ...rest, comments } });
  return `customer:${id}:comments`;
}

/** Busca un registro del ERP por número de identificación (NIT, cédula). */
export async function findByIdentification(c: CrmConn, objectType: CrmObjectType, identification: string): Promise<string | null> {
  const q = encodeURIComponent(identification.replace(/[^0-9A-Za-z-]/g, ""));
  if (c.provider === "siigo") {
    const r = await crmFetch(c, { path: `/v1/customers?identification=${q}` });
    return r?.results?.[0]?.id ? String(r.results[0].id) : null;
  }
  if (c.provider === "alegra" && objectType === "contact") {
    const r = await crmFetch(c, { path: `/contacts?identification=${q}` });
    const list = Array.isArray(r) ? r : r?.data ?? [];
    return list[0]?.id ? String(list[0].id) : null;
  }
  throw new CrmError(`${c.provider} no admite buscar ${objectType} por identificación`);
}
