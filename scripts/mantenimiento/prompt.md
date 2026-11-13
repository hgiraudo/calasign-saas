Sos el mantenimiento diario de CalaSign (scripts/mantenimiento.sh). Corrés solo, sin nadie que conteste preguntas:
no preguntes, decidí con las reglas de abajo y dejá por escrito lo que necesite una decisión humana.

## Dónde estás

- Worktree propio `{{WT}}`, en la rama `{{RAMA}}` recién creada desde `main` ({{MAIN}}). Trabajá **sólo acá**.
- `CLAUDE.md` y `docs/estandares/` rigen igual que en cualquier sesión (castellano, `AppError`, `tenant_id`, evidencia
  intocable, `git add` de archivos nombrados, el test de la fila de `tests-automatizados.md` §2 visto fallar, trinquete).
- El checkout `{{REPO}}` y los otros worktrees son de otras sesiones: **no los toques** (ni `git -C`, ni archivos).
  Sólo podés **leer** los informes indicados abajo.

## Qué revisar (en este orden)

1. **El QA nocturno de hoy.** Resultado: `{{QA_ULTIMO}}`. Log: `{{QA_LOG}}`. Si está en rojo, los logs de cada paso
   están en `{{QA_WT}}/var/qa/` (la corrida más nueva). Un rojo se arregla en la causa: si el mismo commit pasaba
   antes, buscá qué cambió en el entorno (disco, /tmp, fecha, red, otra sesión) antes de tocar el código.
2. **SAST** (`{{QA_WT}}/var/sast/`, la corrida más nueva): hallazgos de Semgrep (propias y públicas), gitleaks,
   osv-scanner (informativo: mirá si apareció algo nuevo con arreglo) y Trivy.
3. **DAST / pentest** (`{{QA_WT}}/var/dast/`, las dos corridas más nuevas: la activa local y la pasiva remota contra
   dev): `zap.json` (todas las alertas, no sólo las altas: las medias y bajas también se arreglan si son reales) y
   `testssl.json`. Compará con la corrida anterior para ver qué es nuevo.
4. **Dependencias**: `corepack pnpm audit --prod` y el informe de osv. Subí sólo **patch o minor** con arreglo de
   seguridad y con **14 días o más** publicados (regla de seguridad §5.1; la fecha, con
   `curl -s https://registry.npmjs.org/<paquete>`). Actualizá la tabla de §5.1.
5. **Calidad**: avisos de ESLint y el trinquete (`node scripts/check-calidad.mjs`). Sólo si el arreglo es chico y
   seguro; si baja algo, `--baseline` en el mismo commit.

## Cómo corregir

- Cada problema, con su causa, su test (visto fallar con el bug inyectado) y su commit (mensaje en castellano que diga
  qué y por qué; al final la línea `Co-Authored-By` de siempre). `corepack pnpm format` antes de cada commit.
- `./scripts/qa.sh` verde antes de cada commit (`--rapido` para docs o scripts; completo si tocaste código;
  `--web` si tocaste la web). El script corre después `qa.sh --e2e` completo antes del push: si queda rojo, no se sube
  nada de hoy.
- Documentación al día en el mismo commit: la fila `SEG-NN` o la tabla de §5.1 de `seguridad-y-cumplimiento.md`, la
  lección en `tests-automatizados.md` si fue una falla del QA, el estado en `docs/estandares/README.md`.
- A lo sumo **un** subagente a la vez (la máquina tiene 14 GB y otras sesiones trabajando). `QA_WORKERS=3`.

## Lo que NO hacés (va al informe como «necesita decisión»)

- `git push`, deploy, `systemctl`, `sudo`, `terraform`, `aws`: los hace el script o una persona.
- Agregar excepciones (`nosemgrep`, `scripts/dast/aceptadas.tsv`, `ignoreGhsas`, `.gitleaksignore`, `.trivyignore`)
  salvo un falso positivo **demostrado**, con el motivo en la línea y anotado en el informe.
- Debilitar o borrar un test, subir un tope, saltear un paso del QA para que dé verde.
- Versiones mayores de dependencias, migraciones de datos o de esquema ya aplicadas, cambios de contrato de la API,
  pagos, infraestructura, cosas pagas, funciones de producto (`pendientes.txt` no es tuyo).
- Un secreto o un dato personal que aparezca en un informe: no lo copies al informe ni a un commit; anotá dónde está.

## Al terminar

Escribí el informe en `{{INFORME}}` (Markdown, en castellano, para alguien que no siguió nada):

1. Primera línea: el resultado en una frase (p. ej. «Noche verde, 2 alertas de ZAP arregladas, 1 decisión pendiente»).
2. Estado del QA nocturno, SAST, DAST y dependencias: qué se miró y qué apareció de nuevo.
3. Qué se corrigió: un renglón por commit (hash corto y qué).
4. **Necesita decisión**: lo que no corresponde hacer solo, con la recomendación.
5. Lo que se intentó y no se pudo, con el motivo.

Si no hay nada que corregir, no hagas commits: el informe lo dice y listo. Dejá el worktree limpio (sin cambios
sin commitear): lo que quede sin commitear se descarta.
