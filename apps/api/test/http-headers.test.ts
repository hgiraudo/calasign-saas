// Encabezados HTTP globales: cache-control por defecto de /v1/*, Permissions-Policy, CSP con Turnstile solo en /f/* y /wf/* y
// la cookie de sesión __Host-cs_session (con HTTPS) leyendo todavía la de nombre viejo. App real sobre PGlite.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-http-headers-"));
delete process.env.DATABASE_URL;
// Antes de importar config: cookie Secure (como en dev/producción) y Turnstile configurado.
process.env.COOKIE_SECURE = "true";
process.env.TURNSTILE_SITE_KEY = "site-key-test";
process.env.TURNSTILE_SECRET_KEY = "secret-key-test";
process.env.SESSION_COOKIE_PARENT_DOMAINS = "app.calasign.test,calasign.test";

type Db = Awaited<ReturnType<typeof import("../src/infra/db")["createDb"]>>;
type App = Awaited<ReturnType<typeof import("../src/app")["buildApp"]>>;
let db: Db;
let app: App;
let session = "";
const ORIGIN = { origin: "http://localhost:5173" };

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email: "duena@headers.test", password: "una-clave-larga-123", name: "Dueña", organization: "Org Headers" },
  });
  expect(res.statusCode).toBe(201);
  const c = res.cookies.find((x) => x.name === "__Host-cs_session")!;
  expect(c).toBeTruthy();
  expect(c.secure).toBe(true);
  expect(c.path).toBe("/");
  expect(c.domain).toBeUndefined();
  expect(res.cookies.some((x) => x.name === "cs_session" && x.value)).toBe(false);
  session = c.value;
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

describe("cache-control por defecto en /v1/*", () => {
  it("una respuesta de la API sin cache-control propio sale private, no-store (también los errores)", async () => {
    const me = await app.inject({ method: "GET", url: "/v1/me", cookies: { "__Host-cs_session": session } });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("private, no-store");
    const anon = await app.inject({ method: "GET", url: "/v1/me" });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers["cache-control"]).toBe("private, no-store");
  });
  it("respeta el cache-control que pone la ruta (OpenAPI público)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
  });
  it("fuera de /v1/ no se agrega", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.headers["cache-control"]).toBeUndefined();
  });
});

describe("Permissions-Policy y CSP", () => {
  it("Permissions-Policy en toda respuesta: cámara solo para el propio origen, el resto deshabilitado", async () => {
    for (const url of ["/healthz", "/v1/me", "/s/abc"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.headers["permissions-policy"]).toBe("camera=(self), microphone=(), geolocation=(), payment=(), usb=()");
    }
  });
  it("Turnstile solo en el CSP de las páginas con captcha (/f/* y /wf/*)", async () => {
    for (const url of ["/f/un-formulario", "/wf/un-flujo"]) {
      const form = String((await app.inject({ method: "GET", url })).headers["content-security-policy"]);
      expect(form).toMatch(/(^|;)script-src 'self' https:\/\/challenges\.cloudflare\.com(;|$)/);
      expect(form).toMatch(/(^|;)frame-src 'self' https:\/\/challenges\.cloudflare\.com(;|$)/);
      // script-src-attr no se toca.
      expect(form).toMatch(/script-src-attr 'none'/);
    }
    for (const url of ["/login", "/s/abc", "/v1/me", "/app/f/x", "/app/wf/x", "/wfx"]) {
      const csp = String((await app.inject({ method: "GET", url })).headers["content-security-policy"]);
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("challenges.cloudflare.com");
    }
  });
});

describe("cookie de sesión __Host-cs_session", () => {
  it("la cookie de nombre viejo (cs_session) sigue valiendo durante la transición", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me", cookies: { cs_session: session } });
    expect(res.statusCode).toBe(200);
  });
  it("el logout cierra la sesión y borra las dos cookies (con Secure)", async () => {
    const login = await app.inject({ method: "POST", url: "/v1/auth/login", headers: ORIGIN, payload: { email: "duena@headers.test", password: "una-clave-larga-123" } });
    expect(login.statusCode).toBe(200);
    const tok = login.cookies.find((x) => x.name === "__Host-cs_session")!.value;
    const out = await app.inject({ method: "POST", url: "/v1/auth/logout", headers: ORIGIN, cookies: { cs_session: tok } });
    expect(out.statusCode).toBe(204);
    const cleared = out.cookies.filter((x) => !x.value);
    // La vieja también con Domain= de los dominios configurados (una plantada desde un subdominio).
    expect(cleared.map((x) => `${x.name}@${x.domain ?? ""}`).sort()).toEqual([
      "__Host-cs_session@",
      "cs_session@",
      "cs_session@app.calasign.test",
      "cs_session@calasign.test",
    ]);
    expect(cleared.every((x) => x.secure && x.path === "/")).toBe(true);
    expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { "__Host-cs_session": tok } })).statusCode).toBe(401);
  });
  it("pasada la fecha de la transición, la cookie vieja ya no abre sesión", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-10T00:00:01Z"));
      // (La sesión misma también vence a los 14 días: el control positivo con la cookie vieja está en el primer caso.)
      const { sessionCookieToken } = await import("../src/modules/context");
      expect(sessionCookieToken({ cookies: { cs_session: "viejo" } } as any)).toBeUndefined();
      expect(sessionCookieToken({ cookies: { "__Host-cs_session": "nuevo", cs_session: "viejo" } } as any)).toBe("nuevo");
      vi.setSystemTime(new Date("2026-11-09T23:59:59Z"));
      expect(sessionCookieToken({ cookies: { cs_session: "viejo" } } as any)).toBe("viejo");
    } finally {
      vi.useRealTimers();
    }
  });
});
