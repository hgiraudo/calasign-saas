# Estándares — SQL y migraciones

> Postgres en dev (y en producción), **PGlite** (Postgres embebido en WebAssembly) en local y en los tests. El mismo
> SQL corre en los dos, así que todo lo de acá vale para ambos salvo donde se dice. El modelo y la lista de migraciones
> están en [`../MODELO-DE-DATOS.md`](../MODELO-DE-DATOS.md); los triggers de evidencia, en
> [`../EVIDENCIA-ROLES-BD.md`](../EVIDENCIA-ROLES-BD.md).

---

## 1. Acceso a la base

```ts
// La interfaz es infra/db.ts: query (filas), one (primera fila o null), tx (transacción)
const rows = await s.db.query<Fila>(`SELECT … WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
const env  = await s.db.one<EnvelopeRow>(`SELECT … WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
await s.db.tx(async (t) => { … });   // todo lo de adentro con t, nunca con s.db
```

- **Siempre parámetros (`$1`, `$2`)**, nunca interpolar un valor en el SQL. Un nombre de columna u orden dinámico sale
  de una lista cerrada en el código (`const ORDER = { created: "created_at", … }[q.sort]`), nunca del pedido.
- **Una búsqueda por texto con `LIKE`** escapa los comodines (`likeContains` de `lib/util.ts`).
- **Dentro de una transacción se usa `t`**, no `s.db`: una consulta por `s.db` va por otra conexión del pool, no ve lo
  escrito en la transacción y puede quedar esperando un lock que la propia transacción tiene.

---

## 2. Escribir una consulta

### 2.1 Multi-tenant: la regla que no se rompe

🔴 **Toda consulta sobre datos de una organización filtra por `tenant_id`**, y el valor sale de `req.auth.tenantId`,
nunca del cuerpo, la query o el path. Un `id` de otro tenant tiene que dar **404, no 403** (no se confirma que existe).

```sql
-- ❌ El id viene del cliente: con el UUID de un sobre ajeno, lo devuelve
SELECT * FROM envelopes WHERE id = $1

-- ✅
SELECT * FROM envelopes WHERE tenant_id = $1 AND id = $2
```

La visibilidad **dentro** de la organización (roles, grupos, compartidos) no se reimplementa: sale de
`envelopeVisibilitySql` / `templateVisibilitySql` (`modules/access.ts`).

### 2.2 Reglas de escritura

| Regla | Por qué |
|---|---|
| Fechas en `timestamptz`, se comparan en UTC y salen por `iso()` | La web las formatea en la zona del navegador; un `timestamp` sin zona se lee con la del server |
| Un id que viene del cliente puede no ser UUID: lo convierte el manejador global (22P02 → 400 `invalid_id`) | No hace falta validarlo a mano, pero **sí** que la consulta no lo concatene |
| Una carrera contra una restricción única da 23505 → 409 `conflict` | Si el flujo tiene una respuesta mejor (devolver el existente), `ON CONFLICT` explícito |
| `SELECT … FOR UPDATE` cuando se lee para decidir y escribir (estado de un sobre, cupo del plan) | Dos pedidos simultáneos leen el mismo estado y los dos «ganan» |
| Una cola o un barrido toma filas con `FOR UPDATE SKIP LOCKED` | Dos workers no procesan el mismo job |
| Paginación por **cursor** (`created_at, id`), no por `OFFSET` | Con `OFFSET` una fila insertada en el medio se repite o se saltea, y en tablas grandes es lento |
| Toda lista tiene `LIMIT` (con tope) | Una organización con 200.000 sobres no puede pedir todos de una |
| Lo que se compara exacto (montos, uso del plan) va en `numeric` o entero de centavos | `float` cambia el último dígito |

### 2.3 Rendimiento: medir, no estimar

- **Una consulta nueva sobre una tabla que crece** (`envelopes`, `envelope_events`, `jobs`, `webhook_deliveries`,
  `account_audit_log`) lleva su índice, y el índice va en la misma migración que la consulta lo necesita.
- **`EXPLAIN ANALYZE` a una escala representativa**, no sobre la base de un test con 3 filas: PGlite con 3 filas
  hace seq scan y tarda 1 ms; en dev con cientos de miles, no.
- **`DB_STATEMENT_TIMEOUT_MS` (60 s) corta lo que se cuelga**: una consulta que se acerca a ese tiempo en un pedido
  web es un bug, no un caso para subir el límite.

---

## 3. Transacciones

- **Lo que tiene que pasar junto va en una transacción**: el cambio de estado del sobre, su evento de evidencia y el
  job o el webhook que dispara (outbox, `infra/webhook-outbox.ts`). Si una parte falla, no queda ninguna.
- **Nada lento adentro**: ni una llamada HTTP a un tercero, ni procesar un PDF. Si es inevitable (S3, TSA), que sea
  corto: `DB_IDLE_IN_TX_TIMEOUT_MS` (5 min) corta la transacción ociosa.
- **Serialización y deadlocks (40001, 40P01) se reintentan**: el manejador global devuelve 503 `concurrent_update`
  con `Retry-After`. Un job que choca lo reintenta el worker.

---

## 4. Migraciones

### 4.1 Cómo funcionan

`apps/api/migrations/NNNN_descripcion.sql`, aplicadas por `migrate()` (`infra/db.ts`) **por nombre, en orden
alfabético**, cada una en su transacción junto con su fila en `schema_migrations`, con un candado para que la API y el
worker no las corran a la vez. En local y en los tests corren al arrancar; en producción, con `MIGRATE_ON_START=1`.

### 4.2 Reglas (lo que verifica `scripts/check-calidad.mjs` está marcado con 🤖)

| Regla | Qué pasa si no |
|---|---|
| 🤖 **Nombre `NNNN_descripcion_en_minusculas.sql`, número siguiente al último** | — |
| 🤖 **Un número por migración**: ramas en paralelo toman cada una el suyo **antes** de empezar | Dos `0052` (pasó): el orden lo decide el resto del nombre. Quedó en la lista de permitidos porque ya se aplicaron |
| 🤖 **Una migración aplicada en algún entorno no se edita**: el cambio va en una nueva | Ya corrió: en dev no se vuelve a aplicar y dev queda distinto de una base nueva. Se editaron 5 ya versionadas; si todavía no se deployó, `CALIDAD_MIGRACION_EDITABLE=1` |
| **Aditivas**: columnas nuevas nulables o con default, tablas nuevas | El rollback del deploy **no deshace migraciones**: el código anterior tiene que andar con la base nueva (README § Entorno dev) |
| **Re-ejecutables**: `IF NOT EXISTS` / `IF EXISTS` | Una migración a medio aplicar (sin transacción) se reintenta entera |
| **Una columna que se deja de usar no se borra en el mismo deploy** que deja de leerla | El rollback vuelve al código que sí la lee |
| Una migración destructiva (`DROP`, cambio de clave) se anuncia en el commit y en `MODELO-DE-DATOS.md` | `0016` (clave primaria) y `0017` (tablas) son las que hacen que el rollback necesite restaurar el backup |
| **Índice sobre una tabla grande**: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` en una migración propia con `-- no-transaction` en la primera línea | Un `CREATE INDEX` común bloquea las escrituras de la tabla mientras dura |
| **Backfills grandes no van en la migración**: la migración agrega la columna; el barrido periódico (`modules/jobs.ts`) la llena de a lotes | Un `UPDATE` masivo retiene bloqueos durante todo el arranque |
| **El cuerpo de una función `plpgsql` va en una sola línea** | El runner (`splitSql`) corta en un punto y coma al final de línea |
| Cada migración empieza con un comentario: **qué cambia y por qué** | Es la única documentación del esquema que se lee al lado del cambio (ver `0122`) |
| Una entrada en la tabla de `MODELO-DE-DATOS.md` | Es el mapa de qué agregó cada número |

### 4.3 Tablas append-only

`envelope_events` (la cadena de evidencia de cada sobre) y `account_audit_log` (la auditoría de la organización)
**rechazan `UPDATE`, `DELETE` y `TRUNCATE` por trigger** (0072, 0074), salvo las dos excepciones documentadas. Una
tabla nueva que sea evidencia o auditoría lleva el mismo trigger. Un mantenimiento que de verdad necesite escribir ahí
usa `SET LOCAL calasign.allow_evidence_write = 'on'` dentro de su transacción y queda explicado en su migración.

🔴 **Nunca se «corrige» una fila de evidencia**: un evento equivocado se compensa con otro evento. Editarla rompe la
cadena de hashes, y un peritaje lo ve.

---

## 5. PGlite y Postgres

- **El código no pregunta por el dialecto** salvo en `infra/db.ts` (`db.dialect`). Si hace falta una diferencia, va
  ahí, no en un módulo.
- **PGlite es un solo proceso**: no prueba concurrencia real entre conexiones. Una carrera (dos workers, dos pedidos)
  se prueba con Postgres o con un test que fuerce el orden; que pase en PGlite no prueba nada.
- **PGlite no tiene `CONCURRENTLY`**: el runner lo quita; la migración igual tiene que andar en una transacción.
- Lo que sólo existe en Postgres (extensiones, roles, `pg_stat_*`) no se usa sin una alternativa en PGlite, o los
  tests y el desarrollo local dejan de funcionar.

---

## 6. Checklist antes de commitear SQL o una migración

- [ ] Toda consulta nueva filtra por `tenant_id` del `req.auth`; un id ajeno da 404
- [ ] Parámetros `$N`; ningún valor interpolado; orden/columnas dinámicos de una lista cerrada
- [ ] Listas con `LIMIT` y paginación por cursor
- [ ] Leer-para-escribir con `FOR UPDATE`; colas con `SKIP LOCKED`
- [ ] Índice para la consulta nueva sobre una tabla que crece, medido con `EXPLAIN ANALYZE` a escala
- [ ] Migración: número propio y siguiente, aditiva, re-ejecutable, con comentario y entrada en `MODELO-DE-DATOS.md`
- [ ] Índice sobre tabla grande → migración propia `-- no-transaction` + `CONCURRENTLY IF NOT EXISTS`
- [ ] Ninguna migración ya aplicada editada (`node scripts/check-calidad.mjs` lo dice)
- [ ] Tabla nueva de evidencia o auditoría → trigger append-only
