import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PageText, TextLine } from "@calasign/pdf";
import type { DocText } from "../src/modules/ai/heuristics";
import { ContractMetadataSchema, PlaybookReviewInput, UpdateAiSettingsInput } from "@calasign/shared";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-ai-"));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const H = await import("../src/modules/ai/heuristics");
const { renewalAlertDate } = await import("../src/modules/ai/service");
const { getAiProvider } = await import("../src/modules/ai/provider");

function line(id: string, text: string, y: number, x = 72): TextLine {
  const width = text.length * 5;
  return { id, text, x, y, width, height: 10, spans: [{ text, x, width }] };
}

function doc(lines: string[][]): DocText {
  const pages: PageText[] = lines.map((ls, p) => ({
    page: p,
    width: 595,
    height: 842,
    lines: ls.map((t, i) => line(`p${p + 1}-l${i + 1}`, t, 100 + i * 20)),
  }));
  return { id: "11111111-1111-7111-8111-111111111111", name: "contrato.pdf", pages };
}

const CONTRACT = doc([
  [
    "CONTRATO DE PRESTACIÓN DE SERVICIOS",
    "EL CLIENTE: Banco Demo S.A.",
    "EL PROVEEDOR: Servicios Andinos SAS",
    "El presente contrato tiene vigencia desde el 01/02/2026 y vence el 31/01/2027.",
    "Se renovará automáticamente por períodos iguales salvo preaviso de 60 días de anticipación.",
    "El precio mensual es de USD 1.500,50 más impuestos.",
    "Jurisdicción de los tribunales de Bogotá.",
    "La responsabilidad se limita a 18 meses de honorarios.",
  ],
  [
    "Firma del cliente: ____________________",
    "Aclaración: ____________________",
    "Fecha: ____________",
    "______________________________",
    "Assinatura do fornecedor",
    "Iniciales: ______",
  ],
]);

describe("heurísticas de detección de campos", () => {
  it("detecta firma, aclaración, fecha, iniciales y bloques de firma con rótulo debajo", () => {
    const s = H.heuristicFieldSuggestions(CONTRACT);
    const types = s.map((x) => `${x.lineId}:${x.type}`);
    expect(types).toContain("p2-l1:signature");
    expect(types).toContain("p2-l2:name");
    expect(types).toContain("p2-l3:date_signed");
    expect(types).toContain("p2-l4:signature"); // línea en blanco + "Assinatura do fornecedor" debajo
    expect(types).toContain("p2-l6:initials");
    // El texto de las cláusulas no genera sugerencias.
    expect(s.every((x) => x.page === 1)).toBe(true);
    expect(s.find((x) => x.lineId === "p2-l1")?.roleHint).toBe("cliente");
    expect(s.find((x) => x.lineId === "p2-l4")?.roleHint).toBe("fornecedor");
  });

  it("ubica la sugerencia dentro de la página y sobre la línea punteada", () => {
    const l = CONTRACT.pages[1].lines[0];
    const box = H.placeSuggestion(l, CONTRACT.pages[1], "signature");
    for (const v of [box.x, box.y, box.width, box.height]) expect(v).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1);
    expect(box.y + box.height).toBeLessThanOrEqual(1);
    // Empieza donde empiezan los guiones bajos ("Firma del cliente: " = 19 caracteres).
    expect(box.x * 595).toBeGreaterThan(l.x + 15 * 5);
    // La firma se apoya sobre el renglón.
    expect((box.y + box.height) * 842).toBeCloseTo(l.y + l.height, 0);
  });

  it("roleFromLine entiende español, portugués e inglés", () => {
    expect(H.roleFromLine("Firma del Locatario:")).toBe("locatario");
    expect(H.roleFromLine("Assinatura da contratante ____")).toBe("contratante");
    expect(H.roleFromLine("Signature of the Supplier")).toBe("supplier");
    expect(H.roleFromLine("Firma: ____")).toBeNull();
  });
});

describe("mock: metadatos, montos y fechas", () => {
  it("parseAmount respeta separadores locales", () => {
    expect(H.parseAmount("USD 1.500,50")).toBe(1500.5);
    expect(H.parseAmount("$1,500.50")).toBe(1500.5);
    expect(H.parseAmount("R$ 12.000")).toBe(12000);
    expect(H.parseAmount("1,500,000")).toBe(1500000);
    expect(H.parseAmount("99,9")).toBe(99.9);
  });

  it("findDates reconoce formatos numéricos y en texto", () => {
    expect(H.findDates("vence el 31/01/2027")).toEqual(["2027-01-31"]);
    expect(H.findDates("a partir del 15 de marzo de 2026")).toEqual(["2026-03-15"]);
    expect(H.findDates("válido até 2026-12-01")).toEqual(["2026-12-01"]);
    expect(H.findDates("effective March 5, 2026")).toEqual(["2026-03-05"]);
  });

  it("extrae partes, vigencia, renovación, monto, ley aplicable y preaviso", () => {
    const { metadata, confidence } = H.mockMetadata([CONTRACT]);
    expect(metadata.parties.map((p) => p.name)).toEqual(["Banco Demo S.A.", "Servicios Andinos SAS"]);
    expect(metadata.effectiveDate).toBe("2026-02-01");
    expect(metadata.expiryDate).toBe("2027-01-31");
    expect(metadata.autoRenewal).toBe(true);
    expect(metadata.amounts[0]).toMatchObject({ value: 1500.5, currency: "USD" });
    expect(metadata.governingLaw).toBe("Bogota");
    expect(metadata.noticePeriodDays).toBe(60);
    expect(ContractMetadataSchema.parse(metadata)).toBeTruthy();
    expect(confidence.expiryDate).toBeGreaterThan(0);
  });
});

describe("mock: resumen, preguntas y playbook", () => {
  it("responde con citas que existen en el documento", () => {
    const a = H.mockAnswer([CONTRACT], "¿Cuál es el precio mensual?");
    expect(a.answered).toBe(true);
    expect(a.citations[0].quote).toContain("USD 1.500,50");
    expect(H.locateQuote([CONTRACT], a.citations[0].quote).verified).toBe(true);
    expect(H.locateQuote([CONTRACT], "una cláusula que no existe").verified).toBe(false);
    expect(H.mockAnswer([CONTRACT], "¿Hay mascotas permitidas?").answered).toBe(false);
  });

  it("evalúa reglas del playbook: ok, violación y no encontrado", () => {
    const r = H.mockPlaybookReview([CONTRACT], [
      "Jurisdicción debe ser Bogotá",
      "Jurisdicción debe ser Medellín",
      "Responsabilidad <= 12 meses",
      "Confidencialidad debe ser 5 años",
    ]);
    expect(r.map((x) => x.status)).toEqual(["ok", "violation", "violation", "not_found"]);
    expect(r[2].quote).toContain("18 meses");
    expect(r[2].page).toBe(1);
  });

  it("el proveedor sin clave es el mock y reporta tokens estimados", async () => {
    const p = getAiProvider();
    expect(p.name).toBe("mock");
    const s = await p.summarize([CONTRACT], "es");
    expect(s.result.summary.length).toBeGreaterThan(20);
    expect(s.usage.inputTokens).toBeGreaterThan(50);
    expect(s.usage.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("alertas de renovación", () => {
  const today = new Date("2026-10-01T12:00:00Z");
  const base = { parties: [], effectiveDate: null, renewalDate: null, autoRenewal: null, amounts: [], governingLaw: null, noticePeriodDays: null };
  it("N días antes del vencimiento, o el preaviso si es mayor", () => {
    expect(renewalAlertDate({ ...base, expiryDate: "2027-01-31" }, 30, today)).toBe("2027-01-01");
    expect(renewalAlertDate({ ...base, expiryDate: "2027-01-31", noticePeriodDays: 60, autoRenewal: true }, 30, today)).toBe("2026-11-25");
  });
  it("si ya pasó la fecha de aviso, avisa hoy; si ya venció o está desactivado, nada", () => {
    expect(renewalAlertDate({ ...base, expiryDate: "2026-10-10" }, 30, today)).toBe("2026-10-01");
    expect(renewalAlertDate({ ...base, expiryDate: "2026-09-01" }, 30, today)).toBeNull();
    expect(renewalAlertDate({ ...base, expiryDate: "2027-01-31" }, 0, today)).toBeNull();
  });
});

describe("esquemas", () => {
  it("validan configuración y reglas", () => {
    expect(() => UpdateAiSettingsInput.parse({ monthlyTokenBudget: -1 })).toThrow();
    expect(UpdateAiSettingsInput.parse({ playbook: ["Jurisdicción debe ser Bogotá"] }).playbook).toHaveLength(1);
    expect(() => PlaybookReviewInput.parse({ rules: ["ab"] })).toThrow();
    expect(() => ContractMetadataSchema.parse({ ...H.mockMetadata([CONTRACT]).metadata, expiryDate: "31/01/2027" })).toThrow();
    // Fecha con forma válida pero que no existe en el calendario.
    expect(() => ContractMetadataSchema.parse({ ...H.mockMetadata([CONTRACT]).metadata, renewalDate: "2027-02-31" })).toThrow();
    expect(ContractMetadataSchema.parse({ ...H.mockMetadata([CONTRACT]).metadata, renewalDate: "2028-02-29" }).renewalDate).toBe("2028-02-29");
  });
});
