// El firmante, de punta a punta en el navegador: consentimiento, adoptar la firma, finalizar y descargar el PDF
// sellado. Corre también con el viewport y el toque de un celular (proyecto "celular" en playwright.config.ts).
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { altaDeCuenta, pdfSellado, sobreEnviado } from "./helpers/api";
import { vigilarErrores } from "./helpers/pagina";

test.describe("firmante", () => {
  test("firma con el nombre escrito y descarga el mismo PDF que selló el servidor", async ({ page, request }) => {
    const sinErrores = vigilarErrores(page);
    const cuenta = await altaDeCuenta(request);
    const sobre = await sobreEnviado(request, cuenta);

    await page.goto(`/s/${sobre.token}`);
    await expect(page.getByRole("heading", { name: `Contrato web ${cuenta.stamp}` })).toBeVisible();

    // Sin el consentimiento no se puede seguir.
    const continuar = page.getByRole("button", { name: "Acepto y continúo" });
    await expect(continuar).toBeDisabled();
    await page.getByRole("checkbox", { name: /Acepto firmar electrónicamente/ }).check();
    await continuar.click();

    // Antes de firmar no se ofrece descargar el documento: recién en la pantalla de fin.
    await expect(page.getByRole("group", { name: "contrato.pdf — 1" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Descargar documento/ })).toHaveCount(0);

    // El PDF se dibujó (pdf.js) y el campo de firma está sobre la página.
    await expect(page.getByRole("group", { name: "contrato.pdf — 1" })).toContainText("Contrato de prueba web - pagina 1");
    await expect(page.getByRole("main").getByText("0 de 1 campos")).toBeVisible();
    await page.getByRole("button", { name: /activar para firmar/ }).click();

    const pad = page.getByRole("dialog", { name: "Adoptá tu firma" });
    await expect(pad.getByRole("textbox", { name: "Escribí tu nombre" })).toHaveValue(sobre.signerName);
    await pad.getByRole("button", { name: "Adoptar y firmar" }).click();
    await expect(pad).toBeHidden();
    await expect(page.getByRole("button", { name: "Firma: firmado" })).toBeVisible();
    await expect(page.getByRole("main").getByText("1 de 1 campos")).toBeVisible();

    await page.getByRole("main").getByRole("button", { name: "Finalizar" }).click();
    await expect(page.getByRole("heading", { name: "¡Listo! Firmaste el documento" })).toBeVisible({ timeout: 30_000 });
    // Mientras sella hay otro aviso ("Estamos sellando…"); se espera el definitivo.
    await expect(page.getByRole("main").getByText("El documento está completo y sellado.")).toBeVisible({ timeout: 30_000 });

    // Lo que baja el firmante es byte a byte el PDF sellado que guarda el servidor.
    const sellado = await pdfSellado(request, sobre.envelopeId);
    const [descarga] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /Descargar documento firmado/ }).click()]);
    const bajado = await descarga.createReadStream().then(async (s) => {
      const partes: Buffer[] = [];
      for await (const p of s) partes.push(p as Buffer);
      return Buffer.concat(partes);
    });
    expect(bajado.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(sha(bajado)).toBe(sha(sellado));
    sinErrores();
  });

  test("el firmante cambia el idioma a portugués", async ({ page, request }) => {
    const sinErrores = vigilarErrores(page);
    const cuenta = await altaDeCuenta(request);
    const sobre = await sobreEnviado(request, cuenta);
    await page.goto(`/s/${sobre.token}`);
    await expect(page.getByRole("heading", { name: "Antes de empezar" })).toBeVisible();
    await page.getByRole("combobox", { name: "Idioma" }).selectOption({ label: "Português" });
    await expect(page.getByRole("heading", { name: "Antes de começar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Concordo e continuo" })).toBeVisible();
    sinErrores();
  });

  test("un link inválido lo dice y no muestra un documento", async ({ page }) => {
    const sinErrores = vigilarErrores(page);
    await page.goto("/s/link-que-no-existe-0000");
    await expect(page.getByRole("heading", { name: "Link inválido o vencido" })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText("Pedile al remitente que te reenvíe el sobre.");
    await expect(page.getByRole("button", { name: "Acepto y continúo" })).toHaveCount(0);
    sinErrores();
  });
});
