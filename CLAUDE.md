# CalaSign SaaS — instrucciones para sesiones de Claude Code

Firma electrónica en la nube (monorepo TypeScript: `apps/api` Fastify, `apps/web` React, `packages/*`). Comentarios,
mensajes de error, commits, docs y respuestas en castellano (los identificadores del código, en inglés como están). Contexto del producto en `README.md` y `ROADMAP.md`.

## Estándares (leer el de la capa antes de tocarla)

`docs/estandares/` — [`README`](docs/estandares/README.md) con el estado de cada regla ·
[backend](docs/estandares/codigo-backend.md) · [frontend](docs/estandares/codigo-frontend.md) ·
[SQL y migraciones](docs/estandares/codigo-sql-y-migraciones.md) · [decisiones](docs/estandares/decisiones-de-diseno.md) ·
[contribuir](docs/estandares/contribuir.md) · [tests](docs/estandares/tests-automatizados.md) ·
[seguridad `SEG-NN`](docs/estandares/seguridad-y-cumplimiento.md).

## Antes de dar algo por terminado

- `corepack pnpm format` (Prettier) y `./scripts/qa.sh` verde (`--rapido` para un cambio chico; `--web` si tocaste
  la web; `--e2e` después de un merge o un cambio grande). ESLint: errores en cero, avisos que no suben.
- El test de la fila que corresponda en `tests-automatizados.md` §2, visto fallar con el bug inyectado.
- El trinquete (`node scripts/check-calidad.mjs`) no sube; si algo bajó, `--baseline` en el mismo commit.

## Reglas que más se rompen

- Toda consulta filtra por el `tenant_id` del `req.auth`; un recurso ajeno da 404.
- Errores al cliente: `AppError` con código estable y mensaje que dice qué hacer; código nuevo con texto en PT-BR y EN.
- La evidencia (`envelope_events`, `account_audit_log`) no se edita nunca. Migraciones aplicadas tampoco.
- Ningún secreto ni dato personal en el repo, en logs ni en fixtures.
- Otra sesión puede estar trabajando en este checkout: `git add` de archivos nombrados y `git commit` juntos; nunca
  `git add -A`; no matar procesos ajenos; máximo dos agentes en paralelo, cada uno en su worktree, merge `--ff-only`.
