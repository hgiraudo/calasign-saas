# Seguridad y cumplimiento — reglas `SEG-NN`

> Qué tiene que cumplir CalaSign (código, operación y datos) para que la firma tenga valor legal en los cinco países
> y para pasar el cuestionario de seguridad de un cliente grande (banco, aseguradora, gobierno). Cada regla tiene un
> identificador para citarla en commits, en una pasada de review y en la respuesta a un cliente.
>
> Fuentes: el marco legal por país de [`../../ROADMAP.md` §3.5-3.6](../../ROADMAP.md), la arquitectura de evidencia de
> [`../EVIDENCIA.md`](../EVIDENCIA.md) y [`../EVIDENCIA-ROLES-BD.md`](../EVIDENCIA-ROLES-BD.md), y lo medido en el código el
> 29-Oct-2026. **No es asesoramiento legal**: el encuadre de cada caso de uso se confirma con un abogado local.

---

## 0. Por qué no se copió el doc del BCRA

El set de Milhouse trae `cumplimiento-bcra.md`: 90 reglas sobre los requisitos de tecnología y seguridad que el **Banco
Central de la República Argentina** exige a las entidades financieras argentinas. CalaSign no es una entidad
financiera ni opera en Argentina (mercados: República Dominicana, Honduras, Colombia, Brasil y Perú), así que esa norma
no le aplica.

Lo que sí se tomó es **la forma**: una regla por fila, con identificador, estado medido y dónde se verifica; lo caro
marcado aparte para decidir caso a caso. Y una observación que vale igual acá: **un control se cumple demostrándolo**
(un test, un registro, una fecha), no declarándolo.

Si algún día un cliente es un banco que pide ese nivel (incluido uno argentino como cliente de la API), ese doc es el
punto de partida para el cuestionario.

| Marca | Significa |
|---|---|
| ✅ | Se cumple hoy, con la evidencia que se cita (en general, un test que fallaría) |
| 🟡 | Parcial: hay algo, falta lo que se nombra |
| 🔴 | No se cumple. Costo bajo: se hace |
| 💲 | Recomendado pero con costo alto (proveedor, certificación, hardware): se decide con el usuario |

---

## 1. Evidencia de la firma

| ID | Regla | Estado | Evidencia |
|---|---|---|---|
| **SEG-01** | **La evidencia es append-only**: `envelope_events` y `account_audit_log` rechazan `UPDATE`/`DELETE`/`TRUNCATE` por trigger, además de la cadena de hashes. Un error se compensa con otro evento, nunca se edita | ✅ | Migraciones 0072/0074 · `test/evidence-append-only.test.ts` |
| **SEG-02** | **El PDF final va sellado (PAdES) con una clave que no sale del KMS** en dev y producción; nunca una clave privada de sello en disco fuera de local | ✅ | `infra/seal.ts`, `infra/kms.ts` · `docs/EVIDENCIA.md` |
| **SEG-03** | **Cualquiera puede verificar** un PDF por su hash (`/verify`), atado al hash de la cadena impreso en el certificado de finalización | ✅ | `modules/verify.ts` · `test/evidence-append-only.test.ts` |
| **SEG-04** | **Sello de tiempo RFC 3161 de una TSA confiable** en producción (B-T o superior) | 🟡 Por defecto `freetsa.org` (pública, sin acuerdo de servicio). Para producción, una TSA con contrato, y por país donde la ley lo pida 💲 | `config.ts` `TSA_URL` |
| **SEG-05** | **Lo que se firma es lo que se ve**: el PDF que muestra el visor es el mismo que se sella (normalizado al subir) | ✅ | `preparePdfUpload` (`packages/pdf/src/inspect.ts`) · `test/upload-limits.test.ts` |
| **SEG-06** | **El parser de PDF y de XML resiste un archivo hostil**: topes de recursos, error tipado, sin cuelgue | ✅ | `packages/pdf/test/sanitize`, `stream-budget`, `validate-limits`, `revisions-attacks` |
| **SEG-07** | **Niveles de firma explícitos**: el certificado de finalización dice qué nivel se usó (simple, con certificado del titular) y qué verificación de identidad hubo | ✅ | `docs/FIRMA-CON-CERTIFICADO.md`, `docs/VERIFICACION-IDENTIDAD.md` |

---

## 2. Accesos y aislamiento

| ID | Regla | Estado | Evidencia |
|---|---|---|---|
| **SEG-10** | **Toda acción de una persona o cuenta de servicio queda en la auditoría** de la organización, con actor, objeto, valor anterior y nuevo, **sin secretos** | ✅ (por ruta; una ruta nueva tiene que sumarse) | `modules/audit.ts` · `test/audit-coverage.test.ts` |
| **SEG-11** | **Aislamiento multi-tenant**: toda consulta filtra por el `tenant_id` del `req.auth`; un recurso ajeno da 404 | ✅ Un test recorre **todas** las rutas registradas (las enumera la app): cada id del path de otra organización da 404 con sesión, API key, token SCIM y link de firma, sin cambiar sus datos, y los listados no la muestran; una ruta nueva sin fixture ni excepción lo hace fallar. **Desde el 5-Nov-2026 también los ids del cuerpo y de la query**: otro test enumera desde el OpenAPI cada campo que es un id y lo prueba con el id de B: la misma respuesta que un id que no existe, B sin cambios y **ninguna fila de A guardando un id de B**; un campo nuevo sin prueba ni excepción lo hace fallar. Encontró uno: el filtro `triggerConfig.templateId` de un mapeo CRM guardaba la plantilla de otra organización (arreglado). Aceptado con su motivo: un id que elige el cliente y es clave de la fila (firmantes, roles y campos) da 409 si ya lo usa otra organización (confirma que existe, sin datos ni acceso) | `codigo-sql-y-migraciones.md` §2.1 · `test/tenant-isolation-routes.test.ts` · `test/tenant-isolation-refs.test.ts` |
| **SEG-12** | **Una sola política de acceso** (RBAC + scopes OAuth + plan) para la web, las API keys, OAuth y el MCP | ✅ | `modules/access.ts` · `test/permissions-trim.test.ts`, `mcp-security.test.ts` |
| **SEG-13** | **Ninguna credencial se guarda en claro**: sesiones y API keys como SHA-256; token del firmante como hash (búsqueda) y AES-256-GCM (reenvío) | ✅ | `docs/ARQUITECTURA.md` §3.1 · `test/signer-session-token.test.ts` |
| **SEG-14** | **Contraseñas**: largo mínimo, lista de comunes, no contiene el correo, bloqueo por intentos por red y por cuenta; 2FA TOTP; SSO obligatorio por organización | ✅ | `lib/password-policy.ts` · `test/staff-auth-hardening.test.ts`, `totp.test.ts` |
| **SEG-15** | **Límite de pedidos** en todo lo público (login, verificación, formularios, OTP) | ✅ | `@fastify/rate-limit` en `app.ts` y por ruta |
| **SEG-16** | **Cookie de sesión `__Host-`**, `HttpOnly`, `Secure`, `SameSite=Lax`; cierre por inactividad | ✅ La de nombre viejo (`cs_session`, sin `__Host-`) dejó de abrir sesión con HTTPS el **5-Nov-2026** (se leía desde el cambio del 20-Oct-2026; ninguna sesión de entonces seguía vigente) | `modules/context.ts` · `test/http-headers.test.ts` |

---

## 3. Datos personales

Ley 172-13 (RD), Ley 1581 de 2012 (CO), LGPD (BR), Ley 29733 (PE); Honduras sin ley integral (ver ROADMAP §3.6).

| ID | Regla | Estado | Evidencia |
|---|---|---|---|
| **SEG-20** | **Nada de datos personales reales fuera de su lugar**: ni en fixtures, ni en logs, ni en mensajes de error, ni en avisos (Telegram, correo de alertas). Correos de prueba en `example.com` | ✅ **Desde el 3-Nov-2026** en logs y errores del servidor, en dos capas. **En ejecución** (`safeLoggerOptions`, en la API y, desde ese día, también en el worker, que logueaba sin redactar nada): pino censura a cualquier profundidad las claves de un dato personal o un secreto, comparadas por el final (`email`, `phone`, `cpf`, `cnpj`, `dni`, `firstName`…: también `signerEmail`, `recipient_phone`) o enteras (`recipient`, `signers`, `contact`, `body`); enmascara los correos de cualquier texto (el mensaje, el `detail` de un error de Postgres), y la URL del log de acceso sale sin `q`, `login_hint` ni el documento de una búsqueda (`identification`…). Quedan a propósito, para que el log sirva: `name` y `title` a secas, los ids, la IP del log de acceso, los números y booleanos. **En el código** (Semgrep en cada `qa.sh`): `calasign-dato-personal-en-log` (el valor que la clave no delata: `{ to: r.email }`, el destinatario entero, `req.body`, también en `console.*`), `calasign-dato-personal-en-error` (un `new …Error` con un dato o la IP: termina en `last_error`, en el log del worker y en la respuesta) y `calasign-url-en-error-o-log` (la URL con su query, como el `?identification=` de Siigo y Alegra → `redactUrl`). 🟡 **Sigue en la revisión**: un teléfono o un documento dentro de un texto libre (sólo el correo se reconoce por la forma), el cuerpo de la respuesta de un proveedor citado en un error, un nombre en una variable `name`, `console.*` en ejecución, los fixtures y los avisos | `lib/redact.ts` · `test/redact.test.ts` (bajo mutation testing) · `test/logs-pii.test.ts` · `scripts/semgrep/calasign.yml` · `tests-automatizados.md` §3 |
| **SEG-21** | **Ningún secreto en el repo**: van a SSM o a `var/`. El tfstate no se versiona | ✅ **Desde el 31-Oct-2026** gitleaks recorre **todo el historial** en cada `qa.sh` (el hook sólo veía lo que está en stage, y hay que activarlo en cada clon). Primera pasada: 100 hallazgos, todos claves inventadas de tests y ejemplos de la documentación; ningún secreto real | `scripts/sast.sh` · `.gitleaks.toml`, `.gitleaksignore` · `scripts/hooks/pre-commit` |
| **SEG-22** | **Residencia**: el dato de una organización no sale de su celda | ✅ en el código; 🟡 **excepción desde el 30-Oct-2026** (pedido del usuario): el alta ofrece todas las regiones y una sin configurar deja a la organización en la celda por defecto (la pedida queda en `tenants.requested_cell`): antes de tener clientes reales, configurar esas celdas o volver a mostrarlas como «Próximamente»; 💲 la celda de Brasil (São Paulo) necesita cambiar la SCP de la organización AWS | `infra/cells.ts` · `test/cells-residency.test.ts` · `docs/DATOS.md` |
| **SEG-23** | **Cifrado de lo sensible** en la base (tokens de proveedores, claves en custodia) y BYOK con el KMS del cliente | ✅ | `lib/util.ts` `encrypt` · `modules/custody.ts` · `test/byok-archive-hardening.test.ts` |
| **SEG-24** | **Retención**: la purga borra archivos y deja el evento `envelope.purged`; no se borra evidencia | ✅ | `modules/retention.ts` · `test/retention.test.ts` |
| **SEG-25** | **Logs del proxy sin secretos**: Caddy escribe `[redacted]` en links de firma, invitaciones, descargas y callbacks OAuth | ✅ | `infra/dev/host/Caddyfile` · README § Entorno dev |

---

## 4. Terceros y salientes

| ID | Regla | Estado | Evidencia |
|---|---|---|---|
| **SEG-30** | **Catálogo de proveedores que reciben datos** (qué datos, para qué, región, cómo se apaga): Anthropic, Twilio, Truora, Veriff, Stripe, Mercado Pago, WhatsApp, Telegram, Google, Dropbox, Microsoft, SES y los CRM. Un proveedor nuevo se suma **antes** de integrarlo | ✅ **3-Nov-2026**: [`docs/PROVEEDORES.md`](../PROVEEDORES.md), relevado del código (archivo de cada pedido): 17 que contrata la plataforma, 8 grupos que conecta la organización con su cuenta, lo que sale desde el navegador (Google Fonts sólo con una fuente de Google en la marca) y lo que no hay (ni analítica ni seguimiento de errores). SMS, WhatsApp y Telegram se apagan por organización (Ajustes → Organización → Canales, migración 0128; `test/organization-channels.test.ts`). Pendiente 💲: confirmar la región de procesamiento de cada uno con su DPA al contratar producción | `docs/PROVEEDORES.md`, `modules/channel-policy.ts` |
| **SEG-31** | **SSRF**: todo destino elegido por el cliente (webhook, Slack/Teams, S3 compatible, URL de un PDF) pasa por `assertPublicDestination` | ✅ | `modules/webhooks.ts` · `test/ssrf.test.ts` |
| **SEG-32** | **Webhooks salientes firmados** con HMAC, con reintentos y desactivación por fallas | ✅ | `modules/webhooks.ts` · `test/webhooks-health.test.ts` |
| **SEG-33** | **Webhooks entrantes verifican la firma** del proveedor (Stripe, Mercado Pago, SES, KYC) antes de leer el cuerpo | ✅ | código `invalid_signature` · `test/payments-flow.test.ts`, `ses-sns.test.ts` |
| **SEG-34** | **IA con opt-in por organización** y presupuesto; ningún documento va al proveedor sin el opt-in | ✅ | `docs/IA.md` · `test/ai.test.ts`, `ai-plan-usage.test.ts` |

---

## 5. Dependencias y operación

| ID | Regla | Estado | Evidencia |
|---|---|---|---|
| **SEG-40** | **Scripts de instalación bloqueados** salvo los de `pnpm.onlyBuiltDependencies` (`esbuild`, `pkcs11js`) | ✅ | `package.json`, `pnpm-workspace.yaml` |
| **SEG-41** | **`pnpm audit` sin críticas ni altas en producción** | ✅ **Desde el 31-Oct-2026**: 0 altas sin aceptar; las aceptadas, en §5.1 | `pnpm audit --prod --audit-level high` en `qa.sh` (todos los modos) · `pnpm.auditConfig.ignoreGhsas` |
| **SEG-42** | **Backups diarios** de Postgres con alarma si pasan 24 h sin uno | ✅ | `calasign-backup.timer` · README § Entorno dev |
| **SEG-43** | **Prueba de restauración periódica** del backup, una vez por trimestre, con la fecha y el tiempo anotados | ✅ **3-Nov-2026**: `calasign-20261103T120526Z.dump` (4,2 MB, 104 tablas, 32.684 filas) bajado en 1,0 s, restaurado en 1,9 s y verificado en 2,6 s (**5,5 s en total**, sin contar parar y arrancar el servicio): las 9.569 entradas de evidencia de 924 sobres con su cadena recalculada y el mismo hash que en la base en uso. La primera corrida encontró **dos errores del procedimiento** que habrían hecho fallar una restauración real: la lista de `pg_restore` la escribía root con `umask 077` y `calasign` no la podía leer, y el README decía que la base no usa extensiones pero el índice de búsqueda de acuerdos necesita `pg_trgm` (migración 0088). Los dos, corregidos en el README. El verificador visto fallar con un evento alterado. **Próxima: febrero de 2027** | `scripts/prueba-restauracion.sh` (restaura en una base aparte del EC2, la verifica con `scripts/verificar-restauracion.mts` y la borra; no corta el servicio) · README § Restaurar un backup |
| **SEG-44** | **Parches de seguridad del host** diarios | ✅ | timer `calasign-security-updates` (lo instala `scripts/deploy-dev.sh`) |
| **SEG-45** | **Un cambio de código no llega a dev sin el QA** | ✅ **3-Nov-2026**: `deploy-dev.sh` corre `qa.sh` completo (con los tests unitarios y el SAST), salvo que ese commit ya lo haya pasado sin cambios (marca por commit que deja `qa.sh`, también desde el QA nocturno). `QA_DEPLOY=rapido` y `SKIP_QA=1` son excepciones explícitas que se ven en la salida | `tests-automatizados.md` §4.3 |
| **SEG-46** | **Revisión por otra persona** antes de producción (hoy sólo hay dev) | 💲 / decisión: cuando exista producción, un pase aprobado por alguien distinto de quien hizo el cambio | — |
| **SEG-47** | **Certificaciones** (ISO 27001, SOC 2) que piden los clientes grandes | 💲 | — |
| **SEG-48** | **SAST**: el código pasa Semgrep con las reglas propias (SQL con datos del pedido, evidencia append-only, GCM sin largo de tag, comparación de secretos no constante, redirect abierto, `Math.random` para secretos, TLS sin verificar, `postMessage("*")`, `dangerouslySetInnerHTML`, `eval`, dato personal o URL con query en un log o en un error) y los rulesets públicos de TypeScript/Node; la infraestructura pasa Trivy | ✅ **Desde el 31-Oct-2026**. Una excepción va en la línea con `// nosemgrep: <regla> — <motivo>` | `scripts/sast.sh` (reglas propias en `qa.sh`; `--completo` de noche) · `scripts/semgrep/calasign.yml` + su test · `.trivyignore` |
| **SEG-49** | **DAST**: OWASP ZAP ataca la API (escaneo activo, autenticado, con la spec OpenAPI) sobre una instancia efímera, y analiza en pasivo el entorno desplegado (más TLS con testssl.sh); una alerta alta nueva corta | ✅ **Desde el 31-Oct-2026**, cada noche. Las aceptadas, con el motivo, en `scripts/dast/aceptadas.tsv` | `scripts/dast.sh` · `scripts/qa-nocturno.sh` |
| **SEG-50** | **Pentest externo** de un tercero antes de tener clientes reales (lo piden los cuestionarios y SOC 2/ISO 27001) | 💲 La revisión white-box interna (§5.3) deja hecho lo barato | — |

### 5.1 `pnpm audit` medido el 29-Oct-2026

Todo el árbol: 2 críticas, 3 altas, 13 moderadas, 4 bajas. **Sólo dependencias de producción** (`--prod`): 0 críticas,
3 altas, 9 moderadas, 4 bajas.

| Severidad | Paquete | Por dónde llega | Exposición | Arreglo |
|---|---|---|---|---|
| Crítica | `tinypool` 1.1.1 | `vitest` 3.2.7 (sólo tests) | Baja: no corre en el servidor | ✅ **4-Nov-2026**: vitest **4.1.12**, que ya no usa tinypool (y trae `@vitest/mocker` arreglado) |
| Alta | `zod` 3.25.76 (memoria con colecciones grandes) | `@modelcontextprotocol/sdk` 1.32.1 | Media: el MCP valida entradas de agentes | Subir el SDK de MCP cuando traiga zod ≥ 4.6.6, o un `pnpm.overrides` probado |
| Alta | `body-parser` 2.3.0 (DoS por bytes de más) | `@modelcontextprotocol/sdk` → `express` | Baja: el servidor MCP usa el transporte web estándar sobre Fastify (`modules/mcp/index.ts`), no monta express | Mismo que arriba |
| Alta | `node-forge` 1.4.0 (verificación RSA PKCS#1 v1.5 laxa) | `apps/api` directo | Baja: sólo se usa para **leer** `.p12` (`custody.ts`, Firmador), no para verificar firmas | Sin versión arreglada: mantener el uso acotado a parsear |

**31-Oct-2026: SEG-41 adoptado.** `qa.sh` corre `pnpm audit --prod --audit-level high` y da rojo ante una alta o
crítica nueva. Lo que se hizo con las de arriba (para entonces, 8 altas: aparecieron 5 nuevas de `node-forge`, entre
ellas falsificación del MAC de un PKCS#12 y bypass de `basicConstraints` en `verifyCertificateChain`):

| Advisory | Qué se hizo |
|---|---|
| `node-forge` ≤ 1.4.0 (las seis, incluida la RSA PKCS#1 v1.5) | Subido a **1.4.1** en `apps/api` y `packages/firmador` |
| `body-parser` < 2.4.0 | `pnpm.overrides` → `^2.4.0` (llega por `express` del SDK de MCP; mismo major) |
| `zod` < 4.6.6 (`GHSA-mrhx-c7xc-m3w5`) | **Aceptada** en `pnpm.auditConfig.ignoreGhsas`: no hay arreglo en zod 3 y pasar a zod 4 es una migración de todo `@calasign/shared`. Exposición acotada: el cuerpo de un pedido no pasa de 2 MB (`bodyLimit` en `app.ts`). Se saca de la lista al migrar a zod 4 |

Una alta nueva se arregla o se acepta acá con su motivo, y su GHSA va a `ignoreGhsas` en el mismo commit. Las
moderadas y bajas (`nodemailer`, `fast-uri`, `glob`, `react-router` 6) no cortan el gate.

**31-Oct-2026: osv-scanner** (en `sast.sh --completo`, informativo) ve 29 sobre todo el lockfile, las mismas de arriba
más las de herramientas de desarrollo. Las moderadas de producción con arreglo en el mismo major **se suben cuando la
versión arreglada cumpla 14 días publicada** (las cadenas de npm comprometidas de 2025 se detectaron en días; pnpm 9
no tiene `minimumReleaseAge`, que llega con pnpm 10.16):

| Paquete | Arreglada en | Publicada | Subir desde |
|---|---|---|---|
| `nodemailer` 10.0.16 (3 moderadas) | 10.1.4 | 18-Oct-2026 | ✅ **Subido el 5-Nov-2026 a 10.1.7** (la última de 10.1, del mismo día; 10.2 y 10.3 traen cambios nuevos y no hacen falta) |
| `fast-uri` 3.1.8 / 4.2.2 (vía `ajv` y `@fastify/ajv-compiler`) | 3.1.9 / 4.2.3 | 19-Oct-2026 | ✅ **Subido el 4-Nov-2026** en el lockfile (`pnpm update -r --depth Infinity fast-uri`: los rangos ya lo admitían, sin `overrides`) |
| `vite` 6.4.4 (dev) | 6.4.5 | 21-Oct-2026 | ✅ **Subido el 5-Nov-2026** |
| `glob`/`minimatch` (vía `@fastify/static`), `react-router` 6 | majors nuevos | — | con la próxima subida de `@fastify/static` / migración a react-router 7 |

**4-Nov-2026**, tras subir vitest y fast-uri: osv-scanner pasa de 29 a **16** (0 críticas; la única alta es la de
`zod`, aceptada arriba). **5-Nov-2026**, con nodemailer y vite: **11**.

### 5.2 Herramientas de SAST y DAST (sin Docker)

Binarios en `~/.local/bin`, instalados el 31-Oct-2026 con checksum verificado y versiones de al menos 14 días:
gitleaks 8.30.1, Trivy 0.75.0, osv-scanner 2.7.0 (releases de GitHub, `*_checksums.txt`), Semgrep 1.180.0 (venv propio
en `~/.local/share/semgrep-venv`, `pip install semgrep==…`), testssl.sh 3.2.4 (`~/opt/testssl`). OWASP ZAP 2.17.0 en
`~/opt/ZAP_2.17.0` (tarball Linux con su sha256; corre con el Java 17 de `~/opt`). Bajar los tarballs a disco, no a
`/tmp` (es tmpfs y se queda sin cuota).

| Corre | Qué | Tiempo |
|---|---|---|
| `qa.sh` (todos los modos) | `sast.sh`: reglas propias de Semgrep + gitleaks del historial | ~40 s |
| QA nocturno | `sast.sh --completo` (rulesets públicos, osv-scanner, Trivy), `dast.sh` (activo sobre API efímera), `dast.sh --remoto https://dev.calasign.com` (pasivo + TLS) | ~20 min |

Primera corrida (31-Oct-2026): ZAP activo 12 min sobre ~730 URLs autenticadas, **0 altas**; 4 medias/bajas aceptadas
por diseño (CORS `*` de `/oauth/*` para clientes MCP, `client_secret_basic`, XSS en JSON de baja confianza) y
`style-src 'unsafe-inline'` en la CSP (**resuelto el 3-Nov-2026**, ver abajo). dev.calasign.com: cabeceras correctas
(CSP, HSTS, `nosniff`, `frame-ancestors 'none'`), TLS sin problemas altos; testssl marca BREACH (gzip) como medio:
aceptado, el HTML comprimido no mezcla secretos con texto del atacante.

**CSP sin `'unsafe-inline'` en `style-src` (3-Nov-2026).** Queda `style-src 'self' https://fonts.googleapis.com` en
toda respuesta de la API y de la web: un HTML inyectado ya no puede meter `<style>` (leer tokens de la página con
selectores de atributo, tapar o mover botones) ni `style="…"`. Lo que lo necesitaba y cómo quedó:

| Qué | Ahora |
|---|---|
| Tema de la marca (color, fuente, CSS propio) que la web aplicaba con un `<style>` creado por script | Hoja construida (`adoptedStyleSheets`, `lib/white-label.ts`), que la CSP no frena. En navegadores sin hojas construidas (Safari < 16.4) queda el `<style>` que manda el servidor; un cambio de marca dentro de la sesión se ve al recargar |
| `<style id="brand-theme">` del `index.html` con la marca, página sin conexión de la marca, página neutra de vuelta de un proveedor, link embebido vencido | `<style>` con su hash `'sha256-…'` en el CSP de esa respuesta (`apps/api/src/lib/csp.ts` `inlineStyle`); sin atributos `style` |
| `offline.html` de la plataforma (estático) | Estilos en `/offline.css`, guardado por el service worker junto con la página |
| Vistas previas de Marca (página de firma y correos, que van con `style="…"`): iframes `srcdoc`, que heredan la CSP | Marco `/brand-preview` con su propia CSP (`white-label/preview-frame.ts`): estilos en línea sí; script sólo el suyo por hash; sin red, formularios ni `allow-same-origin`. Recibe el HTML por `postMessage` |

Fuera de la CSP de la web, con la suya propia y `'unsafe-inline'` en estilos a propósito: el complemento de Office
(`/integrations/office/*`, lo exige office.js), las páginas de pago simulado (`billing/mock-page.ts`, sólo local), los
SVG de logo y archivos de marca (`sandbox`, sin scripts) y la UI local del firmador de escritorio. Lo prueban
`apps/api/test/http-headers-estilos.test.ts` (ninguna respuesta pide `'unsafe-inline'`; cada `<style>` lleva su hash)
y `apps/web/e2e/seguridad.e2e.ts` (cero violaciones de la CSP en firmante, consola, Marca, `/verify`, `/developers` y
el pase al celular, en Chromium y WebKit). WebKit reporta `style-src-attr` al crear un `<select>` (su árbol interno
del control; el control se dibuja bien): el test lo descuenta.

### 5.3 Revisión white-box (pentest interno) del 31-Oct-2026

Revisión manual de autenticación, SSO, OAuth, firmante, embed, MCP/IA, entradas, marca blanca y webhooks, más el test
de SEG-11. Lo encontrado y arreglado, cada uno con su test:

| Severidad | Hallazgo | Arreglo |
|---|---|---|
| Media | Una sesión SSO de la organización A listaba y cerraba las sesiones de la persona en sus otras organizaciones y revocaba sus apps OAuth allá (el IdP de A puede afirmar el correo de un miembro) | Las sesiones SSO quedan acotadas a su organización en `/v1/me/sessions`, su `DELETE` y `logout-all` (`sessions.ts`) · `test/sso-session-scope.test.ts` |
| Media | `DELETE /v1/settings/email-domains/:domain` y `DELETE /v1/oauth/connected-apps/:clientId` respondían 204 a un recurso de otra organización (sin tocarlo) y lo anotaban en la auditoría propia | 404 si no borró nada · `test/tenant-isolation-routes.test.ts` |
| Baja | `Authorization: Basic …` salteaba el control de Origin y el pedido se autenticaba igual con la cookie | Sólo un Bearer de verdad lo saltea (`app.ts`) · `test/sso-session-scope.test.ts` |
| Baja | `decryptBytes` aceptaba un tag GCM de 4 bytes (falsificable por fuerza bruta); igual en el sobre de `storage.ts` y el KMS de prueba | `authTagLength: 16` · `test/crypto-gcm-tag.test.ts` · regla de Semgrep |

Los dos que habían quedado para decidir, resueltos el 3-Nov-2026:

| Severidad | Hallazgo | Arreglo |
|---|---|---|
| Media | `/v1/xml/verify` decía `valid: true` con un certificado autofirmado o de una CA desconocida: cualquiera puede generarse uno con el nombre de cualquier empresa | `valid` sigue siendo la integridad; la respuesta suma `trusted` (la cadena de KeyInfo llega al almacén de confianza) y `trustWarnings`. Con sólo la hoja en KeyInfo (lo habitual en DGII) da `trusted: false` con «no se pudo completar la cadena» · `test/xml-verify-trust.test.ts` |
| Baja | El firmante autoservicio de un link público de workflow (y el de un formulario web) ya quedaba `self_registered` con su evento en la cadena, pero el certificado de finalización decía «Link único enviado al canal del destinatario» | El certificado dice «Link mostrado en pantalla a quien completó el formulario público (correo escrito por el firmante, no verificado)» mientras no valide el correo con el código · `certificateAuthMethod` (`otp.ts`) · `test/certificate-auth-method.test.ts` y `packages/pdf/test/finalize.test.ts` |
| Media | **SSRF** (lo encontró el mutation testing de `isPrivateAddress`): `::ffff:0:a.b.c.d` (IPv4 traducida, SIIT) con una IPv4 interna adentro, el NAT64 de uso local `64:ff9b:1::/48` y el resto de `::/8` se tomaban como públicas: un webhook o una URL de PDF podía apuntar a la red interna | La forma SIIT valida su IPv4, el NAT64 conocido es sólo `64:ff9b::/96` y el resto de `::/8` es interno (`webhooks.ts`) · `test/ssrf.test.ts` prueba los dos extremos de cada rango |

---

## 6. Checklist de seguridad antes de commitear

- [ ] Consulta nueva → `tenant_id` del auth; recurso ajeno 404 (SEG-11)
- [ ] Acción nueva de una persona → auditoría con antes/después sin secretos (SEG-10)
- [ ] Algo nuevo sobre un sobre → evento de evidencia; nunca editar uno existente (SEG-01)
- [ ] Ruta nueva con un secreto en el path o la query → `lib/redact.ts` + test (SEG-20, SEG-25)
- [ ] Ningún dato personal en logs, errores, avisos ni fixtures (SEG-20): un parámetro de query nuevo con un dato →
  `PII_PARAMS` de `lib/redact.ts`; las reglas `calasign-dato-personal-*` miran logs y errores, los avisos y los textos
  libres no
- [ ] Ningún secreto en el diff; el hook activado (SEG-21)
- [ ] Destino saliente elegido por el cliente → `assertPublicDestination` (SEG-31)
- [ ] Webhook entrante → verificar la firma antes de leer (SEG-33)
- [ ] Proveedor externo nuevo → al catálogo (SEG-30) y a su doc, antes de integrarlo
- [ ] `./scripts/sast.sh` verde (lo corre `qa.sh`); una excepción, con `nosemgrep` y el motivo (SEG-48). Si una regla
  propia y una de los rulesets públicos marcan lo mismo, la excepción nombra **las dos** (separadas por coma): los
  públicos sólo corren con `--completo`, de noche, y el rápido no lo detecta
- [ ] Dependencia nueva → `pnpm audit` sin altas nuevas; si trae script de instalación, revisarlo antes de sumarlo a `onlyBuiltDependencies` (SEG-40, SEG-41)
