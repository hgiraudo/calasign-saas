// Clientes HTTP de los conectores HRIS y CLM. Interfaz común (Driver): probar la conexión, buscar registros, leer
// un registro normalizado (propiedades + personas), traer su documento (CLM), entregar archivos al registro y
// escribir el estado. Las URLs base salen de variables de entorno (las pruebas apuntan a simuladores), nunca del
// usuario: el dominio de BambooHR y la región de Ironclad se validan contra una lista cerrada.
//
// Supuestos tomados de la documentación pública de cada API (detalle y fuentes en docs/CONECTORES-HR-CLM-DMS.md):
//  · BambooHR  API v1 con Basic (API key : x); GET /employees/{id}?fields=…, GET /employees/directory,
//              POST /employees/{id}/files (multipart file, fileName, category, share), POST /employees/{id} (campos).
//  · HiBob     API v1 con Basic (service user id : token); GET /people/{id}, POST /people/search,
//              POST /docs/people/{id}/{confidential|shared}/upload (multipart file).
//  · Factorial API versionada por fecha (/api/{versión}/resources/…), x-api-key u OAuth; employees/employees y
//              documents/documents (multipart employee_id, folder_id, file).
//  · Ironclad  /public/api/v1 con Bearer (token de API u OAuth); workflows (GET, document/{key}/download,
//              POST upload-signed con "attachment") y records (GET, PATCH, POST attachments/{key}).
//  · Juro      API v3 con x-api-key; GET /contracts/{id}, GET /contracts/{id}/pdf/binary, POST /contracts/upload.
import type { ConnectorObjectType, ConnectorProvider, ConnectorRecordSummary, CrmRecord } from "@calasign/shared";
import { config } from "../../config";
import type { Db } from "../../infra/db";
import { decrypt, encrypt } from "../../lib/util";

const env = process.env;
const trim = (u: string) => u.replace(/\/$/, "");

export const FACTORIAL_VERSION = () => env.FACTORIAL_API_VERSION ?? "2026-07-01";
const IRONCLAD_HOSTS: Record<string, string> = { na1: "https://ironcladapp.com", eu1: "https://eu1.ironcladapp.com", demo: "https://demo.ironcladapp.com" };

export const BASES = {
  bamboohr: (company: string) => trim(env.BAMBOOHR_API_BASE ?? "https://api.bamboohr.com/api/gateway.php/{company}/v1").replace("{company}", encodeURIComponent(company)),
  hibob: () => trim(env.HIBOB_API_BASE ?? "https://api.hibob.com/v1"),
  factorial: () => trim(env.FACTORIAL_API_BASE ?? "https://api.factorialhr.com"),
  ironcladHost: (region?: string | null) => trim(env.IRONCLAD_BASE ?? IRONCLAD_HOSTS[region ?? "na1"] ?? IRONCLAD_HOSTS.na1),
  juro: () => trim(env.JURO_API_BASE ?? "https://api.juro.com/v3"),
};

// ───────────────────────────── OAuth (Ironclad, Factorial) ─────────────────────────────

export type OAuthProvider = "ironclad" | "factorial";
export const OAUTH_PROVIDERS: readonly ConnectorProvider[] = ["ironclad", "factorial"];

export interface OAuthAppCfg {
  clientId?: string;
  clientSecret?: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
}

export function oauthApp(p: OAuthProvider, region?: string | null): OAuthAppCfg {
  if (p === "ironclad") {
    const host = BASES.ironcladHost(region);
    return {
      clientId: env.IRONCLAD_CLIENT_ID,
      clientSecret: env.IRONCLAD_CLIENT_SECRET,
      authorizeUrl: `${host}/oauth/authorize`,
      tokenUrl: `${host}/oauth/token`,
      scope: [
        "public.workflows.readWorkflows",
        "public.workflows.readDocuments",
        "public.workflows.uploadSignedDocuments",
        "public.records.readRecords",
        "public.records.updateRecords",
        "public.records.createAttachments",
      ].join(" "),
    };
  }
  return {
    clientId: env.FACTORIAL_CLIENT_ID,
    clientSecret: env.FACTORIAL_CLIENT_SECRET,
    authorizeUrl: `${BASES.factorial()}/oauth/authorize`,
    tokenUrl: `${BASES.factorial()}/oauth/token`,
    scope: env.FACTORIAL_SCOPE ?? "",
  };
}

export const oauthConfigured = (p: ConnectorProvider) => (OAUTH_PROVIDERS.includes(p) ? Boolean(oauthApp(p as OAuthProvider).clientId && oauthApp(p as OAuthProvider).clientSecret) : false);
export const connectorRedirectUri = (p: OAuthProvider) => `${config.appUrl}/v1/connectors/oauth/${p}/callback`;

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    /** Credenciales revocadas o inválidas: hay que reconectar (no se reintenta solo). */
    readonly authFailed = false,
  ) {
    super(message);
  }
}

export async function oauthTokenRequest(p: OAuthProvider, region: string | null | undefined, params: Record<string, string>): Promise<any> {
  const app = oauthApp(p, region);
  const res = await fetch(app.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: app.clientId!, client_secret: app.clientSecret!, ...params }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const invalid = body.error === "invalid_grant" || res.status === 400 || res.status === 401;
    throw new ConnectorError(`token ${p}: HTTP ${res.status} ${body.error_description ?? body.error ?? ""}`.trim(), res.status, invalid);
  }
  return body;
}

// ───────────────────────────── Conexión ─────────────────────────────

export interface ConnRow {
  id: string;
  provider: ConnectorProvider;
  auth_type: "oauth" | "api_key";
  credentials_enc: string;
  config: Record<string, any>;
}

export class Conn {
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
  async persist() {
    if (!this.db) return;
    this.row.credentials_enc = encrypt(JSON.stringify(this.creds));
    await this.db.query(`UPDATE connector_connections SET credentials_enc = $2, updated_at = now() WHERE id = $1`, [this.row.id, this.row.credentials_enc]);
  }
}

/** Valida y normaliza las credenciales por clave; devuelve lo que se cifra y la configuración sin secretos. */
export function normalizeCredentials(p: ConnectorProvider, raw: Record<string, string>): { creds: Record<string, string>; config: Record<string, unknown> } {
  const need = (k: string, min = 1) => {
    const v = String(raw[k] ?? "").trim();
    if (v.length < min) throw new ConnectorError(`falta ${k}`, 400);
    return v;
  };
  switch (p) {
    case "bamboohr": {
      // Subdominio de la empresa (acme en acme.bamboohr.com): va dentro de la URL, así que solo letras, números y guiones.
      const company = need("companyDomain").toLowerCase().replace(/^https?:\/\//, "").replace(/\.bamboohr\.com.*$/, "");
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(company)) throw new ConnectorError("companyDomain inválido (el subdominio de bamboohr.com)", 400);
      return { creds: { apiKey: need("apiKey", 8) }, config: { companyDomain: company } };
    }
    case "hibob":
      return { creds: { serviceUserId: need("serviceUserId"), token: need("token", 8) }, config: {} };
    case "factorial":
      return { creds: { apiKey: need("apiKey", 8) }, config: {} };
    case "ironclad": {
      const region = String(raw.region ?? "na1").trim() || "na1";
      if (!IRONCLAD_HOSTS[region]) throw new ConnectorError("region: na1, eu1 o demo", 400);
      const userEmail = String(raw.userEmail ?? "").trim();
      if (userEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(userEmail)) throw new ConnectorError("userEmail inválido", 400);
      return { creds: { apiToken: need("apiToken", 8) }, config: { region, userEmail: userEmail || null } };
    }
    case "juro":
      return { creds: { apiKey: need("apiKey", 8) }, config: {} };
  }
}

// ───────────────────────────── HTTP con autenticación ─────────────────────────────

interface Req {
  method?: string;
  path: string;
  json?: unknown;
  form?: FormData;
  /** Devolver los bytes (descarga de documentos). */
  binary?: boolean;
}

function baseFor(c: Conn): string {
  switch (c.provider) {
    case "bamboohr":
      return BASES.bamboohr(String(c.cfg.companyDomain ?? ""));
    case "hibob":
      return BASES.hibob();
    case "factorial":
      return `${BASES.factorial()}/api/${FACTORIAL_VERSION()}/resources`;
    case "ironclad":
      return `${BASES.ironcladHost(c.cfg.region)}/public/api/v1`;
    case "juro":
      return BASES.juro();
  }
}

async function refreshOAuth(c: Conn) {
  if (!c.creds.refresh_token) throw new ConnectorError("la conexión venció: hay que volver a conectarla", 401, true);
  const b = await oauthTokenRequest(c.provider as OAuthProvider, c.cfg.region, { grant_type: "refresh_token", refresh_token: c.creds.refresh_token });
  c.creds = { access_token: b.access_token, refresh_token: b.refresh_token ?? c.creds.refresh_token, expires_at: b.expires_in ? Date.now() + Number(b.expires_in) * 1000 : null };
  await c.persist();
}

async function authHeaders(c: Conn): Promise<Record<string, string>> {
  const basic = (u: string, p: string) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}` });
  if (c.row.auth_type === "oauth") {
    if (c.creds.expires_at && c.creds.expires_at - 60_000 < Date.now()) await refreshOAuth(c);
    const h: Record<string, string> = { authorization: `Bearer ${c.creds.access_token}` };
    if (c.provider === "ironclad" && c.cfg.userEmail) h["x-as-user-email"] = c.cfg.userEmail;
    return h;
  }
  switch (c.provider) {
    case "bamboohr":
      return basic(c.creds.apiKey, "x");
    case "hibob":
      return basic(c.creds.serviceUserId, c.creds.token);
    case "factorial":
    case "juro":
      return { "x-api-key": c.creds.apiKey };
    case "ironclad": {
      const h: Record<string, string> = { authorization: `Bearer ${c.creds.apiToken}` };
      if (c.cfg.userEmail) h["x-as-user-email"] = c.cfg.userEmail;
      return h;
    }
  }
}

export interface FetchOut {
  data: any;
  headers: Headers;
}

export async function cFetch(c: Conn, r: Req, retried = false): Promise<FetchOut> {
  const headers: Record<string, string> = { accept: r.binary ? "*/*" : "application/json", ...(await authHeaders(c)) };
  let body: BodyInit | undefined;
  if (r.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(r.json);
  } else if (r.form) body = r.form;
  const res = await fetch(`${baseFor(c)}${r.path}`, { method: r.method ?? (body ? "POST" : "GET"), headers, body, signal: AbortSignal.timeout(r.binary || r.form ? 60_000 : 20_000) });
  if (res.status === 401 && !retried && c.row.auth_type === "oauth" && c.creds.refresh_token) {
    await refreshOAuth(c);
    return cFetch(c, r, true);
  }
  if (r.binary && res.ok) return { data: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data
        ? data.message ?? data.error?.message ?? data.error_description ?? (typeof data.error === "string" ? data.error : null) ?? JSON.stringify(data).slice(0, 200)
        : String(data ?? "").slice(0, 200) || res.headers.get("x-bamboohr-error-message") || "";
    throw new ConnectorError(`${c.provider} ${r.method ?? "GET"} ${r.path.split("?")[0]}: HTTP ${res.status} ${msg}`.trim(), res.status, res.status === 401 || res.status === 403);
  }
  return { data, headers: res.headers };
}
const get = async (c: Conn, path: string) => (await cFetch(c, { path })).data;

// ───────────────────────────── Utilidades de normalización ─────────────────────────────

const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Personas de un registro de CLM: pares xxxName / xxxEmail (counterpartySignerName + counterpartySignerEmail). */
export function peopleFromAttributes(attrs: Record<string, unknown>): CrmRecord["contacts"] {
  const out: CrmRecord["contacts"] = [];
  for (const [k, v] of Object.entries(attrs)) {
    const email = typeof v === "string" ? v.trim() : typeof v === "object" && v && "email" in (v as any) ? String((v as any).email) : "";
    if (!/email$/i.test(k) || !EMAIL.test(email)) continue;
    const prefix = k.replace(/email$/i, "");
    const nameVal = attrs[`${prefix}Name`] ?? attrs[`${prefix}name`] ?? (typeof v === "object" && v ? (v as any).name : null);
    out.push({ id: k, name: str(nameVal) ?? email, email, phone: null, role: prefix || null, primary: false });
  }
  // Primero la contraparte (es quien tiene que firmar), después el resto en el orden del registro.
  out.sort((a, b) => Number(/counterparty/i.test(b.role ?? "")) - Number(/counterparty/i.test(a.role ?? "")));
  if (out[0]) out[0].primary = true;
  return out;
}

const matches = (q: string, ...vals: unknown[]) => !q || vals.some((v) => String(v ?? "").toLowerCase().includes(q.toLowerCase()));

export interface SourceRecord extends CrmRecord {
  title: string;
}

export interface DeliverFile {
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

function fileForm(fields: Record<string, string>, fileField: string, f: DeliverFile) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append(fileField, new Blob([Buffer.from(f.bytes)], { type: f.contentType }), f.name);
  return form;
}

const ensurePdf = (bytes: Uint8Array, what: string) => {
  if (Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") throw new ConnectorError(`${what} no es un PDF (convertilo a PDF en el sistema de origen)`, 422);
  return bytes;
};

// ───────────────────────────── Operaciones por proveedor ─────────────────────────────

const BAMBOO_FIELDS = ["firstName", "lastName", "displayName", "workEmail", "homeEmail", "mobilePhone", "jobTitle", "department", "division", "location", "hireDate", "employeeNumber", "supervisorEId", "payRate"];

export async function testConnection(c: Conn): Promise<{ label: string | null }> {
  switch (c.provider) {
    case "bamboohr":
      await get(c, "/employees/directory");
      return { label: `${c.cfg.companyDomain}.bamboohr.com` };
    case "hibob": {
      await cFetch(c, { method: "POST", path: "/people/search", json: { fields: ["root.id"], showInactive: false } });
      return { label: `service user ${c.creds.serviceUserId}` };
    }
    case "factorial": {
      await get(c, "/employees/employees?limit=1");
      return { label: "Factorial" };
    }
    case "ironclad":
      await get(c, "/workflows?pageSize=1");
      return { label: `Ironclad ${c.cfg.region ?? "na1"}` };
    case "juro":
      await get(c, "/contracts?limit=1");
      return { label: "Juro" };
  }
}

/** Busca registros para elegir desde la UI (filtra por nombre/correo/título). */
export async function searchRecords(c: Conn, objectType: ConnectorObjectType, q: string): Promise<ConnectorRecordSummary[]> {
  const out: ConnectorRecordSummary[] = [];
  const push = (id: unknown, title: unknown, subtitle: unknown) => out.length < 25 && out.push({ id: String(id), title: String(title ?? id), subtitle: str(subtitle) });
  switch (c.provider) {
    case "bamboohr": {
      const d = await get(c, "/employees/directory");
      for (const e of d?.employees ?? []) if (matches(q, e.displayName, e.workEmail, e.id)) push(e.id, e.displayName ?? `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(), [e.jobTitle, e.workEmail].filter(Boolean).join(" · "));
      break;
    }
    case "hibob": {
      const d = (await cFetch(c, { method: "POST", path: "/people/search", json: { fields: ["root.id", "root.displayName", "root.email", "work.title"], showInactive: false } })).data;
      for (const e of d?.employees ?? []) if (matches(q, e.displayName, e.email, e.id)) push(e.id, e.displayName, [e.work?.title, e.email].filter(Boolean).join(" · "));
      break;
    }
    case "factorial": {
      const d = await get(c, "/employees/employees");
      for (const e of d?.data ?? d ?? []) if (matches(q, e.full_name, e.email, e.id)) push(e.id, e.full_name ?? `${e.first_name ?? ""} ${e.last_name ?? ""}`.trim(), e.email);
      break;
    }
    case "ironclad": {
      if (objectType === "record") {
        const d = await get(c, "/records?pageSize=100");
        for (const r of d?.list ?? []) if (matches(q, r.name, r.id)) push(r.id, r.name, r.type);
      } else {
        const d = await get(c, "/workflows?pageSize=100&status=active");
        for (const w of d?.list ?? []) if (matches(q, w.title, w.id)) push(w.id, w.title, w.step ?? w.status);
      }
      break;
    }
    case "juro": {
      const d = await get(c, "/contracts?limit=100");
      for (const k of d?.contracts ?? d?.data ?? []) if (matches(q, k.name, k.id)) push(k.id, k.name, k.state ?? k.status);
      break;
    }
  }
  return out;
}

/** Lee el registro normalizado: propiedades (para prellenar) y personas (destinatarios). */
export async function fetchRecord(c: Conn, objectType: ConnectorObjectType, id: string, extra: string[] = []): Promise<SourceRecord> {
  const enc = encodeURIComponent(id);
  switch (c.provider) {
    case "bamboohr": {
      const fields = [...new Set([...BAMBOO_FIELDS, ...extra.filter((x) => /^[A-Za-z0-9_.-]+$/.test(x))])].join(",");
      const e = await get(c, `/employees/${enc}?fields=${encodeURIComponent(fields)}`);
      const name = str(e.displayName) ?? [e.firstName, e.lastName].filter(Boolean).join(" ").trim();
      const contacts: SourceRecord["contacts"] = [{ id: String(e.id ?? id), name: name || `Empleado ${id}`, email: str(e.workEmail ?? e.homeEmail), phone: str(e.mobilePhone), role: "employee", primary: true }];
      if (e.supervisorEId) {
        const s = await get(c, `/employees/${encodeURIComponent(String(e.supervisorEId))}?fields=displayName,firstName,lastName,workEmail,mobilePhone`).catch(() => null);
        if (s) contacts.push({ id: String(e.supervisorEId), name: str(s.displayName) ?? [s.firstName, s.lastName].filter(Boolean).join(" "), email: str(s.workEmail), phone: str(s.mobilePhone), role: "manager", primary: false });
      }
      return { id: String(e.id ?? id), objectType, title: name, properties: { ...e, name }, contacts };
    }
    case "hibob": {
      const e = await get(c, `/people/${enc}?humanReadable=replace`);
      const name = str(e.displayName) ?? [e.firstName, e.surname].filter(Boolean).join(" ");
      const contacts: SourceRecord["contacts"] = [{ id: String(e.id ?? id), name: name ?? `Empleado ${id}`, email: str(e.email), phone: str(e.home?.mobilePhone ?? e.work?.mobilePhone), role: "employee", primary: true }];
      const mgr = e.work?.reportsTo;
      if (mgr && typeof mgr === "object" && mgr.email) contacts.push({ id: String(mgr.id ?? "manager"), name: str(mgr.displayName) ?? mgr.email, email: str(mgr.email), phone: null, role: "manager", primary: false });
      return { id: String(e.id ?? id), objectType, title: name ?? id, properties: { ...e, name }, contacts };
    }
    case "factorial": {
      const raw = await get(c, `/employees/employees/${enc}`);
      const e = raw?.data ?? raw;
      const name = str(e.full_name) ?? [e.first_name, e.last_name].filter(Boolean).join(" ");
      const contacts: SourceRecord["contacts"] = [{ id: String(e.id ?? id), name: name ?? `Empleado ${id}`, email: str(e.email ?? e.login_email), phone: str(e.phone_number), role: "employee", primary: true }];
      if (e.manager_id) {
        const m = await get(c, `/employees/employees/${encodeURIComponent(String(e.manager_id))}`).catch(() => null);
        const mm = m?.data ?? m;
        if (mm) contacts.push({ id: String(e.manager_id), name: str(mm.full_name) ?? `${mm.first_name ?? ""} ${mm.last_name ?? ""}`.trim(), email: str(mm.email ?? mm.login_email), phone: str(mm.phone_number), role: "manager", primary: false });
      }
      return { id: String(e.id ?? id), objectType, title: name ?? id, properties: { ...e, name }, contacts };
    }
    case "ironclad": {
      if (objectType === "record") {
        const r = await get(c, `/records/${enc}`);
        const props: Record<string, unknown> = { name: r.name, type: r.type };
        for (const [k, v] of Object.entries<any>(r.properties ?? {})) props[k] = v && typeof v === "object" && "value" in v ? v.value : v;
        return { id: String(r.id ?? id), objectType, title: String(r.name ?? id), properties: props, contacts: peopleFromAttributes(props) };
      }
      const w = await get(c, `/workflows/${enc}`);
      const attrs = w.attributes ?? {};
      return { id: String(w.id ?? id), objectType, title: String(w.title ?? id), properties: { ...attrs, title: w.title, status: w.status, step: w.step, template: w.template }, contacts: peopleFromAttributes(attrs) };
    }
    case "juro": {
      const raw = await get(c, `/contracts/${enc}`);
      const k = raw?.contract ?? raw;
      const props: Record<string, unknown> = { name: k.name, state: k.state ?? k.status };
      for (const f of k.fields ?? []) if (f?.title) props[String(f.title)] = f.value;
      const contacts: SourceRecord["contacts"] = [];
      for (const side of k.signingSides ?? []) {
        for (const s of side.signatories ?? []) {
          if (!s?.email) continue;
          contacts.push({ id: String(s.id ?? s.email), name: str(s.name) ?? s.email, email: s.email, phone: null, role: str(side.name ?? side.uid), primary: contacts.length === 0 });
        }
      }
      return { id: String(k.id ?? id), objectType, title: String(k.name ?? id), properties: props, contacts };
    }
  }
}

/** Documento del registro (el contrato a firmar) para los flujos con documentSource = record. */
export async function fetchDocument(c: Conn, objectType: ConnectorObjectType, id: string, rec: SourceRecord): Promise<DeliverFile> {
  const enc = encodeURIComponent(id);
  if (c.provider === "ironclad" && objectType === "workflow") {
    const attrs = rec.properties as any;
    const doc = (Array.isArray(attrs.draft) ? attrs.draft : Array.isArray(attrs.documents) ? attrs.documents : [])[0];
    if (!doc?.key) throw new ConnectorError("el workflow no tiene un documento en borrador", 422);
    const bytes = (await cFetch(c, { path: `/workflows/${enc}/document/${encodeURIComponent(String(doc.key))}/download`, binary: true })).data as Uint8Array;
    return { name: String(doc.filename ?? doc.name ?? `${rec.title}.pdf`), bytes: ensurePdf(bytes, "el documento del workflow"), contentType: "application/pdf" };
  }
  if (c.provider === "juro") {
    const bytes = (await cFetch(c, { path: `/contracts/${enc}/pdf/binary`, binary: true })).data as Uint8Array;
    return { name: `${rec.title}.pdf`, bytes: ensurePdf(bytes, "el contrato de Juro"), contentType: "application/pdf" };
  }
  throw new ConnectorError(`${c.provider} (${objectType}) no tiene documento de origen: usá los documentos de la plantilla`, 422);
}

/** ¿El proveedor acepta archivos que no son PDF (el certificado de evidencia JSON) en el registro? */
export const acceptsEvidenceFile = (p: ConnectorProvider, objectType: ConnectorObjectType) => ["bamboohr", "hibob", "factorial"].includes(p) || (p === "ironclad" && objectType === "record");

/** Sube un archivo al registro de origen. Devuelve una referencia remota. */
export async function deliverFile(c: Conn, objectType: ConnectorObjectType, id: string, f: DeliverFile, folder: string | null | undefined, kind: "signed" | "evidence"): Promise<string> {
  const enc = encodeURIComponent(id);
  switch (c.provider) {
    case "bamboohr": {
      let category = folder ?? c.cfg.defaultCategory ?? null;
      if (!category) {
        // La API exige una categoría (sección de archivos del legajo): sin una configurada, la primera del legajo.
        const v = await get(c, `/employees/${enc}/files/view`);
        category = v?.categories?.[0]?.id ?? null;
        if (!category) throw new ConnectorError("BambooHR no informó categorías de archivos: indicá la categoría en el flujo", 422);
      }
      const out = await cFetch(c, { method: "POST", path: `/employees/${enc}/files`, form: fileForm({ fileName: f.name, category: String(category), share: "no" }, "file", f) });
      return out.headers.get("location") ?? `bamboohr:employee:${id}:${f.name}`;
    }
    case "hibob": {
      const area = folder === "shared" ? "shared" : "confidential";
      const out = await cFetch(c, { method: "POST", path: `/docs/people/${enc}/${area}/upload`, form: fileForm({}, "file", f) });
      return `hibob:${area}:${out.data?.id ?? f.name}`;
    }
    case "factorial": {
      const fields: Record<string, string> = { employee_id: id, name: f.name };
      if (folder) fields.folder_id = folder;
      const out = await cFetch(c, { method: "POST", path: `/documents/documents`, form: fileForm(fields, "file", f) });
      return `factorial:document:${out.data?.data?.id ?? out.data?.id ?? f.name}`;
    }
    case "ironclad": {
      if (objectType === "workflow") {
        if (kind !== "signed") throw new ConnectorError("Ironclad solo recibe el documento firmado en el workflow", 422);
        // Sin metadata (signerRoleNames) Ironclad lo toma como totalmente firmado y completa el paso de firma.
        const out = await cFetch(c, { method: "POST", path: `/workflows/${enc}/upload-signed`, form: fileForm({}, "attachment", f) });
        return `ironclad:workflow:${id}:${out.data?.key ?? "signed"}`;
      }
      const key = kind === "evidence" ? "calasignEvidence" : folder || "signedCopy";
      const form = fileForm({ metadata: JSON.stringify({ filename: f.name }) }, "attachment", f);
      await cFetch(c, { method: "POST", path: `/records/${enc}/attachments/${encodeURIComponent(key)}`, form });
      return `ironclad:record:${id}:${key}`;
    }
    case "juro": {
      // Juro no recibe un PDF firmado por terceros en el contrato original: se sube como contrato nuevo (copia firmada).
      const out = await cFetch(c, { method: "POST", path: `/contracts/upload`, form: fileForm({ name: f.name.replace(/\.pdf$/i, "") }, "file", f) });
      return `juro:contract:${out.data?.contract?.id ?? out.data?.id ?? f.name}`;
    }
  }
}

/** ¿Se puede escribir el estado en un campo del registro? */
export const supportsStatus = (p: ConnectorProvider, objectType: ConnectorObjectType) => p === "bamboohr" || (p === "ironclad" && objectType === "record");

export async function writeStatus(c: Conn, objectType: ConnectorObjectType, id: string, property: string, value: string) {
  const enc = encodeURIComponent(id);
  if (c.provider === "bamboohr") return cFetch(c, { method: "POST", path: `/employees/${enc}`, json: { [property]: value } });
  if (c.provider === "ironclad" && objectType === "record") return cFetch(c, { method: "PATCH", path: `/records/${enc}`, json: { properties: { [property]: { type: "string", value } } } });
  throw new ConnectorError(`${c.provider} (${objectType}) no admite escribir el estado`);
}

// ───────────────────────────── Webhooks entrantes ─────────────────────────────

export interface InboundEvent {
  recordId: string;
  event: string | null;
  objectType: ConnectorObjectType | null;
}

/** Extrae los registros que dispara un webhook del proveedor (o uno genérico: {recordId, event}). */
export function parseWebhook(p: ConnectorProvider, body: any): InboundEvent[] {
  if (!body || typeof body !== "object") return [];
  const out: InboundEvent[] = [];
  const add = (id: unknown, event: unknown, objectType: ConnectorObjectType | null = null) => {
    if (id === undefined || id === null || id === "") return;
    out.push({ recordId: String(id).slice(0, 200), event: str(event), objectType });
  };
  if (body.recordId !== undefined) add(body.recordId, body.event, null);
  else if (p === "bamboohr" && Array.isArray(body.employees)) for (const e of body.employees.slice(0, 100)) add(e?.id, e?.action, "employee");
  else if (p === "hibob") add(body.employee?.id ?? body.data?.employeeId ?? body.employeeId, body.type, "employee");
  else if (p === "factorial") add(body.data?.employee_id ?? body.data?.id ?? body.employee_id ?? body.id, body.event ?? body.type, "employee");
  else if (p === "ironclad") {
    const pl = body.payload ?? body;
    if (pl.recordId ?? pl.recordID) add(pl.recordId ?? pl.recordID, body.event, "record");
    else add(pl.workflowID ?? pl.workflowId, body.event, "workflow");
  } else if (p === "juro") add(body.contract?.id ?? body.data?.contract?.id ?? body.contractId, body.event ?? body.type, "contract");
  return out;
}
