// La consola del remitente: login por la pantalla y el sobre creado por la API en la lista.
import { expect, test } from "@playwright/test";
import { altaDeCuenta, sobreEnviado } from "./helpers/api";
import { vigilarErrores } from "./helpers/pagina";

test.describe("consola", () => {
  test("login por la pantalla y el sobre enviado aparece en la lista y en su detalle", async ({ page, request }) => {
    const sinErrores = vigilarErrores(page);
    const cuenta = await altaDeCuenta(request);
    const sobre = await sobreEnviado(request, cuenta);

    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(cuenta.email);
    await page.getByRole("textbox", { name: "Contraseña" }).fill(cuenta.password);
    await page.getByRole("button", { name: "Ingresar" }).click();
    await expect(page).toHaveURL(/\/app/);

    const asunto = page.getByText(`Contrato web ${cuenta.stamp}`).first();
    await expect(asunto).toBeVisible();
    await asunto.click();
    await expect(page).toHaveURL(new RegExp(`/app/envelopes/${sobre.envelopeId}`));
    await expect(page.getByText(sobre.signerName).first()).toBeVisible();
    sinErrores();
  });

  test("una contraseña equivocada no entra y lo dice", async ({ page, request }) => {
    const cuenta = await altaDeCuenta(request);
    await page.goto("/login");
    await page.getByRole("textbox", { name: "Email" }).fill(cuenta.email);
    await page.getByRole("textbox", { name: "Contraseña" }).fill("otra-clave-equivocada-1");
    await page.getByRole("button", { name: "Ingresar" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});
