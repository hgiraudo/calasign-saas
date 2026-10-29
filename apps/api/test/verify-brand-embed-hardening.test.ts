// Verificación con marca blanca (textos del veredicto y CSS propio fuera de /verify), comodines de frame-ancestors y
// destino de postMessage de la página embebida.
import { describe, expect, it } from "vitest";
import { BrandConfigInput, FrameAncestor, isProtectedTextKey, originAllowed, type PublicBrandTheme } from "@calasign/shared";
import { publicTheme, type ResolvedBrand } from "../src/modules/white-label/brand";
import { isVerifyPath } from "../src/modules/white-label/index";
import { brandText, isVerifyPath as webIsVerifyPath, setBrandTheme, setVerifyPageMode } from "../../web/src/lib/white-label";

describe("textos de la verificación con marca blanca", () => {
  it("las claves del veredicto y del reporte técnico están protegidas; título e intro no", () => {
    for (const k of [
      "verify.matchTitle",
      "verify.noMatchTitle",
      "verify.brokenText",
      "verify.chainOk",
      "verify.chainBroken",
      "verify.hash",
      "val.intact",
      "val.broken",
    ]) {
      expect(isProtectedTextKey(k)).toBe(true);
    }
    for (const k of ["verify.title", "verify.text", "sign.doneTitle", "otp.title"]) expect(isProtectedTextKey(k)).toBe(false);
  });

  it("el esquema descarta (no rechaza) un texto propio para el veredicto", () => {
    expect(BrandConfigInput.parse({ texts: { es: { "verify.noMatchTitle": "Documento válido ✓", "sign.doneTitle": "¡Listo!" } } }).texts).toEqual({
      es: { "sign.doneTitle": "¡Listo!" },
    });
    expect(BrandConfigInput.parse({ texts: { en: { "val.intact": "OK" } } }).texts).toEqual({ en: {} });
    expect(BrandConfigInput.safeParse({ texts: { es: { "verify.title": "Verificá tu documento", "sign.doneTitle": "¡Listo!" } } }).success).toBe(
      true,
    );
  });

  it("brandText no aplica un texto protegido guardado antes de la validación", () => {
    setBrandTheme({
      texts: { es: { "verify.noMatchTitle": "Documento válido ✓", "verify.title": "Mi verificación" } },
    } as unknown as PublicBrandTheme);
    try {
      expect(brandText("es", "verify.noMatchTitle", "El documento no coincide")).toBe("El documento no coincide");
      expect(brandText("es", "verify.title", "Verificar")).toBe("Mi verificación");
    } finally {
      setBrandTheme(null);
    }
  });

  it("publicTheme para /verify: sin CSS propio, sin fondo ni color de texto y sin textos protegidos", () => {
    const b = {
      brandId: null,
      key: "acme",
      name: "ACME",
      productName: null,
      whiteLabel: false,
      theme: {
        primaryColor: "#112233",
        secondaryColor: null,
        backgroundColor: "#ffffff",
        textColor: "#ffffff",
        buttonColor: "#00aa55",
        buttonTextColor: null,
        headerTextColor: null,
        borderRadius: null,
        fontFamily: null,
        fontSource: null,
      },
      customCss: ".final-icon{display:none}",
      links: { websiteUrl: null, supportUrl: null, privacyUrl: null, termsUrl: null },
      texts: { es: { "verify.matchTitle": "x", "sign.doneTitle": "¡Listo!" } },
      assets: {},
      baseUrl: "https://acme.test",
    } as unknown as ResolvedBrand;
    const full = publicTheme(b);
    expect(full.css).toContain(".final-icon{display:none}");
    expect(full.texts.es).toEqual({ "sign.doneTitle": "¡Listo!" });
    const v = publicTheme(b, { verify: true });
    expect(v.css).not.toContain("final-icon");
    expect(v.css).toContain("--navy:#112233");
    expect(v.css).toContain(".btn-primary{background:#00aa55");
    expect(v.css).not.toContain("--bg:");
    expect(v.css).not.toContain("--text:");
    expect(v.pageCss).toBeUndefined();
    // El index.html de /verify lleva además el CSS completo (pageCss) para restaurarlo al salir navegando.
    expect(publicTheme(b, { verify: true, withPageCss: true }).pageCss).toBe(full.css);
  });

  it("/verify con barra final también es la verificación (servidor y web)", () => {
    for (const f of [isVerifyPath, webIsVerifyPath]) {
      expect(f("/verify")).toBe(true);
      expect(f("/verify/")).toBe(true);
      expect(f("/verifyx")).toBe(false);
      expect(f("/s/verify")).toBe(false);
    }
  });

  it("al salir de /verify navegando dentro de la web se restaura el CSS completo de la marca", () => {
    const els = new Map<string, any>();
    const fakeDoc = {
      head: { appendChild: (el: any) => els.set(el.id, el) },
      getElementById: (id: string) => els.get(id) ?? null,
      createElement: () => ({ id: "", textContent: "", remove() {} }),
      querySelector: () => null,
    };
    const g = globalThis as { document?: unknown };
    const prev = g.document;
    g.document = fakeDoc;
    try {
      setVerifyPageMode(true);
      setBrandTheme({
        theme: { fontSource: null },
        css: ":root{--navy:#112233}",
        pageCss: ":root{--navy:#112233}\n.x{}",
        texts: {},
      } as unknown as PublicBrandTheme);
      expect(els.get("brand-theme").textContent).not.toContain(".x{}");
      setVerifyPageMode(false);
      expect(els.get("brand-theme").textContent).toBe(":root{--navy:#112233}\n.x{}");
    } finally {
      setBrandTheme(null);
      setVerifyPageMode(false);
      g.document = prev;
    }
  });
});

describe("frame-ancestors con comodín", () => {
  it("exige dos etiquetas y que no sea un sufijo público", () => {
    for (const bad of ["https://*.com", "https://*.com.ar", "https://*.co.uk", "https://*.github.io", "https://*.vercel.app", "https://*.ar"]) {
      expect(FrameAncestor.safeParse(bad).success, bad).toBe(false);
    }
    for (const ok of [
      "https://*.cliente.com",
      "https://*.cliente.com.ar",
      "https://app.cliente.com",
      "https://cliente.com:8443",
      "http://localhost:5199",
    ]) {
      expect(FrameAncestor.safeParse(ok).success, ok).toBe(true);
    }
  });

  it("originAllowed: exacto y comodín", () => {
    const list = ["https://app.cliente.com", "https://*.otro.com"];
    expect(originAllowed("https://app.cliente.com", list)).toBe(true);
    expect(originAllowed("https://x.otro.com", list)).toBe(true);
    expect(originAllowed("https://otro.com", list)).toBe(false);
    expect(originAllowed("https://evil.com", list)).toBe(false);
    expect(originAllowed("http://x.otro.com", list)).toBe(false);
  });
});
