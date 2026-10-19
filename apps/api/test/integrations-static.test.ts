// Encabezados de /integrations/: el complemento de Office se puede mostrar dentro de Office (frame-ancestors, sin
// X-Frame-Options, office.js permitido, COOP unsafe-none) y el resto del sitio queda con el CSP estricto de helmet.
import Fastify from "fastify";
import helmet from "@fastify/helmet";
import { describe, expect, it } from "vitest";
import { integrationsStaticHeaders } from "../src/modules/integrations-static";

async function app() {
  const a = Fastify();
  await a.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } } });
  integrationsStaticHeaders(a);
  for (const p of ["/integrations/office/taskpane.html", "/integrations/calasign.mcpb", "/integrations/gemini-api/example.py", "/app", "/oauth/authorize"]) a.get(p, async () => "x");
  a.get("/integrations/office/missing.html", async (_req, reply) => reply.code(404).send({ error: "nf" }));
  return a;
}

describe("integrationsStaticHeaders", () => {
  it("abre el complemento de Office a los dominios de Office", async () => {
    const r = await (await app()).inject("/integrations/office/taskpane.html");
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toContain("frame-ancestors 'self' https://*.officeapps.live.com");
    expect(csp).toContain("https://*.office.com");
    expect(csp).toContain("script-src 'self' https://appsforoffice.microsoft.com");
    expect(r.headers["x-frame-options"]).toBeUndefined();
    expect(r.headers["cross-origin-opener-policy"]).toBe("unsafe-none");
    expect(r.headers["cache-control"]).toBe("no-cache");
  });

  it("el consentimiento OAuth se puede abrir desde el diálogo de Office (COOP unsafe-none, CSP sin cambios)", async () => {
    const a = await app();
    const r = await a.inject("/oauth/authorize?client_id=x");
    expect(r.headers["cross-origin-opener-policy"]).toBe("unsafe-none");
    expect(String(r.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
    expect((await a.inject("/app")).headers["cross-origin-opener-policy"]).toBe("same-origin");
  });

  it("no cambia el CSP fuera del complemento", async () => {
    const a = await app();
    for (const p of ["/integrations/calasign.mcpb", "/app"]) {
      const r = await a.inject(p);
      expect(String(r.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
      expect(r.headers["x-frame-options"]).toBe("SAMEORIGIN");
    }
    const mcpb = await a.inject("/integrations/calasign.mcpb");
    expect(mcpb.headers["content-type"]).toBe("application/zip");
    expect(mcpb.headers["cache-control"]).toBe("no-cache");
    expect((await a.inject("/integrations/gemini-api/example.py")).headers["content-type"]).toBe("text/plain; charset=utf-8");
  });

  it("los errores conservan los encabezados por defecto", async () => {
    const r = await (await app()).inject("/integrations/office/missing.html");
    expect(r.statusCode).toBe(404);
    expect(String(r.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
  });
});
