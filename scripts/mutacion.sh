#!/bin/bash
# Mutation testing con Stryker (docs/estandares/tests-automatizados.md §8): cambia el código a propósito (un `<` por
# `<=`, un `true` por `false`, borra una línea…) y corre los tests. Si los tests siguen verdes, ese mutante
# «sobrevivió»: hay un comportamiento que ningún test verifica.
#
#   ./scripts/mutacion.sh            pdf y api (los módulos de cada stryker.config.mjs)
#   ./scripts/mutacion.sh pdf        sólo packages/pdf
#   ./scripts/mutacion.sh api        sólo apps/api
#
# Lento a propósito: no va en qa.sh. Correrlo al tocar un módulo mutado y una vez por mes. Incremental: la segunda
# corrida sólo prueba los mutantes de lo que cambió (var/mutacion/*-incremental.json). Informe en var/mutacion/*.html.
# Un comando pesado a la vez: los dos paquetes van uno después del otro.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export CALASIGN_REPO_ROOT="$ROOT" PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH" FORCE_COLOR=0
mkdir -p var/mutacion
rc=0
for p in ${1:-pdf api}; do
  case "$p" in
    pdf) dir=packages/pdf ;;
    api) dir=apps/api ;;
    *) echo "paquete desconocido: $p (pdf o api)" >&2; exit 2 ;;
  esac
  echo "▶ mutación: $dir"
  (cd "$dir" && ./node_modules/.bin/stryker run) 2>&1 | tee "var/mutacion/$p.log" | grep -E "Mutation score|Killed|Survived|Timeout|NoCoverage|All files|^\S+\.ts|Final mutation|ERROR|break" || true
  [ "${PIPESTATUS[0]}" -eq 0 ] || rc=1
  echo "  informe: var/mutacion/$p.html · log: var/mutacion/$p.log"
done
exit $rc
