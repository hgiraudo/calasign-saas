# Tests automatizados y el gate antes de deployar

> Lo que no puede fallar en CalaSign es **la evidencia de una firma**: que el PDF sellado sea el que se firmó, que la
> cadena de eventos esté completa y que nadie vea un sobre de otra organización. El centro de gravedad está en los
> tests de la API y de `packages/pdf`; el navegador tiene un smoke de los caminos críticos y sus pruebas de seguridad (§6).
>
> Este doc es el **mapa**: qué capa caza qué, qué test escribir para cada cambio, y el comando que corre todo.

---

## 1. El mapa de capas

De la más barata a la más cara. Tiempos medidos el 29-Oct-2026 en esta máquina (8 núcleos, 14 GB), con las
dependencias instaladas.

| # | Capa | Comando | Tarda | Qué caza | Qué NO caza |
|---|---|---|---|---|---|
| 0 | **Hook pre-commit** | automático en `git commit` (si está activado) | **~1,5 s** | secretos en texto plano (gitleaks si está instalado, más las regex propias), `.env`/tfstate en stage, formato y errores de ESLint en lo que está en stage, el trinquete, `bash -n` | nada de comportamiento |
| 1 | **Typecheck** | `tsc --noEmit` en los 7 paquetes | **~42 s** (api 14, web 14) | contrato API↔web roto (`@calasign/shared`), traducciones faltantes (`Record<Key, string>`) | que algo funcione |
| 2 | **Reglas** | `prettier --check` + `eslint` + `check-calidad.mjs` + `check-error-codes.mjs` + `pnpm audit --prod --audit-level high` (red) + `sast.sh` (Semgrep con las reglas propias y gitleaks sobre todo el historial) | **~65 s** (Prettier 19, ESLint 14, SAST 30) | formato, imports y variables sin uso, hooks de React mal usados, `any`/`catch` vacío/`console` nuevos, migraciones con número repetido o editadas, códigos de error sin texto, una dependencia de producción con vulnerabilidad alta nueva, SQL con datos del pedido, cambios a la evidencia, redirects abiertos y otros patrones inseguros (SEG-48), un secreto en cualquier commit (SEG-21) | fallas que sólo aparecen corriendo (eso es el DAST, capa 9) |
| 3 | **Unit de paquetes** | vitest en `pdf`, `xades`, `firmador`, `sdk-node` | **~36 s** · 261 tests (pdf 188) | PDF malformado, ByteRange, LTV, XAdES de DGII/DIAN/SUNAT, el Firmador | integración con la API |
| 4 | **Unit + integración de la API** | `cd apps/api && vitest run` | **~3 min 40 s** · **954 tests** · 100 archivos | la app real sobre PGlite: permisos, auditoría, evidencia append-only, SSRF, webhooks, carreras, OpenAPI | concurrencia real (PGlite es un proceso) |
| 5 | **Integraciones y SDKs** | `integrations/test/*`, `smoke_test.py` | **~10 s** | skill, MCPB, conectores de Office/Google, SDK de Python sin red | — |
| 6 | **e2e locales** | `qa.sh --solo-e2e` | **~5 min** · 23 suites | flujos de punta a punta contra una API de verdad: firmar, sellar, CRM, conectores, certificado propio, SDKs | la web en un navegador; B-LT/B-LTA (sin PKI de laboratorio) |
| 7 | **e2e contra dev** | `node scripts/<suite>.mjs https://dev.calasign.com` | minutos | lo mismo sobre Postgres, S3, KMS y Caddy reales | las suites que sólo existen en local (§5.1) |
| 8 | **Web en navegador** | `qa.sh --web` (Playwright) | **~1,5 min** · 25 tests (build 19 s + ~70 s) | el firmante de punta a punta en Chromium de escritorio y de celular y en WebKit (consentimiento, PDF dibujado, firma, descarga idéntica al sellado), login, `/verify`, `/developers`, excepciones de JavaScript; violaciones de la CSP, XSS almacenado, enmarcado y sesión tras salir (`seguridad.e2e.ts`) | pantallas fuera del smoke |
| 9 | **Seguridad nocturna** | `sast.sh --completo`, `dast.sh`, `dast.sh --remoto https://dev.calasign.com` (QA nocturno) | **~20 min** | rulesets públicos de Semgrep, dependencias con vulnerabilidad (osv-scanner, informativo), configuración insegura de `infra/` (Trivy); OWASP ZAP **atacando** la API efímera autenticado con la spec OpenAPI (inyección, XSS, traversal, cabeceras, errores que filtran internos) y en pasivo dev, más TLS (SEG-49) | lógica de negocio y autorización entre organizaciones (eso es `tenant-isolation-routes.test.ts`) |

**`qa.sh` las agrupa:**

| Modo | Capas | Tarda | Cuándo |
|---|---|---|---|
| `./scripts/qa.sh --rapido` | 1-2 | ~105 s | antes de un commit chico; `deploy-dev.sh` con `QA_DEPLOY=rapido` |
| `./scripts/qa.sh` | 1-5 | ~15 min | antes de commitear un cambio de comportamiento; lo corre `deploy-dev.sh` si ese commit no lo pasó (§4.3) |
| `./scripts/qa.sh --web` | 8 | ~1 min | después de tocar la web |
| `./scripts/qa.sh --e2e` | 1-6 y 8 | ~17 min | antes de un deploy grande, después de un merge de ramas, al cerrar una pasada de review |

---

## 2. Qué test escribir para cada cambio

Buscá tu fila **antes** de escribir el test.

| Si cambiás… | Escribís… | Y además |
|---|---|---|
| Un endpoint nuevo | Test en `apps/api/test/` con `buildApp` sobre PGlite: el camino feliz, **otro tenant da 404**, **sin permiso da 403** | OpenAPI (`openapi-contract.test.ts` falla si falta), SDKs si es público; con un id nuevo en el path, su fixture en `tenant-isolation-fixtures.ts` (o la excepción pública con el motivo): `tenant-isolation-routes.test.ts` falla si falta; con un id nuevo en el cuerpo o la query, su prueba en `tenant-isolation-refs.test.ts` (o la excepción con el motivo), que también falla si falta |
| Permisos, roles, scopes OAuth, límites del plan | **Unit obligatorio con el caso negativo** (el que NO tiene que poder) | `permissions-trim.test.ts` y `team-membership-hardening.test.ts` son el patrón |
| Algo que pasa sobre un sobre (estado, firma, sello) | Test que verifica **el evento en la cadena** y que la cadena sigue verificando (`verifyRows`) | Si es nuevo tipo de evento: `MODELO-DE-DATOS.md` § Eventos |
| Una acción nueva de una persona | Entrada en `audit-coverage.test.ts`: la acción queda en la auditoría, con antes/después y **sin secretos** | — |
| Sellado, PAdES, validador, parser de PDF | Unit en `packages/pdf/test/` con un PDF sintético (generado en el test) y **el caso malformado** | Tope de recursos: un PDF hostil no puede colgar (`stream-budget`, `validate-limits`) |
| Firma XML (DGII, DIAN, SUNAT) | Unit en `packages/xades/test/` con el perfil del país | — |
| Una migración | Que `qa.sh` la aplique desde cero (lo hace cada test de la API) | Si cambia datos existentes: test que siembra el estado viejo y verifica el nuevo |
| Un job, un barrido, un reintento | Test que lo corre **dos veces** (idempotencia) y uno que lo hace fallar a mitad | `sweep-robustness.test.ts`, `storage-export-retry.test.ts` |
| Una carrera (dos pedidos a la vez) | Test que fuerza el orden; **en PGlite pasar no prueba nada** de concurrencia real | `crm-writeback-race.test.ts`, `ai-metadata-races.test.ts` |
| Un destino saliente (webhook, Slack, S3, URL de un PDF) | Caso en `ssrf.test.ts`: IP interna, nombre que resuelve a una interna, redirect | — |
| Una ruta con un secreto en el path o la query, o un parámetro con un dato personal | Caso en `redact.test.ts` | Y la ruta en `lib/redact.ts` (`SECRET_AFTER`, `SECRET_PARAMS` o `PII_PARAMS`) |
| Una clave nueva que lleva un dato personal en los logs (`PII_KEY_ENDINGS`, `PII_KEYS` de `lib/redact.ts`) | Caso en el `it.each` de `redact.test.ts`, visto censurado en la línea de pino | — |
| Una regla de Semgrep propia (`scripts/semgrep/calasign.yml`) | Un caso `ruleid:` y uno `ok:` en `scripts/semgrep/calasign.tsx` (`semgrep --test`, lo corre `sast.sh`) | Correrla sobre el repo: cada hallazgo se arregla o lleva `nosemgrep` con el motivo (SEG-48) |
| Un código de error nuevo | Nada a mano: `check-error-codes.mjs` verifica el texto en PT-BR/EN | — |
| Un conector de CRM o de terceros | Simulador HTTP del proveedor en la suite e2e del área (`e2e-crm`, `e2e-connectors`) | Unit del mapeo (`crm-mapping.test.ts`) |
| Una pantalla de la web | Si está en un camino crítico (firmante, login, verificación): un test en `apps/web/e2e/`; si no, tsc + prueba manual en celular y escritorio | §6 |
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
./scripts/qa.sh --rapido     # typecheck + formato + lint + reglas (~75 s)
./scripts/qa.sh --e2e        # completo + e2e contra una API efímera + navegador (~11 min)
./scripts/qa.sh --solo-e2e   # sólo la parte e2e (API y navegador)
./scripts/qa.sh --web        # sólo los tests en navegador (~1 min)
```

Corre **un comando pesado a la vez** (la máquina tiene 14 GB y puede haber otra sesión compilando), deja los logs en
`var/qa/<corrida>/` (se borran si todo pasa; `QA_KEEP=1` los conserva) y sale con ≠0 si algo falló, mostrando las
últimas líneas de lo que falló. Con poca RAM: `QA_WORKERS=2 ./scripts/qa.sh`.

Una vez por máquina, además de Node y pnpm: `sudo apt install python3-lxml`. Es el verificador independiente de la firma
XML (`packages/xades/test/verify_xmldsig.py`, libxml2): `qa.sh` lo exige (`XMLDSIG_REQUIRED=1`) y sin él `vitest xades`
falla con «instalar python3-lxml». Antes el test lo salteaba y en ninguna máquina estaba instalado: del 17-Oct al
12-Nov-2026 el contraste con libxml2 no corrió nunca con el QA en verde (§5, punto 3).

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

**ESLint sigue la misma idea**: errores en cero, y los avisos (`react-hooks/exhaustive-deps`, 2 desde el 14-Nov-2026) no pueden
subir: `qa.sh` corre `eslint --max-warnings 2` (`ESLINT_MAX_WARNINGS` lo cambia). Si un arreglo baja la cuenta, el
número de `qa.sh` y de `package.json` (`lint`) baja en el mismo commit.

### 4.3 Cableado al deploy

**Desde el 3-Nov-2026 (SEG-45)** `scripts/deploy-dev.sh` corre el **completo** (`qa.sh`, con los tests unitarios)
antes de compilar y subir, **salvo que ese commit ya lo haya pasado**: `qa.sh` completo o `--e2e` en verde sobre un
árbol sin cambios deja una marca por commit en el directorio común de git (`.git/calasign-qa-verde/<sha>`), que ven
todos los worktrees, también el del QA nocturno. Así el costo se paga una vez por commit y no en cada deploy (antes iba
sólo el rápido porque repetir el completo en cada deploy terminaba salteándose). Con cambios sin commitear se corre
siempre. `QA_DEPLOY=rapido` corre sólo el rápido (un cambio que no toca código; queda dicho en la salida) y
`SKIP_QA=1` lo saltea: es para una emergencia, y se dice en el commit o en la sesión.

### 4.4 QA nocturno

**Estado (31-Oct-2026).** ✅ Instalado en la máquina de trabajo: `scripts/qa-nocturno.sh` y sus unidades en
`scripts/qa-nocturno/`. En un clon nuevo se instala una vez (lo hace el usuario: es un timer que queda corriendo en su
máquina):

```bash
./scripts/qa-nocturno.sh --instalar   # crea el worktree ../calasign-qa e instala calasign-qa.timer (03:30 cada noche)
./scripts/qa-nocturno.sh --estado     # la última corrida y el próximo disparo
./scripts/qa-nocturno.sh              # una corrida ahora, igual que la del timer
```

- Corre `qa.sh --e2e` **con WebKit** (`E2E_WEBKIT=1`) sobre el último `main` **local** en un **worktree propio** (`checkout --detach main`, sin pull: lo
  que está commiteado en `main` aunque no esté pusheado), nunca en el checkout compartido.
- Después, la seguridad (capa 9, desde el 31-Oct-2026): `sast.sh --completo`, `dast.sh` (ZAP activo sobre una API
  efímera en `:4196`) y `dast.sh --remoto` contra dev (`DAST_REMOTO` cambia el destino; vacío lo saltea). Una alerta
  alta nueva de ZAP o un hallazgo nuevo del SAST deja la noche en rojo. Informes en `var/dast/` y `var/sast/` del
  worktree (del SAST en verde queda sólo `osv.txt`: hasta el 14-Nov-2026 se borraba todo y lo más nuevo en `var/sast/`
  era un rojo del 4-Nov, que se podía leer como el de la noche). Herramientas: `seguridad-y-cumplimiento.md` §5.2.
- Con `Nice=10`, E/S `idle` y `QA_WORKERS=3`: no le gana la máquina a una sesión que esté trabajando.
- Cada paso con techo propio (`timeout`, sale con 124 y el log dice «cortado a los …»): `qa.sh --e2e` 75 min (y
  dentro, vitest de la API 25 min con `QA_TIMEOUT_VITEST_API`), SAST 20, DAST activo 60 y remoto 25. La unidad corta a
  los 200 min, por encima de la suma; si igual corta, el script escribe `ultimo.txt` en rojo y avisa.
- Temporales en disco, en `/var/tmp/calasign-qa-nocturno-<uid>` (`TMPDIR`), que se vacía en cada corrida: `/tmp` es
  tmpfs y lo comparten los QA nocturnos de otros proyectos de la máquina, que corren a la misma hora. **No** dentro del
  repo: el 12 y 13-Nov-2026 estuvo en `var/tmp/` del worktree y la noche quedó roja por dos lados. AppArmor (perfil
  `gs` de Ubuntu) sólo deja a Ghostscript crear temporales en `/tmp` y `/var/tmp`, y bajo el repo Node encuentra el
  `package.json` raíz (`"type": "module"`) y los conectores que `integrations/test` genera en el temporal ya no se
  cargan con `require`.
- Resultado en `var/qa-nocturno/ultimo.txt` y el log de cada noche al lado (quedan 14). En rojo, aviso de escritorio.
- Sin `linger` el timer corre sólo con la sesión abierta; `Persistent=true` recupera la corrida perdida al volver
  (`sudo loginctl enable-linger $USER` lo hace correr con la sesión cerrada).
- Se descartó GitHub Actions: el gate usa PGlite, puertos fijos y la PKI de laboratorio local, y un runner nuevo pide
  instalar todo cada vez; el timer local no cuesta nada.

La lección de Milhouse que hay que copiar: **la señal de que el QA corre es `systemctl --user status calasign-qa` en
verde y la fecha de `ultimo.txt`, no la ausencia de aviso**. El suyo estuvo rojo 26 noches sin que nadie lo viera
porque moría antes de correr un test y no mandaba nada.

Nos pasó lo mismo del 1 al 4-Nov-2026: el cuerpo del script iba entre llaves (`{ … } >"$LOG"`) y su `exit` terminaba
el script entero antes de escribir `ultimo.txt` y de avisar. Ninguna noche dejó `ultimo.txt` y la del 4-Nov quedó en
rojo (SAST) sin aviso. Desde `490b13c` es un subshell. Si `--estado` dice «Nunca corrió» con logs en
`var/qa-nocturno/`, el script está roto, no el timer.

Y otra vez el 10 y 11-Nov-2026, con el mismo commit que había pasado el 9: vitest de la API falló con `ENOSPC`
(«Check free disk space» de PGlite) y se quedó colgado hasta que systemd lo mató a los 150 min; `ultimo.txt` siguió
diciendo «verde» del 9 y no hubo aviso. `/tmp` (tmpfs de 7,4 GB) estaba lleno: 1,7 GB eran carpetas de la API de
Playwright (`calasign-web-e2e-*`) que no se borraban porque Playwright mata su `webServer` con SIGKILL, y el resto,
temporales de los QA nocturnos de otros proyectos. Arreglos: `servidor.mjs` lleva el PID en la carpeta y barre las de
servidores muertos (como `test-support/global-tmp.ts`), Playwright lo apaga con SIGTERM (`gracefulShutdown`), el
nocturno usa su propio `TMPDIR`, cada paso tiene techo y `qa.sh` avisa si el temporal tiene menos de 3 GB libres.
**Un test que crea una carpeta temporal tiene que borrarla también cuando lo matan** (PID en el nombre y barrido al
arrancar), no sólo en el `exit`.


### 4.5 Mantenimiento diario

**Estado (13-Nov-2026).** 🟡 Nuevo: `scripts/mantenimiento.sh`, timer `calasign-mantenimiento` a las **07:30**, después
del QA nocturno. Instalación (una vez por máquina, la hace el usuario):

```bash
./scripts/mantenimiento.sh --instalar    # crea el worktree ../calasign-mant e instala el timer
claude setup-token                       # token de larga duración; guardarlo en ~/.config/calasign-mantenimiento/token (chmod 600)
./scripts/mantenimiento.sh --estado      # el último informe y el próximo disparo
./scripts/mantenimiento.sh --sin-subir   # una corrida ahora, sin push ni deploy (los commits quedan en la rama mant/<fecha>)
```

1. Espera a que termine el QA nocturno de hoy (§4.4: `qa.sh --e2e`, SAST completo, DAST activo —el pentest de ZAP— y
   pasivo contra dev); si no corrió, lo corre.
2. En un worktree propio (`../calasign-mant`, rama `mant/<fecha>` desde `main`) lanza un agente de Claude Code sin
   supervisión (`claude -p`, permisos en modo `auto`, tope de 4 h y US$ 20) con las instrucciones de
   `scripts/mantenimiento/prompt.md`: revisa el QA, los informes de SAST y DAST (todas las alertas, no sólo las altas),
   `pnpm audit` y osv, ESLint y el trinquete; corrige con su test y su documentación, y commitea. No puede hacer push,
   deploy, `sudo`, `systemctl`, `terraform` ni `aws`, ni tocar el checkout compartido. Lo que necesita una persona
   (excepciones, versiones mayores, contratos de la API, migraciones, infraestructura, cosas pagas) va al informe.
3. El script, no el agente, corre `qa.sh --e2e` sobre esos commits. Sólo en verde: push a `origin/main` (sin force:
   si avanzó, rebase o se frena), adelanta el `main` local (`--ff-only`) y despliega en dev (`deploy-dev.sh`).
4. Informe del día en `var/mantenimiento/<fecha>.md` (la primera línea va en el aviso de escritorio) y log al lado;
   quedan 30 días.

Variables: `MANT_BUDGET_USD`, `MANT_HORAS`, `MANT_MODELO`, `MANT_DIR`. La señal de que corre es la fecha del último
informe (`--estado`), igual que en el nocturno.

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
7. **Una carpeta temporal que sólo se borra en el `exit`.** Si al proceso lo matan (SIGKILL de Playwright, Ctrl+C,
   `timeout`), queda para siempre en `/tmp`, que es tmpfs y lo comparten otros proyectos: lleno, PGlite falla con
   `ENOSPC` y vitest se cuelga (§4.4, 10 y 11-Nov-2026). PID en el nombre y, al arrancar, borrar las de procesos que ya
   no existen (`test-support/global-tmp.ts`, `apps/web/e2e/servidor.mjs`).

### 5.1 Suites que sólo existen en local

`e2e-integrations`, `e2e-teams`, `e2e-identity`, `e2e-ai`, `e2e-agreements`, `e2e-data`, `e2e-white-label`, `e2e-api`,
`e2e-password` y `e2e-platform` usan funciones que sólo existen con `APP_ENV=local` (buzón sin sesión, barridos
manuales, receptores en 127.0.0.1). El resto también corre contra `https://dev.calasign.com`.

---

## 6. e2e de la web en navegador (Playwright)

**Estado (3-Nov-2026).** Vigente: `apps/web/e2e/`, con su [`README`](../../apps/web/e2e/README.md). 25 tests, ~70 s
más ~19 s de compilar la web. Corren en `qa.sh --web` y dentro de `qa.sh --e2e`.

**Por qué.** Hay regresiones que **sólo** se ven en un navegador y que la pasada 147 tuvo que arreglar a mano: el
visor de PDF en Safari < 17.4, el foco al cambiar de ruta, una pestaña abierta durante un deploy que pide un chunk que
ya no existe, la barra del firmante ilegible con colores de marca claros.

### 6.1 Qué cubre

| Archivo | Proyecto | Qué prueba |
|---|---|---|
| `firmante.e2e.ts` | Chromium escritorio **y celular** (Pixel 7) | Consentimiento obligatorio, PDF dibujado por pdf.js, adoptar la firma escrita, finalizar, pantalla de fin, **descarga byte a byte igual al PDF sellado**; idioma portugués; link inválido |
| `consola.e2e.ts` | Chromium | Login por la pantalla, el sobre en la lista y en el detalle, contraseña equivocada |
| `firma-importar-celular.e2e.ts` | Chromium | Firma **importada** de una imagen (SVG rechazado) y firma **dibujada en el celular** (link `/h/…` en otra página, un solo uso, la computadora la recibe y finaliza), con la evidencia de cada una |
| `publicas.e2e.ts` | Chromium | `/verify` con el PDF sellado («Documento válido»), con **un byte cambiado** y con un PDF ajeno («No coincide»); `/developers` y cambio de idioma |
| `seguridad.e2e.ts` | Chromium | **Cero violaciones de la CSP** (sin `'unsafe-inline'`) en el firmante con marca, el pase al celular, la consola (lista, detalle, editor, Marca con sus vistas previas), `/verify` y `/developers`; la marca se sigue aplicando. **XSS almacenado** en asunto, mensaje, firmante y archivo (firmante y consola, con la CSP apagada para probar el escape) y `javascript:` en un link de la marca. **Enmarcado**: cabeceras de las páginas y un sitio ajeno real que no puede enmarcar login, firmante ni firma embebida (el integrador autorizado sí). **Sesión**: tras salir, ni Atrás ni una ruta de la consola muestran datos |

Todos fallan además si la página tira una excepción de JavaScript. Visto fallar con un bug inyectado: con la traba
del consentimiento quitada, el test del firmante da rojo («Expected: disabled / Received: enabled»). Los de
`seguridad.e2e.ts`, cada uno con el suyo (3-Nov-2026): la vista previa de Marca otra vez en `srcdoc` y el tema por
`<style>.textContent` (violaciones de la CSP), un `dangerouslySetInnerHTML` del asunto en el firmante y en el detalle
(`window.__xss = "asunto"`), `javascript:` aceptado en los links de la marca (200 en vez de 400), `frame-ancestors *`
(las cabeceras y el sitio ajeno, que mostraba la app), el logout sin llamar a la API (la consola seguía abierta) y
`'unsafe-inline'` de vuelta en `style-src`.

### 6.2 Cómo corre

- **API efímera propia** (`e2e/servidor.mjs`, `:4197`, PGlite temporal, buzón de desarrollo, sin TSA) que sirve
  `apps/web/dist`. 🔴 Si el puerto está ocupado **falla**: no corre contra una API ajena. Playwright la apaga con
  SIGTERM (`gracefulShutdown`) para que borre su carpeta, y cada arranque barre las de servidores muertos.
- **Los datos se arman por la API** (`helpers/api.ts`); la UI sólo para lo que se prueba.
- **Un worker**: comparten la API y la máquina tiene poca RAM.
- **Navegadores**: Chromium siempre; **WebKit** (Safari, 22 tests más, ~3 min) con `E2E_WEBKIT=1`: lo corre siempre el
  QA nocturno, y a mano conviene después de tocar el visor de PDF, el lienzo de la firma o estilos. Playwright **1.64.1**
  (la 1.49 sólo traía WebKit para Ubuntu 24.04). Una vez por máquina: `./node_modules/.bin/playwright install chromium
  webkit` (en `apps/web`) y `sudo apt-get install libevent-2.1-7t64 libavif16 libmanette-0.2-0`.
- **CSP en http**: la API no manda `upgrade-insecure-requests` si `APP_URL` es `http://` (WebKit, a diferencia de
  Chromium, lo aplica en localhost y la página quedaba en blanco). Con `https://` va siempre (`http-headers*.test.ts`).
- **En una falla**: captura y traza en `var/playwright/<test>/` (`playwright show-trace …/trace.zip`).

### 6.3 Reglas

| Regla | Por qué |
|---|---|
| `getByRole` con el nombre accesible, nunca clases CSS | Prueba también la accesibilidad, y no se rompe por un cambio de estilo |
| Esperar un **ancla** (heading, botón), nunca `networkidle` | El firmante y la consola mantienen conexiones abiertas |
| Un selector nuevo se verifica contra la app corriendo | `locator("body").ariaSnapshot()` muestra lo que ve el test |
| Los datos se arman por la API | Un test de firma no pasa por diez pantallas de alta |
| Todo `test()` dentro de un `test.describe` | Si no, el reporte lo muestra como `<anonymous>` |
| `page.once("dialog", …)`, no `page.on` | Con `on` el handler queda y se apila en los reintentos |
| Sin capturas comparadas (golden images) | Son la mayor parte del mantenimiento de un set así; se agregan sólo ante una regresión visual que esto no caza |
| Un selector que matchea dos cosas se acota (`getByRole("main").getByText(…)`) | Mientras sella hay dos `status` en la pantalla de fin: el modo estricto de Playwright lo marca |

---

## 7. Checklist de testing antes de commitear

- [ ] Encontré mi fila en §2 y escribí **ese** test
- [ ] El test puede **fallar**: lo corrí una vez con el bug inyectado
- [ ] Permisos o datos de una organización → el caso negativo (otro tenant 404, sin permiso 403)
- [ ] Fixtures sintéticos; ningún dato de una persona real; correos en `example.com`
- [ ] `./scripts/qa.sh` verde (o `--rapido` + el test del área para algo chico)
- [ ] Cambio en la web → `./scripts/qa.sh --web`; pantalla nueva en un camino crítico → su test en `apps/web/e2e/`
- [ ] Cambio grande, merge de ramas o cierre de una pasada de review → `./scripts/qa.sh --e2e`
- [ ] Bajó alguna cuenta del trinquete → `node scripts/check-calidad.mjs --baseline` en el mismo commit

---

## 8. Mutation testing (Stryker)

**Qué es.** Stryker cambia el código a propósito (un `<` por `<=`, una condición por `true`, borra una línea…) y
corre los tests. Si siguen verdes, ese **mutante sobrevivió**: hay un comportamiento que ningún test verifica. Es la
versión automática de «ver el test fallar con el bug inyectado» (§2).

```bash
./scripts/mutacion.sh        # pdf, api y sdk, uno después del otro
./scripts/mutacion.sh pdf    # sólo packages/pdf (~1,5 min)
./scripts/mutacion.sh api    # sólo apps/api
./scripts/mutacion.sh sdk    # sólo packages/sdk-node (~30 s)
./scripts/mutacion.sh --completo api   # sin el incremental: para medir el puntaje o subir el piso
```

Informe navegable en `var/mutacion/<paquete>.html` (qué mutante sobrevivió y en qué línea). **Incremental**: la segunda
corrida sólo prueba los mutantes de lo que cambió.

### 8.1 Alcance, a propósito chico

Stryker corre los tests una vez por mutante: sobre la suite entera de la API (954 tests, ~4 min, PGlite por archivo)
serían días. Por eso cada paquete muta **pocos módulos críticos y puros** y usa una configuración de vitest
(`vitest.stryker.config.ts`) con **sólo sus tests unitarios enfocados**:

| Paquete | Módulos | Tests | Por qué esos |
|---|---|---|---|
| `packages/pdf` | `src/signatures.ts` | `test/byterange.test.ts` | `byteRangeIssue`: si el hueco sin firmar no es exactamente el `/Contents`, se pueden cambiar bytes sin invalidar la firma |
| `apps/api` | `src/lib/redact.ts`, `src/lib/totp.ts` | `test/redact.test.ts`, `test/totp.test.ts` | Que ningún secreto ni dato personal llegue a un log; el segundo factor |
| `apps/api` | `src/lib/util.ts` | `test/util.test.ts`, `test/crypto-gcm-tag.test.ts` | La base criptográfica: AES-256-GCM con la clave de la aplicación (y de dónde sale esa clave), HMAC por propósito, scrypt de las contraseñas, el JSON canónico de la cadena de evidencia, `bearerToken` y `requestPath` (qué credencial y qué ruta ve el control de acceso) |
| `apps/api` | `src/lib/password-policy.ts` | `test/password-policy.test.ts` | Contraseñas cortas, comunes o armadas con el correo: cada palabra base y cada regla de `basedOnEmail` |
| `apps/api` | `src/infra/evidence.ts` | `test/evidence-chain.test.ts` (Db falsa en memoria) | El hash de cada evento y `verifyRows`: un mutante que sobrevive es una evidencia alterada que la verificación no detecta |
| `apps/api` | `src/modules/webhooks.ts`: sólo `signPayload` e `isPrivateAddress` (el resto, entre `// Stryker disable all` y `// Stryker restore all`) | `test/ssrf.test.ts`, `test/webhook-signature.test.ts` | La clasificación de direcciones internas: un mutante que sobrevive es un SSRF. La firma que verifican los SDK |
| `packages/sdk-node` | `src/index.ts`: sólo la verificación de webhooks entrantes (el cliente HTTP, entre comentarios `Stryker disable`) | `test/webhooks.test.ts`, `test/unit.test.ts` | `constructWebhookEvent`: un mutante que sobrevive es una firma falsa, vieja o de otro secreto que el integrador acepta |

Un módulo nuevo entra si es crítico, puro (sin base ni red) y tiene un test unitario enfocado: se suma a `mutate` en
el `stryker.config.mjs` y su test al `include` del `vitest.stryker.config.ts`. Si sólo una parte del archivo es pura,
el resto va entre `// Stryker disable all` y `// Stryker restore all` (sus mutantes quedan «Ignored» y no cuentan).

### 8.2 Medido el 29-Oct-2026

| Módulo | Mutantes | Muertos | Sobreviven | Sin cobertura | Puntaje total | Sobre lo cubierto |
|---|---|---|---|---|---|---|
| `pdf` `signatures.ts` (primera corrida) | 262 | 79 | 23 | 160 | 30 % | 77 % |
| `pdf` `signatures.ts` (con los tests nuevos) | 262 | 102 | 2 | 158 | 39 % | **98 %** |
| `api` `redact.ts` | 142 | 93 | 48 | 1 | 65 % | 66 % |
| `api` `totp.ts` | 99 | 55 | 20 | 24 | 56 % | 73 % |
| `api` `redact.ts` (3-Nov-2026, con los tests nuevos) | 146 | 145 | 1 | 0 | **99 %** | 99 % |
| `api` `totp.ts` (3-Nov-2026, con los tests nuevos) | 92 | 87 | 5 | 0 | **95 %** | 95 % |
| `api` `redact.ts` (3-Nov-2026, con los datos personales de SEG-20) | 296 | 293 + 1 por tiempo | 2 | 0 | **99 %** | 99 % |

- La primera corrida de `pdf` encontró 23 bordes de `byteRangeIssue` sin probar (valores negativos o no enteros, el
  límite exacto del archivo, cada extremo de los rangos hexadecimales, el largo impar, el relleno con ceros). Se
  agregaron los tests y quedaron 2, los dos **equivalentes** (no cambian el resultado: `Buffer.from(…, "hex")` corta en
  el primer carácter no hexadecimal, y sin la comparación de largo el `equals` igual da distinto).
- «Sin cobertura» son funciones del archivo que ese test unitario no llama (en `signatures.ts`, el parser de firmas,
  probado por otros tests de `pdf` más pesados). No es una falla: dice dónde haría falta un test unitario.
- **3-Nov-2026: `redact.ts` y `totp.ts`.** Cada ruta y cada parámetro con secreto tiene su caso en `redact.test.ts`
  (con un secreto **corto**: uno largo lo redacta igual la regla de «forma de token» y la entrada de la lista no se
  prueba), más los bordes de UUID y de forma de token y la censura de headers de pino (`LOG_REDACT_PATHS`). En
  `totp.test.ts`, los vectores de base32 de RFC 4648, el paso siguiente, `lastStep`, códigos que no son 6 dígitos (no
  tiran) y los códigos de recuperación. Los 6 que quedan son **equivalentes**: `i <= segs.length` (el segmento
  `undefined` se saltea igual), `/\s/g` por `/\s+/g` (dos veces), `.trim()` antes de un `replace` que ya saca los
  espacios, `bits > 5` en base32 (el carácter sale igual en la vuelta siguiente o en la cola) y
  `opts.lastStep != null` → `true` (`step <= null` es `step <= 0`, falso para cualquier paso posterior a 1970).
- **3-Nov-2026, datos personales (SEG-20).** `redact.ts` suma `maskEmails`, `PII_PARAMS` y la limpieza de cada log
  (`sanitizeLogValue`, `LOG_HOOKS`): cada clave censurada tiene su caso en un `it.each`, más el tope de profundidad,
  los números y booleanos que quedan, los objetos de una clase que no se recorren y los errores (también un
  `DOMException`, que con el prototipo original hacía reventar el log). Los 2 vivos son **equivalentes**: el
  `i <= segs.length` de antes y sacar `"stack"` de la lista de campos del error (en V8 `stack` es siempre propio, así
  que igual se copia).
- 🔴 **El incremental mintió**: tras agregar los tests, la corrida incremental seguía dando 49 vivos en `api` (80 %);
  sin el incremental eran 6 (98 %). No vuelve a probar los mutantes de constantes del módulo (las listas, las regex)
  si sólo cambió el test. Para medir o subir el piso: `./scripts/mutacion.sh --completo`.

**Medido el 3-Nov-2026** (módulos nuevos; «antes» es con los tests enfocados que ya existían, `stryker run --force`):

| Módulo | Mutantes | Muertos | Sobreviven | Sin cobertura | Puntaje total | Sobre lo cubierto |
|---|---|---|---|---|---|---|
| `api` `util.ts` (antes: sólo `crypto-gcm-tag.test.ts`) | 221 | 22 | 11 | 188 | 10 % | 67 % |
| `api` `util.ts` (con `util.test.ts`) | 221 | 212 | 9 | 0 | **96 %** | 96 % |
| `api` `password-policy.ts` (antes: sin test unitario) | 130 | 0 | 0 | 130 | 0 % | — |
| `api` `password-policy.ts` (con `password-policy.test.ts`) | 130 | 122 | 7 | 1 | **94 %** | 95 % |
| `api` `evidence.ts` (antes: sin test unitario) | 54 | 0 | 0 | 54 | 0 % | — |
| `api` `evidence.ts` (con `evidence-chain.test.ts`) | 54 | 54 | 0 | 0 | **100 %** | 100 % |
| `api` `webhooks.ts`, firma y SSRF (antes: `ssrf.test.ts`) | 270 | 190 | 62 | 18 | 70 % | 75 % |
| `api` `webhooks.ts`, firma y SSRF (con los casos nuevos y la corrección) | 286 | 263 | 21 | 2 | **92 %** | 93 % |
| `sdk` verificación de webhooks (antes: `unit.test.ts`) | 66 | 45 | 19 | 2 | 68 % | 70 % |
| `sdk` verificación de webhooks (con `webhooks.test.ts`) | 66 | 64 | 2 | 0 | **97 %** | 97 % |

- **Bug encontrado** (`isPrivateAddress`): con los extremos de cada rango salió que `::ffff:0:a.b.c.d` (IPv4
  traducida, SIIT) y el NAT64 de uso local `64:ff9b:1::/48` (RFC 8215) se clasificaban como públicas aunque llevaran
  una IPv4 interna, y en general nada de `::/8` (reservado, no se enruta) estaba bloqueado. Ahora la traducida valida
  su IPv4, el NAT64 conocido es exactamente `64:ff9b::/96` y el resto de `::/8` cuenta como interna.
- Los 62 sobrevivientes de la primera corrida de `webhooks.ts` eran casi todos rangos IPv4 sin su borde probado
  (`169.254` comparando sólo un octeto, `100.64/10` y `172.16/12` sin el último valor, cada `a === …` de
  documentación): ahora `ssrf.test.ts` prueba los dos extremos de cada rango y la dirección pública de al lado.
- **Equivalentes que quedan** (no cambian el resultado; anotados para no volver a mirarlos):
  - `webhooks.ts` (21 + 2 sin cobertura): las defensas de `ipv6Groups` (`parts.length !== 8`, `NaN` o fuera de rango,
    `if (!g)`) nunca se activan porque sólo se llama con lo que `isIP` ya aceptó como IPv6; `toUpperCase` en vez de
    `toLowerCase` (`parseInt(…, 16)` no distingue mayúsculas); las regex sin `$` (el `.*` o la IPv4 punteada ya
    llegan al final); `tail !== ""` y el `fill("")` (un grupo vacío se lee como `"0"`); `includes("")` (sin `::` el
    relleno da 0); y `:: / ::1` (si no los ataja la primera línea, los ataja la de IPv4 compatible como `0.0.0.x`).
  - `util.ts` (9): la caché de la clave (`if (secretKey)`: recalcularla da la misma), el `.trim()` de `secret.key`
    (el decodificador base64 de Node ignora el salto de línea), `"utf8"` → `""` en `update` (Node usa UTF-8 igual),
    `tag ?? "…"` (cualquier texto da un tag que no mide 16), `{ authTagLength: 16 }` en `decrypt` (el largo ya se
    controla antes), las dos variantes de la regex de `bearerToken` (el `trim()` y el flag `s` las igualan) y la
    constante SQL `BUMP_UPDATED_AT` (la prueban los tests de edición concurrente sobre PGlite, no un unitario).
  - `password-policy.ts` (7 + 1 sin cobertura): la caché de la lista, el `filter(Boolean)` (una entrada vacía nunca
    se consulta), las regex sin `+` o sin `$`, `?? ""` tras `split("@")`, el `% === 0` (sin él `repeat` redondea
    para abajo y no coincide) y `base.length >= 4` (la lista sólo tiene entradas de 10 o más).
  - `sdk` (2): `typeof payload === "string"` → `false` o `""`: pasar un string por `Buffer.from(…).toString("utf8")`
    da el mismo string (y `createHmac` ya codifica en UTF-8 los surrogates sueltos igual).
- **Caché a nivel de módulo = falso sobreviviente.** Stryker reusa el módulo entre mutantes: la lista de contraseñas
  comunes, cargada una vez, quedaba de una corrida anterior y los mutantes de su carga «sobrevivían» aunque el test
  los mata (verificado inyectándolos a mano). `password-policy.test.ts` y `util.test.ts` importan el módulo de nuevo
  en cada test (`vi.resetModules()`); un test nuevo sobre un módulo con caché tiene que hacer lo mismo.

### 8.3 El piso

Cada `stryker.config.mjs` tiene `thresholds.break` con el puntaje total medido (pdf **38**, api **95**, sdk **96**, medidos el 3-Nov-2026 con `--completo`): si baja, la
corrida falla. Cuando un test nuevo lo sube, el piso sube el mismo día, igual que el trinquete de `check-calidad.mjs`.

**Cuándo correrlo**: al tocar un módulo mutado (o su test), y una vez por mes. No va en `qa.sh` ni en el deploy: tarda
minutos y compite por la RAM. Un mutante que sobrevive no se «arregla» con un test que sólo sube el número: el test
tiene que afirmar el comportamiento que el mutante rompió.

