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
| **SEG-11** | **Aislamiento multi-tenant**: toda consulta filtra por el `tenant_id` del `req.auth`; un recurso ajeno da 404 | ✅ Un test recorre **todas** las rutas registradas (las enumera la app): cada id del path de otra organización da 404 con sesión, API key, token SCIM y link de firma, sin cambiar sus datos, y los listados no la muestran; una ruta nueva sin fixture ni excepción lo hace fallar. Los ids que viajan en el cuerpo o en la query siguen por revisión | `codigo-sql-y-migraciones.md` §2.1 · `test/tenant-isolation-routes.test.ts` |
| **SEG-12** | **Una sola política de acceso** (RBAC + scopes OAuth + plan) para la web, las API keys, OAuth y el MCP | ✅ | `modules/access.ts` · `test/permissions-trim.test.ts`, `mcp-security.test.ts` |
| **SEG-13** | **Ninguna credencial se guarda en claro**: sesiones y API keys como SHA-256; token del firmante como hash (búsqueda) y AES-256-GCM (reenvío) | ✅ | `docs/ARQUITECTURA.md` §3.1 · `test/signer-session-token.test.ts` |
| **SEG-14** | **Contraseñas**: largo mínimo, lista de comunes, no contiene el correo, bloqueo por intentos por red y por cuenta; 2FA TOTP; SSO obligatorio por organización | ✅ | `lib/password-policy.ts` · `test/staff-auth-hardening.test.ts`, `totp.test.ts` |
| **SEG-15** | **Límite de pedidos** en todo lo público (login, verificación, formularios, OTP) | ✅ | `@fastify/rate-limit` en `app.ts` y por ruta |
| **SEG-16** | **Cookie de sesión `__Host-`**, `HttpOnly`, `Secure`, `SameSite=Lax`; cierre por inactividad | ✅ (TODO con fecha: quitar la cookie vieja el 2026-11-10) | `modules/context.ts` · `test/config-cookies.test.ts` |

---

## 3. Datos personales

Ley 172-13 (RD), Ley 1581 de 2012 (CO), LGPD (BR), Ley 29733 (PE); Honduras sin ley integral (ver ROADMAP §3.6).

| ID | Regla | Estado | Evidencia |
|---|---|---|---|
| **SEG-20** | **Nada de datos personales reales fuera de su lugar**: ni en fixtures, ni en logs, ni en mensajes de error, ni en avisos (Telegram, correo de alertas). Correos de prueba en `example.com` | 🟡 Regla nueva; los secretos de ruta se redactan solos, los datos personales dependen de la revisión | `lib/redact.ts` · `test/redact.test.ts` · `tests-automatizados.md` §3 |
| **SEG-21** | **Ningún secreto en el repo**: van a SSM o a `var/`. El tfstate no se versiona | ✅ **Desde el 31-Oct-2026** gitleaks recorre **todo el historial** en cada `qa.sh` (el hook sólo veía lo que está en stage, y hay que activarlo en cada clon). Primera pasada: 100 hallazgos, todos claves inventadas de tests y ejemplos de la documentación; ningún secreto real | `scripts/sast.sh` · `.gitleaks.toml`, `.gitleaksignore` · `scripts/hooks/pre-commit` |
| **SEG-22** | **Residencia**: el dato de una organización no sale de su celda | ✅ en el código; 🟡 **excepción desde el 30-Oct-2026** (pedido del usuario): el alta ofrece todas las regiones y una sin configurar deja a la organización en la celda por defecto (la pedida queda en `tenants.requested_cell`): antes de tener clientes reales, configurar esas celdas o volver a mostrarlas como «Próximamente»; 💲 la celda de Brasil (São Paulo) necesita cambiar la SCP de la organización AWS | `infra/cells.ts` · `test/cells-residency.test.ts` · `docs/DATOS.md` |
| **SEG-23** | **Cifrado de lo sensible** en la base (tokens de proveedores, claves en custodia) y BYOK con el KMS del cliente | ✅ | `lib/util.ts` `encrypt` · `modules/custody.ts` · `test/byok-archive-hardening.test.ts` |
| **SEG-24** | **Retención**: la purga borra archivos y deja el evento `envelope.purged`; no se borra evidencia | ✅ | `modules/retention.ts` · `test/retention.test.ts` |
| **SEG-25** | **Logs del proxy sin secretos**: Caddy escribe `[redacted]` en links de firma, invitaciones, descargas y callbacks OAuth | ✅ | `infra/dev/host/Caddyfile` · README § Entorno dev |

---

## 4. Terceros y salientes

| ID | Regla | Estado | Evidencia |
|---|---|---|---|
| **SEG-30** | **Catálogo de proveedores que reciben datos** (qué datos, para qué, región, cómo se apaga): Anthropic, Twilio, Truora, Veriff, Stripe, Mercado Pago, WhatsApp, Telegram, Google, Dropbox, Microsoft, SES y los CRM. Un proveedor nuevo se suma **antes** de integrarlo | 🔴 La información está repartida en cada `docs/*.md`; no hay una lista única (la piden LGPD y los cuestionarios de clientes) | — |
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
| **SEG-43** | **Prueba de restauración periódica** del backup (el procedimiento existe; nadie lo corrió con fecha) | 🔴 Hacerla una vez por trimestre y anotar la fecha y el tiempo | README § Restaurar un backup |
| **SEG-44** | **Parches de seguridad del host** diarios | ✅ | timer `calasign-security-updates` (lo instala `scripts/deploy-dev.sh`) |
| **SEG-45** | **Un cambio de código no llega a dev sin el QA** | 🟡 `deploy-dev.sh` corre `qa.sh --rapido`; el completo es manual | `tests-automatizados.md` §4.3 |
| **SEG-46** | **Revisión por otra persona** antes de producción (hoy sólo hay dev) | 💲 / decisión: cuando exista producción, un pase aprobado por alguien distinto de quien hizo el cambio | — |
| **SEG-47** | **Certificaciones** (ISO 27001, SOC 2) que piden los clientes grandes | 💲 | — |
| **SEG-48** | **SAST**: el código pasa Semgrep con las reglas propias (SQL con datos del pedido, evidencia append-only, GCM sin largo de tag, comparación de secretos no constante, redirect abierto, `Math.random` para secretos, TLS sin verificar, `postMessage("*")`, `dangerouslySetInnerHTML`, `eval`) y los rulesets públicos de TypeScript/Node; la infraestructura pasa Trivy | ✅ **Desde el 31-Oct-2026**. Una excepción va en la línea con `// nosemgrep: <regla> — <motivo>` | `scripts/sast.sh` (reglas propias en `qa.sh`; `--completo` de noche) · `scripts/semgrep/calasign.yml` + su test · `.trivyignore` |
| **SEG-49** | **DAST**: OWASP ZAP ataca la API (escaneo activo, autenticado, con la spec OpenAPI) sobre una instancia efímera, y analiza en pasivo el entorno desplegado (más TLS con testssl.sh); una alerta alta nueva corta | ✅ **Desde el 31-Oct-2026**, cada noche. Las aceptadas, con el motivo, en `scripts/dast/aceptadas.tsv` | `scripts/dast.sh` · `scripts/qa-nocturno.sh` |
| **SEG-50** | **Pentest externo** de un tercero antes de tener clientes reales (lo piden los cuestionarios y SOC 2/ISO 27001) | 💲 La revisión white-box interna (§5.3) deja hecho lo barato | — |

### 5.1 `pnpm audit` medido el 29-Oct-2026

Todo el árbol: 2 críticas, 3 altas, 13 moderadas, 4 bajas. **Sólo dependencias de producción** (`--prod`): 0 críticas,
3 altas, 9 moderadas, 4 bajas.

| Severidad | Paquete | Por dónde llega | Exposición | Arreglo |
|---|---|---|---|---|
| Crítica | `tinypool` 1.1.1 | `vitest` 3.2.7 (sólo tests) | Baja: no corre en el servidor | Subir vitest a una versión con tinypool ≥ 2.1.2 |
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
| `nodemailer` 10.0.16 (3 moderadas) | 10.1.4 | 18-Oct-2026 | **1-Nov-2026** |
| `fast-uri` 3.1.8 / 4.2.2 (vía `ajv` y `@fastify/ajv-compiler`) | 3.1.9 / 4.2.3 (`pnpm.overrides`) | 19-Oct-2026 | **2-Nov-2026** |
| `vite` 6.4.4 (dev) | 6.4.5 | 21-Oct-2026 | **4-Nov-2026** |
| `glob`/`minimatch` (vía `@fastify/static`), `react-router` 6 | majors nuevos | — | con la próxima subida de `@fastify/static` / migración a react-router 7 |

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
`style-src 'unsafe-inline'` en la CSP (pendiente: sacar los estilos inline). dev.calasign.com: cabeceras correctas
(CSP, HSTS, `nosniff`, `frame-ancestors 'none'`), TLS sin problemas altos; testssl marca BREACH (gzip) como medio:
aceptado, el HTML comprimido no mezcla secretos con texto del atacante.

### 5.3 Revisión white-box (pentest interno) del 31-Oct-2026

Revisión manual de autenticación, SSO, OAuth, firmante, embed, MCP/IA, entradas, marca blanca y webhooks, más el test
de SEG-11. Lo encontrado y arreglado, cada uno con su test:

| Severidad | Hallazgo | Arreglo |
|---|---|---|
| Media | Una sesión SSO de la organización A listaba y cerraba las sesiones de la persona en sus otras organizaciones y revocaba sus apps OAuth allá (el IdP de A puede afirmar el correo de un miembro) | Las sesiones SSO quedan acotadas a su organización en `/v1/me/sessions`, su `DELETE` y `logout-all` (`sessions.ts`) · `test/sso-session-scope.test.ts` |
| Media | `DELETE /v1/settings/email-domains/:domain` y `DELETE /v1/oauth/connected-apps/:clientId` respondían 204 a un recurso de otra organización (sin tocarlo) y lo anotaban en la auditoría propia | 404 si no borró nada · `test/tenant-isolation-routes.test.ts` |
| Baja | `Authorization: Basic …` salteaba el control de Origin y el pedido se autenticaba igual con la cookie | Sólo un Bearer de verdad lo saltea (`app.ts`) · `test/sso-session-scope.test.ts` |
| Baja | `decryptBytes` aceptaba un tag GCM de 4 bytes (falsificable por fuerza bruta); igual en el sobre de `storage.ts` y el KMS de prueba | `authTagLength: 16` · `test/crypto-gcm-tag.test.ts` · regla de Semgrep |

Quedan anotados para decidir: `/v1/xml/verify` dice `valid: true` con un certificado autofirmado (no evalúa confianza;
sumar `trusted` o una advertencia), y el link público de un workflow con firmante autoservicio no verifica el correo
que se escribe (revisar que la evidencia lo marque como no verificado, como `self_registered` en los formularios).

---

## 6. Checklist de seguridad antes de commitear

- [ ] Consulta nueva → `tenant_id` del auth; recurso ajeno 404 (SEG-11)
- [ ] Acción nueva de una persona → auditoría con antes/después sin secretos (SEG-10)
- [ ] Algo nuevo sobre un sobre → evento de evidencia; nunca editar uno existente (SEG-01)
- [ ] Ruta nueva con un secreto en el path o la query → `lib/redact.ts` + test (SEG-20, SEG-25)
- [ ] Ningún dato personal en logs, errores, avisos ni fixtures (SEG-20)
- [ ] Ningún secreto en el diff; el hook activado (SEG-21)
- [ ] Destino saliente elegido por el cliente → `assertPublicDestination` (SEG-31)
- [ ] Webhook entrante → verificar la firma antes de leer (SEG-33)
- [ ] Proveedor externo nuevo → al catálogo (SEG-30) y a su doc, antes de integrarlo
- [ ] `./scripts/sast.sh` verde (lo corre `qa.sh`); una excepción, con `nosemgrep` y el motivo (SEG-48)
- [ ] Dependencia nueva → `pnpm audit` sin altas nuevas; si trae script de instalación, revisarlo antes de sumarlo a `onlyBuiltDependencies` (SEG-40, SEG-41)
