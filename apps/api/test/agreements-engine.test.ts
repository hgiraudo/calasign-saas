import { describe, expect, it } from "vitest";
import {
  analyzeTemplate,
  blocksToText,
  checkClauseGraph,
  diffWords,
  parseLocaleDate,
  parseLocaleNumber,
  parseTemplate,
  renderTemplate,
  TemplateSyntaxError,
} from "@calasign/shared";
import { interpolateValue, toIsoDate, toNumberOrNull } from "../src/modules/agreements/common";
import { agreementMetaFromMapping, renderTemplateCompat } from "../src/modules/agreements/documents";

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
    const r = renderTemplate('A {{x}} y {{y.z}} {{w | default:"n/d"}}', { y: {} }, { missing: "placeholder" });
    expect(r.missing.sort()).toEqual(["x", "y.z"]);
    expect(blocksToText(r.blocks)).toBe("A [x] y [y.z] n/d");
  });

  it("errores de sintaxis con número de línea", () => {
    expect(() => parseTemplate("hola\n{{#if a}}\nx")).toThrow(/Línea 2/);
    expect(() => parseTemplate("{{/each}}")).toThrow(TemplateSyntaxError);
    expect(() => parseTemplate("{{x | evalua}}")).toThrow(/filtro desconocido/);
  });

  it("cláusulas recursivas no entran en bucle: son un error de sintaxis", () => {
    expect(() => renderTemplate("{{clausula:a}}", {}, { clauses: { a: "A\n{{clausula:b}}", b: "B\n{{clausula:a}}" } })).toThrow(TemplateSyntaxError);
  });

  it("análisis: variables, bucles, roles y cláusulas", () => {
    const a = analyzeTemplate(SRC, clauses);
    expect(a.variables).toEqual(["cliente.cuit", "cliente.esEmpresa", "cliente.nombre", "empresa", "plazo"]);
    expect(a.loops).toEqual([{ path: "items", as: "it", fields: ["cantidad", "nombre", "precio"] }]);
    expect(a.roles).toEqual(["Cliente"]);
    expect(a.clauses).toEqual(["confidencialidad"]);
  });

  it("diff por palabras", () => {
    // Textos muy distintos: no agota la memoria (diff en bloque) y el resultado sigue reconstruyendo ambos lados.
    const big1 = Array.from({ length: 9000 }, (_, i) => `a${i}`).join(" ");
    const big2 = Array.from({ length: 9000 }, (_, i) => `b${i}`).join(" ");
    const t0 = Date.now();
    const bd = diffWords(big1, big2);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(
      bd
        .filter((p) => p.op !== "ins")
        .map((p) => p.text)
        .join(""),
    ).toBe(big1);
    expect(
      bd
        .filter((p) => p.op !== "del")
        .map((p) => p.text)
        .join(""),
    ).toBe(big2);

    const d = diffWords("El plazo es de 12 meses y se renueva", "El plazo es de 24 meses y no se renueva");
    expect(d.filter((p) => p.op === "del").map((p) => p.text.trim())).toEqual(["12"]);
    expect(d.filter((p) => p.op === "ins").map((p) => p.text.trim())).toEqual(["24", "no"]);
    expect(
      d
        .filter((p) => p.op !== "ins")
        .map((p) => p.text)
        .join(""),
    ).toBe("El plazo es de 12 meses y se renueva");
    expect(
      d
        .filter((p) => p.op !== "del")
        .map((p) => p.text)
        .join(""),
    ).toBe("El plazo es de 24 meses y no se renueva");
  });

  it("un valor sin dígitos no se imprime como 0 y un if en línea puede ocupar la línea entera", () => {
    const text = (src: string, data: unknown) => blocksToText(renderTemplate(src, data).blocks);
    expect(text("Precio: {{precio | money:USD}} / {{precio | number}}{{#if precio == 0}} GRATIS{{/if}}", { precio: "a convenir" })).toBe(
      "Precio: a convenir / a convenir",
    );
    expect(text("{{#if empresa}}S.A.{{/if}}", { empresa: "x" })).toBe("S.A.");
    expect(text('{{#if tipo == "a"}}Hola{{else}}Chau{{/if}}', { tipo: "b" })).toBe("Chau");
    expect(text("{{#if empresa}}\nS.A.\n{{/if}}", { empresa: "x" })).toBe("S.A.");
  });

  it("montos con miles repetidos (1.500.000 / 1,500,000) se formatean y se comparan como números", () => {
    const text = (src: string, data: unknown) => blocksToText(renderTemplate(src, data, { locale: "es" }).blocks);
    const src = "{{valor | number}}{{#if valor > 1000000}} (grande){{/if}}";
    expect(text(src, { valor: "1.500.000" })).toBe("1.500.000 (grande)");
    expect(text(src, { valor: "1,500,000" })).toBe("1.500.000 (grande)");
    expect(text(src, { valor: "$ 2.000.000,50" })).toBe("2.000.000,5 (grande)");
    expect(text(src, { valor: "1,5" })).toBe("1,5");
  });

  it("una fecha inexistente se imprime tal cual, no corrida a otro día", () => {
    const text = (data: unknown) => blocksToText(renderTemplate("Vence: {{f | date:long}}", data, { locale: "es" }).blocks);
    expect(text({ f: "31/02/2027" })).toBe("Vence: 31/02/2027");
    expect(text({ f: "2027-02-31" })).toBe("Vence: 2027-02-31");
    expect(text({ f: "28/02/2027" })).toBe("Vence: 28 de febrero de 2027");
    expect(text({ f: "2028-02-29" })).toBe("Vence: 29 de febrero de 2028");
    expect(text({ f: "2027-03-01T10:00:00Z" })).toBe("Vence: 1 de marzo de 2027");
  });
});

describe("motor de plantillas: cláusulas, listas, números, fechas y roles", () => {
  it("un ciclo de cláusulas (a → a, a → b → a) es un error, no texto duplicado", () => {
    expect(() => renderTemplate("{{clausula:a}}", {}, { clauses: { a: "Texto A\n{{clausula:a}}" } })).toThrow(/ciclo/);
    let err: unknown;
    try {
      renderTemplate("{{clausula:a}}", {}, { clauses: { a: "A\n{{clausula:b}}", b: "B\n{{clausula:a}}" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TemplateSyntaxError);
    expect((err as TemplateSyntaxError).reason).toBe("clause_cycle");
    expect((err as Error).message).toContain("{{clausula:a}} → {{clausula:b}} → {{clausula:a}}");
    // La misma cláusula dos veces (no anidada) no es un ciclo.
    const ok = renderTemplate("{{clausula:a}}\n{{clausula:a}}", {}, { clauses: { a: "Hola" } });
    expect(blocksToText(ok.blocks)).toBe("Hola\nHola");
  });

  it("hasta 8 niveles de cláusulas anidadas se insertan; el 9º es un error (antes el 4º se perdía sin aviso)", () => {
    const chain = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i + 1}`, `Nivel ${i + 1}${i + 1 < n ? `\n{{clausula:c${i + 2}}}` : ""}`]));
    const r = renderTemplate("{{clausula:c1}}", {}, { clauses: chain(8) });
    expect(blocksToText(r.blocks)).toContain("Nivel 4");
    expect(blocksToText(r.blocks)).toContain("Nivel 8");
    expect(r.usedClauses.sort()).toEqual(Object.keys(chain(8)).sort());
    expect(() => renderTemplate("{{clausula:c1}}", {}, { clauses: chain(9) })).toThrow(/niveles/);
  });

  it("checkClauseGraph detecta ciclos en todas las ramas y el tope de niveles", () => {
    const lib = { a: "{{#if x}}\n{{clausula:b}}\n{{/if}}", b: "{{#each items as i}}\n{{clausula:a}}\n{{/each}}", c: "{{clausula:d}}", d: "Fin" };
    expect(() => checkClauseGraph(lib, ["a"])).toThrow(/ciclo/);
    expect(() => checkClauseGraph(lib, ["c"])).not.toThrow();
    // Una cláusula ya validada en otra rama cuenta sus niveles desde donde se la cita.
    const deep = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`n${i + 1}`, i < 7 ? `{{clausula:n${i + 2}}}` : "fin"]));
    expect(() => checkClauseGraph(deep, ["n2", "n1"])).not.toThrow();
    expect(() => checkClauseGraph({ ...deep, top: "{{clausula:n1}}" }, ["n1", "top"])).toThrow(/niveles/);
  });

  it("las listas numeradas conservan el número inicial", () => {
    const r = renderTemplate("1. uno\n2. dos\n\nTexto en el medio.\n\n3. tres\n4. cuatro", {});
    const lists = r.blocks.filter((b) => b.type === "list");
    expect(lists).toHaveLength(2);
    expect((lists[0] as { start?: number }).start).toBeUndefined();
    expect((lists[1] as { start?: number }).start).toBe(3);
    expect(blocksToText(r.blocks)).toContain("3. tres\n4. cuatro");
  });

  it("tablas separadas por una línea en blanco no se fusionan; con {{#each}} siguen siendo una", () => {
    const r = renderTemplate("| A | B |\n|---|---|\n| 1 | 2 |\n\n| C | D |\n| 3 | 4 |", {});
    expect(r.blocks.filter((b) => b.type === "table")).toHaveLength(2);
    const e = renderTemplate("| X |\n|---|\n{{#each xs as x}}\n| {{x}} |\n{{/each}}", { xs: ["a", "b"] });
    const t = e.blocks.filter((b) => b.type === "table");
    expect(t).toHaveLength(1);
    expect((t[0] as { rows: unknown[] }).rows).toHaveLength(2);
  });

  it("números según el idioma: 1.500 en es/pt = 1500, 2,500 en en = 2500; ambiguo se imprime tal cual", () => {
    expect(parseLocaleNumber("1.500", "es")).toBe(1500);
    expect(parseLocaleNumber("1.500", "pt-BR")).toBe(1500);
    expect(parseLocaleNumber("1.500", "en")).toBe(1.5);
    expect(parseLocaleNumber("2,500", "en")).toBe(2500);
    expect(parseLocaleNumber("2,500", "es")).toBe(2.5);
    expect(parseLocaleNumber("1.234,56", "en")).toBe(1234.56);
    expect(parseLocaleNumber("1,234.56", "es")).toBe(1234.56);
    expect(parseLocaleNumber("1.500.000", "es")).toBe(1500000);
    expect(parseLocaleNumber("1500.50", "es")).toBe(1500.5);
    expect(parseLocaleNumber("0,500", "en")).toBe(0.5);
    expect(parseLocaleNumber("1,2.3", "es")).toBeNull();
    expect(parseLocaleNumber("1.23,4.5", "es")).toBeNull();
    expect(parseLocaleNumber("a convenir", "es")).toBeNull();
    const r = renderTemplate("{{p | money:USD}} {{q | number}}{{#if p > 1000}} grande{{/if}}", { p: "1.500", q: "1,2.3" }, { locale: "es" });
    expect(blocksToText(r.blocks)).toMatch(/^1500,00\sUS\$ 1,2\.3 grande$/);
    expect(blocksToText(renderTemplate("{{p | number}}", { p: "2,500" }, { locale: "en" }).blocks)).toBe("2,500");
    expect(toNumberOrNull("1.500", "es")).toBe(1500);
    expect(toNumberOrNull("2,500", "en")).toBe(2500);
    expect(toNumberOrNull("1,2.3")).toBeNull();
  });

  it("fechas con barras: mes/día/año en inglés, día/mes/año en es y pt", () => {
    expect(parseLocaleDate("03/01/2027", "en")?.toISOString().slice(0, 10)).toBe("2027-03-01");
    expect(parseLocaleDate("03/01/2027", "es")?.toISOString().slice(0, 10)).toBe("2027-01-03");
    expect(parseLocaleDate("03/01/2027", "pt-BR")?.toISOString().slice(0, 10)).toBe("2027-01-03");
    expect(parseLocaleDate("13/01/2027", "en")).toBeNull();
    expect(parseLocaleDate("2027-02-31", "es")).toBeNull();
    const en = blocksToText(renderTemplate("{{d | date:long}}", { d: "03/01/2027" }, { locale: "en" }).blocks);
    expect(en).toBe("March 1, 2027");
    const es = blocksToText(renderTemplate("{{d | date:long}}", { d: "03/01/2027" }, { locale: "es" }).blocks);
    expect(es).toBe("3 de enero de 2027");
    expect(toIsoDate("03/01/2027", "en")).toBe("2027-03-01");
    expect(toIsoDate("03/01/2027")).toBe("2027-01-03");
  });

  it("roles sin distinguir mayúsculas: el análisis y el render usan la grafía de la primera aparición", () => {
    const src = "{{firma:Cliente}} {{iniciales:cliente}} {{fecha_firma:CLIENTE}} {{iniciales:Testigo}}";
    const a = analyzeTemplate(src);
    expect(a.roles).toEqual(["Cliente", "Testigo"]);
    expect(a.unsignedRoles).toEqual(["Testigo"]);
    expect(renderTemplate(src, {}).marks.map((m) => m.role)).toEqual(["Cliente", "Cliente", "Cliente", "Testigo"]);
  });

  it("un rol de más de 80 caracteres es un error de sintaxis", () => {
    let err: unknown;
    try {
      parseTemplate(`{{firma:${"R".repeat(81)}}}`);
    } catch (e) {
      err = e;
    }
    expect((err as TemplateSyntaxError).reason).toBe("role_too_long");
    expect(() => parseTemplate(`{{firma:${"R".repeat(80)}}}`)).not.toThrow();
  });

  it("las firmas condicionales solo aparecen en las marcas si se cumple la condición", () => {
    const src = "{{firma:Cliente}}\n{{#if garante}}\n{{firma:Garante}}\n{{/if}}";
    expect(renderTemplate(src, {}).marks.map((m) => m.role)).toEqual(["Cliente"]);
    expect(renderTemplate(src, { garante: "Juan" }).marks.map((m) => m.role)).toEqual(["Cliente", "Garante"]);
  });
});

describe("números y fechas: literales, valores crudos y compatibilidad de cláusulas", () => {
  it("los literales numéricos de las condiciones usan el idioma de la plantilla, como los datos", () => {
    const src = "{{#if monto > 1.500}}grande{{else}}chico{{/if}}";
    // es: "1.500" = 1500
    expect(blocksToText(renderTemplate(src, { monto: 1000 }, { locale: "es" }).blocks)).toBe("chico");
    expect(blocksToText(renderTemplate(src, { monto: 2000 }, { locale: "es" }).blocks)).toBe("grande");
    // en: "1.500" = 1,5
    expect(blocksToText(renderTemplate(src, { monto: 1000 }, { locale: "en" }).blocks)).toBe("grande");
    const en = "{{#if monto >= 2,500}}si{{else}}no{{/if}}";
    expect(blocksToText(renderTemplate(en, { monto: "2,400" }, { locale: "en" }).blocks)).toBe("no");
    expect(blocksToText(renderTemplate(en, { monto: 2400 }, { locale: "en" }).blocks)).toBe("no");
    expect(blocksToText(renderTemplate(en, { monto: 2400 }, { locale: "es" }).blocks)).toBe("si"); // es: 2,5
    expect(blocksToText(renderTemplate("{{#if x == 1,5}}ok{{/if}}", { x: "1,5" }, { locale: "es" }).blocks)).toBe("ok");
    expect(() => parseTemplate("{{#if x > 1,2.3}}a{{/if}}")).toThrow(TemplateSyntaxError);
  });

  it("parseLocaleDate y toIsoDate aceptan AAAA/M/D en cualquier idioma", () => {
    expect(parseLocaleDate("2027/3/1", "es")?.toISOString().slice(0, 10)).toBe("2027-03-01");
    expect(parseLocaleDate("2027/03/01", "en")?.toISOString().slice(0, 10)).toBe("2027-03-01");
    expect(parseLocaleDate("2027/02/31", "es")).toBeNull();
    expect(toIsoDate("2027/3/1", "en")).toBe("2027-03-01");
    expect(toIsoDate("2027/02/30")).toBeNull();
  });

  it("interpolateValue: una sola variable sin filtro conserva el número (2.125 no pasa a 2125)", () => {
    const data = { monto: 2.125, total: "1.500", fecha: "2027-03-01", c: { v: 7 } };
    expect(interpolateValue("{{monto}}", data, "es")).toBe(2.125);
    expect(interpolateValue(" {{ c.v }} ", data, "es")).toBe(7);
    expect(toNumberOrNull(interpolateValue("{{monto}}", data, "es"), "es")).toBe(2.125);
    // Texto escrito por una persona: sigue el idioma.
    expect(toNumberOrNull(interpolateValue("{{total}}", data, "es"), "es")).toBe(1500);
    expect(toIsoDate(interpolateValue("{{fecha}}", data, "es"), "es")).toBe("2027-03-01");
    // Con filtro o con más texto se interpola.
    expect(interpolateValue("{{monto | number}}", data, "es")).toBe("2,13");
    expect(interpolateValue("US$ {{monto}}", data, "es")).toBe("US$ 2.125");
    expect(interpolateValue("{{falta}}", data, "es")).toBe("");
  });

  it("agreementMetaFromMapping conserva un número JSON con decimales (ruta suelta o {{variable}})", () => {
    const data = { monto: 2.125, vence: "2028/1/15" };
    expect(agreementMetaFromMapping({ value: "{{monto}}", expiryDate: "{{vence}}" } as any, data, "es")).toMatchObject({
      value: 2.125,
      expiryDate: "2028-01-15",
    });
    expect(agreementMetaFromMapping({ value: "monto" } as any, data, "es")).toMatchObject({ value: 2.125 });
  });

  it("legacyClauseRecursion: ciclos y niveles de más se omiten (3 niveles) en vez de fallar; renderTemplateCompat lo usa solo ante esos errores", () => {
    const clauses = { a: "A\n{{clausula:b}}", b: "B\n{{clausula:a}}" };
    expect(() => renderTemplate("{{clausula:a}}", {}, { clauses })).toThrow(/ciclo/);
    const legacy = renderTemplate("{{clausula:a}}", {}, { clauses, legacyClauseRecursion: true });
    expect(blocksToText(legacy.blocks).replace(/\s+/g, " ").trim()).toBe("A B A");
    expect(
      blocksToText(renderTemplateCompat("{{clausula:a}}", {}, { clauses }).blocks)
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe("A B A");
    // Sin ciclo, igual que renderTemplate (más de 3 niveles incluidos).
    const deep = { p1: "1\n{{clausula:p2}}", p2: "2\n{{clausula:p3}}", p3: "3\n{{clausula:p4}}", p4: "4" };
    expect(
      blocksToText(renderTemplateCompat("{{clausula:p1}}", {}, { clauses: deep }).blocks)
        .replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 2 3 4");
    // Otros errores de sintaxis siguen fallando.
    expect(() => renderTemplateCompat("{{#if x}}", {}, {})).toThrow(TemplateSyntaxError);
  });
});
