// Errores de JavaScript no atrapados en la página: un test que pasa con la consola llena de excepciones no está
// probando lo que cree. Se juntan con `pageerror` (no los console.error: un 401 esperado los genera).
import { expect, type Page } from "@playwright/test";

export function vigilarErrores(page: Page): () => void {
  const errores: string[] = [];
  page.on("pageerror", (e) => errores.push(e.message));
  return () => expect(errores, "errores de JavaScript en la página").toEqual([]);
}

/**
 * Violaciones de la CSP en la página y en sus marcos: el evento `securitypolicyviolation` (escuchado desde antes de que
 * corra la página, también tras navegar) y, para los marcos sin scripts, el aviso que el navegador deja en la consola.
 * Registrarlo antes del primer `goto`. La CSP no admite estilos ni scripts en línea (seguridad §5.2): una pantalla que
 * los use se ve rota en producción aunque sus otros tests pasen.
 */
export async function vigilarCsp(page: Page): Promise<() => void> {
  const violaciones: string[] = [];
  const consola: string[] = [];
  // WebKit (no Chromium) reporta style-src-attr al crear un <select>: es el estilo de su propio árbol interno del
  // control, no uno de la página, y el control se dibuja igual. Se descuenta ese caso puntual (evento con el <select>
  // como destino y sin muestra), y su aviso genérico en la consola.
  let selectsWebKit = 0;
  await page.exposeBinding("__violacionCsp", (_origen, v: string) => {
    if (v === "select-webkit") selectsWebKit++;
    else violaciones.push(v);
  });
  await page.addInitScript(() => {
    // El aviso de WebKit llega mientras se crea el <select> (todavía sin conectar: el destino es el documento).
    let creandoSelect = false;
    const crear = Document.prototype.createElement;
    Document.prototype.createElement = function (this: Document, tag: string, ...resto: unknown[]) {
      const select = String(tag).toLowerCase() === "select";
      if (select) creandoSelect = true;
      try {
        return (crear as (...a: unknown[]) => HTMLElement).call(this, tag, ...resto);
      } finally {
        if (select) creandoSelect = false;
      }
    } as typeof Document.prototype.createElement;
    document.addEventListener(
      "securitypolicyviolation",
      (e) => {
        const reportar = (window as unknown as { __violacionCsp?: (v: string) => void }).__violacionCsp;
        const destino = e.target as Element | null;
        const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
        // Ídem con los scripts que inyecta el propio Playwright en WebKit (web-inspector://…): no son de la página.
        const herramienta = e.sourceFile.startsWith("web-inspector://");
        if (webkit && e.effectiveDirective === "style-src-attr" && !e.sample && (creandoSelect || destino?.nodeName === "SELECT" || herramienta))
          return reportar?.("select-webkit");
        reportar?.(
          `${e.effectiveDirective} bloqueó ${e.blockedURI || "(en línea)"} en ${e.sourceFile || location.pathname}:${e.lineNumber}:${e.columnNumber} «${e.sample}»`,
        );
      },
      true,
    );
  });
  page.on("console", (m) => {
    if (/Content.Security.Policy/i.test(m.text())) consola.push(`consola (${m.location().url}): ${m.text()}`);
  });
  return () => {
    const generico = /Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear/;
    let descontar = selectsWebKit;
    const resto = consola.filter((c) => !(descontar > 0 && generico.test(c) && descontar--));
    expect([...violaciones, ...resto], "violaciones de la CSP").toEqual([]);
  };
}
