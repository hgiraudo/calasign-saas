# Tests automatizados y el gate antes de deployar

> Lo que no puede fallar en CalaSign es **la evidencia de una firma**: que el PDF sellado sea el que se firmó, que la
> cadena de eventos esté completa y que nadie vea un sobre de otra organización. El centro de gravedad está en los
> tests de la API y de `packages/pdf`; el navegador es la capa más floja (§6).
>
> Este doc es el **mapa**: qué capa caza qué, qué test escribir para cada cambio, y el comando que corre todo.

---

## 1. El mapa de capas

De la más barata a la más cara. Tiempos medidos el 29-Oct-2026 en esta máquina (8 núcleos, 14 GB), con las
dependencias instaladas.

| # | Capa | Comando | Tarda | Qué caza | Qué NO caza |
|---|---|---|---|---|---|
| 0 | **Hook pre-commit** | automático en `git commit` (si está activado) | **0,15 s** | secretos en texto plano, `.env`/tfstate en stage, el trinquete sobre lo que está en stage, `bash -n` | nada de comportamiento |
| 1 | **Typecheck** | `tsc --noEmit` en los 7 paquetes | **~42 s** (api 14, web 14) | contrato API↔web roto (`@calasign/shared`), traducciones faltantes (`Record<Key, string>`) | que algo funcione |
| 2 | **Reglas** | `check-calidad.mjs` + `check-error-codes.mjs` | **< 1 s** | `any`/`catch` vacío/`console` nuevos, migraciones con número repetido o editadas, códigos de error sin texto | — |
| 3 | **Unit de paquetes** | vitest en `pdf`, `xades`, `firmador`, `sdk-node` | **~36 s** · 261 tests (pdf 188) | PDF malformado, ByteRange, LTV, XAdES de DGII/DIAN/SUNAT, el Firmador | integración con la API |
| 4 | **Unit + integración de la API** | `cd apps/api && vitest run` | **~3 min 40 s** · **954 tests** · 100 archivos | la app real sobre PGlite: permisos, auditoría, evidencia append-only, SSRF, webhooks, carreras, OpenAPI | concurrencia real (PGlite es un proceso) |
| 5 | **Integraciones y SDKs** | `integrations/test/*`, `smoke_test.py` | **~10 s** | skill, MCPB, conectores de Office/Google, SDK de Python sin red | — |
| 6 | **e2e locales** | `qa.sh --solo-e2e` | **~5 min** · 23 suites | flujos de punta a punta contra una API de verdad: firmar, sellar, CRM, conectores, certificado propio, SDKs | la web en un navegador; B-LT/B-LTA (sin PKI de laboratorio) |
| 7 | **e2e contra dev** | `node scripts/<suite>.mjs https://dev.calasign.com` | minutos | lo mismo sobre Postgres, S3, KMS y Caddy reales | las suites que sólo existen en local (§5.1) |
| 8 | **Web en navegador** | 🔴 no existe | — | — | §6: propuesta |

**`qa.sh` las agrupa:**

| Modo | Capas | Tarda | Cuándo |
|---|---|---|---|
| `./scripts/qa.sh --rapido` | 1-2 | ~45 s | lo corre `deploy-dev.sh`; antes de un commit chico |
| `./scripts/qa.sh` | 1-5 | ~5 min | antes de commitear un cambio de comportamiento |
| `./scripts/qa.sh --e2e` | 1-6 | ~10 min | antes de un deploy grande, después de un merge de ramas, al cerrar una pasada de review |

---

## 2. Qué test escribir para cada cambio

Buscá tu fila **antes** de escribir el test.

| Si cambiás… | Escribís… | Y además |
|---|---|---|
| Un endpoint nuevo | Test en `apps/api/test/` con `buildApp` sobre PGlite: el camino feliz, **otro tenant da 404**, **sin permiso da 403** | OpenAPI (`openapi-contract.test.ts` falla si falta), SDKs si es público |
| Permisos, roles, scopes OAuth, límites del plan | **Unit obligatorio con el caso negativo** (el que NO tiene que poder) | `permissions-trim.test.ts` y `team-membership-hardening.test.ts` son el patrón |
| Algo que pasa sobre un sobre (estado, firma, sello) | Test que verifica **el evento en la cadena** y que la cadena sigue verificando (`verifyRows`) | Si es nuevo tipo de evento: `MODELO-DE-DATOS.md` § Eventos |
| Una acción nueva de una persona | Entrada en `audit-coverage.test.ts`: la acción queda en la auditoría, con antes/después y **sin secretos** | — |
| Sellado, PAdES, validador, parser de PDF | Unit en `packages/pdf/test/` con un PDF sintético (generado en el test) y **el caso malformado** | Tope de recursos: un PDF hostil no puede colgar (`stream-budget`, `validate-limits`) |
| Firma XML (DGII, DIAN, SUNAT) | Unit en `packages/xades/test/` con el perfil del país | — |
| Una migración | Que `qa.sh` la aplique desde cero (lo hace cada test de la API) | Si cambia datos existentes: test que siembra el estado viejo y verifica el nuevo |
| Un job, un barrido, un reintento | Test que lo corre **dos veces** (idempotencia) y uno que lo hace fallar a mitad | `sweep-robustness.test.ts`, `storage-export-retry.test.ts` |
| Una carrera (dos pedidos a la vez) | Test que fuerza el orden; **en PGlite pasar no prueba nada** de concurrencia real | `crm-writeback-race.test.ts`, `ai-metadata-races.test.ts` |
| Un destino saliente (webhook, Slack, S3, URL de un PDF) | Caso en `ssrf.test.ts`: IP interna, nombre que resuelve a una interna, redirect | — |
| Una ruta con un secreto en el path o la query | Caso en `redact.test.ts` | Y la ruta en `lib/redact.ts` |
| Un código de error nuevo | Nada a mano: `check-error-codes.mjs` verifica el texto en PT-BR/EN | — |
| Un conector de CRM o de terceros | Simulador HTTP del proveedor en la suite e2e del área (`e2e-crm`, `e2e-connectors`) | Unit del mapeo (`crm-mapping.test.ts`) |
| Una pantalla de la web | **Nada automatizado hoy**: tsc + prueba manual en celular y escritorio | §6 |
| Un script de deploy u operación | `bash -n` (lo hace `qa.sh`) + una corrida en seco | Nunca contra dev sin avisar si hay otra sesión trabajando ahí |

**La regla que gobierna todas**: antes de creerle a un test nuevo que pasa, **correlo una vez con el bug inyectado a
propósito** (comentá la guarda, invertí la condición). Si no falla, no está probando nada. El modo de falla más caro es
la ausencia de resultado leída como resultado limpio (§5).

---

## 3. Fixtures y datos de prueba

1. **Sintéticos, generados en el test**: los PDF se arman a mano (`tinyPdf()` en los e2e, los de `packages/pdf/test`),
   las claves y certificados con la PKI de laboratorio. 🔴 **Nunca un documento, un nombre, un documento de identidad
   o un correo de una persona real**, ni copiado de dev (ver [`seguridad-y-cumplimiento.md`](seguridad-y-cumplimiento.md) SEG-20).
2. **Correos de prueba en dominios que no existen** (`@example.com`, `@e2e.test`): un correo de verdad en un fixture
   termina recibiendo una invitación cuando el test corre contra dev.
3. **Una clave falsa en un test que parece real** lleva el comentario `calidad:permitir-secreto` en la línea, o el
   hook de pre-commit la bloquea.
4. **Determinismo**: la hora se inyecta, los ids se comparan por forma, no por valor; nada depende del orden de
   `Object.keys` de un objeto armado en otro lado.
5. **Cada test en su base**: `DATA_DIR` temporal por archivo (`test-support/tmpdir.ts`); nada compartido entre archivos.

---

## 4. El gate: `scripts/qa.sh`

```bash
./scripts/qa.sh              # completo sin e2e (~5 min)
./scripts/qa.sh --rapido     # typecheck + reglas (~45 s)
./scripts/qa.sh --e2e        # completo + e2e contra una API efímera (~10 min)
./scripts/qa.sh --solo-e2e   # sólo la parte e2e
```

Corre **un comando pesado a la vez** (la máquina tiene 14 GB y puede haber otra sesión compilando), deja los logs en
`var/qa/<corrida>/` (se borran si todo pasa; `QA_KEEP=1` los conserva) y sale con ≠0 si algo falló, mostrando las
últimas líneas de lo que falló. Con poca RAM: `QA_WORKERS=2 ./scripts/qa.sh`.

### 4.1 La API efímera del modo `--e2e`

- Arranca en `:4199` (**no** 4190: `fetch` bloquea ese puerto por especificación y todas las suites dan «bad port»),
  sobre PGlite en `var/qa/<corrida>/e2e-data`, con `KMS_MOCK=1`, dos celdas y **sin TSA** (`TSA_URL` vacío: el sello
  sale sin sello de tiempo y no depende de la red; `QA_TSA=1` usa la TSA por defecto).
- 🔴 **Si ya hay algo escuchando en el puerto, aborta**: puede ser la API de otra sesión, y una suite corriendo contra
  una API ajena da resultados que no son de tu código.
- Las cuatro suites que levantan **su propia** API y simuladores (`e2e-crm`, `e2e-connectors`, `e2e-lowcode`,
  `e2e-certsign`) usan puertos fijos (4115, 4117, 4118): corren de a una, después de apagar la efímera.
- Lo que **no** cubre: B-LT/B-LTA y el sello de empresa (necesitan la PKI de laboratorio, `scripts/dev-pki.mts`) y la
  fuente PKCS#11 del Firmador (necesita `softhsm2-util`). Las suites lo dicen y lo saltean.

### 4.2 El trinquete (`scripts/check-calidad.mjs`)

No exige cero: exige que **ningún archivo suba**. El baseline está en `scripts/calidad-baseline.json`, por archivo.

```
✗ calidad: 1 cuenta(s) suben respecto del baseline
  ✗ apps/api/src/modules/teams.ts: any 67 → 68   — tipos `any` (`: any`, `as any`, `<any>`, `any[]`)
  arreglalos; si es deliberado (o un renombre), regenerá el baseline en el mismo commit:
  node scripts/check-calidad.mjs --baseline   (y anotá el motivo en el mensaje del commit)
```

**Cuando un arreglo baja una cuenta, el baseline baja el mismo día** (`--baseline`): si no, el trinquete queda flojo y
el próximo puede volver a subir hasta el número viejo sin que nadie se entere. `qa.sh` lo avisa.

| Métrica | Baseline (29-Oct) | Regla |
|---|---|---|
| `any` | 1.164 en 102 archivos | [`codigo-backend.md` §3](codigo-backend.md#3-tipos-any-zod-y-el-contrato) |
| `catch-vacio` | 109 en 59 archivos | [`codigo-backend.md` §2.3](codigo-backend.md#23-lo-que-no-se-traga) |
| `console-api` | 2 (`migrate.ts`, la CLI de migraciones) | [`codigo-backend.md` §5](codigo-backend.md#5-logs) |
| `todo-sin-fecha` | 1 | [`codigo-backend.md` §10](codigo-backend.md#10-comentarios--el-estilo-de-la-casa) |
| `ts-ignore` | 0 | [`codigo-backend.md` §3](codigo-backend.md#3-tipos-any-zod-y-el-contrato) |

Además: estructura de `apps/api/migrations` (nombre, número repetido, migración versionada editada) y un aviso si un
archivo **nuevo** pasa las 1.000 líneas.

### 4.3 Cableado al deploy

`scripts/deploy-dev.sh` corre `qa.sh --rapido` antes de compilar y subir (unos 45 s sobre un deploy de varios
minutos). `SKIP_QA=1 ./scripts/deploy-dev.sh` lo saltea: es para una emergencia, y se dice en el commit o en la sesión.
El completo no va en el camino del deploy: 5 minutos cada vez terminarían salteándose siempre.

### 4.4 QA nocturno — propuesta

No existe todavía. La forma barata es un timer de systemd de usuario que corra `qa.sh --e2e` de madrugada sobre
`main` en un **worktree propio** (no el checkout compartido) y avise sólo si sale ≠0:

```ini
# ~/.config/systemd/user/calasign-qa.service (propuesta, no instalada)
[Service]
Type=oneshot
WorkingDirectory=%h/cala/calasign-qa        # git worktree add ../calasign-qa main, actualizado con git pull --ff-only
ExecStartPre=/usr/bin/git pull --ff-only
ExecStart=%h/cala/calasign-qa/scripts/qa.sh --e2e
```

La lección de Milhouse que hay que copiar: **la señal de que el QA corre es `systemctl --user status calasign-qa` en
verde, no la ausencia de aviso**. El suyo estuvo rojo 26 noches sin que nadie lo viera porque moría antes de correr un
test y no mandaba nada.

---

## 5. Lo que NO hay que hacer al escribir un test o comparar resultados

1. **Afirmar un vacío sin afirmar el éxito.** `expect(items).toEqual([])` pasa si el pedido dio 500 y el cliente
   devolvió `[]`. Primero el status, después el contenido.
2. **Afirmar que «no está» buscando un texto.** `expect(pdfText).not.toContain("secreto")` pasa si el texto no se pudo
   extraer. Afirmá también algo que **sí** tiene que estar.
3. **Un test que se saltea solo y da verde.** `describe.skipIf(!up)` es útil, pero en el gate un salteo es una falla
   (por eso `qa.sh` verifica que la integración del SDK de Node **no** se haya salteado).
4. **Comparar sólo las claves en común.** Un campo que desapareció de la respuesta no se compara nunca. Afirmá la forma
   completa con `toEqual` o el esquema de `shared`.
5. **Un `catch` en el test que se come la aserción.** `try { … } catch {}` alrededor de un `expect` lo vuelve verde
   siempre.
6. **Timeouts como sincronización.** `await sleep(500)` y después afirmar: pasa en esta máquina y falla en otra.
   Esperar la condición (polling con tope) o el evento.

### 5.1 Suites que sólo existen en local

`e2e-integrations`, `e2e-teams`, `e2e-identity`, `e2e-ai`, `e2e-agreements`, `e2e-data`, `e2e-white-label`, `e2e-api`
y `e2e-password` usan funciones que sólo existen con `APP_ENV=local` (buzón sin sesión, barridos manuales, receptores en
127.0.0.1). El resto también corre contra `https://dev.calasign.com`.

---

## 6. e2e de la web en navegador — propuesta acotada (no vigente)

**Estado.** No hay Playwright ni ninguna herramienta de navegador en el repo.

**Por qué conviene, acotado.** Hay regresiones que **sólo** se ven en un navegador y que la pasada 147 tuvo que
arreglar a mano: el visor de PDF en Safari < 17.4, el foco al cambiar de ruta, una pestaña abierta durante un deploy
que pide un chunk que ya no existe, la barra del firmante ilegible con colores de marca claros.

### 6.1 Alcance mínimo: un smoke, sin capturas de pantalla

```
apps/web/e2e/
├── firmante.e2e.ts   — abrir el link del buzón de desarrollo, ver el PDF, firmar, descargar el PDF sellado
├── consola.e2e.ts    — login, crear un sobre con un PDF, enviarlo, verlo en la lista
├── publicas.e2e.ts   — /verify con el PDF sellado, /developers carga en ES/PT-BR/EN
└── helpers/
    ├── api.ts        — alta de cuenta y sobre por la API (rápido), no por la UI
    └── ir.ts         — goto + espera de un ancla del componente
```

Contra la API efímera de `qa.sh --e2e`, con Chromium y WebKit (WebKit es el que caza Safari). En el gate iría como
`--web`, **opt-in**, hasta que tenga un mes sin falsos positivos.

**Reglas tomadas del set de Milhouse que sí aplican:**

| Regla | Por qué |
|---|---|
| `load`, **nunca** `networkidle` | El firmante y la consola mantienen conexiones (eventos, sesión): `networkidle` puede no llegar nunca |
| Después de navegar, **esperar un ancla** del componente | Confirma que React montó, no que llegó el HTML |
| Selectores por rol y texto accesible (`getByRole`), nunca por clase CSS | Prueba también la accesibilidad, y no se rompe por un cambio de estilo |
| Los datos se arman por la API, la UI sólo para lo que se prueba | Un test de firma no tiene que pasar por diez pantallas de alta |
| Todo `test()` dentro de un `test.describe` | Si no, el reporte lo muestra como `<anonymous>` |
| `page.once("dialog", …)`, no `page.on` | Con `on` el handler queda y se apila en los reintentos |

### 6.2 Lo que NO hay que copiar

- 🔴 **Capturas de pantalla comparadas (golden images) de entrada, no**: son la mayor parte del mantenimiento de un
  set así (fuentes, antialiasing, fechas). Primero el smoke funcional.
- 🔴 **Cobertura total de pantallas, no**: el equivalente acá está en los tests de la API.
- **Los tres idiomas, sí, pero baratos**: `tsc` ya garantiza que las claves existen; el e2e sólo verifica que cambiar
  el idioma cambia la página.

---

## 7. Checklist de testing antes de commitear

- [ ] Encontré mi fila en §2 y escribí **ese** test
- [ ] El test puede **fallar**: lo corrí una vez con el bug inyectado
- [ ] Permisos o datos de una organización → el caso negativo (otro tenant 404, sin permiso 403)
- [ ] Fixtures sintéticos; ningún dato de una persona real; correos en `example.com`
- [ ] `./scripts/qa.sh` verde (o `--rapido` + el test del área para algo chico)
- [ ] Cambio grande, merge de ramas o cierre de una pasada de review → `./scripts/qa.sh --e2e`
- [ ] Bajó alguna cuenta del trinquete → `node scripts/check-calidad.mjs --baseline` en el mismo commit
