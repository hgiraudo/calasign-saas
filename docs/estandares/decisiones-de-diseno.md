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

## 7. Prettier **no** se adopta como gate 🔴

**Decisión.** No hay `.prettierrc` ni `prettier --check` en el QA.

**Por qué, con el costo medido (29-Oct-2026, Prettier 3.3.3 sobre los 538 `.ts/.tsx/.mts/.mjs` versionados).**

| Configuración | Archivos que cambian |
|---|---|
| `printWidth` 100 (cerca del default) | **509 de 538** |
| `printWidth` 150 (el ancho que usa el repo) | 422 |
| `printWidth` 160 | 409 |

El estilo de la casa es deliberadamente compacto (líneas de hasta ~150, un `if` corto en una línea, objetos chicos en
una línea) y Prettier lo expande. No hay configuración que haga que el repo ya cumpla.

Y «formatear sólo lo que tocás» **no es barato**: Prettier trabaja por archivo. Tocar una función de
`modules/openapi.ts` reformatearía 1.769 líneas, en un working tree donde trabajan **varias sesiones y agentes en
paralelo** (§12): conflicto de merge garantizado y un `git blame` inútil.

**Lo que queda en su lugar.** El estilo está escrito (2 espacios, comillas dobles, punto y coma, líneas ≤ ~150) y se
revisa leyendo el diff. `tsc` caza lo que importa.

**Si alguna vez se adopta**, la única forma sana es **un commit único de reformateo** con todas las sesiones avisadas
y sin ramas abiertas, agregando la config, el gate y `.git-blame-ignore-revs` en el mismo commit. Es una decisión del
usuario, no de una sesión.

---

## 8. ESLint: pendiente de decisión ⚠️

**Estado.** No hay ESLint en ningún paquete. Lo que más se le pediría ya está cubierto de otra forma:

| Regla típica de ESLint | Cómo se cubre hoy |
|---|---|
| `no-explicit-any` | El trinquete (`check-calidad.mjs`): no sube por archivo |
| `no-empty` (catch vacío) | El trinquete |
| `no-console` en la API | El trinquete |
| `no-unused-vars` | No se cubre. **Medido**: `tsc --noUnusedLocals` da **12** avisos (10 api, 2 web) y `--noUnusedParameters`, 3 |
| `react-hooks/exhaustive-deps` | No se cubre. Es la que más bugs encontraría (efectos con datos viejos) y la que más ruido haría |

**Las dos salidas, las dos razonables:**

- **A — sin ESLint, `tsc` más estricto.** Arreglar los 12 + 3 y activar `noUnusedLocals`/`noUnusedParameters` en
  `tsconfig.base.json`. Costo: una pasada chica. Gana el `no-unused-vars` sin herramienta nueva.
- **B — ESLint con config mínima** (`typescript-eslint` + `eslint-plugin-react-hooks`, sólo `exhaustive-deps` en
  `warn` y por delta como el trinquete). Costo: una dependencia más y una medición del ruido de `exhaustive-deps`.

Mientras no se decida, **no se escribe en ningún doc que «el lint pasa»**.

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
*Arreglar todo de una*: mismo problema que §7.

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

**Descartado.** *GitHub Actions*: no hay remoto en GitHub. *Un runner local en Docker*: compite por la RAM (§12).

---

## 11. Los e2e son scripts Node contra una API real, no Playwright 🟡

**Decisión.** `scripts/e2e-*.mjs` ejercitan la API de punta a punta (crear sobre, firmar, sellar, webhooks, CRM…)
contra una API corriendo, local o `dev.calasign.com`. No hay e2e en navegador.

**Por qué.** El riesgo grande está en la API (evidencia, sellado, permisos), que es además lo que usan los
integradores. Un script con `fetch` es rápido, no se rompe por un cambio de CSS y corre contra dev igual que en local.

**El costo que se acepta.** Nada prueba que la **web** funcione: un error de render del firmante en Safari pasa todos
los tests. La propuesta acotada está en [`tests-automatizados.md` §6](tests-automatizados.md#6-e2e-de-la-web-en-navegador--propuesta-acotada-no-vigente).

---

## 12. Agentes en paralelo con worktrees, máximo dos, merge `--ff-only` ✅

**Decisión.** Un trabajo grande se reparte en agentes con `isolation: worktree`, **de a dos como máximo**, cada uno
con su número de migración reservado. El merge se resuelve en un worktree aparte y entra a `main` con un
`git merge --ff-only`.

**Por qué.** Con cinco agentes a la vez la máquina (14 GB) se quedó sin memoria (19-Oct). Y otra sesión suele estar
trabajando en el checkout principal con `tsx watch`: un merge con conflictos ahí deja marcas de conflicto en el código
que esa sesión está corriendo.

**Consecuencias.** Las reglas que reescriben en masa (§7, §9) chocan de frente con esto: por eso están como están.

---

## 13. Comentarios con el porqué dentro del código ✅

**Decisión.** Las decisiones no obvias se comentan en el código: qué, por qué, qué se rompía, y desde cuándo.

**Por qué.** Es lo que evita que la próxima pasada de review «arregle» algo deliberado. El repo ya tiene 147 pasadas
de code review: sin el comentario, cada una re-descubriría el mismo borde.

**Descartado.** *Sólo el mensaje del commit*: nadie lo lee mientras edita la línea.

---

## 14. No hay mutation testing 🟡

**Estado.** Ninguna herramienta mide si un test verde puede fallar.

**Dónde tendría sentido, acotado.** Donde un test que no prueba nada es caro: `packages/pdf` (sellado, validador),
`packages/xades`, `apps/api/src/infra/evidence.ts` y `modules/access.ts`. Stryker sobre esos módulos, **mensual y
fuera de horario**, es razonable; sobre toda la API, no (la suite tarda casi 4 minutos y Stryker la corre una vez por
mutante).

**Mientras tanto, la regla manual** ([`tests-automatizados.md` §2](tests-automatizados.md#2-qué-test-escribir-para-cada-cambio)):
antes de creerle a un test nuevo, correrlo una vez con el bug inyectado a propósito.
