// Páginas públicas: la verificación de un PDF sellado y el portal de desarrolladores.
import { expect, test } from "@playwright/test";
import { altaDeCuenta, firmarPorApi, pdfSellado, sobreEnviado, tinyPdf } from "./helpers/api";
import { vigilarErrores } from "./helpers/pagina";

test.describe("páginas públicas", () => {
  test("/verify reconoce el PDF sellado y rechaza el mismo con un byte cambiado", async ({ page, request }) => {
    const sinErrores = vigilarErrores(page);
    const cuenta = await altaDeCuenta(request);
    const sobre = await sobreEnviado(request, cuenta);
    await firmarPorApi(request, sobre.token);
    const pdf = await pdfSellado(request, sobre.envelopeId);

    await page.goto("/verify");
    await expect(page.getByRole("heading", { name: "Verificar un documento" })).toBeVisible();
    const archivo = page.locator('input[type="file"]').first();
    await archivo.setInputFiles({ name: "firmado.pdf", mimeType: "application/pdf", buffer: pdf });
    await expect(page.getByRole("heading", { name: "Documento válido" })).toBeVisible();
    await expect(page.getByRole("row", { name: /Asunto/ })).toContainText(`Contrato web ${cuenta.stamp}`);
    await expect(page.getByRole("row", { name: /Registro de eventos/ })).toContainText("Íntegro");

    // El mismo PDF con UN byte cambiado en el medio ya no es el sellado: tiene que decir que no coincide.
    const alterado = Buffer.from(pdf);
    const medio = Math.floor(alterado.length / 2);
    alterado[medio] = alterado[medio] ^ 0x01;
    await page.goto("/verify");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "alterado.pdf", mimeType: "application/pdf", buffer: alterado });
    await expect(page.getByRole("heading", { name: "No coincide" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Documento válido" })).toHaveCount(0);

    // Y un PDF que nunca pasó por CalaSign, tampoco.
    await page.goto("/verify");
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: "otro.pdf", mimeType: "application/pdf", buffer: tinyPdf(2) });
    await expect(page.getByRole("heading", { name: "No coincide" })).toBeVisible();
    sinErrores();
  });

  test("alta de cuenta: las regiones de datos, agrupadas, con las próximas deshabilitadas", async ({ page }) => {
    const sinErrores = vigilarErrores(page);
    await page.goto("/signup");
    const region = page.getByRole("combobox", { name: "Dónde se guardan tus documentos" });
    await expect(region).toBeVisible();
    // La del despliegue (Estados Unidos) elegida y habilitada; Chile, Canadá y el resto de AWS, «Próximamente».
    await expect(region).toHaveValue("us");
    await expect(region.locator(`option[value="us"]`)).not.toHaveAttribute("disabled");
    for (const [id, nombre] of [
      ["cl", "Chile (Santiago)"],
      ["ca-central-1", "Canadá (Montreal)"],
      ["ca-west-1", "Canadá (Calgary)"],
      ["br", "Brasil (São Paulo)"],
    ]) {
      const op = region.locator(`option[value="${id}"]`);
      await expect(op).toHaveAttribute("disabled", "");
      await expect(op).toHaveText(`${nombre} — Próximamente`);
    }
    await expect(region.locator("optgroup")).toHaveCount(4);
    expect(await region.locator("option").count()).toBeGreaterThanOrEqual(35);
    sinErrores();
  });

  test("/developers carga y cambia de idioma", async ({ page }) => {
    const sinErrores = vigilarErrores(page);
    await page.goto("/developers");
    await expect(page.getByRole("heading", { name: "Documentación para desarrolladores", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Menú de la documentación" }).getByRole("link", { name: "Inicio rápido" })).toBeVisible();
    await page.getByRole("combobox", { name: "Idioma" }).selectOption({ index: 2 });
    await expect(page.getByRole("heading", { name: "Documentación para desarrolladores", level: 1 })).toHaveCount(0);
    await expect(page.locator("main h1")).not.toBeEmpty();
    sinErrores();
  });
});
