// Contrato compartido (@calasign/shared): validaciones que la API aplica tal cual.
import { describe, expect, it } from "vitest";
import { AnchorFieldInput, CreateOAuthAppInput, WorkflowStep } from "@calasign/shared";

describe("URI de redirección de apps OAuth", () => {
  const app = (uri: string) => CreateOAuthAppInput.safeParse({ name: "App", grantTypes: ["authorization_code"], redirectUris: [uri], scopes: ["envelopes:read"] });

  it("rechaza esquemas que ejecutan código o leen archivos", () => {
    for (const uri of ["javascript:alert(document.domain)//", "JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd"]) {
      expect(app(uri).success, uri).toBe(false);
    }
  });

  it("acepta https, http y esquemas propios de apps (RFC 8252)", () => {
    for (const uri of ["https://app.example.com/cb", "http://localhost:5173/cb", "com.example.app:/oauth2redirect", "myapp://callback"]) {
      expect(app(uri).success, uri).toBe(true);
    }
  });
});

describe("campos por ancla", () => {
  it("conservan las propiedades de un campo con coordenadas", () => {
    const f = AnchorFieldInput.parse({
      recipientId: "00000000-0000-4000-8000-000000000001",
      type: "dropdown",
      value: "Contado",
      readOnly: true,
      options: ["Contado", "Cuotas"],
      min: 1,
      max: 12,
      formula: "{A} * 2",
      conditions: [{ fieldId: "00000000-0000-4000-8000-000000000002", operator: "checked" }],
      anchor: { text: "[[x]]", width: 100, height: 20 },
    });
    expect(f).toMatchObject({ value: "Contado", readOnly: true, options: ["Contado", "Cuotas"], min: 1, max: 12, formula: "{A} * 2" });
    expect(f.conditions).toHaveLength(1);
  });
});

describe("pasos de recolección de datos de un workflow", () => {
  const step = (fields: unknown[]) =>
    WorkflowStep.safeParse({ id: "00000000-0000-4000-8000-000000000003", name: "Datos", type: "collect_data", config: { title: "Datos", fields } });

  it("un campo de lista necesita opciones", () => {
    expect(step([{ key: "plan", label: "Plan", type: "select" }]).success).toBe(false);
    expect(step([{ key: "plan", label: "Plan", type: "select", options: [] }]).success).toBe(false);
    expect(step([{ key: "plan", label: "Plan", type: "select", options: ["Básico", "Pro"] }]).success).toBe(true);
    expect(step([{ key: "nombre", label: "Nombre", type: "text" }]).success).toBe(true);
  });
});
