import { describe, expect, it } from "vitest";
import { assertLogicOrder, danglingFormulaProblems, newLogicOrderProblems, problemsError, signerWithoutSignature } from "../src/modules/envelopes";
import { AppError } from "../src/lib/errors";

// envelope_incomplete / logic_order: además del texto en español (message y details.problems, la lista de textos de siempre), details.issues trae code y params para
// que el cliente lo traduzca.
describe("details.issues con código y parámetros", () => {
  const recips = [
    { id: "a", name: "Ana", routing_order: 1 },
    { id: "b", name: "Beto", routing_order: 2 },
  ];

  it("logic_order: cada problema con code, params y el texto de siempre; message une los textos", async () => {
    const fields = [
      { id: "b1", recipient_id: "b", label: "Casilla", conditions: null },
      { id: "a1", recipient_id: "a", label: "Extra", conditions: [{ fieldId: "b1" }] },
    ];
    const err = await assertLogicOrder(fields, recips).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    const e = err as AppError;
    expect(e.status).toBe(422);
    expect(e.code).toBe("logic_order");
    const problems = (e.details as { issues: { code: string; params: Record<string, unknown>; message: string }[] }).issues;
    expect((e.details as { problems: string[] }).problems).toEqual(problems.map((p) => p.message));
    expect(problems).toEqual([
      {
        code: "logic_order",
        params: { field: "Extra", recipient: "Ana", source: "Beto" },
        message: 'El campo "Extra" de Ana depende de un campo de Beto, que firma después o al mismo tiempo',
      },
    ]);
    expect(e.message).toBe(problems[0].message);
  });

  it("logic_order_formula: la dependencia a través de una fórmula lleva params.formula", () => {
    const fields = [
      { id: "b1", recipient_id: "b", label: "Monto", type: "number", conditions: null },
      { id: "t1", recipient_id: "a", label: "Total", type: "number", formula: "{Monto}", conditions: null },
      { id: "a2", recipient_id: "a", label: "Garantía", conditions: [{ fieldId: "t1" }] },
    ];
    const [p] = newLogicOrderProblems(fields, recips);
    expect(p.code).toBe("logic_order_formula");
    expect(p.params).toEqual({ field: "Garantía", recipient: "Ana", source: "Beto", formula: "Total" });
    expect(p.message).toContain("a través de la fórmula");
  });

  it("formula_missing_ref sin nombre de campo: sin params.field (la consola usa el message)", () => {
    const [p] = danglingFormulaProblems([{ type: "number", label: null, formula: "{Monto}" }]);
    expect(p.params).toEqual({ refs: "{Monto}" });
    expect(p.message).toBe('La fórmula de un campo cita {Monto}, que ya no está en el sobre');
  });

  it("formula_missing_ref y envelope_incomplete", () => {
    const problems = [
      ...danglingFormulaProblems([{ type: "number", label: "Total", formula: "{Monto} + {Iva}" }]),
      signerWithoutSignature("Ana Pérez"),
    ];
    expect(problems.map((p) => [p.code, p.params])).toEqual([
      ["formula_missing_ref", { field: "Total", refs: "{Monto}, {Iva}" }],
      ["signer_without_signature", { name: "Ana Pérez" }],
    ]);
    const e = problemsError("envelope_incomplete", problems);
    expect(e.status).toBe(422);
    expect(e.code).toBe("envelope_incomplete");
    expect(e.message).toBe('La fórmula de "Total" cita {Monto}, {Iva}, que ya no está en el sobre. Ana Pérez no tiene ningún campo de firma');
    expect((e.details as { issues: unknown[] }).issues).toBe(problems);
    expect((e.details as { problems: string[] }).problems).toEqual(problems.map((p) => p.message));
  });
});
