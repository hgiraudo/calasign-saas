# Decisiones de diseño — código, calidad y proceso

> Qué se decidió, **por qué**, y qué alternativas se descartaron. Existe para que una decisión no se re-litigue desde
> cero cada pocas semanas, y para que quien la quiera cambiar sepa contra qué está discutiendo.
>
> Las decisiones de **arquitectura** (celdas, outbox, `SignatureProvider`, KMS) están en
> [`../ARQUITECTURA.md`](../ARQUITECTURA.md) y no se duplican. Acá van las de **código y proceso**.
>
> Estado: ✅ vigente · 🟡 nueva o parcial · 🔴 descartada / no adoptada · ⚠️ revisar.

---

## 1. Monolito modular: un deployable de API, paquetes por dominio técnico ✅

**Decisión.** Toda la lógica de negocio vive en `apps/api` (un módulo por área, registrados en `app.ts`); lo que es
técnico y reusable va a `packages/` (`pdf`, `xades`, `shared`). El worker es el mismo código con otro entrypoint.

**Por qué.** Equipo chico y un dominio con mucho acople legítimo (un sobre toca firmante, evidencia, cobro, webhooks y
plan). Separar servicios agregaría red, versionado y transacciones distribuidas donde hoy hay una transacción con
outbox. Los paquetes sí se separan porque se testean solos y los usan otros (el Firmador usa `pdf`; la web, `shared`).

**Descartado.** *Microservicios por área*: sin carga que lo pida. *Un paquete por módulo de la API*: los módulos
comparten `Services`, la política de acceso y la auditoría; partirlos sólo movería imports.

---

## 2. El contrato vive en `packages/shared` (Zod), sin codegen ✅

**Decisión.** Los esquemas Zod del pedido y los tipos de la respuesta están en `packages/shared`; la API los usa para
validar y la web para tipar. No hay generación de tipos desde el OpenAPI ni al revés.

**Por qué.** Una sola fuente de verdad que **ya es código**: un campo nuevo rompe `tsc` en el lado que no se actualizó,
en el mismo commit. Es mejor que el espejado a mano (lo que tiene Milhouse, con su agujero de «el backend dejó de
mandar un campo») y más barato que un generador.

**Lo que queda abierto ⚠️.** El OpenAPI (`modules/openapi*.ts`) se escribe **aparte** y puede desalinearse del Zod.
`openapi-contract.test.ts` verifica rutas, códigos de error y los esquemas que leen los clientes, no cada campo.

**Descartado.** *Generar el OpenAPI desde Zod* (`zod-to-openapi`): el OpenAPI tiene descripciones, ejemplos y textos
en tres idiomas que no viven en el esquema; se evaluará si el desalineo empieza a doler.

---

## 3. Los tests usan una base de verdad (PGlite), no mocks ✅

**Decisión.** Los tests de la API levantan la app real (`buildApp`) sobre PGlite con las migraciones aplicadas, en una
carpeta temporal por archivo (`test-support/`). Los proveedores externos (CRM, pagos, KYC) se simulan con servidores
HTTP locales, no con mocks de funciones.

**Por qué.** Lo que más se rompe es la interacción entre la consulta, la transacción, los triggers y la política de
acceso; un mock de la base prueba que el SQL se arma, no que funciona. PGlite arranca en milisegundos y es Postgres de
verdad (mismo parser, mismos triggers).

**El costo que se acepta.** PGlite es un solo proceso: **no prueba concurrencia real** (ver
[`codigo-sql-y-migraciones.md` §5](codigo-sql-y-migraciones.md#5-pglite-y-postgres)). Y la suite de la API tarda
**~3 min 40 s** (954 tests, medido el 29-Oct) porque cada archivo migra su base.

**Descartado.** *Postgres en Docker para los tests*: más fiel en concurrencia, pero pide Docker y RAM en una máquina
que ya está al límite (ver §12).

---

## 4. El OpenAPI se escribe a mano, con un test de contrato ✅

**Decisión.** `GET /v1/openapi.json` se arma en `modules/openapi*.ts`. Toda ruta registrada tiene que estar
documentada, salvo una lista de exclusiones **con motivo** (`EXCLUDED` en `test/openapi-contract.test.ts`).

**Por qué.** El OpenAPI alimenta el portal `/developers`, los SDKs, los conectores (Zapier, Make, Power Automate) y la
skill: es un producto, con textos pensados para un integrador. El test garantiza que no haya rutas sin documentar.

---

## 5. Un solo tipo de error, con código estable y texto traducido ✅

**Decisión.** `AppError(status, code, message, details)` para todo lo que llega al cliente. El `code` es estable e
interfaz pública; el `message` es castellano; la web traduce por `code` a PT-BR y EN.

**Por qué.** Los clientes (SDK, conectores, agentes de IA) deciden por el código, no por el texto. Y la persona tiene
que leer el error en su idioma: `check-error-codes.mjs` garantiza que **los 411 códigos** tengan texto.

**Descartado.** *Una jerarquía de clases de error por área*: nadie hace `instanceof` sobre ellas; el manejador global
sólo necesita status y código.

---

## 6. La evidencia es append-only en la base, no sólo en el código ✅

**Decisión.** `envelope_events` y `account_audit_log` rechazan `UPDATE`/`DELETE`/`TRUNCATE` por trigger (0072, 0074),
además de la cadena de hashes. Detalle en [`../EVIDENCIA-ROLES-BD.md`](../EVIDENCIA-ROLES-BD.md).

**Por qué.** La cadena de hashes **detecta** una edición, pero alguien con escritura (o un bug) podía reescribirla
entera de forma consistente. El trigger lo **impide**. Para un producto cuyo valor es que la evidencia resista un
peritaje, la defensa va en la capa más baja posible.

---

## 7. Prettier: adoptado con un único commit de reformateo ✅

**Decisión (29-Oct-2026, pedida por el usuario).** Prettier 3.3.3 con `printWidth` 150, comillas dobles, punto y
coma y `trailingComma: "all"` (`.prettierrc.json`), **sólo sobre TypeScript y JavaScript** (`.prettierignore`).
Es gate: `prettier --check` en `qa.sh` y en el hook de pre-commit.

**El costo medido antes de decidir.**

| Configuración | Archivos que cambian (de 538 `.ts/.tsx/.mts/.mjs`) |
|---|---|
| `printWidth` 100 (cerca del default) | 509 |
| `printWidth` 150 (el ancho que ya usaba el repo) | 422 |
| `printWidth` 160 | 409 |

Se eligió 150 porque es el estilo que ya tenía el código. El reformateo final tocó **438 archivos** (los 538 más los
`.js`), en **un solo commit sin otros cambios** (`e93f8fc`), con el QA completo verde antes de commitearlo.

**Cómo se hizo para que no doliera** (lo que esta sección pedía cuando Prettier estaba descartado):
- Un commit que **sólo** formatea, separado de la configuración y del resto.
- `.git-blame-ignore-revs` con ese commit, y `git config blame.ignoreRevsFile .git-blame-ignore-revs` en el clon:
  `git blame` sigue mostrando al autor real de cada línea.
- Sin otra sesión trabajando en el repo en ese momento.

**Fuera de Prettier, a propósito.** Markdown (las tablas de los docs están alineadas a mano), CSS (reglas de una
línea), JSON, SQL y HTML.

⚠️ **Ramas viejas.** Los worktrees de agentes de hace 10-12 días (`.claude/worktrees/`) quedaron con el formato
anterior: uno tiene 7 commits sin mergear. Si alguna vez se mergea, primero `corepack pnpm format` en esa rama.

**Una rareza conocida.** Prettier no siempre deja el archivo estable en una pasada (pasó con `app.ts`, cadenas
de métodos): si `--check` falla justo después de un `--write`, se corre `--write` otra vez.

---

## 8. ESLint: sin reglas de tipos, errores en cero ✅

**Decisión (29-Oct-2026).** ESLint 9 con `@eslint/js` + `typescript-eslint` (recomendadas, **sin** reglas que
necesiten información de tipos: `tsc` ya es el gate de tipos) + `eslint-plugin-react-hooks` en la web
(`eslint.config.mjs`). Tarda ~15 s sobre todo el repo.

| Qué | Cómo quedó |
|---|---|
| Errores | **0**. El hook rechaza un commit con errores en lo que está en stage |
| `react-hooks/exhaustive-deps` | En **aviso**: 4 hoy (`BillingExtras`, `embed`, `Billing`, `Branding`). No se tocaron a ciegas: agregar una dependencia cambia cuándo corre el efecto. `qa.sh` corre con `--max-warnings 4`: el total no sube; si se arregla uno, se baja el número el mismo día |
| `no-explicit-any`, `catch` vacíos | Apagadas: las mide el trinquete por archivo (§9), con baseline |
| `no-control-regex` | Apagada: filtrar `\x00-\x1f` en cabeceras y nombres de archivo es deliberado |
| Entornos | Declarados por carpeta: Apps Script (un scope global compartido entre archivos), Zapier en CommonJS, widget AMD de Kommo, Office/Word, service worker |

**La primera pasada.** 456 hallazgos, de los cuales 413 eran de entorno (los de arriba). Los reales: 16 imports,
constantes y funciones sin uso (los mismos 12 + 3 que había medido `tsc --noUnusedLocals/--noUnusedParameters`), 4
`eslint-disable` de más, dos escapes de más en un regex de `packages/pdf/src/sanitize.ts` y expresiones sueltas en
scripts. Verificado: 188 tests de `pdf`, integraciones, y los tipos del SDK idénticos con el script viejo y el nuevo.

**Descartado.** *Reglas con información de tipos* (`recommendedTypeChecked`): minutos por paquete y mucho de lo que
cazan ya lo caza `tsc` con `strict`.

---

## 9. Trinquete por archivo en vez de exigir cero 🟡

**Decisión.** Los patrones que los estándares piden no agregar (`any`, `catch` vacío, `console` en la API, `TODO` sin
fecha, `@ts-ignore`) se **cuentan por archivo** contra un baseline (`scripts/calidad-baseline.json`). Falla si un
archivo **sube**; si algo **baja**, pide regenerar el baseline el mismo día.

**Por qué.** Hoy hay 1.164 `any` y 109 `catch` vacíos. Exigir cero son cientos de cambios sin ninguna corrección de
comportamiento, en un repo con trabajo en paralelo (§12). Pero que **no crezca** es gratis y se verifica en 0,2 s. Por
archivo (no total) para que nadie «pague» su `any` nuevo con el arreglo de otro.

**El costo que se acepta.** Un renombre de archivo cuenta como archivo nuevo: se regenera el baseline en ese commit.

**Descartado.** *`"noImplicitAny"` más estricto o una regla de lint en `error`*: rompe con el código existente.
*Arreglar todo de una*: cientos de cambios de código (no sólo de formato, como el de §7) sin ninguna corrección de comportamiento.

---

## 10. `scripts/qa.sh` como un comando, sin CI 🟡

**Decisión.** La verificación es `./scripts/qa.sh` (typecheck + trinquete + códigos de error + unit + integraciones;
con `--e2e`, también las 23 suites contra una API efímera). `deploy-dev.sh` corre `--rapido` antes de subir.

**Por qué.** No hay un remoto con runners: el repo vive en esta máquina, que es a la vez la de desarrollo. Un comando
que corre lo mismo en todos lados (a mano, en el deploy, en un timer) es lo que se puede sostener. Los tiempos medidos
están en [`tests-automatizados.md` §1](tests-automatizados.md#1-el-mapa-de-capas).

**La lección que se toma de Milhouse.** Su QA nocturno estuvo **rojo 26 noches sin que nadie lo viera**: bajo systemd
el `PATH` no traía `node`, el script moría antes de correr un test, y el silencio se leyó como verde. Por eso `qa.sh`
exporta su propio `PATH`, y si se agrega un timer (propuesta en `tests-automatizados.md` §4.4), **la señal de que corre
es el estado del servicio, no la ausencia de aviso**.

**Descartado por ahora.** *GitHub Actions*: el repo sí tiene remoto en GitHub (`origin`), así que es posible; no se
armó todavía porque la verificación que importa (las 23 suites e2e, los tests en navegador) necesita levantar la API
y bajar navegadores, y conviene primero tener `qa.sh` estable un tiempo. Es el candidato natural para el QA nocturno
(`tests-automatizados.md` §4.4). *Un runner local en Docker*: compite por la RAM (§12).

---

## 11. e2e: scripts Node contra la API, y un smoke en navegador con Playwright 🟡

**Decisión.** `scripts/e2e-*.mjs` ejercitan la API de punta a punta (crear sobre, firmar, sellar, webhooks, CRM…)
contra una API corriendo, local o `dev.calasign.com`. Desde el 29-Oct-2026, además, **Playwright** prueba la web en
navegador (`apps/web/e2e/`): el firmante de punta a punta en escritorio y celular, el login y las páginas públicas.

**Por qué.** El riesgo grande está en la API (evidencia, sellado, permisos), que es además lo que usan los
integradores. Un script con `fetch` es rápido, no se rompe por un cambio de CSS y corre contra dev igual que en local.

**El costo que se acepta.** El smoke en navegador es chico a propósito (15 tests): cubre los caminos que no pueden
romperse, no cada pantalla. WebKit (Safari) es opcional porque necesita librerías del sistema que se instalan con
`sudo`. Ver [`tests-automatizados.md` §6](tests-automatizados.md#6-e2e-de-la-web-en-navegador-playwright).

---

## 12. Agentes en paralelo con worktrees, máximo dos, merge `--ff-only` ✅

**Decisión.** Un trabajo grande se reparte en agentes con `isolation: worktree`, **de a dos como máximo**, cada uno
con su número de migración reservado. El merge se resuelve en un worktree aparte y entra a `main` con un
`git merge --ff-only`.

**Por qué.** Con cinco agentes a la vez la máquina (14 GB) se quedó sin memoria (19-Oct). Y otra sesión suele estar
trabajando en el checkout principal con `tsx watch`: un merge con conflictos ahí deja marcas de conflicto en el código
que esa sesión está corriendo.

**Consecuencias.** Todo lo que reescribe en masa choca de frente con esto: el reformateo de Prettier (§7) se hizo
en un único commit con el repo sin otras sesiones, y el trinquete (§9) mide el delta en vez de exigir cero.

---

## 13. Comentarios con el porqué dentro del código ✅

**Decisión.** Las decisiones no obvias se comentan en el código: qué, por qué, qué se rompía, y desde cuándo.

**Por qué.** Es lo que evita que la próxima pasada de review «arregle» algo deliberado. El repo ya tiene 147 pasadas
de code review: sin el comentario, cada una re-descubriría el mismo borde.

**Descartado.** *Sólo el mensaje del commit*: nadie lo lee mientras edita la línea.

---

## 14. Mutation testing con Stryker, acotado a módulos críticos 🟡

**Decisión (29-Oct-2026, pedida por el usuario).** Stryker 10 con el runner de vitest, sobre **pocos módulos críticos
y puros** con sus tests unitarios enfocados: `packages/pdf/src/signatures.ts` (ByteRange) y `apps/api/src/lib/redact.ts`
y `totp.ts`. `./scripts/mutacion.sh`, incremental, con un piso por paquete (`thresholds.break`). Detalle y números en
[`tests-automatizados.md` §8](tests-automatizados.md#8-mutation-testing-stryker).

**Por qué acotado.** Stryker corre los tests una vez por mutante. El primer intento, con un archivo de `pdf` y toda su
suite (194 tests, 2,5 min la corrida en seco), pasó los 45 minutos sin terminar. Con sólo los tests enfocados, el mismo
archivo tarda 1,5 min. Sobre toda la API serían días.

**Lo que ya dio.** La primera corrida encontró 23 bordes sin probar en `byteRangeIssue` (la validación que impide que un
PDF firmado tenga bytes sin firmar); con los tests nuevos el puntaje sobre lo cubierto pasó de 77 % a 98 %.

**Descartado.** *Stryker en `qa.sh` o en el deploy*: minutos por paquete, compite por la RAM. *Mutar toda la API*: la
suite levanta PGlite por archivo.
