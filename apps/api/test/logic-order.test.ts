import { describe, expect, it } from "vitest";
import { logicOrderKeys, logicOrderProblems, newLogicOrderProblems } from "../src/modules/envelopes";

const recips = [
  { id: "a", name: "Ana", routing_order: 1 },
  { id: "b", name: "Beto", routing_order: 2 },
  { id: "c", name: "Caro", routing_order: 2 },
];

// Una condición que cita un campo de otro firmante se decide cuando completa el dueño del campo condicionado.
describe("orden de la lógica entre firmantes", () => {
  it("permite depender de un campo propio, de uno fijo o de alguien que firma antes", () => {
    const fields = [
      { id: "a1", recipient_id: "a", label: "Acepta", conditions: null },
      { id: "fixed", recipient_id: "a", label: "Fijo", conditions: null, read_only: true },
      { id: "b1", recipient_id: "b", label: "Detalle", conditions: [{ fieldId: "a1" }] },
      { id: "b2", recipient_id: "b", label: "Otro", conditions: [{ fieldId: "b1" }] },
      { id: "a2", recipient_id: "a", label: "Usa fijo", conditions: [{ fieldId: "fixed" }] },
    ];
    expect(logicOrderProblems(fields, recips)).toEqual([]);
  });
  it("rechaza depender de alguien que firma después o en el mismo turno", () => {
    const fields = [
      { id: "b1", recipient_id: "b", label: "Casilla", conditions: null },
      { id: "a1", recipient_id: "a", label: "Firma extra", conditions: [{ fieldId: "b1" }] },
      { id: "c1", recipient_id: "c", label: "Misma vuelta", conditions: [{ fieldId: "b1" }] },
    ];
    expect(logicOrderProblems(fields, recips)).toHaveLength(2);
  });
  it("sigue las fórmulas: un total propio que suma el monto de quien firma después tampoco vale", () => {
    const fields = [
      { id: "b1", recipient_id: "b", label: "Monto", type: "number", conditions: null },
      { id: "a1", recipient_id: "a", label: "Base", type: "number", conditions: null },
      { id: "t1", recipient_id: "a", label: "Total", type: "number", formula: "{Base} + {Monto}", conditions: null },
      { id: "t2", recipient_id: "a", label: "Solo base", type: "number", formula: "{Base} * 2", conditions: null },
      { id: "a2", recipient_id: "a", label: "Garantía", conditions: [{ fieldId: "t1" }] },
      { id: "a3", recipient_id: "a", label: "Ok", conditions: [{ fieldId: "t2" }] },
    ];
    const problems = logicOrderProblems(fields, recips);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Garantía");
    expect(problems[0]).toContain("Total");
  });
  it("un problema previo se reconoce aunque se regeneren los ids de la hoja de la fórmula y del campo dependiente", () => {
    const build = (leaf: string, dep: string) => [
      { id: leaf, recipient_id: "b", label: "Monto", type: "number", conditions: null },
      { id: "t1", recipient_id: "a", label: "Total", type: "number", formula: "{Monto}", conditions: null },
      { id: dep, recipient_id: "a", label: "Garantía", conditions: [{ fieldId: "t1" }] },
    ];
    const before = logicOrderKeys(build("m1", "g1"), recips);
    expect(before).toHaveLength(1);
    expect(newLogicOrderProblems(build("m2", "g2"), recips, before)).toEqual([]);
    expect(newLogicOrderProblems(build("m2", "g2"), recips, [])).toHaveLength(1);
  });
});
