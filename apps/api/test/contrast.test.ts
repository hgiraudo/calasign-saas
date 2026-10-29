// Contraste WCAG del tema de marca (packages/shared/src/white-label.ts).
import { describe, expect, it } from "vitest";
import { contrastRatio, contrastText, darkenToContrast, relativeLuminance, themeToCss } from "@calasign/shared";
import { render } from "../src/notifications/templates";

describe("contraste WCAG", () => {
  it("luminancia y relación de contraste con los valores de referencia", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 6);
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 6);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 6);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    // #767676 es el gris más claro con 4.5:1 sobre blanco.
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#ffffff")).toBeLessThan(4.5);
  });

  it("contrastText elige el texto (blanco u oscuro) con más contraste", () => {
    expect(contrastText("#0b1f3a")).toBe("#ffffff");
    expect(contrastText("#ffffff")).toBe("#0f172a");
    expect(contrastText("#facc15")).toBe("#0f172a");
    // Colores medios: el elegido supera al otro.
    for (const c of ["#14b8a6", "#ef4444", "#6366f1", "#0ea5a4", "#808080"]) {
      const fg = contrastText(c);
      const other = fg === "#ffffff" ? "#0f172a" : "#ffffff";
      expect(contrastRatio(fg, c)).toBeGreaterThan(contrastRatio(other, c));
    }
  });

  it("darkenToContrast llega a 4.5:1 sobre blanco y no toca un color que ya cumple", () => {
    for (const c of ["#14b8a6", "#facc15", "#93c5fd", "#ffffff"]) expect(contrastRatio(darkenToContrast(c), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(darkenToContrast("#0b1f3a")).toBe("#0b1f3a");
  });

  it("themeToCss: sin color de botón, el texto del botón primario contrasta con el color principal; --teal-dark ≥ 4.5:1", () => {
    const css = themeToCss({ primaryColor: "#facc15", secondaryColor: "#5eead4" });
    expect(css).toContain(".btn-primary{color:#0f172a}");
    expect(css).toContain(".stepper li.current .step-n{color:#0f172a}");
    const tealDark = /--teal-dark:(#[0-9a-f]{6})/.exec(css)?.[1];
    expect(tealDark).toBeTruthy();
    expect(contrastRatio(tealDark!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // Con color de texto del botón propio, se respeta.
    expect(themeToCss({ primaryColor: "#facc15", buttonTextColor: "#123456" })).toContain(".btn-primary{color:#123456}");
  });

  it("themeToCss: el texto de .btn-primary sigue ≥ 4.5:1 en hover (también con texto oscuro sobre un color medio)", () => {
    const bgOf = (css: string, re: RegExp) => re.exec(css)?.[1];
    for (const primary of ["#3b82f6", "#22c55e", "#f97316", "#0ea5e9", "#facc15", "#0b1f3a", "#8b5cf6", "#e11d48"]) {
      const css = themeToCss({ primaryColor: primary });
      const fg = bgOf(css, /\.btn-primary\{color:(#[0-9a-f]{6})\}/)!;
      const hover = bgOf(css, /--navy-2:(#[0-9a-f]{6})/)!;
      const hoverFg = bgOf(css, /\.btn-primary:hover\{color:(#[0-9a-f]{6})\}/)!;
      expect(hover, primary).toBeTruthy();
      expect(hoverFg, primary).toBeTruthy();
      expect(contrastRatio(hoverFg, hover), primary).toBeGreaterThanOrEqual(4.5);
      // Con texto blanco el hover sigue oscureciendo (como antes).
      if (fg === "#ffffff") expect(relativeLuminance(hover)).toBeLessThan(relativeLuminance(primary));
    }
    for (const btn of ["#3b82f6", "#22c55e", "#f97316", "#facc15"]) {
      const css = themeToCss({ primaryColor: "#0b1f3a", buttonColor: btn });
      const m = /\.btn-primary:hover\{background:(#[0-9a-f]{6});border-color:#[0-9a-f]{6};color:(#[0-9a-f]{6})\}/.exec(css);
      expect(m, btn).toBeTruthy();
      expect(contrastRatio(m![2], m![1]), btn).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("correos: botón y encabezado sin logo con texto que contrasta", () => {
    const vars = { recipientName: "Ana", senderName: "Juan", organizationName: "ACME", subject: "Contrato", link: "https://x.test/s/1" };
    const light = render("invite", "es", vars, { primaryColor: "#fde047", brandName: "ACME" }).html;
    expect(light).toContain("background:#fde047;color:#0f172a;text-decoration:none");
    expect(light).toContain("background:#fde047;padding:18px 28px;color:#0f172a");
    const own = render("invite", "es", vars, {
      primaryColor: "#fde047",
      brandName: "ACME",
      headerTextColor: "#222222",
      buttonTextColor: "#333333",
    }).html;
    expect(own).toContain("padding:18px 28px;color:#222222");
    expect(own).toContain("color:#333333;text-decoration:none");
  });
});
