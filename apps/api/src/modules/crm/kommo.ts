// Kommo (ex amoCRM): cliente de la API v4 sobre el subdominio de la cuenta (https://<cuenta>.kommo.com).
// Separado de providers.ts para que cada CRM quede en su propio bloque; providers.ts solo despacha.
//
// Supuestos tomados de la documentación pública de Kommo (developers.kommo.com, ver docs/CRM.md):
//  · OAuth 2.0: authorize en www.kommo.com/oauth?client_id=…&state=…&mode=post_message; el callback trae code, state
//    y referer (el host de la cuenta, p. ej. acme.kommo.com). El token se pide AL SUBDOMINIO de la cuenta:
//    POST https://<cuenta>.kommo.com/oauth2/access_token con JSON { client_id, client_secret, grant_type, code |
//    refresh_token, redirect_uri }. Access token de 24 h; refresh token de 3 meses que rota con cada uso.
//    No documenta PKCE (no se usa).
//  · API v4 (HAL): GET /api/v4/leads/{id}?with=contacts (_embedded.contacts [{ id, is_main }]),
//    GET /api/v4/contacts?filter[id][]=… (custom_fields_values con field_code EMAIL / PHONE),
//    GET /api/v4/leads/custom_fields (id, name, code, type, enums [{ id, value }]),
//    PATCH /api/v4/leads/{id} { custom_fields_values: [{ field_id, values: [{ value } | { enum_id }] }] },
//    POST /api/v4/leads/notes [{ entity_id, note_type: "common", params: { text } }].
//  · Files API: GET /api/v4/account?with=drive_url → https://drive-<x>.kommo.com; POST {drive}/v1.0/sessions
//    { file_name, file_size, content_type } → { upload_url, max_part_size }; partes en crudo por POST a upload_url
//    (cada respuesta trae next_url; la última, uuid y version_uuid); PUT /api/v4/leads/{id}/files [{ file_uuid }].
//    Requiere el permiso «Access to files» de la integración: sin él, queda solo la nota con el link y el hash.
import type { CrmObjectType, CrmRecord } from "@calasign/shared";
import { config } from "../../config";
import { MappingError } from "./mapping";
import { CrmError, crmFetch, type AttachInput, type CrmConn } from "./providers";

const KOMMO_HOST = /^[a-z0-9][a-z0-9-]{0,62}\.(kommo|amocrm)\.com$/i;
const KOMMO_DRIVE_HOST = /^drive-[a-z0-9-]{1,30}\.(kommo|amocrm)\.com$/i;
const RESERVED = new Set(["www", "api", "drive", "oauth", "id", "accounts"]);

function parseUrl(raw: string, what: string): URL {
  const s = String(raw ?? "").trim();
  try {
    // El referer del callback llega sin esquema (acme.kommo.com).
    return new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new CrmError(`${what} de Kommo inválido: ${s.slice(0, 100)}`);
  }
}
const isLocalDev = (u: URL) => ["localhost", "127.0.0.1"].includes(u.hostname) && config.environment === "local";

/**
 * Valida el dominio de la cuenta (el referer del callback o el guardado en la conexión): ahí se manda el client
 * secret y el token, así que tiene que ser un subdominio de kommo.com (o amocrm.com de cuentas viejas), https y sin
 * puerto ni ruta. Devuelve el origen (https://acme.kommo.com).
 */
export function validateKommoDomain(raw: string): string {
  const u = parseUrl(raw, "dominio de la cuenta");
  if (isLocalDev(u)) return u.origin;
  const sub = u.hostname.split(".")[0]!.toLowerCase();
  if (
    u.protocol !== "https:" ||
    u.port ||
    u.username ||
    u.password ||
    !KOMMO_HOST.test(u.hostname) ||
    RESERVED.has(sub) ||
    sub.startsWith("drive-")
  ) {
    throw new CrmError(`dominio de Kommo inesperado: ${u.hostname}`);
  }
  return u.origin;
}

/** Valida el servidor de archivos (drive_url de la cuenta y las URLs de subida que devuelve). */
export function validateKommoDrive(raw: string): URL {
  const u = parseUrl(raw, "servidor de archivos");
  if (isLocalDev(u)) return u;
  if (u.protocol !== "https:" || u.port || u.username || u.password || !KOMMO_DRIVE_HOST.test(u.hostname))
    throw new CrmError(`servidor de archivos de Kommo inesperado: ${u.hostname}`);
  return u;
}

function assertLead(t: CrmObjectType) {
  if (t !== "deal") throw new CrmError(`kommo no admite registros de tipo ${t} (solo leads, objectType deal)`);
}

/** Id de lead numérico o 404. */
function leadId(id: string): string {
  const v = String(id).trim();
  if (!/^\d{1,18}$/.test(v)) throw new CrmError(`kommo: el lead ${v.slice(0, 40)} no existe`, 404);
  return v;
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));

interface KField {
  id: number;
  name: string;
  code?: string | null;
  type: string;
  enums?: { id: number; value: string }[] | null;
}

async function loadLeadFields(c: CrmConn): Promise<KField[]> {
  const out: KField[] = [];
  for (let page = 1; page <= 4; page++) {
    const r = await crmFetch(c, { path: `/api/v4/leads/custom_fields?limit=250&page=${page}` });
    const list: KField[] = Array.isArray(r?._embedded?.custom_fields) ? r._embedded.custom_fields : [];
    out.push(...list);
    if (list.length < 250 || !r?._links?.next) break;
  }
  return out;
}

/** Campo por id, por código (p. ej. CALASIGN_STATUS) o por nombre visible. */
function findField(fields: KField[], ref: string): KField | undefined {
  const r = ref.trim();
  const low = r.toLowerCase();
  return (
    fields.find((f) => String(f.id) === r) ??
    fields.find((f) => f.code && String(f.code).toLowerCase() === low) ??
    fields.find(
      (f) =>
        String(f.name ?? "")
          .trim()
          .toLowerCase() === low,
    )
  );
}

const ENUM_TYPES = new Set(["select", "radiobutton", "multiselect", "category"]);

/** Valores de un custom_fields_values como texto ("a, b"). */
const cfText = (x: any) =>
  (Array.isArray(x?.values) ? x.values : [])
    .map((v: any) => (v && typeof v === "object" ? (v.value ?? v.enum_code) : v))
    .filter((v: unknown) => v !== undefined && v !== null && v !== "")
    .join(", ");

function cfFirst(list: any, code: string, prefer?: string): string | null {
  const f = (Array.isArray(list) ? list : []).find((x: any) => String(x?.field_code ?? "").toUpperCase() === code);
  const values: any[] = Array.isArray(f?.values) ? f.values.filter((v: any) => v?.value) : [];
  const v = (prefer && values.find((x) => String(x.enum_code ?? "").toUpperCase() === prefer)) || values[0];
  return str(v?.value);
}

function toContact(x: any, primary: boolean): CrmRecord["contacts"][number] {
  const email = cfFirst(x.custom_fields_values, "EMAIL", "WORK");
  const name = String(x.name ?? "").trim() || [x.first_name, x.last_name].filter(Boolean).join(" ").trim() || email || `Contacto ${x.id}`;
  return { id: String(x.id), name, email, phone: cfFirst(x.custom_fields_values, "PHONE", "MOB"), role: null, primary };
}

/** Lee un lead y sus contactos (el principal primero), con los campos personalizados por nombre, código e id. */
export async function kommoFetchRecord(c: CrmConn, t: CrmObjectType, id: string, _properties: string[]): Promise<CrmRecord> {
  assertLead(t);
  const lid = leadId(id);
  // Kommo responde 204 (sin cuerpo) o 404 si el lead no existe.
  const lead = await crmFetch(c, { path: `/api/v4/leads/${lid}?with=contacts` });
  if (!lead || typeof lead !== "object" || !lead.id) throw new CrmError(`kommo: lead ${lid} no encontrado`, 404);
  const { _links, _embedded, custom_fields_values: cfv, ...rest } = lead;
  const props: Record<string, unknown> = { ...rest };
  for (const f of Array.isArray(cfv) ? cfv : []) {
    const v = cfText(f);
    if (f?.field_name) props[String(f.field_name)] = v;
    if (f?.field_code) props[String(f.field_code)] = v;
    if (f?.field_id !== undefined) props[String(f.field_id)] = v;
  }

  const refs: { id: string; main: boolean }[] = (Array.isArray(_embedded?.contacts) ? _embedded.contacts : [])
    .filter((x: any) => x && /^\d+$/.test(String(x.id)))
    .map((x: any) => ({ id: String(x.id), main: Boolean(x.is_main) }));
  refs.sort((a, b) => Number(b.main) - Number(a.main)); // estable: el principal primero, el resto en su orden
  const ids = [...new Set(refs.map((r) => r.id))].slice(0, 50);
  const contacts: CrmRecord["contacts"] = [];
  if (ids.length) {
    const q = ids.map((x) => `filter%5Bid%5D%5B%5D=${x}`).join("&");
    const r = await crmFetch(c, { path: `/api/v4/contacts?${q}&limit=50` });
    const byId = new Map<string, any>((Array.isArray(r?._embedded?.contacts) ? r._embedded.contacts : []).map((x: any) => [String(x.id), x]));
    for (const cid of ids) {
      const x = byId.get(cid);
      if (x) contacts.push(toContact(x, contacts.length === 0 && Boolean(refs.find((r) => r.id === cid)?.main)));
    }
    // Sin contacto marcado como principal, el primero hace de principal.
    if (contacts.length && !contacts.some((k) => k.primary)) contacts[0]!.primary = true;
  }
  return { id: String(lead.id), objectType: t, title: str(lead.name), properties: props, contacts };
}

/** Escribe el estado en un campo personalizado del lead (por id, código o nombre). En los de lista se busca la
 *  opción con ese texto y se escribe su enum_id. */
export async function kommoWriteStatus(c: CrmConn, t: CrmObjectType, id: string, property: string, value: string) {
  assertLead(t);
  const lid = leadId(id);
  const fields = await loadLeadFields(c);
  const f = findField(fields, property);
  if (!f)
    throw new MappingError("crm_status_field", `Kommo no tiene un campo "${property}" en los leads (usá el id, el código o el nombre del campo)`);
  let values: Record<string, unknown>[] = [{ value }];
  if (ENUM_TYPES.has(f.type)) {
    const opt = (f.enums ?? []).find((o) => String(o.value).trim().toLowerCase() === value.trim().toLowerCase());
    if (!opt) throw new MappingError("crm_status_option", `El campo "${f.name}" de Kommo no tiene la opción "${value}"`);
    values = [{ enum_id: opt.id }];
  }
  return crmFetch(c, { method: "PATCH", path: `/api/v4/leads/${lid}`, json: { custom_fields_values: [{ field_id: f.id, values }] } });
}

export const kommoNote = (a: AttachInput) => `CalaSign: «${a.subject}» firmado.\nSobre ${a.envelopeId}\nSHA-256 del PDF: ${a.sha256}\n${a.url}`;

/** Sube el PDF al drive de la cuenta (sesión + partes) y devuelve el uuid del archivo. */
async function uploadToDrive(c: CrmConn, a: AttachInput): Promise<string> {
  const acc = await crmFetch(c, { path: "/api/v4/account?with=drive_url" });
  if (!acc?.drive_url) throw new CrmError("kommo: la cuenta no informó drive_url", 404);
  const drive = validateKommoDrive(String(acc.drive_url));
  const pdf = Buffer.from(a.pdf);
  const session = await crmFetch(c, {
    method: "POST",
    base: drive.origin,
    path: "/v1.0/sessions",
    json: { file_name: a.fileName, file_size: pdf.length, content_type: "application/pdf" },
  });
  const part = Math.max(64 * 1024, Math.min(Number(session?.max_part_size) || 512 * 1024, 16 * 1024 * 1024));
  let next = session?.upload_url ? String(session.upload_url) : null;
  for (let off = 0, i = 0; next && i < 400; off += part, i++) {
    const u = validateKommoDrive(next);
    // Las URLs de subida son del mismo servidor de archivos (no se sigue una URL a otro host).
    if (u.origin !== drive.origin) throw new CrmError(`kommo: URL de subida fuera del servidor de archivos (${u.hostname})`);
    const r = await crmFetch(c, {
      method: "POST",
      base: u.origin,
      path: `${u.pathname}${u.search}`,
      raw: pdf.subarray(off, off + part),
      headers: { "content-type": "application/octet-stream" },
    });
    if (r?.uuid) return String(r.uuid);
    next = r?.next_url ? String(r.next_url) : null;
    if (off + part >= pdf.length && !next) break;
  }
  throw new CrmError("kommo: la subida del archivo no terminó (sin uuid)");
}

/** Adjunta el PDF sellado al lead (Files API) y deja una nota con el hash y el link. Si la integración no tiene el
 *  permiso de archivos (403) o la cuenta no tiene drive, queda solo la nota. */
export async function kommoAttach(c: CrmConn, t: CrmObjectType, id: string, a: AttachInput): Promise<string> {
  assertLead(t);
  const lid = leadId(id);
  const refs: string[] = [];
  let fileUuid: string | null = null;
  try {
    fileUuid = await uploadToDrive(c, a);
  } catch (err) {
    // Sin «Access to files» (403) o sin drive (404): sigue con la nota. Otros errores (5xx, red) se reintentan.
    if (!(err instanceof CrmError) || ![403, 404].includes(err.status ?? 0)) throw err;
    refs.push("file:skipped");
  }
  if (fileUuid) {
    await crmFetch(c, { method: "PUT", path: `/api/v4/leads/${lid}/files`, json: [{ file_uuid: fileUuid }] });
    refs.push(`file:${fileUuid}`);
  }
  try {
    const note = await crmFetch(c, {
      method: "POST",
      path: "/api/v4/leads/notes",
      json: [{ entity_id: Number(lid), note_type: "common", params: { text: kommoNote(a) } }],
    });
    refs.push(`note:${note?._embedded?.notes?.[0]?.id ?? "?"}`);
  } catch (err) {
    // Con el PDF ya adjunto, la nota es un extra (reintentar subiría el PDF dos veces). Sin PDF, la nota es todo lo
    // que vuelve al lead: el error se relanza y el trabajo se reintenta.
    if (!fileUuid) throw err;
  }
  return refs.join(" ");
}

/** Prueba de la conexión: la cuenta (nombre y subdominio). */
export async function kommoTest(c: CrmConn): Promise<{ label: string | null; config: Record<string, unknown> }> {
  const acc = (await crmFetch(c, { path: "/api/v4/account" })) ?? {};
  const host = c.cfg.baseDomain ? new URL(String(c.cfg.baseDomain)).host : null;
  // Cuentas viejas de amoCRM conservan su host (<cuenta>.amocrm.com).
  const label = acc.subdomain ? (host?.endsWith(".amocrm.com") ? host : `${acc.subdomain}.kommo.com`) : (host ?? acc.name ?? null);
  return { label, config: { accountId: acc.id != null ? String(acc.id) : null } };
}
