// Configuración de la cookie de sesión vieja: dominios para borrarla sin sufijos públicos y fecha de fin de lectura
// validada al arrancar (una fecha ilegible daba NaN y la cookie vieja se leía para siempre).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-config-cookies-"));
const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

describe("dominios de la cookie vieja", () => {
  it("el host y sus padres, nunca un sufijo público", async () => {
    const { hostAndParentDomains } = await import("../src/config");
    expect(hostAndParentDomains("https://app.calasign.com")).toEqual(["app.calasign.com", "calasign.com"]);
    expect(hostAndParentDomains("https://app.calasign.com.ar")).toEqual(["app.calasign.com.ar", "calasign.com.ar"]);
    expect(hostAndParentDomains("https://firmas.cliente.co.uk")).toEqual(["firmas.cliente.co.uk", "cliente.co.uk"]);
    expect(hostAndParentDomains("https://app.ejemplo.com.br")).toEqual(["app.ejemplo.com.br", "ejemplo.com.br"]);
    expect(hostAndParentDomains("https://calasign.vercel.app")).toEqual(["calasign.vercel.app"]);
    expect(hostAndParentDomains("https://com.mx")).toEqual([]);
    expect(hostAndParentDomains("http://localhost:5173")).toEqual([]);
    expect(hostAndParentDomains("http://10.0.0.1")).toEqual([]);
  });

  it("SESSION_COOKIE_PARENT_DOMAINS descarta sufijos públicos", async () => {
    process.env.SESSION_COOKIE_PARENT_DOMAINS = "app.calasign.com.ar, .calasign.com.ar, com.ar, ar";
    const { config } = await import("../src/config");
    expect(config.legacySessionCookieDomains).toEqual(["app.calasign.com.ar", "calasign.com.ar"]);
  });
});

describe("LEGACY_SESSION_COOKIE_READ_UNTIL", () => {
  it("una fecha ilegible aborta el arranque", async () => {
    process.env.LEGACY_SESSION_COOKIE_READ_UNTIL = "10/11/2026 mañana";
    await expect(import("../src/config")).rejects.toThrow(/LEGACY_SESSION_COOKIE_READ_UNTIL/);
  });

  it("una fecha válida se usa", async () => {
    process.env.LEGACY_SESSION_COOKIE_READ_UNTIL = "2026-12-01T00:00:00Z";
    const { config } = await import("../src/config");
    expect(config.legacySessionCookieReadUntil).toBe(Date.parse("2026-12-01T00:00:00Z"));
  });
});
