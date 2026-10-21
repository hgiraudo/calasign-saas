// SPA servida por la API: index.html sin caché (nombra los archivos con hash del deploy actual) y HEAD igual que GET.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { registerSpa } from "../src/spa";

const root = mkdtempSync(join(tmpdir(), "spa-"));
writeFileSync(join(root, "index.html"), "<!doctype html><title>CalaSign</title>");
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "assets", "index-abc.js"), "console.log(1)");
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function app(branded = false) {
  const a = Fastify();
  await registerSpa(a, {
    root,
    sendBrandedIndex: async (_req, reply) => {
      if (!branded) return false;
      reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").send("<!doctype html><title>Marca</title>");
      return true;
    },
  });
  return a;
}

describe("SPA fallback", () => {
  it("index.html de una ruta de la app sale con cache-control: no-cache (no el max-age=0 de @fastify/static)", async () => {
    const r = await (await app()).inject("/app/envelopes/123");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.body).toContain("<title>CalaSign</title>");
  });

  it("HEAD de una ruta de la app responde como GET (200, sin cuerpo)", async () => {
    const a = await app();
    const r = await a.inject({ method: "HEAD", url: "/s/token-de-firma" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.headers["content-type"]).toContain("text/html");
    expect(r.body).toBe("");
    const branded = await (await app(true)).inject({ method: "HEAD", url: "/s/token-de-firma" });
    expect(branded.statusCode).toBe(200);
    expect(branded.headers["cache-control"]).toBe("no-cache");
  });

  it("los archivos con hash son inmutables y lo que falta (asset, API) es 404", async () => {
    const a = await app();
    const asset = await a.inject("/assets/index-abc.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await a.inject("/assets/index-viejo.js")).statusCode).toBe(404);
    expect((await a.inject({ method: "HEAD", url: "/assets/index-viejo.js" })).statusCode).toBe(404);
    expect((await a.inject("/v1/no-existe")).statusCode).toBe(404);
    expect((await a.inject({ method: "POST", url: "/app" })).statusCode).toBe(404);
  });
});
