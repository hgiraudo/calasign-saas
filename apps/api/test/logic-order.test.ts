import { describe, expect, it } from "vitest";
import { logicOrderProblems } from "../src/modules/envelopes";

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
});
