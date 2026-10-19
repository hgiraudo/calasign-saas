// Marca blanca: CSS del tema, saneamiento del CSS propio, plantillas de correo y textos del certificado.
import { describe, expect, it } from "vitest";
import { BrandConfigInput, customCssProblem, fillTemplate, themeToCss } from "@calasign/shared";
import { labels } from "../../../packages/pdf/src/i18n";
import { brandText, render } from "../src/notifications/templates";
import { mergeConfig } from "../src/modules/white-label/brand";

const vars = { recipientName: "Ana", senderName: "Juan", organizationName: "ACME", subject: "Contrato", link: "https://firmas.acme.com/s/x" };

describe("CSS de la marca", () => {
  it("genera variables y reglas del tema", () => {
    const css = themeToCss({ primaryColor: "#112233", buttonColor: "#00aa55", borderRadius: 4, fontFamily: "Montserrat", fontSource: "google" });
    expect(css).toContain("--navy:#112233");
    expect(css).toContain(".btn-primary{background:#00aa55");
    expect(css).toContain("--radius:4px");
    expect(css).toContain('--font:"Montserrat"');
  });
  it("ignora valores inválidos", () => {
    expect(themeToCss({ primaryColor: "red;}body{x:y" as never, fontFamily: "x\"}" })).toBe("");
  });
  it("rechaza CSS que carga recursos o escapa del <style>", () => {
    for (const bad of ["a{background:url(x)}", "@import 'x';", "a{b:c}</style><script>", "a{background:\\75rl(x)}", "a{background-image:image-set('x' 1x)}"]) {
      expect(customCssProblem(bad)).not.toBeNull();
    }
    expect(customCssProblem(".signer-bar{letter-spacing:.02em}")).toBeNull();
  });
});

describe("plantillas de correo", () => {
  it("reemplaza variables", () => {
    expect(fillTemplate("Hola {{ recipientName }}: {{subject}} {{nada}}", { recipientName: "Ana", subject: "X" })).toBe("Hola Ana: X ");
  });
  it("marca blanca total: sin la plataforma y con la plantilla propia", () => {
    const m = render("invite", "es", vars, {
      productName: "FirmaPro",
      hidePoweredBy: true,
      brandName: "ACME",
      template: { subject: "{{organizationName}} pide tu firma", body: "Hola {{recipientName}}\n\nUsá {{productName}}", cta: "Firmar" },
    });
    expect(m.subject).toBe("ACME pide tu firma");
    expect(m.cta).toBe("Firmar");
    expect(`${m.subject}${m.text}${m.html}`).not.toMatch(/calasign/i);
    expect(m.text).toContain("Usá FirmaPro");
  });
  it("sin marca blanca conserva el pie de la plataforma", () => {
    expect(render("invite", "es", vars).html).toContain("CalaSign");
  });
  it("certificate_request nombra al producto de la marca", () => {
    const m = render("certificate_request", "en", vars, { productName: "FirmaPro" });
    expect(m.text).toContain("FirmaPro Signer");
    expect(m.text).not.toMatch(/CalaSign/);
  });
  it("brandText quita el correo de contacto de la plataforma", () => {
    expect(brandText("escribinos a contacto@calasign.com", { hidePoweredBy: true, brandName: "ACME", supportUrl: "https://ayuda.acme.com" })).toBe("escribinos a https://ayuda.acme.com");
  });
});

describe("certificado", () => {
  it("declaración y pie con el producto, o sin nombrar ninguno", () => {
    expect(labels("es", "FirmaPro").statement).toContain("mediante FirmaPro");
    expect(labels("pt-BR", "").statement).not.toMatch(/CalaSign/);
    expect(labels("en", "").pageFooter).toBe("Envelope");
    expect(labels("es").statement).toContain("CalaSign");
  });
});

describe("sub-marcas", () => {
  it("heredan lo que no definen", () => {
    const base = BrandConfigInput.parse({ productName: "Revendedor", hidePoweredBy: true, theme: { primaryColor: "#111111", buttonColor: "#222222" }, texts: { es: { a: "1", b: "2" } } });
    const sub = BrandConfigInput.parse({ productName: "Cliente", theme: { primaryColor: "#333333" }, texts: { es: { b: "3" } } });
    const m = mergeConfig(base, sub);
    expect(m.productName).toBe("Cliente");
    expect(m.hidePoweredBy).toBe(true);
    expect(m.theme).toMatchObject({ primaryColor: "#333333", buttonColor: "#222222" });
    expect(m.texts?.es).toEqual({ a: "1", b: "3" });
  });

  it("heredan el cuerpo y el botón de una plantilla de la que solo cambian el asunto", () => {
    const base = BrandConfigInput.parse({ templates: { invite: { es: { subject: "Base", body: "Cuerpo", cta: "Firmar" } } } });
    const sub = BrandConfigInput.parse({ templates: { invite: { es: { subject: "Propio", body: null } } } });
    expect(mergeConfig(base, sub).templates?.invite?.es).toEqual({ subject: "Propio", body: "Cuerpo", cta: "Firmar" });
  });
});
