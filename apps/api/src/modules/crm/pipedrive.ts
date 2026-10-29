// Pipedrive: cliente de la API v1 sobre el api_domain de la compañía (lo devuelve el token OAuth).
// Separado de providers.ts para que cada CRM quede en su propio bloque; providers.ts solo despacha.
//
// Supuestos tomados de la documentación pública de Pipedrive (ver docs/CRM.md):
//  · OAuth 2.0 en oauth.pipedrive.com: /oauth/authorize (sin scope: los scopes se eligen en el Developer Hub) y
//    /oauth/token con Basic client_id:client_secret. El token trae api_domain (https://<compañía>.pipedrive.com),
//    vence en ~1 h y se renueva con refresh_token.
//  · API v1: respuestas { success, data }. GET /deals/{id} (person_id / org_id / user_id como objetos con value = id),
//    GET /deals/{id}/participants, GET /persons/{id}, GET /dealFields y /personFields (key hash de 40 caracteres de los
//    campos personalizados; los de opción única/múltiple guardan el id de la opción), PUT /deals/{id} y /persons/{id},
//    POST /files (multipart con deal_id o person_id) y POST /notes (content HTML).
import type { CrmObjectType, CrmRecord } from "@calasign/shared";
import { config } from "../../config";
import { MappingError } from "./mapping";
import { CrmError, crmFetch, type AttachInput, type CrmConn } from "./providers";

/** Valida el api_domain que devuelve Pipedrive (es la única URL que viene del proveedor). */
export function validatePipedriveDomain(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CrmError(`api_domain inválido: ${String(raw).slice(0, 100)}`);
  }
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  if (local && config.environment === "local") return u.origin;
  if (u.protocol !== "https:" || !/^[a-z0-9-]+\.pipedrive\.com$/i.test(u.hostname)) throw new CrmError(`api_domain inesperado: ${u.hostname}`);
  return u.origin;
}

const HASH_KEY = /^[0-9a-f]{40}$/i;
const objPath = (t: CrmObjectType) => (t === "deal" ? "deals" : "persons");
const fieldsPath = (t: CrmObjectType) => (t === "deal" ? "dealFields" : "personFields");

function assertObject(t: CrmObjectType) {
  if (t !== "deal" && t !== "contact") throw new CrmError(`pipedrive no admite registros de tipo ${t}`);
}

interface PdField {
  key: string;
  name: string;
  field_type: string;
  options?: { id: number | string; label: string }[] | null;
}

async function loadFields(c: CrmConn, t: CrmObjectType): Promise<PdField[]> {
  const r = await crmFetch(c, { path: `/api/v1/${fieldsPath(t)}?limit=500` });
  return Array.isArray(r?.data) ? r.data : [];
}

/** Campo por su key (hash de 40 caracteres en los personalizados) o por su nombre visible. */
function findField(fields: PdField[], ref: string): PdField | undefined {
  const low = ref.trim().toLowerCase();
  return (
    fields.find((f) => f.key === ref) ??
    fields.find(
      (f) =>
        String(f.name ?? "")
          .trim()
          .toLowerCase() === low,
    )
  );
}

const isOptions = (f: PdField) => (f.field_type === "enum" || f.field_type === "set") && Array.isArray(f.options);

/** Id(s) de opción → etiqueta(s), para que el prellenado muestre "Plan Pro" y no "37". */
function optionLabels(f: PdField, v: unknown): unknown {
  if (v === null || v === undefined || v === "") return v;
  const ids = String(v)
    .split(",")
    .map((x) => x.trim());
  const labels = ids.map((id) => f.options!.find((o) => String(o.id) === id)?.label ?? id);
  return labels.join(", ");
}

const firstValue = (list: unknown): string | null => {
  if (typeof list === "string") return list || null;
  if (!Array.isArray(list) || list.length === 0) return null;
  const p = list.find((x: any) => x?.primary) ?? list[0];
  const v = typeof p === "object" && p ? (p as any).value : p;
  return v === undefined || v === null || v === "" ? null : String(v);
};

/** Contacto normalizado desde una persona de Pipedrive (objeto completo o el person_id expandido de un deal). */
function toContact(p: any, primary: boolean): CrmRecord["contacts"][number] | null {
  if (!p || typeof p !== "object") return null;
  const id = p.value ?? p.id;
  if (id === undefined || id === null) return null;
  const email = firstValue(p.email);
  return { id: String(id), name: String(p.name ?? "").trim() || email || `Persona ${id}`, email, phone: firstValue(p.phone), role: null, primary };
}

/** Lee un Deal (persona principal + participantes) o una Person, con los campos personalizados que pide el mapeo. */
export async function pipedriveFetchRecord(c: CrmConn, t: CrmObjectType, id: string, properties: string[]): Promise<CrmRecord> {
  assertObject(t);
  const enc = encodeURIComponent(id);
  const data = (await crmFetch(c, { path: `/api/v1/${objPath(t)}/${enc}` }))?.data;
  if (!data || typeof data !== "object") throw new CrmError(`pipedrive: ${t} ${id} no encontrado`, 404);
  const props: Record<string, unknown> = { ...data };

  // Campos que pide el mapeo y no vienen con su key (se escribieron por nombre) o que son de opciones (id → etiqueta).
  const own = (k: string) => Object.prototype.hasOwnProperty.call(data, k);
  const wanted = properties.filter((p) => !own(p) || HASH_KEY.test(p));
  if (wanted.length) {
    const fields = await loadFields(c, t);
    for (const p of wanted) {
      const f = findField(fields, p);
      if (!f || !own(f.key)) continue;
      props[p] = isOptions(f) ? optionLabels(f, data[f.key]) : data[f.key];
    }
  }

  const contacts: CrmRecord["contacts"] = [];
  if (t === "contact") {
    const self = toContact(data, true);
    if (self) contacts.push(self);
    return { id: String(data.id ?? id), objectType: t, title: data.name ?? null, properties: props, contacts };
  }
  const main = toContact(typeof data.person_id === "object" ? data.person_id : null, true);
  if (main) contacts.push(main);
  const parts = await crmFetch(c, { path: `/api/v1/deals/${enc}/participants?limit=100` });
  const related = parts?.related_objects?.person ?? {};
  for (const x of Array.isArray(parts?.data) ? parts.data : []) {
    const pid = typeof x?.person_id === "object" && x.person_id ? x.person_id.value : (x?.person_id ?? x?.person?.id);
    if (pid === undefined || pid === null || contacts.some((k) => k.id === String(pid))) continue;
    const person = (typeof x.person_id === "object" && x.person_id) || x.person || related[String(pid)] || null;
    const ct = toContact(person ? { ...person, value: pid } : null, false);
    if (ct) contacts.push(ct);
  }
  return { id: String(data.id ?? id), objectType: t, title: data.title ?? null, properties: props, contacts };
}

/** Escribe el estado en un campo del Deal (o Person). Acepta la key o el nombre del campo; en los de opción única
 *  busca la opción con esa etiqueta (Pipedrive guarda el id de la opción). */
export async function pipedriveWriteStatus(c: CrmConn, t: CrmObjectType, id: string, property: string, value: string) {
  assertObject(t);
  const fields = await loadFields(c, t);
  const f = findField(fields, property);
  if (!f)
    throw new MappingError("crm_status_field", `Pipedrive no tiene un campo "${property}" en ${objPath(t)} (usá la key del campo personalizado)`);
  let v: string | number = value;
  if (isOptions(f)) {
    const opt = f.options!.find((o) => o.label.trim().toLowerCase() === value.trim().toLowerCase());
    if (!opt) throw new MappingError("crm_status_option", `El campo "${f.name}" de Pipedrive no tiene la opción "${value}"`);
    v = typeof opt.id === "number" ? opt.id : String(opt.id);
  }
  return crmFetch(c, { method: "PUT", path: `/api/v1/${objPath(t)}/${encodeURIComponent(id)}`, json: { [f.key]: v } });
}

const html = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Sube el PDF sellado al Deal (o Person) con la Files API y deja una nota con el hash y el link. */
export async function pipedriveAttach(c: CrmConn, t: CrmObjectType, id: string, a: AttachInput): Promise<string> {
  assertObject(t);
  const idField = t === "deal" ? "deal_id" : "person_id";
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(a.pdf)], { type: "application/pdf" }), a.fileName);
  form.append(idField, String(id));
  const file = await crmFetch(c, { method: "POST", path: "/api/v1/files", form });
  const content =
    `<p><b>CalaSign</b>: «${html(a.subject)}» firmado.</p>` +
    `<p>Sobre ${html(a.envelopeId)}<br>SHA-256 del PDF: <code>${html(a.sha256)}</code><br>` +
    `<a href="${html(a.url)}">${html(a.url)}</a></p>`;
  // La nota es un extra: si falla, el PDF ya quedó en el registro (relanzar reintentaría el trabajo y lo subiría dos
  // veces), como en Zoho, RD Station y Kommo.
  const note = await crmFetch(c, {
    method: "POST",
    path: "/api/v1/notes",
    json: { content, [idField]: Number.isFinite(Number(id)) ? Number(id) : id },
  }).catch(() => null);
  return `file:${file?.data?.id ?? "?"} note:${note?.data?.id ?? "?"}`;
}

/** Prueba de la conexión: el usuario del token y su compañía. */
export async function pipedriveTest(c: CrmConn): Promise<{ label: string | null; config: Record<string, unknown> }> {
  const me = (await crmFetch(c, { path: "/api/v1/users/me" }))?.data ?? {};
  const label = me.company_domain ? `${me.company_domain}.pipedrive.com` : (me.company_name ?? me.email ?? null);
  return { label, config: { companyId: me.company_id != null ? String(me.company_id) : null, companyDomain: me.company_domain ?? null } };
}
