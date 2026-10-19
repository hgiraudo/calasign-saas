// RD Station CRM: cliente de la API v2 (https://api.rd.services/crm/v2) con OAuth 2.0 de la RD Station App Store.
// Separado de providers.ts para que cada CRM quede en su propio bloque; providers.ts solo despacha.
//
// Por qué la v2 y no la v1: la v1 (crm.rdstation.com/api/v1, ?token= del usuario en la URL) no tiene OAuth ni
// adjuntos; la v2 (2025-2026) tiene OAuth de la App Store, archivos (POST /deals/{id}/files) y anotações
// (POST /deals/{id}/notes), que es lo que hace falta para devolver el PDF firmado.
//
// Supuestos tomados de la documentación pública (developers.rdstation.com, ver docs/CRM.md):
//  · OAuth: authorize en accounts.rdstation.com/oauth/authorize (response_type=code, client_id, redirect_uri; se
//    manda state y RD lo devuelve), token en api.rd.services/oauth2/token (form: client_id, client_secret, code,
//    redirect_uri, grant_type). El access token dura 2 h; cada refresh devuelve un refresh token nuevo (se guarda).
//    No documenta PKCE: está apagado (RDSTATION_OAUTH_PKCE=true lo enciende si RD lo acepta).
//  · API v2: respuestas { data }, errores { errors: [{ detail }] }. Ids de 24 hex. GET /deals/{id} (contact_ids,
//    custom_fields = { slug: valor }), GET /contacts/{id} (emails [{ email }], phones [{ phone, type }]),
//    GET /custom_fields?filter=entity:deal (id, name, slug, type, options), PUT /deals/{id} { data: { custom_fields } },
//    POST /deals/{id}/files (multipart, campo data[file]) y POST /deals/{id}/notes { data: { description } }.
//  · Sin dominio por cuenta: la base es fija (RDSTATION_API_BASE solo para pruebas), así que no hay URL del
//    proveedor que validar contra SSRF.
import type { CrmObjectType, CrmRecord } from "@calasign/shared";
import { MappingError } from "./mapping";
import { CrmError, crmFetch, type AttachInput, type CrmConn } from "./providers";

/** Ids de RD Station CRM v2: 24 caracteres hexadecimales (ObjectId). */
export const RD_ID = /^[0-9a-f]{24}$/;
const MAX_CONTACTS = 20;

function assertDeal(t: CrmObjectType) {
  if (t !== "deal") throw new CrmError(`rdstation no admite registros de tipo ${t}`);
}

/** Id de negociação válido o 404 (un id con otra forma no existe en RD; así no se arma un path con cualquier cosa). */
function dealId(id: string): string {
  const v = String(id).trim().toLowerCase();
  if (!RD_ID.test(v)) throw new CrmError(`rdstation: la negociação ${String(id).slice(0, 40)} no existe (los ids son de 24 caracteres hex)`, 404);
  return v;
}

interface RdField {
  id: string;
  name: string;
  slug: string;
  type: string;
  options?: string[] | null;
}

/** Campos personalizados de las negociações (hasta 4 páginas de 100). */
async function loadDealFields(c: CrmConn): Promise<RdField[]> {
  const out: RdField[] = [];
  for (let page = 1; page <= 4; page++) {
    const r = await crmFetch(c, { path: `/custom_fields?filter=${encodeURIComponent("entity:deal")}&page%5Bnumber%5D=${page}&page%5Bsize%5D=100` });
    const list: RdField[] = Array.isArray(r?.data) ? r.data : [];
    out.push(...list);
    if (list.length < 100 || !r?.links?.next) break;
  }
  return out;
}

/** Campo por su slug o por su nombre visible. */
function findField(fields: RdField[], ref: string): RdField | undefined {
  const low = ref.trim().toLowerCase();
  return fields.find((f) => f.slug === ref) ?? fields.find((f) => String(f.name ?? "").trim().toLowerCase() === low);
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? null : String(v));

function toContact(x: any, primary: boolean): CrmRecord["contacts"][number] | null {
  if (!x || typeof x !== "object" || !x.id) return null;
  const email = str((Array.isArray(x.emails) ? x.emails : []).find((e: any) => e?.email)?.email);
  const phones: any[] = Array.isArray(x.phones) ? x.phones.filter((p: any) => p?.phone) : [];
  const phone = str((phones.find((p) => p.type === "mobile") ?? phones[0])?.phone);
  return { id: String(x.id), name: String(x.name ?? "").trim() || email || `Contato ${x.id}`, email, phone, role: str(x.job_title), primary };
}

/** Lee una negociação y sus contatos (el primero de contact_ids es el principal), con los campos personalizados
 *  por slug y, si el mapeo los pide por nombre, también por nombre. */
export async function rdstationFetchRecord(c: CrmConn, t: CrmObjectType, id: string, properties: string[]): Promise<CrmRecord> {
  assertDeal(t);
  const did = dealId(id);
  const deal = (await crmFetch(c, { path: `/deals/${did}` }))?.data;
  if (!deal || typeof deal !== "object") throw new CrmError(`rdstation: negociação ${did} no encontrada`, 404);
  const { custom_fields: custom, ...rest } = deal;
  const props: Record<string, unknown> = { ...rest };
  const cf: Record<string, unknown> = custom && typeof custom === "object" ? custom : {};
  for (const [slug, v] of Object.entries(cf)) props[slug] = Array.isArray(v) ? v.join(", ") : v;

  // Campos pedidos por nombre (no por slug): se resuelven con la lista de campos personalizados.
  const missing = properties.filter((p) => !Object.prototype.hasOwnProperty.call(props, p));
  if (missing.length && Object.keys(cf).length) {
    const fields = await loadDealFields(c);
    for (const p of missing) {
      const f = findField(fields, p);
      if (f && Object.prototype.hasOwnProperty.call(cf, f.slug)) props[p] = props[f.slug];
    }
  }

  const contacts: CrmRecord["contacts"] = [];
  const ids: string[] = (Array.isArray(deal.contact_ids) ? deal.contact_ids : []).map(String).filter((x: string) => RD_ID.test(x));
  for (const cid of [...new Set(ids)].slice(0, MAX_CONTACTS)) {
    try {
      const ct = toContact((await crmFetch(c, { path: `/contacts/${cid}` }))?.data, contacts.length === 0);
      if (ct) contacts.push(ct);
    } catch (err) {
      // Un contato borrado entre medio (404) no corta el envío: el mapeo dirá si falta un destinatario.
      if (!(err instanceof CrmError) || err.status !== 404) throw err;
    }
  }
  return { id: String(deal.id ?? did), objectType: t, title: str(deal.name), properties: props, contacts };
}

/** Escribe el estado en un campo personalizado de la negociação (por slug o por nombre). En los de opción, el valor
 *  tiene que ser una de las opciones del campo (RD guarda el texto de la opción). */
export async function rdstationWriteStatus(c: CrmConn, t: CrmObjectType, id: string, property: string, value: string) {
  assertDeal(t);
  const did = dealId(id);
  const fields = await loadDealFields(c);
  const f = findField(fields, property);
  if (!f) throw new MappingError("crm_status_field", `RD Station CRM no tiene un campo personalizado "${property}" en las negociações (usá el slug o el nombre)`);
  let v: string = value;
  if (Array.isArray(f.options) && f.options.length && (f.type === "option" || f.type === "multiple_choice")) {
    const opt = f.options.find((o) => String(o).trim().toLowerCase() === value.trim().toLowerCase());
    if (opt === undefined) throw new MappingError("crm_status_option", `El campo "${f.name}" de RD Station CRM no tiene la opción "${value}"`);
    v = String(opt);
  }
  return crmFetch(c, { method: "PUT", path: `/deals/${did}`, json: { data: { custom_fields: { [f.slug]: v } } } });
}

/** Texto de la anotação con el hash y el link al sobre. */
export const rdstationNote = (a: AttachInput) =>
  `CalaSign: «${a.subject}» firmado.\nSobre ${a.envelopeId}\nSHA-256 del PDF: ${a.sha256}\n${a.url}`;

/** Sube el PDF sellado a la negociação (Anexos) y deja una anotação con el hash y el link. */
export async function rdstationAttach(c: CrmConn, t: CrmObjectType, id: string, a: AttachInput): Promise<string> {
  assertDeal(t);
  const did = dealId(id);
  const form = new FormData();
  form.append("data[file]", new Blob([Buffer.from(a.pdf)], { type: "application/pdf" }), a.fileName);
  const file = await crmFetch(c, { method: "POST", path: `/deals/${did}/files`, form });
  const refs = [`file:${file?.data?.id ?? a.fileName}`];
  // La anotação es un extra: si falla, el PDF ya quedó en la negociação (reintentar lo subiría dos veces).
  try {
    const note = await crmFetch(c, { method: "POST", path: `/deals/${did}/notes`, json: { data: { description: rdstationNote(a) } } });
    if (note?.data?.id) refs.push(`note:${note.data.id}`);
  } catch {
    // no se relanza
  }
  return refs.join(" ");
}

/** Prueba de la conexión: lee un usuario de la cuenta (la v2 no tiene "yo" ni datos de la cuenta). */
export async function rdstationTest(c: CrmConn): Promise<{ label: string | null; config: Record<string, unknown> }> {
  const r = await crmFetch(c, { path: "/users?page%5Bsize%5D=1" });
  const u = Array.isArray(r?.data) ? r.data[0] : null;
  const domain = typeof u?.email === "string" && u.email.includes("@") ? u.email.split("@")[1] : null;
  return { label: domain ? `RD Station CRM · ${domain}` : "RD Station CRM", config: {} };
}
