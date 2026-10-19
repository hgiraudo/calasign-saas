import { describe, expect, it } from "vitest";
import type { CrmRecord } from "@calasign/shared";
import { CreateCrmMappingInput } from "@calasign/shared";
import { MappingError, mapPrefill, mapRecipients, neededProperties, normalizePhone, readProperty, scalarValue, statusForEvidence, statusValue, webhookMatches } from "../src/modules/crm/mapping";

const deal: CrmRecord = {
  id: "9001",
  objectType: "deal",
  properties: { dealname: "Renovación 2027", amount: "1500.50", closedate: "2026-12-31", owner_email: "ventas@acme.co", Account: { Name: "ACME S.A.S." } },
  contacts: [
    { id: "1", name: "Ana Pérez", email: "ana@cliente.co", phone: "+57 300 123 4567", role: null, primary: true },
    { id: "2", name: "Luis Gómez", email: null, phone: "3001234567", role: "Garante", primary: false },
  ],
};

describe("mapeo CRM → plantilla", () => {
  it("destinatarios por índice, rol, propiedad y fijos", () => {
    const roles = CreateCrmMappingInput.parse({
      connectionId: "0192f0e0-0000-7000-8000-000000000001",
      name: "x",
      objectType: "deal",
      roles: [
        { role: "Cliente", source: "contact", index: 0 },
        { role: "Garante", source: "contact_role", contactRole: "garante", channels: ["whatsapp", "email"] },
        { role: "Vendedor", source: "property", nameProperty: "Account.Name", emailProperty: "owner_email" },
        { role: "Apoderado", source: "fixed", name: "Firma Interna", email: "legal@acme.co" },
      ],
    }).roles;
    const out = mapRecipients(deal, roles);
    expect(out[0]).toMatchObject({ role: "Cliente", name: "Ana Pérez", email: "ana@cliente.co", phone: "+573001234567", channels: ["email"] });
    // El garante no tiene correo: queda solo WhatsApp.
    expect(out[1]).toMatchObject({ role: "Garante", name: "Luis Gómez", email: null, phone: "+3001234567", channels: ["whatsapp"] });
    expect(out[2]).toMatchObject({ name: "ACME S.A.S.", email: "ventas@acme.co" });
    expect(out[3]).toMatchObject({ name: "Firma Interna", email: "legal@acme.co", channels: ["email"] });
  });

  it("errores claros cuando falta un contacto o no hay cómo contactarlo", () => {
    expect(() => mapRecipients(deal, [{ role: "Otro", source: "contact", index: 5, channels: ["email"] }])).toThrow(MappingError);
    expect(() => mapRecipients(deal, [{ role: "Otro", source: "contact_role", contactRole: "Firmante", channels: ["email"] }])).toThrow(/rol "Firmante"/);
    const sinDatos: CrmRecord = { ...deal, contacts: [{ id: "3", name: "X", email: null, phone: null, role: null, primary: false }] };
    expect(() => mapRecipients(sinDatos, [{ role: "C", source: "contact", index: 0, channels: ["email"] }])).toThrow(/no tiene correo ni teléfono/);
  });

  it("prellenado desde propiedades, con rutas y omitiendo vacíos", () => {
    expect(mapPrefill(deal, [
      { field: "Monto", property: "amount" },
      { field: "Empresa", property: "Account.Name" },
      { field: "Vacío", property: "noexiste" },
    ])).toEqual({ Monto: "1500.50", Empresa: "ACME S.A.S." });
    expect(neededProperties([{ role: "V", source: "property", nameProperty: "Account.Name", emailProperty: "owner_email", channels: ["email"] }], [{ field: "M", property: "amount" }]).sort()).toEqual(["Account", "amount", "owner_email"]);
    expect(readProperty(deal.properties, "Account.Name")).toBe("ACME S.A.S.");
  });

  it("teléfonos, estados y disparadores", () => {
    expect(normalizePhone("+57 (300) 123-4567")).toBe("+573001234567");
    expect(normalizePhone("123")).toBeNull();
    expect(statusForEvidence("envelope.completed")).toBe("completed");
    expect(statusForEvidence("recipient.declined")).toBe("declined");
    expect(statusForEvidence("recipient.viewed")).toBeNull();
    expect(statusValue({ statusValues: { completed: "Firmado" } }, "completed")).toBe("Firmado");
    expect(statusValue({}, "sent")).toBe("sent");
    expect(webhookMatches({ property: "dealstage", value: "contractsent" }, "dealstage", "contractsent")).toBe(true);
    expect(webhookMatches({ property: "dealstage", value: "contractsent" }, "dealstage", "closedwon")).toBe(false);
    expect(webhookMatches({ property: null }, "dealstage", "x")).toBe(false);
  });

  it("email y teléfono en listas (Pipedrive [{ value, primary }], RD Station [{ email }] / [{ phone }]): el principal o el primero", () => {
    const person: CrmRecord = {
      id: "7",
      objectType: "contact",
      properties: {
        name: "Ana",
        email: [{ label: "home", value: "ana@casa.co", primary: false }, { label: "work", value: "ana@acme.co", primary: true }],
        phone: [{ label: "work", value: "+57 300 111 2233" }, { label: "mobile", value: "+57 310 999 0000" }],
        person_id: { name: "Ana", value: 7, email: [{ value: "", primary: true }, { value: "otra@acme.co" }] },
        emails: [{ email: "rd@acme.com.br" }],
        phones: [{ phone: "+55 11 99999-0000", type: "mobile" }],
        tags: ["vip", "pro"],
        empty: [],
      },
      contacts: [],
    };
    const [r] = mapRecipients(person, [{ role: "Cliente", source: "property", nameProperty: "name", emailProperty: "email", phoneProperty: "phone", channels: ["email"] }] as any);
    expect(r).toMatchObject({ name: "Ana", email: "ana@acme.co", phone: "+573001112233" });
    expect(
      mapPrefill(person, [
        { field: "Correo", property: "email" },
        { field: "Tel", property: "phone" },
        { field: "Correo persona", property: "person_id.email" },
        { field: "RD", property: "emails" },
        { field: "RDTel", property: "phones" },
        { field: "Tags", property: "tags" },
        { field: "Vacío", property: "empty" },
      ]),
    ).toEqual({ Correo: "ana@acme.co", Tel: "+57 300 111 2233", "Correo persona": "otra@acme.co", RD: "rd@acme.com.br", RDTel: "+55 11 99999-0000", Tags: "vip, pro" });
    expect(scalarValue("x")).toBe("x");
    expect(scalarValue([null, ""])).toBeNull();
  });
});
