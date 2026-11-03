// Seguridad en el navegador: lo que los tests de la API no ven porque depende de cómo el navegador aplica la CSP, arma
// el DOM y enmarca páginas. Cero violaciones de la CSP en las pantallas críticas (la CSP no admite estilos ni scripts
// en línea, seguridad §5.2), XSS almacenado en los datos de un sobre, clickjacking y la sesión después de salir.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { altaDeCuenta, firmarPorApi, pdfSellado, sobreEnviado, tinyPdf, type Cuenta } from "./helpers/api";
import { vigilarCsp, vigilarErrores } from "./helpers/pagina";

const MARCA = { theme: { primaryColor: "#7a1f5c" }, customCss: ".signer-bar{letter-spacing:3px}" };
const COLOR_MARCA = "rgb(122, 31, 92)";

async function json<T>(res: APIResponse): Promise<T> {
  expect(res.ok(), `${res.url()} → HTTP ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** Marca de la organización: color de la barra y CSS propio (sin 'unsafe-inline' llegan por hash o por hoja construida). */
async function conMarca(request: APIRequestContext) {
  await json(await request.put("/v1/settings/brands/default", { data: { config: MARCA } }));
}

/** Sobre en borrador con un PDF (para el editor). */
async function borradorConPdf(request: APIRequestContext, subject: string): Promise<{ id: string; documentId: string }> {
  const { envelope } = await json<{ envelope: { id: string } }>(await request.post("/v1/envelopes", { data: { subject } }));
  const doc = await json<{ id: string }>(
    await request.post(`/v1/envelopes/${envelope.id}/documents`, {
      multipart: { file: { name: "contrato.pdf", mimeType: "application/pdf", buffer: tinyPdf() } },
    }),
  );
  return { id: envelope.id, documentId: doc.id };
}

/**
 * Sobre enviado con un firmante embebido (sin invitaciones) y la organización autorizada a enmarcarlo desde
 * `integrador`. Devuelve el asunto y cómo pedir una URL de firma de un solo uso (su camino, /embed/…).
 */
async function firmanteEmbebido(request: APIRequestContext, cuenta: Cuenta, integrador: string) {
  await json(await request.patch("/v1/settings/embed", { data: { frameAncestors: [integrador] } }));
  const subject = `Embebido ${cuenta.stamp}`;
  const { id, documentId } = await borradorConPdf(request, subject);
  const recipientId = crypto.randomUUID();
  await json(
    await request.put(`/v1/envelopes/${id}/recipients`, {
      data: { recipients: [{ id: recipientId, name: `Iván Embebido ${cuenta.stamp}`, embedded: true, routingOrder: 1 }] },
    }),
  );
  await json(
    await request.put(`/v1/envelopes/${id}/fields`, {
      data: { fields: [{ documentId, recipientId, type: "signature", page: 0, x: 0.1, y: 0.6, width: 0.3, height: 0.08 }] },
    }),
  );
  await json(await request.post(`/v1/envelopes/${id}/send`));
  const url = async () =>
    new URL((await json<{ url: string }>(await request.post(`/v1/envelopes/${id}/recipients/${recipientId}/signing-url`, { data: {} }))).url)
      .pathname;
  return { subject, url };
}

async function login(page: Page, cuenta: Cuenta) {
  await page.goto("/login");
  await page.getByRole("textbox", { name: "Email" }).fill(cuenta.email);
  await page.getByRole("textbox", { name: "Contraseña" }).fill(cuenta.password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page).toHaveURL(/\/app/);
}

/** ¿Algún elemento del documento (de la página o de un marco) tiene este color de fondo? */
const hayFondo = (_: Element, color: string) =>
  Array.from(document.querySelectorAll("*")).some((el) => getComputedStyle(el).backgroundColor === color);

test.describe("seguridad en el navegador", () => {
  test.describe("CSP sin violaciones", () => {
    test("firmante con la marca de la organización: consentimiento, PDF, firma, pase al celular y fin", async ({ page, request, browser }) => {
      const csp = await vigilarCsp(page);
      const sinErrores = vigilarErrores(page);
      const cuenta = await altaDeCuenta(request);
      await conMarca(request);
      const sobre = await sobreEnviado(request, cuenta);

      await page.goto(`/s/${sobre.token}`);
      await expect(page.getByRole("heading", { name: `Contrato web ${cuenta.stamp}` })).toBeVisible();
      await page.getByRole("checkbox", { name: /Acepto firmar electrónicamente/ }).check();
      await page.getByRole("button", { name: "Acepto y continúo" }).click();
      await expect(page.getByRole("group", { name: "contrato.pdf — 1" })).toContainText("Contrato de prueba web - pagina 1");

      // La marca se aplica sin 'unsafe-inline': color de la barra y CSS propio.
      const barra = page.getByRole("banner").first();
      await expect(barra).toBeVisible();
      expect(await barra.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(COLOR_MARCA);
      expect(await barra.evaluate((el) => getComputedStyle(el).letterSpacing)).toBe("3px");

      await page.getByRole("button", { name: /activar para firmar/ }).click();
      const pad = page.getByRole("dialog", { name: "Adoptá tu firma" });
      await pad.getByRole("tab", { name: "Dibujar" }).click();
      await pad.getByRole("button", { name: "Dibujar en el celular" }).click();
      const url = await pad.getByRole("textbox", { name: "Link para el celular" }).inputValue();
      expect(url).toMatch(/\/h\/[A-Za-z0-9_-]{43}$/);

      // La página del pase al celular, en otro contexto (otro teléfono).
      const ctxCelular = await browser.newContext({ viewport: { width: 412, height: 860 }, locale: "es-AR" });
      const celular = await ctxCelular.newPage();
      const cspCelular = await vigilarCsp(celular);
      await celular.goto(url);
      await expect(celular.getByRole("heading", { name: "Dibujá tu firma" })).toBeVisible();
      await expect(celular.getByRole("img", { name: "Lienzo para dibujar la firma" })).toBeVisible();
      cspCelular();
      await ctxCelular.close();

      await pad.getByRole("tab", { name: "Escribir" }).click();
      await pad.getByRole("button", { name: "Adoptar y firmar" }).click();
      await expect(page.getByRole("button", { name: "Firma: firmado" })).toBeVisible();
      await page.getByRole("main").getByRole("button", { name: "Finalizar" }).click();
      await expect(page.getByRole("heading", { name: "¡Listo! Firmaste el documento" })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("main").getByText("El documento está completo y sellado.")).toBeVisible({ timeout: 30_000 });
      csp();
      sinErrores();
    });

    test("consola tras el login: lista, detalle, editor de un borrador y Marca con sus vistas previas", async ({ page, request }) => {
      const csp = await vigilarCsp(page);
      const sinErrores = vigilarErrores(page);
      const cuenta = await altaDeCuenta(request);
      await conMarca(request);
      const sobre = await sobreEnviado(request, cuenta);
      const borrador = await borradorConPdf(request, `Borrador web ${cuenta.stamp}`);
      await json(
        await request.put(`/v1/envelopes/${borrador.id}/recipients`, {
          data: { recipients: [{ name: "Rita Borrador", email: `rita+${cuenta.stamp}@example.com`, routingOrder: 1, channels: ["email"] }] },
        }),
      );
      await login(page, cuenta);

      await page.getByText(`Contrato web ${cuenta.stamp}`).first().click();
      await expect(page).toHaveURL(new RegExp(`/app/envelopes/${sobre.envelopeId}`));
      await expect(page.getByText(sobre.signerName).first()).toBeVisible();

      // El editor dibuja el PDF con pdf.js (capa de texto incluida).
      await page.goto(`/app/envelopes/${borrador.id}/edit`);
      await page.getByRole("button", { name: "3 Campos" }).click();
      await expect(page.getByRole("group", { name: "contrato.pdf — 1" })).toContainText("Contrato de prueba web - pagina 1");

      await page.goto("/app/settings/branding");
      await expect(page.getByRole("heading", { name: "Marca y marca blanca", level: 1 })).toBeVisible();
      // Vista previa de la página de firma, en su marco con CSP propia (/brand-preview): el <style> del tema se aplica.
      const previa = page.getByTitle("Vista previa: página de firma").contentFrame();
      await expect(previa.getByText("Firmar").first()).toBeVisible();
      await expect.poll(() => previa.locator("body").evaluate(hayFondo, COLOR_MARCA)).toBe(true);
      // La del correo: el HTML va con style="…" (lo que leen los clientes de correo).
      await page.getByRole("tab", { name: "Correos y SMS" }).click();
      const correo = page.getByTitle("Vista previa del correo").contentFrame();
      await expect(correo.locator("body")).not.toBeEmpty();
      await expect.poll(() => correo.locator("body").evaluate(hayFondo, COLOR_MARCA)).toBe(true);
      csp();
      sinErrores();
    });

    test("/verify con un PDF sellado y /developers", async ({ page, request }) => {
      const csp = await vigilarCsp(page);
      const sinErrores = vigilarErrores(page);
      const cuenta = await altaDeCuenta(request);
      const sobre = await sobreEnviado(request, cuenta);
      await firmarPorApi(request, sobre.token);
      const pdf = await pdfSellado(request, sobre.envelopeId);

      await page.goto("/verify");
      await expect(page.getByRole("heading", { name: "Verificar un documento" })).toBeVisible();
      await page.locator('input[type="file"]').first().setInputFiles({ name: "firmado.pdf", mimeType: "application/pdf", buffer: pdf });
      await expect(page.getByRole("heading", { name: "Documento válido" })).toBeVisible();

      await page.goto("/developers");
      await expect(page.getByRole("heading", { name: "Documentación para desarrolladores", level: 1 })).toBeVisible();
      csp();
      sinErrores();
    });
  });

  test.describe("XSS almacenado", () => {
    // Con la CSP apagada: acá se prueba que la web escapa los datos. Con la CSP prendida un manejador on…= inyectado no
    // correría igual (script-src-attr 'none') y el test no vería el escape roto.
    test.use({ bypassCSP: true });

    const payloads = (stamp: string) => ({
      subject: `Contrato <img src=x onerror="window.__xss='asunto'"> ${stamp}`,
      message: `Hola "><svg onload="window.__xss='mensaje'"></svg><script>window.__xss='script'</script> firmá`,
      signerName: `Ana "><img src=x onerror="window.__xss='firmante'"> ${stamp}`,
      // Sin comillas: el multipart de Playwright no las escapa en filename="…" y el nombre llegaba cortado.
      fileName: `<img src=x onerror=window.__xss=5>.pdf`,
    });
    /** Ni un elemento inyectado ni un script que haya corrido. */
    const sinInyectar = async (page: Page) => {
      expect(await page.evaluate(() => (window as unknown as { __xss?: string }).__xss)).toBeUndefined();
      expect(await page.evaluate(() => document.querySelectorAll('img[src="x"], svg[onload], script:not([src]):not([type])').length)).toBe(0);
    };

    test("en el firmante, el asunto, el mensaje, el nombre y el archivo se muestran como texto", async ({ page, request }) => {
      const sinErrores = vigilarErrores(page);
      const cuenta = await altaDeCuenta(request);
      const p = payloads(cuenta.stamp);
      const sobre = await sobreEnviado(request, cuenta, p);

      await page.goto(`/s/${sobre.token}`);
      await expect(page.getByRole("heading", { name: p.subject })).toBeVisible();
      await expect(page.getByText(p.message)).toBeVisible();
      await page.getByRole("checkbox", { name: /Acepto firmar electrónicamente/ }).check();
      await page.getByRole("button", { name: "Acepto y continúo" }).click();
      await expect(page.getByRole("group", { name: `${p.fileName} — 1` })).toContainText("Contrato de prueba web - pagina 1");
      await page.getByRole("button", { name: /activar para firmar/ }).click();
      const pad = page.getByRole("dialog", { name: "Adoptá tu firma" });
      await expect(pad.getByRole("textbox", { name: "Escribí tu nombre" })).toHaveValue(p.signerName);
      await sinInyectar(page);
      sinErrores();
    });

    test("en la consola, la lista y el detalle del sobre los muestran como texto", async ({ page, request }) => {
      const sinErrores = vigilarErrores(page);
      const cuenta = await altaDeCuenta(request);
      const p = payloads(cuenta.stamp);
      const sobre = await sobreEnviado(request, cuenta, p);
      await login(page, cuenta);

      const asunto = page.getByText(p.subject).first();
      await expect(asunto).toBeVisible();
      await sinInyectar(page);
      await asunto.click();
      await expect(page).toHaveURL(new RegExp(`/app/envelopes/${sobre.envelopeId}`));
      await expect(page.getByText(p.signerName).first()).toBeVisible();
      await expect(page.getByText(p.fileName).first()).toBeVisible();
      await sinInyectar(page);
      sinErrores();
    });

    test("un link de la marca con javascript: se rechaza; el que se guarda llega al firmante como https", async ({ page, request }) => {
      const sinErrores = vigilarErrores(page);
      const cuenta = await altaDeCuenta(request);
      const malo = await request.put("/v1/settings/brands/default", {
        data: { config: { links: { supportUrl: "javascript:window.__xss='link'" } } },
      });
      expect(malo.status()).toBe(400);
      await json(await request.put("/v1/settings/brands/default", { data: { config: { links: { supportUrl: "https://ayuda.example.com/" } } } }));
      const sobre = await sobreEnviado(request, cuenta);

      await page.goto(`/s/${sobre.token}`);
      await expect(page.getByRole("heading", { name: `Contrato web ${cuenta.stamp}` })).toBeVisible();
      await expect(page.getByRole("link", { name: "Soporte" })).toHaveAttribute("href", "https://ayuda.example.com/");
      expect(await page.evaluate(() => Array.from(document.links).filter((a) => /^\s*javascript:/i.test(a.getAttribute("href") ?? "")).length)).toBe(
        0,
      );
      sinErrores();
    });
  });

  test.describe("enmarcado y cabeceras", () => {
    test("las páginas de la web no se dejan enmarcar, no se reinterpretan y no admiten estilos en línea", async ({ request }) => {
      const cuenta = await altaDeCuenta(request);
      const sobre = await sobreEnviado(request, cuenta);
      for (const url of ["/", "/login", "/app", "/app/envelopes", `/s/${sobre.token}`, "/verify", "/developers"]) {
        const res = await request.get(url);
        expect(res.status(), url).toBe(200);
        expect(res.headers()["content-type"], url).toContain("text/html");
        const csp = res.headers()["content-security-policy"] ?? "";
        expect(csp, url).toMatch(/(^|;)\s*frame-ancestors 'none'\s*(;|$)/);
        expect(csp, url).toMatch(/(^|;)\s*style-src 'self' https:\/\/fonts\.googleapis\.com\s*(;|$)/);
        expect(res.headers()["x-frame-options"], url).toBe("SAMEORIGIN");
        expect(res.headers()["x-content-type-options"], url).toBe("nosniff");
      }
    });

    test("un sitio ajeno no enmarca el login, el firmante ni la firma embebida; el integrador autorizado sí", async ({ page, request, baseURL }) => {
      // Los sitios ajenos: un servidor local del test en 127.0.0.1 (el integrador autorizado) y el mismo como localhost
      // (otro origen: el atacante). Locales a propósito: Chromium no deja que una página pública enmarque localhost
      // (Local Network Access) y la API sólo acepta http como origen autorizado para 127.0.0.1 y localhost.
      const paginas = new Map<string, string>();
      const servidor = createServer((req, res) => {
        const html = paginas.get(req.url ?? "");
        res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(html ?? "");
      });
      await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
      try {
        const puerto = (servidor.address() as AddressInfo).port;
        const integrador = `http://127.0.0.1:${puerto}`;
        const atacante = `http://localhost:${puerto}`;
        const base = new URL(baseURL!).origin;
        const cuenta = await altaDeCuenta(request);
        const sobre = await sobreEnviado(request, cuenta);
        const embebido = await firmanteEmbebido(request, cuenta, integrador);
        // Página con iframes; cuenta las cargas (también la de un marco bloqueado, que queda en la página de error).
        const sitio = (marcos: string[]) =>
          `<!doctype html><title>Sitio</title>` +
          marcos.map((u, i) => `<iframe name="m${i}" src="${u}" onload="window.cargados=(window.cargados||0)+1"></iframe>`).join("");
        paginas.set("/integrador", sitio([`${base}${await embebido.url()}`]));
        paginas.set("/atacante", sitio([`${base}/login`, `${base}/s/${sobre.token}`, `${base}${await embebido.url()}`]));

        // Control positivo: el integrador autorizado muestra la firma embebida (el arnés de marcos funciona).
        await page.goto(`${integrador}/integrador`);
        await expect(page.frameLocator('iframe[name="m0"]').getByRole("heading", { name: embebido.subject })).toBeVisible();

        await page.goto(`${atacante}/atacante`);
        await expect.poll(() => page.evaluate(() => (window as unknown as { cargados?: number }).cargados ?? 0)).toBe(3);
        for (const nombre of ["m0", "m1", "m2"]) {
          const marco = page.frame({ name: nombre });
          expect(marco, nombre).toBeTruthy();
          // El navegador no cargó el documento (frame-ancestors): el marco quedó en su página de error, sin la app.
          const conApp = await marco!.evaluate(() => document.getElementById("root") !== null).catch(() => false);
          expect(conApp, `${nombre} no debería mostrar la app`).toBe(false);
        }
        await expect(page.frameLocator('iframe[name="m0"]').getByRole("button", { name: "Ingresar" })).toHaveCount(0);
      } finally {
        servidor.close();
      }
    });
  });

  test.describe("sesión", () => {
    test("después de salir, ni volver atrás ni pedir una ruta de la consola muestra datos", async ({ page, request }) => {
      const sinErrores = vigilarErrores(page);
      const cuenta = await altaDeCuenta(request);
      const sobre = await sobreEnviado(request, cuenta);
      const asunto = `Contrato web ${cuenta.stamp}`;
      await login(page, cuenta);
      await page.goto(`/app/envelopes/${sobre.envelopeId}`);
      await expect(page.getByText(sobre.signerName).first()).toBeVisible();

      await page.getByRole("button", { name: "Salir" }).click();
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole("button", { name: "Ingresar" })).toBeVisible();
      expect((await page.request.get("/v1/me")).status()).toBe(401);

      await page.goBack();
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole("button", { name: "Ingresar" })).toBeVisible();
      await expect(page.getByText(sobre.signerName)).toHaveCount(0);
      await expect(page.getByText(asunto)).toHaveCount(0);

      for (const url of [`/app/envelopes/${sobre.envelopeId}`, "/app", "/app/settings/branding"]) {
        await page.goto(url);
        await expect(page, url).toHaveURL(/\/login/);
        await expect(page.getByRole("button", { name: "Ingresar" })).toBeVisible();
        await expect(page.getByText(asunto)).toHaveCount(0);
      }
      sinErrores();
    });
  });
});
