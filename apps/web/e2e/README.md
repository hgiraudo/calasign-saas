# Tests de la web en navegador (Playwright)

Prueban lo que sólo se ve en un navegador: que el PDF se dibuje, que el firmante pueda aceptar, adoptar la firma,
finalizar y bajar el PDF sellado, que el login funcione, que las páginas públicas respondan y que la CSP, el escape de
los datos, el enmarcado y el cierre de sesión se comporten en un navegador de verdad. El resto (permisos,
evidencia, sellado, webhooks) está en los tests de la API y en `scripts/e2e-*.mjs`.

```bash
./scripts/qa.sh --web                      # compila la web y corre todo (~1 min)
# o, con la web ya compilada:
cd apps/web && ./node_modules/.bin/playwright test
./node_modules/.bin/playwright test e2e/firmante.e2e.ts --project=celular --headed   # uno, viéndolo
./node_modules/.bin/playwright show-trace ../../var/playwright/<test>/trace.zip       # qué pasó en una falla
```

## Qué cubre

| Archivo | Qué prueba |
|---|---|
| `firmante.e2e.ts` | Consentimiento (sin él no se avanza), PDF dibujado, adoptar la firma escrita, finalizar, pantalla de fin y **descarga byte a byte igual al PDF sellado del servidor**; cambio de idioma a portugués; link inválido. Corre también como **celular** (Pixel 7) |
| `consola.e2e.ts` | Login por la pantalla; el sobre enviado por la API aparece en la lista y en el detalle; Ajustes → Organización cambia el huso horario; contraseña equivocada |
| `firma-importar-celular.e2e.ts` | «Adoptá tu firma»: **importar** una imagen PNG (y un SVG rechazado) y firmar; **dibujar en el celular**: pide el link, lo abre en otra página, dibuja con el mouse, envía (un segundo uso lo rechaza), la computadora muestra la firma y finaliza; la evidencia dice cómo se hizo cada una; en una tablet con densidad 3, un cambio de alto (la barra del navegador) **no recorta ni borra** el trazo |
| `seguridad.e2e.ts` | **Cero violaciones de la CSP** (que no admite estilos ni scripts en línea) en el firmante con marca (y la marca se aplica), el pase al celular `/h/…`, la consola (lista, detalle, editor, Marca con las vistas previas de la página de firma y del correo), `/verify` y `/developers`. **XSS almacenado**: asunto, mensaje, firmante y nombre de archivo con payloads se ven como texto en el firmante y en la consola y `window.__xss` queda sin definir (con la CSP apagada, para probar el escape y no la CSP); un link de marca `javascript:` se rechaza. **Enmarcado**: `frame-ancestors 'none'`, `X-Frame-Options` y `nosniff` en las páginas; un sitio ajeno (servidor local del test) no enmarca login, firmante ni firma embebida, y el integrador autorizado sí. **Sesión**: después de «Salir», ni Atrás ni una ruta de la consola muestran datos |
| `publicas.e2e.ts` | `/verify` reconoce el PDF sellado y dice «No coincide» con **un byte cambiado** y con un PDF ajeno; `/verify` ofrece la raíz de CalaSign para Acrobat (la descarga coincide con la huella); el alta muestra las regiones de AWS y Chile agrupadas y todas elegibles; `/developers` carga y cambia de idioma |

Todos fallan si la página tira una excepción de JavaScript (`helpers/pagina.ts` `vigilarErrores`). Para las
violaciones de la CSP, `vigilarCsp` (registrarlo antes del primer `goto`): escucha `securitypolicyviolation` y los
avisos de la consola (también de marcos sin scripts). Descuenta un solo falso positivo de WebKit: el `style-src-attr`
que reporta al crear un `<select>` (estilo de su árbol interno; el control se dibuja bien).

## Cómo funciona

- **`e2e/servidor.mjs`** levanta una API efímera en `:4197` (PGlite en una carpeta temporal, buzón de desarrollo,
  sin TSA) que sirve `apps/web/dist`. Playwright la arranca y la apaga (`webServer` en `playwright.config.ts`). Si
  el puerto está ocupado **falla**: nunca corre contra una API ajena. `E2E_WEB_PORT` lo cambia.
- **Los datos se arman por la API** (`helpers/api.ts`: cuenta, sobre con un PDF generado en el test, firmante,
  envío y link del buzón). La UI se usa sólo para lo que cada test prueba.
- **Datos sintéticos**: correos en `example.com`, PDF generado; nada real (estándares, SEG-20).

## Navegadores

- **Chromium** (escritorio y celular): siempre.
- **WebKit** (el motor de Safari, donde aparecieron los problemas del visor de PDF): opcional, con `E2E_WEBKIT=1`.
  Necesita librerías del sistema que se instalan una vez con
  `sudo ./node_modules/.bin/playwright install-deps webkit`.
- Los navegadores se bajan con `./node_modules/.bin/playwright install chromium webkit` (quedan en
  `~/.cache/ms-playwright`).

## Reglas (de `docs/estandares/tests-automatizados.md` §6)

- Selectores por **rol y nombre accesible** (`getByRole`), nunca por clase CSS: prueban también la accesibilidad.
- Esperar un **ancla** del componente (un heading, un botón), nunca `networkidle`.
- Todo `test()` dentro de un `test.describe`.
- `page.once("dialog", …)`, no `page.on`.
- Un selector nuevo se verifica contra la app corriendo (`locator("body").ariaSnapshot()` muestra lo que ve el test).
- Antes de creerle a un test nuevo, verlo fallar con el bug inyectado (se hizo con la traba del consentimiento y con
  cada test de `seguridad.e2e.ts`: ver `docs/estandares/tests-automatizados.md` §6.1).
- Sin capturas comparadas (golden images): se agregan sólo si aparece una regresión visual que esto no caza.
