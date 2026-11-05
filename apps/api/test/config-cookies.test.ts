// hostAndParentDomains: el host y sus dominios padre sin sufijos públicos (de ahí sale el dominio de la plataforma que
// un dominio propio no puede reclamar, custom-domains.ts).
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

describe("hostAndParentDomains", () => {
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
});
