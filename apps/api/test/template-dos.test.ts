import { describe, expect, it } from "vitest";
import { formatComputed, parseTemplate, renderTemplate } from "@calasign/shared";

// Plantillas que manda la contraparte de una negociación o cualquier cuenta: no pueden colgar el proceso.
describe("motor de plantillas: entradas hostiles", () => {
  it("separador de tabla con muchos espacios y etiquetas sin cerrar en tiempo lineal", () => {
    const t = Date.now();
    parseTemplate("|---|" + " ".repeat(50_000) + "x");
    parseTemplate("{{a}".repeat(50_000));
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it("tope de marcas de firma", () => {
    expect(() => renderTemplate("{{#each items}}\n" + "{{firma:A}} ".repeat(100) + "\n{{/each}}", { items: Array(10).fill(1) })).toThrow(
      /máximo 500/,
    );
  });
  it("las tablas siguen funcionando", () => {
    const b = renderTemplate("| a | b |\n|:---|---:|\n| 1 | 2 |", {}).blocks[0] as any;
    expect(b.type).toBe("table");
    expect(b.header).toHaveLength(2);
    expect(b.rows).toHaveLength(1);
  });
  it("resultados de fórmula fuera de rango quedan vacíos", () => {
    expect(formatComputed(1e308 * 10)).toBeNull();
    expect(formatComputed(1e21)).toBeNull();
    expect(formatComputed(12.345)).toBe("12.35");
  });
});
