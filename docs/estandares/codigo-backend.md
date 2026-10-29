# Estándares de código — backend (`apps/api` y `packages/*`)

> Node 22, TypeScript estricto, ESM. `apps/api`: Fastify + Zod + Postgres (PGlite en local). Paquetes: `shared`
> (contrato Zod), `pdf` (PAdES, validador), `xades` (firma XML), `firmador` (agente de escritorio), `sdk-node`.
> Leé también [`../ARQUITECTURA.md`](../ARQUITECTURA.md) (monolito modular, celdas, outbox) y
> [`codigo-sql-y-migraciones.md`](codigo-sql-y-migraciones.md).

---

## 1. Dónde va cada cosa

```
apps/api/src/
├── server.ts / worker.ts   — entrypoints (API y worker de jobs). NO lógica de negocio.
├── app.ts                  — buildApp(): plugins, hooks, manejador de errores y registro de módulos.
├── config.ts               — TODA variable de entorno se lee acá (con su default y su documentación en el README).
├── infra/                  — db (Postgres/PGlite), storage (disco/S3), queue (jobs), kms, seal, cells, evidence, outbox
├── lib/                    — utilidades sin estado: errors, util (hash, cifrado, uuid), redact, ip, csv, password-policy
├── notifications/          — plantillas y canales (correo, SMS, WhatsApp, Telegram)
└── modules/                — un módulo por área: envelopes, signing, templates, webhooks, teams, mcp/, crm/, ai/…
packages/shared/src/        — contrato de la API (esquemas Zod + tipos) y lógica que usan la API y la web
```

**Reglas de capa** (se cumplen hoy, medido con `grep` el 29-Oct; romperlas se nota en la revisión):

| Capa | Puede usar | NO debe usar |
|---|---|---|
| `packages/shared` | `zod` | `node:*`, Fastify, `pg`, nada de `apps/` — **corre en el navegador** |
| `packages/pdf`, `xades` | sus dependencias de PDF/cripto | `apps/*` — son librerías: reciben bytes y devuelven bytes |
| `apps/api/src/lib` | `node:*`, `config` | `modules/`, `infra/` con estado |
| `apps/api/src/infra` | `lib`, `config` | `modules/` ⚠️ excepción conocida: `infra/webhook-outbox.ts` (fan-out de plataforma, acuerdos y plan) |
| `apps/api/src/modules` | todo lo anterior | — |
| `apps/web` | `@calasign/shared` | `apps/api` (el contrato pasa por `shared`, nunca por un import de la API) |

La regla que más importa: **la web usa exactamente la misma API pública `/v1` que los clientes**. No hay endpoints
privados para la consola salvo los que el OpenAPI excluye con motivo (`apps/api/test/openapi-contract.test.ts`,
`EXCLUDED`).

---

## 2. Errores

### 2.1 Un tipo de error, con código estable

```ts
// ✅ Todo error que llega al cliente es un AppError (lib/errors.ts): status + code estable + mensaje en castellano
import { AppError, badRequest, conflict, notFound } from "../lib/errors";

if (!file) throw badRequest("file_required", "Falta el archivo (campo 'file')");
if (file.file.truncated) throw new AppError(413, "file_too_large", "El archivo supera el tamaño máximo", { limit: "file" });

// ❌ Un Error suelto llega como 500 internal_error, sin código que la web pueda traducir
throw new Error("archivo muy grande");
```

- **El `code` es interfaz pública**: lo leen el SDK, los conectores, la skill y la web para traducir. No se renombra;
  si cambia el significado, es un código nuevo. Va en `snake_case` inglés (`version_changed`, `pdf_busy`).
- **El `message` lo lee una persona**: en castellano, dice qué pasó **y qué hacer**, y nombra el objeto concreto.
- **Un código nuevo necesita su texto en PT-BR y EN** en la web (`apps/web/src/lib/api.ts` `CODE_TEXT` o
  `api-error-text.ts`), o una entrada con motivo en el `ALLOWLIST` de `scripts/check-error-codes.mjs`. Lo verifica
  `qa.sh` y un test: sin eso, en portugués e inglés la persona ve el texto en español.
- **Un código nuevo va al OpenAPI** (`modules/openapi-extra.ts`, `ERRORS`).

```ts
// ❌ No sirve para nada
throw badRequest("invalid", "inválido");

// ✅
throw badRequest("invalid_recipient_order", `El firmante "${r.name}" tiene orden ${r.order}, pero el sobre es en paralelo: quitá el orden o cambiá el envío a secuencial`);
```

### 2.2 Errores del momento: reintentables, con `Retry-After`

Lo que se resuelve solo esperando (carga, carrera con otro pedido) va como **503 con `retryAfterSeconds`** en
`details` — el manejador global pone el encabezado. Así lo hacen `pdf_busy`, `template_busy` y `concurrent_update`
(40001/40P01 de Postgres). Un 500 para algo reintentable hace que el SDK no reintente.

### 2.3 Lo que NO se traga

Un error que se ignora es una decisión, no un descuido: **tiene que estar escrito por qué**. El modo de falla más caro
acá es **la ausencia de resultado leída como resultado limpio**: un sello que no se aplicó y el sobre figura como
completado, una entrega de webhook que falló y se cuenta como enviada.

```ts
// ❌ Si falla, nadie se entera, y el trinquete lo cuenta (catch-vacio)
await s.blobs.delete(key).catch(() => {});

// ✅ Deliberado y explicado: borrar el temporal es de mejor esfuerzo, el barrido de archivos huérfanos lo levanta
await s.blobs.delete(key).catch(() => {}); // de mejor esfuerzo: file-cleanup barre los huérfanos

// ✅ O se registra
await discardCertsignFiles(s.db, s.blobs, id).catch((err) => req.log.warn({ err: String(err), envelopeId: id }, "no se pudieron borrar los PDF de la firma con certificado"));
```

Hoy hay **109 `catch` vacíos sin comentario** (baseline). No se arreglan en masa; el que toca la línea la comenta o la
loguea, y el trinquete baja.

---

## 3. Tipos: `any`, Zod y el contrato

- **Todo cuerpo, query y parámetro que entra se valida con Zod** (`Schema.parse(req.body)`); el `ZodError` lo
  convierte el manejador global en `400 validation_error` con el detalle por campo. Nunca `req.body as Algo`.
- **El esquema vive en `packages/shared`** si la web o el SDK lo usan (es la fuente de verdad del contrato, ver
  [decisiones §2](decisiones-de-diseno.md#2-el-contrato-vive-en-packagesshared-zod-sin-codegen-)); en el módulo, si es interno.
- **`any` está contado por archivo** (1.164 hoy, la mayoría `s.db.one<any>(…)` sobre filas de SQL). La regla es por
  **ubicación**:

| Contexto | `any` |
|---|---|
| Tests | ✅ Libre (el trinquete no mide `test/`) |
| Filas de SQL (`db.query<any>`) en código existente | 🟡 Tolerado; en código **nuevo**, una `interface` de la fila |
| Un dato que viene de afuera (body, JSON de un proveedor, webhook entrante) | ❌ `unknown` + Zod o narrowing |
| La respuesta de la API | ❌ El tipo de `@calasign/shared` con `satisfies` (`return { match: false, sha256 } satisfies VerifyResponse`) |
| Para callar a `tsc` | ❌ Nunca. Tampoco `@ts-ignore`; si de verdad hace falta, `@ts-expect-error` con el motivo |

---

## 4. Permisos, tenant y auditoría — en cada ruta

Toda ruta autenticada pasa por `preHandler: auth` y por **una única política** (`modules/access.ts`: RBAC + scopes
OAuth + límites del plan). Lo que hay que respetar al agregar una:

- **Toda consulta filtra por `tenant_id`** del `req.auth`, nunca por uno que venga del cliente. Ver
  [`codigo-sql-y-migraciones.md` §2](codigo-sql-y-migraciones.md#2-escribir-una-consulta).
- **La visibilidad de sobres y plantillas sale de `envelopeVisibilitySql` / `assertEnvelopeAccess`** (y sus pares de
  plantillas): no se reimplementa con un `WHERE created_by = …`.
- **Permiso nuevo** → en `PERMISSIONS` de `packages/shared/src/teams.ts`, en la política y en la UI de roles.
- **Acción nueva de una persona o una cuenta de servicio** → evento de auditoría de la organización (`recordAudit` /
  `ROUTE_ACTIONS` en `modules/audit.ts`), con valor anterior y nuevo (`changedValues`) y **sin secretos**. Lo verifica
  `test/audit-coverage.test.ts`; sumale tu caso.
- **Algo que pasa sobre un sobre** → evento en su cadena de evidencia (`appendEvent`, `infra/evidence.ts`), que es
  **append-only** y está encadenada por hash. Ver [`seguridad-y-cumplimiento.md`](seguridad-y-cumplimiento.md) SEG-01.
- **Edición concurrente**: un recurso que se edita desde la consola lleva `assertNotStale` (409 `version_changed` con
  `X-Expected-Updated-At`). Dos pestañas o dos personas no se pisan a ciegas.

---

## 5. Logs

pino, por `req.log` dentro de un pedido y `app.log` fuera. **Nunca `console.log` en `apps/api/src`** (el trinquete lo
cuenta): pino pasa por la redacción de `lib/redact.ts`, `console` no.

| Nivel | Para qué |
|---|---|
| `error` | Algo falló y alguien tiene que mirarlo (el manejador global loguea así el 500 «error no controlado») |
| `warn` | Siguió andando pero no como se esperaba: un borrado de mejor esfuerzo que falló, un reintento, un proveedor raro |
| `info` | Hitos: arranque, migraciones, worker en el proceso |
| `debug` | Casi no se usa. Nunca dentro de un loop por página, por campo o por destinatario |

🔴 **Nada de datos personales ni secretos en un log**: ni el token del link de firma, ni el código OTP, ni el documento
de identidad, ni el contenido del PDF, ni un `Authorization`. Las rutas con secreto se redactan solas
(`lib/redact.ts`: `/s/:token`, `/embed/…`, `?code=`…); **una ruta nueva con un secreto en el path o la query se agrega
ahí**, con su test en `test/redact.test.ts`.

Lo que **la persona** tiene que ver no va al log: va a la respuesta (`AppError`), a la auditoría o a un aviso
(`admin-alerts`, `security-notices`).

---

## 6. `async`, jobs y trabajo pesado

- **Lo lento o pesado no corre en el pedido**: sellar, finalizar, notificar, exportar y entregar webhooks van a la cola
  (`enqueue(db, "<cola>", payload, { dedupeKey })`, `infra/queue.ts`). El `dedupeKey` evita duplicados si el pedido se
  reintenta.
- **Todo efecto hacia afuera que depende de un cambio en la base se encola en la misma transacción** (patrón outbox,
  `infra/webhook-outbox.ts`): si la transacción se revierte, el webhook no sale.
- **Un job tiene que poder correr dos veces**: el worker reintenta. Un handler que no es idempotente duplica correos,
  cobros o sellos.
- **Procesamiento de PDF con tope de concurrencia** (`PDF_INGEST_CONCURRENCY`): un PDF grande puede llevar cientos de MB
  de RAM; el exceso espera o devuelve 503 `pdf_busy`.
- **Todo `fetch` saliente lleva timeout** (`AbortSignal.timeout`) y, si el destino lo eligió el cliente,
  `assertPublicDestination` / `postToCustomerUrl` (`modules/webhooks.ts`): sin eso, un webhook apuntado a
  `169.254.169.254` lee las credenciales de la instancia (`test/ssrf.test.ts`).
- **No se mantiene una transacción abierta mientras se espera a un tercero** salvo que sea inevitable (S3, TSA):
  `DB_IDLE_IN_TX_TIMEOUT_MS` la corta a los 5 min.

---

## 7. Agregar un endpoint

Toca estos lugares, en este orden:

1. **Contrato** en `packages/shared/src/<área>.ts`: esquema Zod del pedido y tipo de la respuesta. Campos nuevos en un
   recurso existente: **opcionales** (`.optional()`), o un cliente viejo del SDK deja de validar.
2. **Ruta** en `apps/api/src/modules/<área>.ts`: `preHandler: auth`, `parse` del cuerpo, permisos (§4), `tenant_id`.
3. **OpenAPI** (`modules/openapi*.ts`): la ruta, sus errores y sus esquemas. `openapi-contract.test.ts` falla si una
   ruta registrada no está documentada.
4. **Texto de los códigos de error nuevos** en la web (§2.1).
5. **SDKs** si es parte de la API pública (`packages/sdk-node`, `sdks/python`) y el portal `/developers`.
6. **Tests**: el de la fila que corresponda en [`tests-automatizados.md` §2](tests-automatizados.md#2-qué-test-escribir-para-cada-cambio).

---

## 8. Tamaño de archivo

| Tipo | Objetivo | Máximo razonable |
|---|---|---|
| Módulo de API (un área) | ≤ 600 líneas | 1.500 |
| Paquete (`pdf`, `xades`): un archivo por concepto | ≤ 600 | 1.200 |
| Función (cuerpo) | ≤ 80 | 200 |
| Tablas de datos (OpenAPI, diccionarios i18n, listas) | sin límite | — |

Hoy hay 17 archivos de código (sin tests) de más de 1.000 líneas (el mayor, `modules/openapi.ts`, 1.769). **No se parten por el número.** Se
parten sólo si el corte gana al menos una de estas tres cosas:

1. **Testeabilidad independiente** — cada parte se testea sin la otra.
2. **DRY** — el corte elimina duplicación real.
3. **Navegabilidad** — un lector encuentra lo que busca más rápido.

Cuando se parte, **el archivo original queda como fachada** (`export … from`) para que ningún import cambie en el mismo
commit que la lógica. `check-calidad.mjs` avisa (sin fallar) de un archivo **nuevo** de más de 1.000 líneas.

---

## 9. Paquetes (`pdf`, `xades`, `firmador`, `sdk-node`)

- **Funciones puras de bytes a bytes**: reciben `Uint8Array` y opciones, devuelven `Uint8Array` o un resultado tipado.
  Eso es lo que permite testearlas en segundos con fixtures, sin base ni red.
- **Determinismo**: la misma entrada da el mismo PDF salvo lo que es por definición variable (fecha de firma, sello de
  tiempo), y eso se inyecta (parámetro u opción), no se lee de `Date.now()` adentro.
- **El parser es superficie de ataque**: un PDF o un XML subido por un desconocido. Todo bucle sobre una estructura del
  archivo lleva **tope** (profundidad, cantidad de objetos, `/Kids`), y un archivo malformado da un error tipado, no un
  cuelgue (`test/sanitize.test.ts`, `finalize-invalid-pdf.test.ts`).
- **`sdk-node` es API pública con semver**: un cambio que rompe a un integrador es una versión mayor.

---

## 10. Comentarios — el estilo de la casa

El repo documenta **el por qué dentro del código**, con la medición o el caso cuando lo hay. No es verborragia: es la
única forma de que el próximo que pase no «arregle» algo deliberado. Se mantiene.

```ts
// ✅ El estilo que ya usa el repo: qué, por qué, y qué se rompía
// Milisegundos: la API devuelve las fechas con esa precisión (y pg/PGlite devuelven Date truncado a ms). Cualquier
// diferencia es un cambio: updated_at = now() es la hora de inicio de la transacción y otra que tomó el lock después
// puede dejarlo más viejo que el que tiene el cliente.

// ❌ Lo que no aporta
// incrementa el contador
i += 1;
```

Qué **sí** se comenta, siempre: una decisión contraintuitiva, una guarda que parece de más, un número mágico (de dónde
salió), la compatibilidad con un cliente o un formato viejo y **hasta cuándo**.

Qué **no**: parafrasear la línea de abajo, o un `TODO` sin fecha. El formato es `TODO(2026-11-10): quitar …` (fecha en
la que se puede quitar); el trinquete cuenta los que no la tienen.

---

## 11. Checklist pre-commit (backend)

- [ ] `./scripts/qa.sh` verde (o, para un cambio chico, `--rapido` + los tests del área)
- [ ] Endpoint nuevo → contrato en `shared`, OpenAPI, permisos, `tenant_id`, texto de errores (§7)
- [ ] Ningún `throw new Error` que llegue al cliente: `AppError` con código estable y mensaje que dice qué hacer
- [ ] Ningún `catch` vacío sin comentario, ningún `any` nuevo sobre datos de afuera (el trinquete no sube)
- [ ] Ningún `console.log`; ningún dato personal ni secreto en `req.log`; ruta nueva con secreto → `lib/redact.ts`
- [ ] Acción nueva de una persona → evento de auditoría; algo nuevo sobre un sobre → evento de evidencia
- [ ] Efecto hacia afuera (correo, webhook, cobro) → por la cola, idempotente, con `dedupeKey`
- [ ] `fetch` saliente con timeout; destino elegido por el cliente → `assertPublicDestination`
- [ ] Variable de entorno nueva → `config.ts` + tabla del README (o del doc del área)
- [ ] Migración nueva → reglas de [`codigo-sql-y-migraciones.md` §4](codigo-sql-y-migraciones.md#4-migraciones)
- [ ] Comentario con el porqué en cualquier decisión no obvia
