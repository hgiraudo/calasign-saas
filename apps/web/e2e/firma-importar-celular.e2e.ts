// «Adoptá tu firma» con las dos formas nuevas: importar una imagen (PNG con fondo blanco, que se vuelve transparente)
// y dibujar en el celular (link /h/<token> abierto en otra página, firma con el mouse, la computadora la recibe y
// finaliza). La evidencia del sobre dice cómo se hizo cada firma.
import { deflateSync } from "node:zlib";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { altaDeCuenta, sobreEnviado } from "./helpers/api";
import { vigilarErrores } from "./helpers/pagina";

/** PNG RGB opaco: fondo blanco (un papel escaneado) con un trazo negro en zigzag. Generado acá, sin datos reales. */
function firmaEnPapel(w = 320, h = 110): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0xff);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  for (let x = 20; x < w - 20; x++) {
    const cy = Math.round(h / 2 + Math.sin(x / 12) * (h / 4));
    for (let dy = -3; dy <= 3; dy++) {
      const o = (cy + dy) * (w * 3 + 1) + 1 + x * 3;
      raw[o] = raw[o + 1] = raw[o + 2] = 20;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function abrirFirma(page: Page, token: string, asunto: string) {
  await page.goto(`/s/${token}`);
  await expect(page.getByRole("heading", { name: asunto })).toBeVisible();
  await page.getByRole("checkbox", { name: /Acepto firmar electrónicamente/ }).check();
  await page.getByRole("button", { name: "Acepto y continúo" }).click();
  await page.getByRole("button", { name: /activar para firmar/ }).click();
  return page.getByRole("dialog", { name: "Adoptá tu firma" });
}

async function finalizar(page: Page) {
  await expect(page.getByRole("button", { name: "Firma: firmado" })).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "Finalizar" }).click();
  await expect(page.getByRole("heading", { name: "¡Listo! Firmaste el documento" })).toBeVisible({ timeout: 30_000 });
}

async function eventos(request: APIRequestContext, envelopeId: string) {
  const res = await request.get(`/v1/envelopes/${envelopeId}/events`);
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { items: { type: string; userAgent: string | null; data: Record<string, any> }[] }).items;
}

test.describe("adoptar la firma: importar y celular", () => {
  test("importa una imagen PNG, la ve en la vista previa y firma; la evidencia dice que se importó", async ({ page, request }) => {
    const sinErrores = vigilarErrores(page);
    const cuenta = await altaDeCuenta(request);
    const sobre = await sobreEnviado(request, cuenta);
    const pad = await abrirFirma(page, sobre.token, `Contrato web ${cuenta.stamp}`);

    await pad.getByRole("tab", { name: "Importar" }).click();
    const archivo = pad.getByLabel("Archivo con la firma");
    // Un SVG no se acepta (puede traer scripts y no es una imagen de píxeles): mensaje claro, nada para adoptar.
    await archivo.setInputFiles({ name: "firma.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await expect(pad.getByRole("alert")).toContainText("no es una imagen PNG o JPG");
    await expect(pad.getByRole("button", { name: "Adoptar y firmar" })).toBeDisabled();

    await archivo.setInputFiles({ name: "firma.png", mimeType: "image/png", buffer: firmaEnPapel() });
    await expect(pad.getByRole("img", { name: "Vista previa de la firma importada" })).toBeVisible();
    await pad.getByRole("button", { name: "Adoptar y firmar" }).click();
    await expect(pad).toBeHidden();
    await finalizar(page);

    const firmado = (await eventos(request, sobre.envelopeId)).find((e) => e.type === "recipient.signed");
    expect(firmado?.data.signature).toEqual([expect.objectContaining({ purpose: "signature", kind: "uploaded" })]);
    sinErrores();
  });

  test("pide el link del celular, dibuja ahí con el mouse, la computadora la muestra y finaliza", async ({ page, request, browser }) => {
    const sinErrores = vigilarErrores(page);
    const cuenta = await altaDeCuenta(request);
    const sobre = await sobreEnviado(request, cuenta);
    const pad = await abrirFirma(page, sobre.token, `Contrato web ${cuenta.stamp}`);

    await pad.getByRole("tab", { name: "Dibujar" }).click();
    await pad.getByRole("button", { name: "Dibujar en el celular" }).click();
    const link = pad.getByRole("textbox", { name: "Link para el celular" });
    await expect(link).toHaveValue(/\/h\/[A-Za-z0-9_-]{43}$/);
    const url = await link.inputValue();
    await expect(pad.getByRole("button", { name: "Copiar link" })).toBeVisible();
    // Sin firma todavía no hay nada que adoptar.
    await expect(pad.getByRole("button", { name: "Adoptar y firmar" })).toBeDisabled();

    // El celular: otra página (otro contexto, sin la sesión del remitente ni la del firmante), del tamaño de un teléfono.
    const ctxCelular = await browser.newContext({ viewport: { width: 412, height: 860 }, locale: "es-AR" });
    const celular = await ctxCelular.newPage();
    const sinErroresCelular = vigilarErrores(celular);
    await celular.goto(url);
    await expect(celular.getByRole("heading", { name: "Dibujá tu firma" })).toBeVisible();
    const lienzo = celular.getByRole("img", { name: "Lienzo para dibujar la firma" });
    const caja = (await lienzo.boundingBox())!;
    expect(caja.width).toBeGreaterThan(300);
    await celular.mouse.move(caja.x + caja.width * 0.15, caja.y + caja.height * 0.5);
    await celular.mouse.down();
    for (let i = 1; i <= 24; i++) {
      await celular.mouse.move(caja.x + caja.width * (0.15 + i * 0.03), caja.y + caja.height * (0.5 + (i % 2 ? -0.15 : 0.15)), { steps: 3 });
    }
    await celular.mouse.up();
    await celular.getByRole("button", { name: "Enviar" }).click();
    await expect(celular.getByRole("heading", { name: "¡Listo! Tu firma llegó" })).toBeVisible();
    // Un solo uso: abrir el link otra vez lo dice.
    await celular.reload();
    await expect(celular.getByRole("heading", { name: "Esta firma ya se envió" })).toBeVisible();
    sinErroresCelular();
    await ctxCelular.close();

    // La computadora recibe la firma (consulta el pase) y la muestra para adoptarla.
    await expect(pad.getByRole("img", { name: "Firma recibida del celular" })).toBeVisible();
    await pad.getByRole("button", { name: "Adoptar y firmar" }).click();
    await expect(pad).toBeHidden();
    await finalizar(page);

    const ev = await eventos(request, sobre.envelopeId);
    const enCelular = ev.find((e) => e.type === "recipient.signature_handoff_submitted");
    expect(enCelular?.userAgent).toBeTruthy();
    const firmado = ev.find((e) => e.type === "recipient.signed");
    expect(firmado?.data.signature[0]).toMatchObject({ kind: "drawn", device: { handoffId: enCelular?.data.handoffId } });
    expect(JSON.stringify(ev)).not.toContain(url.split("/h/")[1]);
    sinErrores();
  });

  test("en el celular la firma no se recorta ni se borra cuando la barra del navegador cambia el alto", async ({ page, request, browser }) => {
    const cuenta = await altaDeCuenta(request);
    const sobre = await sobreEnviado(request, cuenta);
    const pad = await abrirFirma(page, sobre.token, `Contrato web ${cuenta.stamp}`);
    await pad.getByRole("tab", { name: "Dibujar" }).click();
    await pad.getByRole("button", { name: "Dibujar en el celular" }).click();
    const url = await pad.getByRole("textbox", { name: "Link para el celular" }).inputValue();

    // Una tablet con densidad 3: el lienzo pasa el tope de píxeles y la densidad se recorta (antes dependía del alto).
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 3, locale: "es-AR" });
    const celular = await ctx.newPage();
    const sinErroresCelular = vigilarErrores(celular);
    await celular.goto(url);
    const lienzo = celular.getByRole("img", { name: "Lienzo para dibujar la firma" });
    await expect(lienzo).toBeVisible();
    const caja = (await lienzo.boundingBox())!;
    // Un trazo en la parte de abajo del lienzo (el 90 % del alto).
    await celular.mouse.move(caja.x + caja.width * 0.2, caja.y + caja.height * 0.9);
    await celular.mouse.down();
    for (let i = 1; i <= 20; i++) await celular.mouse.move(caja.x + caja.width * (0.2 + i * 0.03), caja.y + caja.height * 0.9, { steps: 2 });
    await celular.mouse.up();
    /** Tamaño real del lienzo y si hay tinta en la franja de abajo (del 80 % al final del alto). */
    const estado = () =>
      celular.evaluate(() => {
        const c = document.querySelector("canvas.handoff-canvas") as HTMLCanvasElement;
        const y0 = Math.floor(c.height * 0.8);
        const d = c.getContext("2d")!.getImageData(0, y0, c.width, c.height - y0).data;
        let tinta = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]! > 32) tinta++;
        return { ancho: c.width, tinta };
      });
    const antes = await estado();
    expect(antes.tinta).toBeGreaterThan(100);

    // Aparece la barra del navegador (el alto visible baja) y después se esconde.
    await celular.setViewportSize({ width: 1024, height: 1100 });
    await expect.poll(async () => (await lienzo.boundingBox())!.height).toBeLessThan(caja.height - 50);
    expect((await estado()).ancho).toBe(antes.ancho);
    await celular.setViewportSize({ width: 1024, height: 1366 });
    await expect.poll(async () => Math.round((await lienzo.boundingBox())!.height)).toBe(Math.round(caja.height));
    const despues = await estado();
    expect(despues.ancho).toBe(antes.ancho);
    expect(despues.tinta).toBe(antes.tinta);
    sinErroresCelular();
    await ctx.close();
  });
});
