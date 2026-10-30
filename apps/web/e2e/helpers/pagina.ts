// Errores de JavaScript no atrapados en la página: un test que pasa con la consola llena de excepciones no está
// probando lo que cree. Se juntan con `pageerror` (no los console.error: un 401 esperado los genera).
import { expect, type Page } from "@playwright/test";

export function vigilarErrores(page: Page): () => void {
  const errores: string[] = [];
  page.on("pageerror", (e) => errores.push(e.message));
  return () => expect(errores, "errores de JavaScript en la página").toEqual([]);
}
