// TOTVS Protheus (ERP líder de Brasil): cliente de la API REST estándar del Protheus de la organización.
// Separado de providers.ts para que cada proveedor quede en su propio bloque; providers.ts solo despacha.
//
// Qué hace (como Siigo y Alegra, es un ERP: no se envía desde un registro, recibe el resultado): al completarse un sobre
// busca el **Cliente** (tabla SA1) por el CPF/CNPJ de un firmante y le deja una **Anotação** con el asunto, el SHA-256
// del PDF sellado y el link al sobre.
//
// Por qué Protheus y estas APIs: de las líneas de TOTVS (Protheus, RM, Datasul, Winthor), Protheus es la del backoffice
// de la mayoría de los clientes y la que publica APIs REST estándar (las "APIs TOTVS", T-Talk) en el mismo servidor
// REST de la organización. Fluig (BPM/ECM) es otro producto y no tiene el cadastro de clientes.
//
// Supuestos tomados de la documentación pública (ver docs/CRM.md):
//  · Token: POST {base}/api/oauth2/v1/token?grant_type=password con el usuario y la contraseña en los encabezados
//    `username` y `password` (TDN, "API para obtenção do token de acesso às API's REST no Protheus", LIB 20190705+:
//    https://tdn.totvs.com/pages/releaseview.action?pageId=465383509). Responde { access_token, refresh_token,
//    token_type: "Bearer", expires_in: 3600 }. Los encabezados (y no la query) para que la contraseña no quede en los
//    logs de acceso del servidor de la organización ni de un proxy. El refresh_token NO se usa: TOTVS lo pide en la
//    query (?refresh_token=…, quedaría en esos logs) y vence a las 24 h; con la contraseña guardada (cifrada, como la
//    access key de Siigo) se pide un token nuevo al vencer o ante un 401.
//  · Llamadas con `Authorization: Bearer`. Encabezado opcional `tenantId: <grupo>[,<filial>]` para elegir la empresa
//    y filial (sin él, el REST usa la primera válida de su PrepareIn).
//  · Cliente: GET /api/crm/v1/customerVendor/Customer (API CustomerVendor, adaptador MATS030, Protheus 12.1.21+:
//    https://api.totvs.com.br — jsonschema/apis/CustomerVendor_v1_000.json del repo totvs/ttalk-standard-message).
//    Respuesta { items: [{ branchId, code, storeId, name, governmentalInformation: [{ name: "CNPJ"|"CPF", id }] }],
//    hasNext }. El filtro es el "filtro simple" del Guia de implementação das APIs TOTVS (propriedade_pai.filho=valor:
//    https://tdn.totvs.com/display/public/INT/Guia+de+implementacao+das+APIs+TOTVS): `governmentalInformation.id=`.
//    Como no todas las versiones lo implementan, el documento se vuelve a comparar acá contra cada resultado: si el
//    servidor ignora el filtro y devuelve cualquier cliente, no se vincula el que no es.
//  · Anotação: POST /api/crm/v1/notes (API Notes, adaptador CRMA100, Protheus 12.1.21+: Notes_v1_000.json) con
//    { ResourceType: "SA1", ResourceCode: filial+código+loja (AOB_CHAVE), Description (AOB_TITULO, 250),
//    Content (AOB_CONTEU, 250), Date }.
//  · Por qué no se sube el PDF: la API de Documents (banco de conhecimento, /api/crm/v1/documents, CRMS120) solo
//    registra el nombre del archivo (ACB_OBJETO) y no recibe su contenido (el archivo tiene que estar en el directorio
//    MV_DIRDOC del servidor). Queda la anotação con el hash y el link, como el comentario de Siigo.
//  · Errores: { code, message, detailedMessage } (Guia, "Mensagens de erro").
//
// La URL base la carga la organización (on-premise o TOTVS Cloud, con puerto propio): se valida al conectar y en cada
// uso, y todas las llamadas van por safeRequest (sin destinos internos, validados en la misma resolución DNS que usa la
// conexión, sin seguir redirecciones y con tope de tamaño), como los webhooks.
import { isIP } from "node:net";
import type { CrmObjectType } from "@calasign/shared";
import { config } from "../../config";
import { MAX_API_RESPONSE_BYTES } from "../../lib/http-body";
import { isPrivateAddress, safeRequest } from "../webhooks";
import { CrmError, crmFetch, type AttachInput, type CrmConn } from "./providers";

export interface TotvsCreds {
  username: string;
  password: string;
  access_token?: string;
  expires_at?: number;
}

const isLocalEnv = () => config.environment === "local";

/** Rutas de las APIs estándar sobre la base (la base ya incluye el contexto del REST, p. ej. /rest). */
export const TOTVS_PATHS = {
  token: "/api/oauth2/v1/token",
  customers: "/api/crm/v1/customerVendor/Customer",
  notes: "/api/crm/v1/notes",
};

/**
 * Valida la URL del REST que carga la organización y la devuelve normalizada (origen + ruta, sin barra final). Solo
 * https (http únicamente a localhost en el entorno local), sin credenciales, query ni fragmento, y sin IP internas
 * literales; un nombre que resuelve a una interna lo frena safeRequest al conectar.
 */
export function validateTotvsBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new CrmError("La URL del REST de TOTVS no es válida (ej. https://erp.empresa.com.br:8400/rest)");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local && isLocalEnv()))
    throw new CrmError("La URL del REST de TOTVS tiene que ser https");
  if (u.username || u.password) throw new CrmError("La URL del REST de TOTVS no puede llevar usuario ni contraseña: van en sus campos");
  if (u.search || u.hash) throw new CrmError("La URL del REST de TOTVS no puede llevar parámetros (?…) ni fragmento (#…)");
  if (!isLocalEnv() && (local || (isIP(host) !== 0 && isPrivateAddress(host))))
    throw new CrmError("La URL del REST de TOTVS no puede apuntar a una dirección interna");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

function totvsBase(c: CrmConn): string {
  if (!c.cfg.baseUrl) throw new CrmError("conexión de TOTVS sin la URL del REST");
  return validateTotvsBaseUrl(String(c.cfg.baseUrl));
}

/** Encabezado tenantId (grupo de empresas y filial) si la conexión lo tiene. */
export function totvsTenantHeader(c: CrmConn): Record<string, string> {
  const t = typeof c.cfg.tenantId === "string" ? c.cfg.tenantId.trim() : "";
  return t ? { tenantId: t } : {};
}

/**
 * fetch con la forma de la API web sobre safeRequest: crmFetch lo usa para TOTVS (la URL base la eligió el cliente).
 * Solo cuerpos de texto (las APIs de TOTVS que se usan son JSON).
 */
export async function totvsFetch(url: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") throw new CrmError("totvs: solo se envían cuerpos JSON");
  const r = await safeRequest(String(url), {
    method: init.method ?? "GET",
    headers: (init.headers ?? {}) as Record<string, string>,
    body: (init.body as string | null | undefined) ?? undefined,
    timeoutMs: 20_000,
    maxBytes: MAX_API_RESPONSE_BYTES,
    signal: init.signal ?? undefined,
  });
  if (r.status < 200 || r.status > 599) throw new CrmError(`totvs: respuesta HTTP ${r.status} inesperada`);
  // Solo el tipo de contenido: el resto de los encabezados no se usa y un valor raro haría fallar al constructor.
  const headers = r.headers["content-type"] ? { "content-type": r.headers["content-type"] } : undefined;
  return new Response([204, 205, 304].includes(r.status) ? null : new Uint8Array(r.body), { status: r.status, headers });
}

/** Un encabezado HTTP solo admite latin-1: un usuario o contraseña con otros caracteres no se puede mandar así. */
const headerSafe = (v: string) => !/[^\t\x20-\x7e\x80-\xff]/.test(v);

/** Pide un token nuevo con usuario y contraseña (grant_type=password) y lo guarda en la conexión. */
export async function totvsLogin(c: CrmConn): Promise<void> {
  const cr = c.creds as TotvsCreds;
  if (!headerSafe(cr.username ?? "") || !headerSafe(cr.password ?? ""))
    throw new CrmError("totvs: el usuario o la contraseña tienen caracteres que el REST no recibe en encabezados", 400, true);
  const res = await totvsFetch(`${totvsBase(c)}${TOTVS_PATHS.token}?grant_type=password`, {
    method: "POST",
    headers: { accept: "application/json", username: cr.username, password: cr.password, ...totvsTenantHeader(c) },
  });
  let b: Record<string, unknown> = {};
  try {
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object") b = parsed as Record<string, unknown>;
  } catch {
    // Cuerpo que no es JSON (p. ej. una página HTML de un proxy): se informa el HTTP.
  }
  const token = typeof b.access_token === "string" ? b.access_token : "";
  if (!res.ok || !token) {
    // Credenciales rechazadas (400/401/403) o una URL sin el endpoint de token (404: no es el REST del Protheus, o una
    // LIB anterior a 20190705): hay que corregir la conexión, no se reintenta solo. Un 5xx es transitorio.
    const rejected = res.ok || [400, 401, 403, 404].includes(res.status);
    const msg = String(b.message ?? b.error_description ?? b.error ?? "").slice(0, 200);
    throw new CrmError(`totvs ${TOTVS_PATHS.token}: HTTP ${res.status} ${msg}`.trim(), res.status, rejected);
  }
  // El access token del Protheus dura una hora (no se configura); expires_in manda si viene.
  const ttl = Number(b.expires_in) > 0 ? Number(b.expires_in) : 3600;
  c.creds = { ...cr, access_token: token, expires_at: Date.now() + ttl * 1000 };
  await c.persist();
}

/** CPF / CNPJ normalizado: sin puntuación y en mayúsculas (el CNPJ alfanumérico de 2026 tiene letras). */
export const normalizeTaxId = (v: unknown) =>
  String(v ?? "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");

/** Documentos federales (CPF/CNPJ) de un cliente de la respuesta de CustomerVendor. */
function customerTaxIds(item: Record<string, unknown>): string[] {
  const out: string[] = [];
  const list = Array.isArray(item.governmentalInformation) ? item.governmentalInformation : [];
  for (const g of list) {
    if (!g || typeof g !== "object") continue;
    const gi = g as Record<string, unknown>;
    // Solo CPF y CNPJ: la inscrição estadual o municipal es otro número (si no viene el nombre, se acepta).
    if (gi.name !== undefined && !/^(cpf|cnpj)/i.test(String(gi.name))) continue;
    const ids = gi.id ?? gi.Id;
    for (const v of Array.isArray(ids) ? ids : [ids]) {
      const n = normalizeTaxId(v);
      if (n) out.push(n);
    }
  }
  return out;
}

const KEY_SEP = "|";

/** Id del cliente en el vínculo: filial|código|loja, tal como los devuelve la API (la clave de SA1). */
export function totvsCustomerKey(item: Record<string, unknown>): string | null {
  const code = typeof item.code === "string" ? item.code : null;
  if (!code || !code.trim() || [code, item.branchId, item.storeId].some((v) => typeof v === "string" && v.includes(KEY_SEP))) return null;
  const branch = typeof item.branchId === "string" ? item.branchId : "";
  const store = typeof item.storeId === "string" ? item.storeId : "";
  return [branch, code, store].join(KEY_SEP);
}

/** Lee filial, código y loja de un id de vínculo ("filial|código|loja" o, cargado a mano, "código|loja"). */
export function parseTotvsCustomerKey(id: string): { branch: string; code: string; store: string } {
  const parts = String(id).split(KEY_SEP);
  const [branch, code, store] = parts.length >= 3 ? parts.slice(-3) : ["", parts[0] ?? "", parts[1] ?? ""];
  if (!code.trim() || /[\r\n]/.test(id))
    throw new CrmError(`totvs: el cliente ${String(id).slice(0, 60)} no existe (el id es filial|código|loja)`, 404);
  return { branch, code, store };
}

function assertCustomer(t: CrmObjectType) {
  if (t !== "customer") throw new CrmError(`totvs no admite registros de tipo ${t}`);
}

/** Busca el cliente (SA1) por CPF/CNPJ. Devuelve su id de vínculo o null. */
export async function totvsFindCustomer(c: CrmConn, t: CrmObjectType, identification: string): Promise<string | null> {
  assertCustomer(t);
  const doc = normalizeTaxId(identification);
  if (!doc) return null;
  let r: { items?: unknown } | null;
  try {
    r = await crmFetch(c, { path: `${TOTVS_PATHS.customers}?governmentalInformation.id=${encodeURIComponent(doc)}&page=1&pageSize=20` });
  } catch (err) {
    // Las APIs TOTVS responden 404 («Entidade não localizada») a una búsqueda sin resultados: es "no está", no un error
    // del ERP que haya que reintentar.
    if (err instanceof CrmError && err.status === 404) return null;
    throw err;
  }
  const items: unknown[] = Array.isArray(r?.items) ? r.items : [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const item = it as Record<string, unknown>;
    if (customerTaxIds(item).includes(doc)) return totvsCustomerKey(item);
  }
  return null;
}

/** Fecha de la anotação (AOB_DTNOTA) en el formato de fechas de las APIs TOTVS (yyyy-mm-dd). */
const today = () => new Date().toISOString().slice(0, 10);

/** Texto de la anotação: título con el asunto y contenido con el hash y el link (los dos campos son de 250). */
export function totvsNote(a: AttachInput): { Description: string; Content: string } {
  return {
    Description: `CalaSign: «${a.subject}» assinado`.slice(0, 250),
    Content: `SHA-256 do PDF: ${a.sha256}\n${a.url}\nEnvelope ${a.envelopeId}`.slice(0, 250),
  };
}

/** Deja la anotação con el hash y el link en el cliente. */
export async function totvsAttach(c: CrmConn, t: CrmObjectType, id: string, a: AttachInput): Promise<string> {
  assertCustomer(t);
  const k = parseTotvsCustomerKey(id);
  const note = await crmFetch(c, {
    method: "POST",
    path: TOTVS_PATHS.notes,
    json: { ResourceType: "SA1", ResourceCode: `${k.branch}${k.code}${k.store}`, ...totvsNote(a), Date: today() },
  });
  const ref = note?.Code ?? note?.InternalId ?? note?.items?.[0]?.Code ?? note?.items?.[0]?.InternalId;
  return `note:${ref ? String(ref).trim() : "SA1"}`;
}

/**
 * Prueba de la conexión: token (URL y credenciales) y una página de clientes. La API de anotações no se prueba: las
 * APIs TOTVS pueden responder 404 a una colección vacía y una organización sin anotações quedaría sin poder conectar.
 */
export async function totvsTest(c: CrmConn): Promise<{ label: string | null; config: Record<string, unknown> }> {
  await crmFetch(c, { path: `${TOTVS_PATHS.customers}?page=1&pageSize=1` });
  const u = new URL(totvsBase(c));
  const tenant = totvsTenantHeader(c).tenantId;
  return { label: `TOTVS Protheus · ${u.host}${tenant ? ` · ${tenant}` : ""}`, config: {} };
}
