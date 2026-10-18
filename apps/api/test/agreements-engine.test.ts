import { describe, expect, it } from "vitest";
import { analyzeTemplate, blocksToText, diffWords, parseTemplate, renderTemplate, TemplateSyntaxError } from "@calasign/shared";

const SRC = `# Contrato con {{cliente.nombre}}
Entre **{{empresa}}** y *{{cliente.nombre | upper}}*.
{{#if cliente.esEmpresa}}
El cliente es una persona jurídica (CUIT {{cliente.cuit}}).
{{else}}
El cliente es una persona humana.
{{/if}}
| Producto | Cant. | Precio |
|---|---|---|
{{#each items as it}}
| {{@index}}. {{it.nombre}} | {{it.cantidad}} | {{it.precio | money:USD}} |
{{/each}}
- Plazo: {{plazo}} meses{{#if plazo > 12}} (largo){{/if}}
{{clausula:confidencialidad}}
{{salto}}
Firma: {{firma:Cliente}} {{fecha_firma:Cliente}}`;

const clauses = { confidencialidad: "## Confidencialidad\nLas partes de **{{empresa}}** guardan secreto." };

describe("motor de plantillas", () => {
  it("variables, filtros, condicionales, bucles, tablas, cláusulas y marcas", () => {
    const r = renderTemplate(
      SRC,
      {
        empresa: "ACME",
        cliente: { nombre: "José Pérez", esEmpresa: false },
        plazo: 24,
        items: [
          { nombre: "Licencia", cantidad: 2, precio: 100 },
          { nombre: "Soporte", cantidad: 1, precio: 50.5 },
        ],
      },
      { clauses, locale: "es" },
    );
    expect(r.missing).toEqual([]);
    const text = blocksToText(r.blocks);
    expect(text).toContain("Contrato con José Pérez");
    expect(text).toContain("JOSÉ PÉREZ");
    expect(text).toContain("persona humana");
    expect(text).not.toContain("persona jurídica");
    expect(text).toContain("1. Licencia | 2 |");
    expect(text).toContain("2. Soporte | 1 |");
    expect(text).toMatch(/Licencia \| 2 \| 100,00\sUS\$/);
    expect(text).toContain("(largo)");
    expect(text).toContain("Confidencialidad");
    expect(r.marks).toEqual([
      { kind: "signature", role: "Cliente" },
      { kind: "date", role: "Cliente" },
    ]);
    const table = r.blocks.find((b) => b.type === "table");
    expect(table && table.type === "table" && table.header?.length).toBe(3);
    expect(table && table.type === "table" && table.rows.length).toBe(2);
    expect(r.blocks.some((b) => b.type === "pagebreak")).toBe(true);
    const bold = r.blocks[1].type === "paragraph" ? r.blocks[1].runs.find((x) => "text" in x && x.b) : null;
    expect(bold && "text" in bold && bold.text).toBe("ACME");
  });

  it("los valores se insertan como texto: no generan marcado, marcas ni etiquetas", () => {
    const r = renderTemplate("Hola {{nombre}}", { nombre: "**x** {{firma:Hacker}} {{#if a}}y{{/if}} <script>alert(1)</script>" });
    expect(r.marks).toEqual([]);
    const runs = r.blocks[0].type === "paragraph" ? r.blocks[0].runs : [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({ text: "Hola **x** {{firma:Hacker}} {{#if a}}y{{/if}} <script>alert(1)</script>" });
  });

  it("no ejecuta código: condiciones y rutas son datos, no expresiones", () => {
    expect(() => parseTemplate("{{#if constructor.constructor('return 1')()}}x{{/if}}")).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate("{{process.exit()}}")).toThrow(TemplateSyntaxError);
    const r = renderTemplate("{{constructor.name}}|{{__proto__.x}}|{{a.toString}}", { a: {} });
    expect(blocksToText(r.blocks)).toBe("||");
  });

  it("informa variables faltantes y permite marcarlas", () => {
    const r = renderTemplate("A {{x}} y {{y.z}} {{w | default:\"n/d\"}}", { y: {} }, { missing: "placeholder" });
    expect(r.missing.sort()).toEqual(["x", "y.z"]);
    expect(blocksToText(r.blocks)).toBe("A [x] y [y.z] n/d");
  });

  it("errores de sintaxis con número de línea", () => {
    expect(() => parseTemplate("hola\n{{#if a}}\nx")).toThrow(/Línea 2/);
    expect(() => parseTemplate("{{/each}}")).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate("{{x | evalua}}")).toThrow(/filtro desconocido/);
  });

  it("cláusulas recursivas no entran en bucle", () => {
    const r = renderTemplate("{{clausula:a}}", {}, { clauses: { a: "A\n{{clausula:b}}", b: "B\n{{clausula:a}}" } });
    expect(blocksToText(r.blocks).split("\n").length).toBeLessThan(10);
  });

  it("análisis: variables, bucles, roles y cláusulas", () => {
    const a = analyzeTemplate(SRC, clauses);
    expect(a.variables).toEqual(["cliente.cuit", "cliente.esEmpresa", "cliente.nombre", "empresa", "plazo"]);
    expect(a.loops).toEqual([{ path: "items", as: "it", fields: ["cantidad", "nombre", "precio"] }]);
    expect(a.roles).toEqual(["Cliente"]);
    expect(a.clauses).toEqual(["confidencialidad"]);
  });

  it("diff por palabras", () => {
    const d = diffWords("El plazo es de 12 meses y se renueva", "El plazo es de 24 meses y no se renueva");
    expect(d.filter((p) => p.op === "del").map((p) => p.text.trim())).toEqual(["12"]);
    expect(d.filter((p) => p.op === "ins").map((p) => p.text.trim())).toEqual(["24", "no"]);
    expect(d.filter((p) => p.op !== "ins").map((p) => p.text).join("")).toBe("El plazo es de 12 meses y se renueva");
    expect(d.filter((p) => p.op !== "del").map((p) => p.text).join("")).toBe("El plazo es de 24 meses y no se renueva");
  });
});
