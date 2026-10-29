# Cómo se trabaja en CalaSign SaaS

> El equivalente al `CONTRIBUTING.md`. No hay PRs ni CI: se trabaja sobre `main` en esta máquina, a menudo con **otra
> sesión de Claude Code trabajando en el mismo checkout** y con agentes en worktrees. Lo que en otro equipo protege la
> CI, acá lo protegen `scripts/qa.sh`, el hook de pre-commit y la coordinación.

---

## 1. Al empezar

```bash
git status --short                  # ¿hay cambios sin commitear? Pueden ser de otra sesión: no los toques ni los commitees
git log --oneline -5                # en qué quedó main
pgrep -af "tsx watch|vite"          # ¿otra sesión tiene la API o la web corriendo? (no la mates, no uses su puerto)
free -g                             # la máquina tiene 14 GB: un vitest completo + un build + otra sesión no entran juntos
```

`pendientes.txt` (sin versionar) es la lista de lo que el usuario dejó anotado.

---

## 2. Trabajo en paralelo

| Regla | Por qué |
|---|---|
| **Máximo dos agentes a la vez**, cada uno con un comando pesado a la vez (`pnpm --filter`, no el monorepo entero) | Con cinco, la máquina se quedó sin memoria (19-Oct) |
| Cada agente en su **worktree** (`isolation: worktree`, en `.claude/worktrees/`) | El checkout principal lo usa otra sesión con `tsx watch` |
| **Cada rama reserva su número de migración al empezar** | Dos ramas tomaron la `0052` (ver [`codigo-sql-y-migraciones.md` §4.2](codigo-sql-y-migraciones.md#42-reglas-lo-que-verifica-scriptscheck-calidadmjs-está-marcado-con-)) |
| **El merge se resuelve en un worktree aparte** y entra a `main` con `git merge --ff-only` | Un conflicto resuelto en el checkout compartido deja marcas de conflicto en el código que otra sesión está corriendo |
| Después de cada merge: `./scripts/qa.sh --e2e` | Dos ramas verdes por separado no garantizan un merge verde |
| No reformatear ni reescribir en masa sin avisar | Conflicto garantizado con lo que esté en vuelo (ver [decisiones §7](decisiones-de-diseno.md#7-prettier-no-se-adopta-como-gate-)) |

---

## 3. Git

### 3.1 Mensajes de commit

La convención del repo (no es Conventional Commits), en castellano, diciendo **el efecto**, no el archivo:

```
<Área>: <qué cambió, en una línea>
```

```
✅ Datos (API): BYOK, celdas, renovación de sellos de archivo, dominios SSO verificados, cupo SCIM
✅ Web firmante: pantalla de código OTP, aprobar, delegar, reasignar, recordatorios en el envío y página pública /verify
✅ Migración 0052: índice por created_at en idempotency_keys para la purga de 7 días del sweep
✅ e2e-crm: la API propia arranca por scripts/e2e-api-entry.mts (a salvo de pkill por server.ts)
✅ Code review ronda 18 (147ª pasada, entrega web, accesibilidad y regresiones de la 146): 17 correcciones

❌ fix: bug
❌ feat(api): add endpoint
❌ wip
❌ cambios en envelopes.ts
```

- **Ámbitos reales**, los que ya se usan: el área (`Datos`, `CRM/ERP`, `Integraciones`, `Firmante`, `Web firmante`),
  el script o el doc (`e2e-crm`, `README`, `gitignore`), `Migración NNNN`, `Merge <área>`.
- **Una pasada de review** lleva el formato `Code review ronda N (Mª pasada, <tema>): K correcciones` y un cuerpo con
  una viñeta por corrección, diciendo el efecto para el usuario.
- Cuerpo multilínea sólo si hace falta el porqué; si es largo, va al doc del área.
- Los trailers de atribución (`Co-Authored-By`) van al final.
- Si el commit regenera el baseline del trinquete hacia **arriba**, el cuerpo dice por qué.

### 3.2 Las trampas del checkout compartido

| Regla | Qué pasa si no |
|---|---|
| 🔴 **`git add` y `git commit` van juntos**, nombrando los archivos | Otra sesión commitea lo que dejaste en stage |
| 🔴 **Nunca `git add -A` ni `git add .`** | Arrastra `pendientes.txt`, notas sueltas y cambios de otra sesión |
| 🔴 **`--amend` sólo sobre un commit tuyo y sin nada ajeno en stage** (`git diff --cached` antes) | Reusa el índice entero |
| **Commit antes de deployar** | `deploy-dev.sh` empaqueta el working tree tal cual y marca la versión `-dirty`: nadie puede reconstruir lo que corre |

### 3.3 Secretos y el hook de pre-commit

`scripts/hooks/pre-commit` corre en ~0,15 s sobre lo que está en stage y **bloquea el commit** si encuentra:

- un secreto en texto plano en una línea agregada (claves de AWS, privadas, de Anthropic, Stripe, Mercado Pago, Slack,
  GitHub, Google, Telegram, API keys `cs_live_`);
- un archivo que nunca se versiona (`.env`, `*.tfstate`, `*.tfvars`, `var/`, `.p12`);
- una cuenta del trinquete que sube, o una migración con número repetido o ya versionada editada;
- un script de shell que no pasa `bash -n`.

Activarlo (una vez por clon; los worktrees lo heredan):

```bash
git config core.hooksPath scripts/hooks
```

Se saltea con `git commit --no-verify` **sólo** ante un falso positivo, diciéndolo en el mensaje. Una clave falsa de un
test se marca en su línea con `calidad:permitir-secreto`.

Los secretos de verdad van a SSM (`/calasign-saas/<entorno>/<VARIABLE>`, los lee `deploy-dev.sh`) o a `var/` en local.
🔴 El `terraform.tfstate` de `infra/dev` tiene `SECRET_KEY` en claro: no se versiona ni se comparte.

---

## 4. Deploy a dev

```bash
./scripts/qa.sh                    # verde
git status --short                 # limpio (o sabiendo qué viaja)
./scripts/deploy-dev.sh            # corre qa.sh --rapido, compila, sube, migra, reinicia y espera /healthz
```

- **`deploy-dev.sh` corre `qa.sh --rapido` primero** y aborta si está en rojo. `SKIP_QA=1` lo saltea, sólo en una
  emergencia y diciéndolo.
- Empaqueta **lo versionado más sus cambios sin commitear**; un archivo nuevo sin `git add` aborta el deploy (el server
  arrancaría sin él).
- **Backup previo y rollback automático**: si la versión nueva no responde `/healthz`, vuelve a la anterior. 🔴 **El
  rollback no deshace migraciones**: por eso las migraciones son aditivas (ver
  [`codigo-sql-y-migraciones.md` §4.2](codigo-sql-y-migraciones.md#42-reglas-lo-que-verifica-scriptscheck-calidadmjs-está-marcado-con-)).
  Si el código anterior no anda con la base migrada, se restaura el backup (README § Restaurar un backup).
- **Después del deploy**: las suites que corren contra dev (`node scripts/e2e.mjs https://dev.calasign.com`, y las que
  no son sólo-locales, ver [`tests-automatizados.md` §5.1](tests-automatizados.md#51-suites-que-sólo-existen-en-local)).
- 🔴 **No se republica ni se enlaza el SaaS desde `calasign.com`** hasta que el usuario lo diga (decisión del 19-Oct).

---

## 5. Checklist antes de commitear

Los de cada capa están en su doc ([backend](codigo-backend.md#11-checklist-pre-commit-backend) ·
[frontend](codigo-frontend.md#6-checklist-pre-commit-frontend) ·
[SQL y migraciones](codigo-sql-y-migraciones.md#6-checklist-antes-de-commitear-sql-o-una-migración) ·
[tests](tests-automatizados.md#7-checklist-de-testing-antes-de-commitear)). Este es el transversal:

- [ ] `./scripts/qa.sh` verde (`--e2e` si es un cambio grande o un merge)
- [ ] El test de mi fila de [`tests-automatizados.md` §2](tests-automatizados.md#2-qué-test-escribir-para-cada-cambio), y lo vi fallar con el bug inyectado
- [ ] `git add` de mis archivos, uno por uno, y `git commit` en el mismo paso
- [ ] Mensaje con el formato de §3.1
- [ ] Baseline del trinquete regenerado si alguna cuenta bajó
- [ ] Variable de entorno nueva → `config.ts` y la tabla del README
- [ ] Endpoint o campo nuevo → OpenAPI, SDKs y portal `/developers` (ES, PT-BR, EN)
- [ ] Cambio de comportamiento visible → el doc del área en `docs/` actualizado
- [ ] [`seguridad-y-cumplimiento.md`](seguridad-y-cumplimiento.md): proveedor externo nuevo → SEG-30; acción nueva → auditoría (SEG-10); dato personal nuevo → SEG-20

---

## 6. Qué NO hacer

| No | Por qué |
|---|---|
| Matar procesos por nombre (`pkill -f server.ts`) | Puede ser la API de otra sesión. Las suites e2e arrancan por `e2e-api-entry.mts` justamente por eso |
| Correr una suite e2e contra un puerto que no levantaste | Los resultados no son de tu código |
| Esperar un proceso con `until ! pgrep -f X` | Se encuentra a sí mismo y no termina nunca |
| Editar una migración ya aplicada en dev | No se vuelve a correr; dev queda distinto de una base nueva |
| «Corregir» una fila de evidencia o de auditoría | Rompe la cadena de hashes; un evento equivocado se compensa con otro evento |
| Cerrar un hallazgo de review «porque los tests pasan» | Si no hay un test que falle sin el arreglo, el arreglo no está probado |
| Versionar una clave, un `.env`, un tfstate o un documento real | SEG-01, SEG-21 |
