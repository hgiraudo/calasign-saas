// CSP sin 'unsafe-inline' en style-src (seguridad §5.2): ninguna respuesta lo vuelve a pedir, y el HTML que arma la API
// sólo trae <style> con su hash en el CSP de esa respuesta y ningún atributo style="…". Cubre el index.html con la
// marca (tema y CSS propio), la página sin conexión de la marca, la página neutra de vuelta de un proveedor, la del link
// embebido vencido, la offline de la plataforma (estilos en un archivo) y el marco de las vistas previas de marca blanca,
// que es el único con su propia CSP. App real sobre PGlite, con una web mínima en una carpeta temporal.
import crypto from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WEB = resolve(__dirname, "../../web");
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "calasign-http-estilos-"));
delete process.env.DATABASE_URL;
// La web: el index.html y la página offline de verdad (sin compilar: alcanza para las cabeceras y el HTML).
process.env.WEB_DIST = mkdtempSync(join(tmpdir(), "calasign-http-estilos-web-"));
copyFileSync(join(WEB, "index.html"), join(process.env.WEB_DIST, "index.html"));
copyFileSync(join(WEB, "public/offline.html"), join(process.env.WEB_DIST, "offline.html"));
copyFileSync(join(WEB, "public/offline.css"), join(process.env.WEB_DIST, "offline.css"));
writeFileSync(join(process.env.WEB_DIST, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");

type Db = Awaited<ReturnType<(typeof import("../src/infra/db"))["createDb"]>>;
type App = Awaited<ReturnType<(typeof import("../src/app"))["buildApp"]>>;
let db: Db;
let app: App;
const DOMAIN = "firmas.estilos.test";
const H = (cookie: string) => ({ cookie, origin: "http://localhost:5173" });

beforeAll(async () => {
  const { createDb, migrate } = await import("../src/infra/db");
  const { createBlobStore } = await import("../src/infra/storage");
  const { buildApp } = await import("../src/app");
  const { uuidv7 } = await import("../src/lib/util");
  db = await createDb();
  await migrate(db);
  app = await buildApp({ db, blobs: createBlobStore(), logger: false });
  await app.ready();
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/signup",
    payload: { email: "duena@estilos.test", password: "una-clave-larga-123", name: "Dueña", organization: "Org Estilos" },
  });
  expect(res.statusCode).toBe(201);
  const c = res.cookies.find((x) => x.name.endsWith("cs_session"))!;
  const cookie = `${c.name}=${c.value}`;
  const tenant = (await app.inject({ method: "GET", url: "/v1/me", headers: H(cookie) })).json().tenant.id as string;
  await db.query(`UPDATE tenants SET billing_plan = 'enterprise' WHERE id = $1`, [tenant]);
  // Marca blanca (nombre propio: así se sirve también su página sin conexión) con color y CSS propio.
  const put = await app.inject({
    method: "PUT",
    url: "/v1/settings/brands/default",
    headers: H(cookie),
    payload: { config: { productName: "FirmaAndina", theme: { primaryColor: "#7a1f5c" }, customCss: ".signer-bar{letter-spacing:3px}" } },
  });
  expect(put.statusCode, put.body).toBe(200);
  await db.query(
    `INSERT INTO custom_domains (id, tenant_id, domain, verification_token, status, verified_at) VALUES ($1,$2,$3,'tok','verified',now())`,
    [uuidv7(), tenant, DOMAIN],
  );
}, 120_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.split(/\s+/)[0] === name);
const hashOf = (css: string) => `'sha256-${crypto.createHash("sha256").update(css, "utf8").digest("base64")}'`;

/** El HTML no tiene style="…" y cada <style> lleva su hash en el style-src del CSP; devuelve los <style> que encontró. */
function stylesAllowed(html: string, csp: string): string[] {
  expect(html).not.toMatch(/<[^>]+\sstyle\s*=/i);
  const styleSrc = directive(csp, "style-src") ?? "";
  const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  for (const css of styles) expect(styleSrc.split(/\s+/), `hash del <style>${css.slice(0, 60)}…`).toContain(hashOf(css));
  return styles;
}

describe("CSP sin 'unsafe-inline' en los estilos", () => {
  it("ninguna respuesta lo pide: páginas, API, errores, la página offline y la marca por dominio", async () => {
    const reqs = [
      { url: "/" },
      { url: "/login" },
      { url: "/app/envelopes" },
      { url: "/s/abcdefghijklmnopqrstuvwxyz" },
      { url: "/verify" },
      { url: "/v1/me" },
      { url: "/healthz" },
      { url: "/offline.html" },
      { url: "/embed/abcdefghijklmnopqrstuvwxyz0123" },
      { url: `/v1/payments/return/${crypto.randomUUID()}` },
      { url: "/s/abcdefghijklmnopqrstuvwxyz", headers: { host: DOMAIN } },
      { url: "/offline.html", headers: { host: DOMAIN } },
    ];
    for (const r of reqs) {
      const res = await app.inject({ method: "GET", ...r });
      const csp = String(res.headers["content-security-policy"] ?? "");
      const what = `${r.url} ${r.headers?.host ?? ""}`;
      expect(csp, what).toContain("default-src 'self'");
      expect(directive(csp, "style-src"), what).toMatch(/^style-src 'self' https:\/\/fonts\.googleapis\.com( 'sha256-[A-Za-z0-9+/=]+')*$/);
      // Tampoco por las directivas más finas (que pisarían a style-src).
      expect(csp, what).not.toContain("'unsafe-inline'");
      expect(csp, what).not.toMatch(/style-src-(elem|attr)/);
    }
  });

  it("index.html con la marca (link de firma en su dominio): el CSS del tema y el propio van en un <style> con su hash", async () => {
    const res = await app.inject({ method: "GET", url: "/s/abcdefghijklmnopqrstuvwxyz", headers: { host: DOMAIN } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('id="brand-data"');
    const styles = stylesAllowed(res.body, String(res.headers["content-security-policy"]));
    expect(styles).toHaveLength(1);
    expect(styles[0]).toContain("#7a1f5c");
    expect(styles[0]).toContain("letter-spacing:3px");
    // El de la plataforma no trae ninguno.
    const plain = await app.inject({ method: "GET", url: "/login" });
    expect(plain.statusCode).toBe(200);
    expect(stylesAllowed(plain.body, String(plain.headers["content-security-policy"]))).toEqual([]);
  });

  it("página sin conexión: la de la marca con su <style> por hash; la de la plataforma con la hoja aparte", async () => {
    const own = await app.inject({ method: "GET", url: "/offline.html", headers: { host: DOMAIN } });
    expect(own.statusCode).toBe(200);
    expect(own.body).toContain("Sin conexión");
    expect(own.body).toContain("<title>FirmaAndina</title>");
    const styles = stylesAllowed(own.body, String(own.headers["content-security-policy"]));
    expect(styles).toHaveLength(1);
    expect(styles[0]).toContain("#7a1f5c");

    const plain = await app.inject({ method: "GET", url: "/offline.html" });
    expect(plain.statusCode).toBe(200);
    expect(plain.body).toContain('<link rel="stylesheet" href="/offline.css"');
    expect(stylesAllowed(plain.body, String(plain.headers["content-security-policy"]))).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/offline.css" })).statusCode).toBe(200);
    // El service worker la guarda junto con la página (sin conexión no hay otro lado de donde sacarla).
    expect(readFileSync(join(WEB, "public/sw.js"), "utf8")).toMatch(
      /const OFFLINE_CSS = "\/offline\.css";[\s\S]*PRECACHE = \[OFFLINE_URL, OFFLINE_CSS/,
    );
  });

  it("página neutra de vuelta de un proveedor y link embebido vencido: <style> por hash", async () => {
    const neutral = await app.inject({ method: "GET", url: `/v1/payments/return/${crypto.randomUUID()}` });
    expect(neutral.statusCode).toBe(200);
    expect(neutral.headers["content-type"]).toContain("text/html");
    expect(stylesAllowed(neutral.body, String(neutral.headers["content-security-policy"]))).toHaveLength(1);

    const gone = await app.inject({ method: "GET", url: "/embed/abcdefghijklmnopqrstuvwxyz0123" });
    expect(gone.statusCode).toBe(410);
    expect(gone.body).toContain("Link vencido");
    expect(stylesAllowed(gone.body, String(gone.headers["content-security-policy"]))).toHaveLength(1);
  });

  it("el marco de las vistas previas de marca blanca: su propia CSP, sin red ni formularios, script sólo por hash", async () => {
    const res = await app.inject({ method: "GET", url: "/brand-preview" });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers["content-security-policy"]);
    expect(directive(csp, "default-src")).toBe("default-src 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'self'");
    expect(directive(csp, "form-action")).toBe("form-action 'none'");
    expect(directive(csp, "connect-src")).toBeUndefined();
    // El único script es el suyo, habilitado por su hash (nada de 'unsafe-inline' ni de 'self' para scripts).
    const scripts = [...res.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(1);
    expect(directive(csp, "script-src")).toBe(`script-src ${hashOf(scripts[0])}`);
    // Los estilos en línea, sólo acá (el CSS de la marca y el de los correos).
    expect(directive(csp, "style-src")).toBe("style-src 'unsafe-inline' https://fonts.googleapis.com");
  });
});
