// Alta de una organización con región (cellForSignup): todas las del catálogo se aceptan; las que este despliegue no
// tiene configuradas caen en la celda por defecto; una región fuera del catálogo da 400.
import { afterEach, describe, expect, it } from "vitest";
import { resetCells } from "../src/infra/cells";
import { cellForSignup, publicCells } from "../src/modules/data/cells";

const TWO_CELLS = JSON.stringify({ us: { default: true }, br: { baseUrl: "https://br.example" } });
const setCells = (cells: string | null) => {
  if (cells) process.env.CELLS = cells;
  else delete process.env.CELLS;
  resetCells();
};

afterEach(() => setCells(null));

describe("cellForSignup", () => {
  it("sin región, la por defecto", () => {
    setCells(null);
    expect(cellForSignup(undefined)).toEqual({ cell: "us", requested: null });
    expect(cellForSignup(null)).toEqual({ cell: "us", requested: null });
  });

  it("una región configurada se respeta", () => {
    setCells(TWO_CELLS);
    expect(cellForSignup("br")).toEqual({ cell: "br", requested: null });
    expect(cellForSignup("us")).toEqual({ cell: "us", requested: null });
  });

  it("una región del catálogo sin configurar se acepta, queda en la por defecto y se guarda la pedida", () => {
    setCells(null);
    expect(cellForSignup("br")).toEqual({ cell: "us", requested: "br" });
    expect(cellForSignup("eu-central-1")).toEqual({ cell: "us", requested: "eu-central-1" });
    expect(cellForSignup("cl")).toEqual({ cell: "us", requested: "cl" });
  });

  it("una región fuera del catálogo da 400 cell_unavailable", () => {
    setCells(null);
    expect(() => cellForSignup("marte")).toThrow(expect.objectContaining({ status: 400, code: "cell_unavailable" }));
  });

  it("la lista pública sigue diciendo cuáles están configuradas", () => {
    setCells(null);
    const items = publicCells();
    expect(items.find((c) => c.id === "us")?.available).toBe(true);
    expect(items.find((c) => c.id === "br")?.available).toBe(false);
    expect(items.length).toBeGreaterThanOrEqual(35);
  });
});
