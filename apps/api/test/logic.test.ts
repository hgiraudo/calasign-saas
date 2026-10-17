import { describe, expect, it } from "vitest";
import { computeFormulas, computeHidden, evaluateFormula, formatComputed, validateLogic } from "../src/modules/logic";
import { csvToRows, parseCsv } from "../src/modules/bulk";

describe("fórmulas", () => {
  it("respeta precedencia, paréntesis, unarios y coma decimal", () => {
    const v: Record<string, number> = { precio: 1250.5, cantidad: 2 };
    expect(evaluateFormula("{Precio} * {Cantidad} * 1,21", (l) => v[l.toLowerCase()] ?? null)).toBeCloseTo(3026.21);
    expect(evaluateFormula("-(2 + 3) * 4 / 2", () => null)).toBe(-10);
    expect(evaluateFormula("{Nada} + 1", () => null)).toBe(1);
    expect(evaluateFormula("1 / 0", () => null)).toBeNull();
    expect(formatComputed(2501.004)).toBe("2501");
  });
  it("no evalúa código: rechaza caracteres fuera de la gramática", () => {
    expect(() => evaluateFormula("process.exit(1)", () => 0)).toThrow();
    expect(() => evaluateFormula("{a} ** 2", () => 0)).toThrow();
  });
});

describe("condiciones", () => {
  const f = (id: string, type: string, label: string | null, conditions: any = null, formula: string | null = null) => ({ id, type, label, conditions, formula });
  it("oculta en cascada y calcula solo lo visible", () => {
    const fields = [
      f("a", "checkbox", "A"),
      f("b", "text", "B", [{ fieldId: "a", operator: "checked" }]),
      f("c", "text", "C", [{ fieldId: "b", operator: "filled" }]),
      f("p", "number", "P"),
      f("t", "number", "T", null, "{P} * 2"),
    ];
    const vals: Record<string, string> = { a: "false", b: "x", c: "y", p: "21" };
    const hidden = computeHidden(fields, (id) => vals[id] ?? null);
    expect([...hidden].sort()).toEqual(["b", "c"]);
    expect(computeFormulas(fields, (id) => vals[id] ?? null, hidden).get("t")).toBe("42");
  });
  it("valida ciclos y referencias", () => {
    expect(() => validateLogic([f("a", "text", "A", [{ fieldId: "b", operator: "filled" }]), f("b", "text", "B", [{ fieldId: "a", operator: "filled" }])])).toThrow(/ciclo/);
    expect(() => validateLogic([f("t", "number", "T", null, "{X} + 1")])).toThrow(/X/);
    expect(() => validateLogic([f("t", "number", "T", null, "{T} + 1")])).toThrow();
  });
});

describe("CSV", () => {
  it("detecta punto y coma, comillas, BOM y saltos dentro de comillas", () => {
    expect(parseCsv('﻿a;b\r\n"x;1";"lí\nnea"\r\n')).toEqual([["a", "b"], ["x;1", "lí\nnea"]]);
  });
  it("mapea columnas a roles y campos", () => {
    const r = csvToRows("Cliente.nombre,Cliente.email,field.Plan,Otro\nAna,ANA@x.com,Anual,1\n", [{ id: "r1", name: "Cliente" }]);
    expect(r.fileErrors.length).toBe(1);
    expect(r.rows[0]).toMatchObject({ recipients: [{ roleId: "r1", name: "Ana", email: "ana@x.com" }], prefill: { Plan: "Anual" } });
  });
});
