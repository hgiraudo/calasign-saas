// Mapeo de un registro del CRM a los destinatarios y al prellenado de una plantilla. Puro: sin red ni base.
import type { CrmPrefillMapping, CrmRecord, CrmRoleMapping, CrmEnvelopeStatus, CrmWriteBack } from "@calasign/shared";

export class MappingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MappedRecipient {
  role: string;
  name: string;
  email: string | null;
  phone: string | null;
  channels: ("email" | "whatsapp" | "telegram")[];
}

/** Lee una propiedad con soporte de rutas con punto (Account.Name en Salesforce). */
export function readProperty(props: Record<string, unknown>, path: string): unknown {
  // Solo propiedades propias: con `in` o `cur[part]`, un nombre como "constructor" o "toString" devolvía la función
  // heredada de Object.prototype y se mapeaba su texto como nombre o valor.
  const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  if (own(props, path)) return props[path];
  let cur: any = props;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object" || !own(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

const text = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
};

const E164 = /^\+[1-9]\d{6,14}$/;
/** Normaliza un teléfono a E.164 si es posible; si no, null (el canal WhatsApp lo exige). */
export function normalizePhone(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const digits = s.replace(/[^\d+]/g, "");
  const withPlus = digits.startsWith("+") ? digits : digits.length >= 10 ? `+${digits}` : digits;
  return E164.test(withPlus) ? withPlus : null;
}

export function mapRecipients(record: Pick<CrmRecord, "id" | "properties" | "contacts">, roles: CrmRoleMapping[]): MappedRecipient[] {
  const out: MappedRecipient[] = [];
  for (const r of roles) {
    let name: string | null = null;
    let email: string | null = null;
    let phone: string | null = null;
    if (r.source === "fixed") {
      name = r.name;
      email = r.email ?? null;
      phone = r.phone ?? null;
    } else if (r.source === "property") {
      name = text(readProperty(record.properties, r.nameProperty));
      email = r.emailProperty ? text(readProperty(record.properties, r.emailProperty)) : null;
      phone = r.phoneProperty ? normalizePhone(readProperty(record.properties, r.phoneProperty)) : null;
    } else {
      let c: CrmRecord["contacts"][number] | undefined;
      if (r.source === "contact") c = record.contacts[r.index ?? 0];
      else if (r.primary) c = record.contacts.find((x) => x.primary);
      else if (r.contactRole) c = record.contacts.find((x) => (x.role ?? "").toLowerCase() === r.contactRole!.toLowerCase());
      if (!c) {
        const what = r.source === "contact" ? `el contacto #${(r.index ?? 0) + 1}` : r.primary ? "el contacto principal" : `un contacto con rol "${r.contactRole}"`;
        throw new MappingError("crm_contact_missing", `El registro ${record.id} no tiene ${what} para el rol "${r.role}"`);
      }
      name = c.name;
      email = c.email;
      phone = normalizePhone(c.phone);
    }
    if (!name) throw new MappingError("crm_name_missing", `Falta el nombre del destinatario para el rol "${r.role}"`);
    let channels = (r.channels ?? ["email"]).filter((ch) => (ch === "email" ? Boolean(email) : ch === "whatsapp" ? Boolean(phone) : ch === "telegram" ? false : false));
    if (channels.length === 0) {
      if (email) channels = ["email"];
      else if (phone) channels = ["whatsapp"];
      else throw new MappingError("crm_contact_unreachable", `"${name}" (rol "${r.role}") no tiene correo ni teléfono en el CRM`);
    }
    out.push({ role: r.role, name, email, phone, channels });
  }
  return out;
}

/** Valor de prellenado a partir de propiedades del registro. Se omiten las vacías. */
export function mapPrefill(record: Pick<CrmRecord, "properties">, prefill: CrmPrefillMapping[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of prefill) {
    const v = readProperty(record.properties, p.property);
    if (v === undefined || v === null || v === "") continue;
    out[p.field] = typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return out;
}

/** Propiedades del registro que hacen falta leer para el mapeo. */
export function neededProperties(roles: CrmRoleMapping[], prefill: CrmPrefillMapping[]): string[] {
  const s = new Set<string>();
  for (const r of roles) if (r.source === "property") [r.nameProperty, r.emailProperty, r.phoneProperty].forEach((x) => x && s.add(x.split(".")[0]));
  for (const p of prefill) s.add(p.property.split(".")[0]);
  return [...s];
}

/** Estado del sobre que se escribe en el CRM (o null si el evento no corresponde). */
export function statusForEvidence(type: string): CrmEnvelopeStatus | null {
  switch (type) {
    case "envelope.sent":
      return "sent";
    case "envelope.completed":
      return "completed";
    case "recipient.declined":
      return "declined";
    case "envelope.voided":
      return "voided";
    case "envelope.expired":
      return "expired";
    default:
      return null;
  }
}

export function statusValue(wb: Partial<CrmWriteBack> | null | undefined, status: CrmEnvelopeStatus): string {
  return wb?.statusValues?.[status] ?? status;
}

/** ¿El cambio de propiedad del webhook dispara este mapeo? */
export function webhookMatches(trigger: { property?: string | null; value?: string | null }, propertyName: string | null, propertyValue: string | null): boolean {
  if (!trigger.property) return false;
  if (trigger.property !== propertyName) return false;
  return !trigger.value || trigger.value === propertyValue;
}
