// Conectores low-code: formulario dinámico de una plantilla, envío con roles como objeto y eventos de ejemplo.
import { beforeAll, describe, expect, it } from "vitest";
import type { TemplateDetail } from "@calasign/shared";

let mod: typeof import("../src/modules/lowcode");

beforeAll(async () => {
  process.env.APP_URL = "https://dev.calasign.com";
  mod = await import("../src/modules/lowcode");
});

const R1 = "0190a000-0000-7000-8000-000000000001";
const R2 = "0190a000-0000-7000-8000-000000000002";
const field = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
  id,
  documentId: "0190a000-0000-7000-8000-0000000000d1",
  roleId: R1,
  type,
  page: 0,
  x: 0,
  y: 0,
  width: 0.1,
  height: 0.1,
  required: true,
  label: null,
  value: null,
  readOnly: false,
  options: null,
  min: null,
  max: null,
  conditions: null,
  formula: null,
  ...extra,
});

const tpl = {
  template: { id: "0190a000-0000-7000-8000-0000000000aa", name: "Contrato" },
  documents: [],
  roles: [
    { id: R1, name: "Cliente", role: "signer", routingOrder: 1 },
    { id: R2, name: "Gerente", role: "signer", routingOrder: 2 },
  ],
  fields: [
    field("0190a000-0000-7000-8000-0000000000f1", "signature"),
    field("0190a000-0000-7000-8000-0000000000f2", "text", { label: "Empresa" }),
    field("0190a000-0000-7000-8000-0000000000f3", "number", { label: "Monto" }),
    field("0190a000-0000-7000-8000-0000000000f4", "dropdown", { label: "Plan", options: ["Básico", "Pro"] }),
    field("0190a000-0000-7000-8000-0000000000f5", "text", { label: "Fijo", readOnly: true, value: "x" }),
  ],
} as unknown as TemplateDetail;

describe("templateInputSchema", () => {
  it("un objeto por rol (clave = id) y solo los campos prellenables", () => {
    const s = mod.templateInputSchema(tpl);
    expect(s.roles.map((r) => r.name)).toEqual(["Cliente", "Gerente"]);
    expect(Object.keys((s.rolesSchema as any).properties)).toEqual([R1, R2]);
    expect((s.rolesSchema as any).required).toEqual([R1, R2]);
    expect((s.rolesSchema as any).properties[R1]["x-ms-summary"]).toBe("Cliente");
    expect((s.rolesSchema as any).properties[R1].required).toEqual(["name"]);
    expect(s.fields.map((f) => f.label)).toEqual(["Empresa", "Monto", "Plan"]);
    const p = (s.prefillSchema as any).properties;
    expect(p["0190a000-0000-7000-8000-0000000000f3"].type).toBe("number");
    expect(p["0190a000-0000-7000-8000-0000000000f4"].enum).toEqual(["Básico", "Pro"]);
    expect(p["0190a000-0000-7000-8000-0000000000f5"]).toBeUndefined();
  });
});

describe("toFromTemplateInput", () => {
  it("roles por id o por nombre, canal por defecto y prellenado vacío descartado", () => {
    const out = mod.toFromTemplateInput(
      tpl.template.id,
      {
        roles: { [R1]: { name: "Ana", email: "ANA@example.com" }, gerente: { name: "Beto", phone: "+18095551234" } },
        prefill: { Empresa: "ACME", Monto: 1500, Plan: "", Otro: null },
      },
      tpl,
    );
    expect(out.send).toBe(true);
    expect(out.recipients).toEqual([
      { roleId: R1, name: "Ana", email: "ana@example.com", phone: null, locale: null, channels: ["email"] },
      { roleId: R2, name: "Beto", email: null, phone: "+18095551234", locale: null, channels: ["whatsapp"] },
    ]);
    expect(out.prefill).toEqual({ Empresa: "ACME", Monto: "1500" });
  });

  it("rechaza roles desconocidos, repetidos o vacíos", () => {
    const code = (body: unknown) => {
      try {
        mod.toFromTemplateInput(tpl.template.id, body, tpl);
      } catch (e) {
        return (e as { code?: string }).code;
      }
      return null;
    };
    expect(code({ roles: { Socio: { name: "x", email: "x@x.com" } } })).toBe("unknown_role");
    expect(code({ roles: { cliente: { name: "x", email: "x@x.com" }, [R1]: { name: "y", email: "y@x.com" } } })).toBe("duplicate_role");
    expect(code({ roles: {} })).toBe("roles_missing");
  });

  it("send: false crea un borrador", () => {
    expect(mod.toFromTemplateInput(tpl.template.id, { roles: { Cliente: { name: "Ana", email: "a@x.com" } }, send: false }, tpl).send).toBe(false);
  });
});

describe("syntheticEvent", () => {
  it("tiene la forma de una entrega", () => {
    const e = mod.syntheticEvent("envelope.completed", "t1");
    expect(e.type).toBe("envelope.completed");
    expect(e.data.envelope?.status).toBe("completed");
    expect(mod.syntheticEvent("recipient.signed", "t1").data.recipientId).toBeTruthy();
  });
});
