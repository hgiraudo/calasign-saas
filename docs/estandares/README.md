# Estándares de código, calidad y tests — CalaSign SaaS

Esta carpeta adapta a **nuestro** stack el set de estándares de Milhouse (`~/Downloads/redependencias/`, escrito para
un ETL en Rust + Next.js sobre SQL Server, con normativa del BCRA). Casi nada se aplica tal cual: acá hay un
monorepo TypeScript (Fastify + React/Vite + paquetes de PDF y XML), Postgres/PGlite, un solo entorno dev en AWS, y lo
que no puede fallar es **la evidencia legal de una firma**, no un número de un informe.

Lo que sí se tomó prestado es la **forma**: reglas concretas con ✅/❌, tablas de «prohibido → usar en su lugar», un
registro de decisiones con el *por qué* y lo descartado, checklists antes de commitear y deployar, un mapa de capas
de test y **gates automáticos que miden el delta en vez de exigir cero** (el trinquete).

> Si algo de acá contradice al código, **gana el código** — y se actualiza esto.
> Si contradice una instrucción del usuario o una memoria de directiva, **ganan ellas**.

---

## Los documentos

| Doc | Qué cubre | Equivalente en Milhouse |
|---|---|---|
| [`codigo-backend.md`](codigo-backend.md) | `apps/api` y `packages/*`: capas, `AppError`, Zod, permisos, auditoría y evidencia, logs, jobs, `any`, tamaño, comentarios | `codigo-rust.md` |
| [`codigo-frontend.md`](codigo-frontend.md) | `apps/web` (React 18 + Vite): cliente `api()`, contrato compartido, i18n ES/PT-BR/EN, los tres estados, marca blanca, accesibilidad | `codigo-frontend.md` |
| [`codigo-sql-y-migraciones.md`](codigo-sql-y-migraciones.md) | Postgres y PGlite: consultas con `tenant_id`, transacciones, migraciones numeradas, tablas append-only | `codigo-sql-y-proyectos.md` |
| [`decisiones-de-diseno.md`](decisiones-de-diseno.md) | 14 decisiones de código y proceso, con el porqué y lo descartado (Prettier y ESLint con el costo medido) | `decisiones-de-diseno.md` |
| [`contribuir.md`](contribuir.md) | Commits, worktrees y agentes en paralelo, hook de pre-commit, checklist, deploy a dev y rollback | `contribuir.md` |
| [`tests-automatizados.md`](tests-automatizados.md) | Las capas de test con tiempos medidos, **qué test escribir para cada cambio**, `scripts/qa.sh` y el trinquete | `tests-automatizados.md` |
| [`seguridad-y-cumplimiento.md`](seguridad-y-cumplimiento.md) | Reglas `SEG-NN` (evidencia, multi-tenant, secretos, datos personales, salientes, auditoría) con estado y dónde se verifica | `cumplimiento-bcra.md` (el BCRA no aplica: ver ese doc §0) |

Lo que **no** está acá porque ya tiene su lugar y no se duplica: la arquitectura (`../ARQUITECTURA.md`), el modelo de
datos (`../MODELO-DE-DATOS.md`), la evidencia y el sellado (`../EVIDENCIA.md`), el marco legal por país
(`../../ROADMAP.md` §3.5-3.6) y la operación del host dev (`../../README.md` § Entorno dev).

---

## Cómo se usa

**Antes de tocar un área**, leé el doc de estándares de esa capa (son cortos) y el doc de `docs/` del área. Al
terminar, pasá el checklist de [`contribuir.md`](contribuir.md#5-checklist-antes-de-commitear) y `./scripts/qa.sh`.

**Si una regla te estorba**, no la saltees en silencio: o se discute y se cambia acá, o se anota la excepción con el
porqué en el mismo lugar donde se rompe. Una regla que se incumple sin registro es peor que no tenerla.

**Si encontrás una trampa nueva** (medida, con caso), la regla de una línea va al doc que corresponda, y el relato al
comentario del código donde se cayó (ver [`codigo-backend.md` §10](codigo-backend.md#10-comentarios--el-estilo-de-la-casa)).

---

## Estado de adopción (medido el 29-Oct-2026 sobre `210e5d4`)

El repo tiene ~155.000 líneas de TypeScript que crecieron sin estas reglas escritas, aunque con 147 pasadas de code
review. Varias reglas son **nuevas** y el código existente no las cumple: la distinción importa para no bloquear trabajo.

| Regla | Estado | Cómo se verifica |
|---|---|---|
| `tsc --noEmit` sin errores en los 7 paquetes (y en `apps/web/e2e`) | ✅ Vigente: **0 errores** | `scripts/qa.sh` (también lo corre `deploy-dev.sh`) |
| Tests unitarios verdes (api, pdf, xades, firmador, sdk-node, integraciones) | ✅ Vigente: **1.215 tests verdes** (954 de la API) | `scripts/qa.sh` |
| Todo código de error de la API con texto en PT-BR y EN | ✅ Vigente: 411 códigos, 0 faltantes | `scripts/check-error-codes.mjs` (en `qa.sh` y en un test) |
| Cada ruta registrada está en el OpenAPI | ✅ Vigente | `apps/api/test/openapi-contract.test.ts` |
| Trinquete de calidad: no sube la cuenta de `any`, `catch` vacíos, `console.log` en la API, `TODO` sin fecha, `@ts-ignore` | 🟡 **Nuevo**: baseline 1.164 `any` · 109 `catch` vacíos · 2 `console` · 1 `TODO` · 0 `@ts-ignore` | `scripts/check-calidad.mjs` (en `qa.sh` y en el hook) |
| Ningún secreto en texto plano en un commit | ✅ **Activado el 30-Oct-2026** en el clon de trabajo (`git config core.hooksPath scripts/hooks`; un clon nuevo lo tiene que activar) | `scripts/hooks/pre-commit` |
| QA antes del deploy a dev | 🟡 **Nuevo**: `deploy-dev.sh` corre `qa.sh --rapido` (~75 s); `SKIP_QA=1` lo saltea | `scripts/deploy-dev.sh` |
| e2e en un comando, contra una API efímera | 🟡 **Nuevo**: `qa.sh --e2e` | `scripts/qa.sh` |
| Formato con Prettier (ancho 150, sólo TS/JS) | ✅ **Adoptado el 29-Oct-2026**: todo el repo reformateado en `e93f8fc` (ignorado por `git blame`). Ver [decisiones §7](decisiones-de-diseno.md#7-prettier-adoptado-con-un-único-commit-de-reformateo-) | `prettier --check` en `qa.sh` y en el hook |
| ESLint (typescript-eslint + react-hooks) | ✅ **Adoptado el 29-Oct-2026**: 0 errores; 4 avisos de `exhaustive-deps` que no pueden subir. Ver [decisiones §8](decisiones-de-diseno.md#8-eslint-sin-reglas-de-tipos-errores-en-cero-) | `eslint --max-warnings 4` en `qa.sh`; errores en el hook |
| e2e de la web en navegador (Playwright) | 🟡 **Nuevo**: 16 tests en Chromium de escritorio y de celular (~1 min); WebKit con `E2E_WEBKIT=1` (Playwright 1.64.1; librerías del sistema en §6.2). Ver [`tests-automatizados.md` §6](tests-automatizados.md#6-e2e-de-la-web-en-navegador-playwright) | `qa.sh --web` (y dentro de `--e2e`) |
| Mutation testing (Stryker) | 🟡 **Nuevo**: `signatures.ts` de pdf (98 % sobre lo cubierto), `redact.ts` y `totp.ts` de la API; piso por paquete. Ver [`tests-automatizados.md` §8](tests-automatizados.md#8-mutation-testing-stryker) | `scripts/mutacion.sh` (no va en `qa.sh`: tarda minutos) |
| QA nocturno automático | ✅ **Instalado el 31-Oct-2026** (`./scripts/qa-nocturno.sh --instalar` en un clon nuevo): `qa.sh --e2e` sobre `main` a las 03:30 en un worktree propio. Ver [`tests-automatizados.md` §4.4](tests-automatizados.md#44-qa-nocturno) | `scripts/qa-nocturno.sh` · timer `calasign-qa` |

Lo que está en 🟡 o 🔴 se escribe igual, con el costo medido, para que la decisión de adoptarlo sea del usuario y no se
re-discuta desde cero cada vez.
