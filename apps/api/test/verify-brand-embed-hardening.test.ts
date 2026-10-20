// Verificación con marca blanca (textos del veredicto y CSS propio fuera de /verify), comodines de frame-ancestors y
// destino de postMessage de la página embebida.
import { describe, expect, it } from "vitest";
import { BrandConfigInput, FrameAncestor, isProtectedTextKey, originAllowed, type PublicBrandTheme } from "@calasign/shared";
import { publicTheme, type ResolvedBrand } from "../src/modules/white-label/brand";
import { brandText, setBrandTheme } from "../../web/src/lib/white-label";

describe("textos de la verificación con marca blanca", () => {
  it("las claves del veredicto y del reporte técnico están protegidas; título e intro no", () => {
    for (const k of ["verify.matchTitle", "verify.noMatchTitle", "verify.brokenText", "verify.chainOk", "verify.chainBroken", "verify.hash", "val.intact", "val.broken"]) {
      expect(isProtectedTextKey(k)).toBe(true);
    }
    for (const k of ["verify.title", "verify.text", "sign.doneTitle", "otp.title"]) expect(isProtectedTextKey(k)).toBe(false);
  });

  it("el esquema rechaza un texto propio para el veredicto", () => {
    expect(BrandConfigInput.safeParse({ texts: { es: { "verify.noMatchTitle": "Documento válido ✓" } } }).success).toBe(false);
    expect(BrandConfigInput.safeParse({ texts: { en: { "val.intact": "OK" } } }).success).toBe(false);
    expect(BrandConfigInput.safeParse({ texts: { es: { "verify.title": "Verificá tu documento", "sign.doneTitle": "¡Listo!" } } }).success).toBe(true);
  });

  it("brandText no aplica un texto protegido guardado antes de la validación", () => {
    setBrandTheme({ texts: { es: { "verify.noMatchTitle": "Documento válido ✓", "verify.title": "Mi verificación" } } } as unknown as PublicBrandTheme);
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
  });
});

describe("frame-ancestors con comodín", () => {
  it("exige dos etiquetas y que no sea un sufijo público", () => {
    for (const bad of ["https://*.com", "https://*.com.ar", "https://*.co.uk", "https://*.github.io", "https://*.vercel.app", "https://*.ar"]) {
      expect(FrameAncestor.safeParse(bad).success, bad).toBe(false);
    }
    for (const ok of ["https://*.cliente.com", "https://*.cliente.com.ar", "https://app.cliente.com", "https://cliente.com:8443", "http://localhost:5199"]) {
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
