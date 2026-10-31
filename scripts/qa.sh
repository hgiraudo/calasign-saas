#!/bin/bash
# QA de CalaSign: lo que tiene que estar verde antes de commitear un cambio, de deployar a dev y cada noche.
# Mapa de capas y qué caza cada una: docs/estandares/tests-automatizados.md.
#
#   ./scripts/qa.sh            typecheck (7 paquetes) + calidad + códigos de error + unit (vitest) + integraciones + SDKs
#   ./scripts/qa.sh --rapido   sin vitest ni integraciones (~1 min; es lo que corre deploy-dev.sh)
#   ./scripts/qa.sh --e2e      completo + API efímera sobre PGlite temporal + las 23 suites scripts/e2e*.mjs + SDKs
#   ./scripts/qa.sh --solo-e2e sólo la parte e2e (API y navegador)
#   ./scripts/qa.sh --web      sólo los tests en navegador (Playwright: compila la web y la sirve una API efímera en :4197)
#
# Variables:
#   QA_WORKERS=N     hilos de vitest en apps/api (por defecto, los de vitest: núcleos − 1). Con poca RAM, 2 o 3.
#   QA_E2E_PORT=N    puerto de la API efímera (4199). Si ya hay algo escuchando ahí, aborta: puede ser de otra sesión.
#   QA_TSA=1         la API efímera usa la TSA por defecto (red); sin esto, TSA_URL vacío (sello sin red, determinístico)
#   QA_KEEP=1        conserva var/qa/<corrida>/ (logs y datos de la e2e) aunque todo pase
#
# Corre UN comando pesado a la vez (la máquina tiene 14 GB y otras sesiones compilan en paralelo). Sale con ≠0 si algo
# falló y deja los logs en var/qa/<corrida>/ (var/ no se versiona).
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# Bajo systemd/cron el PATH no trae corepack ni los binarios de usuario: que no muera antes de correr un test.
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 FORCE_COLOR=0 NO_COLOR=1

MODE=completo
case "${1:-}" in
  "") ;;
  --rapido) MODE=rapido ;;
  --e2e) MODE=e2e ;;
  --solo-e2e) MODE=solo-e2e ;;
  --web) MODE=web ;;
  -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
  *) echo "opción desconocida: $1 (ver ./scripts/qa.sh --help)" >&2; exit 2 ;;
esac

RUN="var/qa/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN"
SUMMARY=()
FAILED=0
T0=$(date +%s)

if [ -t 1 ]; then
  c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
  c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
else
  c_green() { printf '%s\n' "$*"; }
  c_red() { printf '%s\n' "$*"; }
fi
# printf %-Ns cuenta bytes: con tildes la columna se corre. ${#} cuenta caracteres.
label() { printf '  %s%*s ' "$1" $(( 28 - ${#1} )) ''; }

# run <nombre> <dir> <comando…>: corre en <dir>, guarda el log y anota el resultado.
run() {
  local name="$1" dir="$2"; shift 2
  local log="$RUN/$name.log" s rc
  s=$(date +%s)
  label "$name"
  (cd "$dir" && "$@") >"$log" 2>&1
  rc=$?
  local dt=$(( $(date +%s) - s ))
  if [ $rc -eq 0 ]; then
    printf '✓ %4ss\n' "$dt"
    SUMMARY+=("✓ $name ${dt}s")
  else
    printf '✗ %4ss  (rc=%s, log: %s)\n' "$dt" "$rc" "$log"
    tail -n 15 "$log" | sed 's/^/      │ /'
    SUMMARY+=("✗ $name ${dt}s")
    FAILED=1
  fi
  return $rc
}

ram_libre_gb() { awk '/MemAvailable/ { printf "%d", $2 / 1048576 }' /proc/meminfo; }

# ───────────────────────────── estáticos ─────────────────────────────
static_checks() {
  echo "▶ typecheck"
  for p in packages/shared packages/pdf packages/xades packages/firmador packages/sdk-node apps/api apps/web; do
    run "tsc $(basename "$p")" "$p" ./node_modules/.bin/tsc --noEmit
  done
  run "tsc web e2e" apps/web ./node_modules/.bin/tsc -p e2e
  echo "▶ reglas"
  run "prettier --check" . ./node_modules/.bin/prettier --check . --log-level warn
  # Errores: cero. Avisos (react-hooks/exhaustive-deps): el total no sube del medido. Si un arreglo lo baja, bajá
  # ESLINT_MAX_WARNINGS el mismo día (docs/estandares/tests-automatizados.md §4.2).
  run "eslint" . ./node_modules/.bin/eslint . --max-warnings "${ESLINT_MAX_WARNINGS:-4}"
  run "calidad (trinquete)" . node scripts/check-calidad.mjs
  run "códigos de error i18n" . node scripts/check-error-codes.mjs
  # Dependencias de producción con vulnerabilidad alta o crítica. Las aceptadas, con el motivo, en
  # docs/estandares/seguridad-y-cumplimiento.md (SEG-41, §5.1) y en pnpm.auditConfig.ignoreGhsas. Necesita red.
  run "pnpm audit (prod, high)" . corepack pnpm audit --prod --audit-level high
  # SAST (SEG-48) y secretos en todo el historial (SEG-21): reglas propias de Semgrep y gitleaks, ~40 s. Lo completo
  # (rulesets públicos, osv-scanner, Trivy) y el DAST con ZAP van en el QA nocturno.
  run "sast (semgrep+gitleaks)" . ./scripts/sast.sh
  local sh_ok=1
  for f in scripts/*.sh scripts/hooks/*; do [ -f "$f" ] && { bash -n "$f" 2>>"$RUN/bash-n.log" || sh_ok=0; }; done
  if [ $sh_ok -eq 1 ]; then label "bash -n scripts"; echo "✓"; SUMMARY+=("✓ bash -n scripts"); else
    label "bash -n scripts"; echo "✗ ($RUN/bash-n.log)"; cat "$RUN/bash-n.log"; SUMMARY+=("✗ bash -n scripts"); FAILED=1; fi
}

# ───────────────────────────── unit ─────────────────────────────
unit_tests() {
  local ram; ram=$(ram_libre_gb)
  if [ "${ram:-0}" -lt 3 ]; then
    echo "  ⚠ ${ram} GB libres: vitest de apps/api puede hacer swap. Probá QA_WORKERS=2 ./scripts/qa.sh" >&2
  fi
  echo "▶ unit (vitest)"
  run "vitest pdf" packages/pdf ./node_modules/.bin/vitest run --reporter=dot
  # xades no tiene vitest propio: usa el de apps/api (como dice el README).
  run "vitest xades" packages/xades ../../apps/api/node_modules/.bin/vitest run --reporter=dot
  run "vitest firmador" packages/firmador ./node_modules/.bin/vitest run --reporter=dot
  run "vitest sdk-node" packages/sdk-node ./node_modules/.bin/vitest run --reporter=dot
  local workers=()
  [ -n "${QA_WORKERS:-}" ] && workers=(--maxWorkers="$QA_WORKERS" --minWorkers=1)
  run "vitest api" apps/api ./node_modules/.bin/vitest run --reporter=dot "${workers[@]}"
  echo "▶ integraciones y SDKs"
  run "integrations test" integrations sh -c 'node test/run.mjs && node test/connectors.mjs && node test/google-workspace.mjs'
  # -I: modo aislado (no carga módulos del directorio actual); sin URL corre sólo las pruebas sin red.
  run "sdk python (sin red)" . python3 -I sdks/python/smoke_test.py
}

# ───────────────────────────── e2e ─────────────────────────────
API_PID=""
stop_api() {
  if [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; then
    kill -TERM "$API_PID" 2>/dev/null
    for _ in $(seq 1 50); do kill -0 "$API_PID" 2>/dev/null || break; sleep 0.2; done
    kill -KILL "$API_PID" 2>/dev/null || true
  fi
  API_PID=""
}
trap 'stop_api' EXIT
trap 'stop_api; exit 130' INT TERM HUP

e2e_tests() {
  # 4199 y no 4190: 4190 está en la lista de puertos que fetch bloquea por especificación ("bad port").
  local port="${QA_E2E_PORT:-4199}" base data
  base="http://localhost:$port"
  echo "▶ e2e (API efímera en $base)"
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$port/healthz"; then
    c_red "  ✗ ya hay algo escuchando en :$port (¿otra sesión?): no se corre contra una API ajena. Usá QA_E2E_PORT=…"
    SUMMARY+=("✗ e2e: puerto $port ocupado"); FAILED=1; return
  fi
  data="$ROOT/$RUN/e2e-data"
  mkdir -p "$data"
  local tsa=(TSA_URL=)
  [ "${QA_TSA:-0}" = "1" ] && tsa=()
  # Entrada sin "server.ts" en el nombre: un pkill/pgrep de otra sesión por ese patrón no mata a esta instancia.
  (cd apps/api && exec env NODE_ENV=development APP_ENV=local PORT="$port" HOST=127.0.0.1 APP_URL="$base" \
    DATA_DIR="$data" DATABASE_URL= LOG_LEVEL=warn KMS_MOCK=1 "${tsa[@]}" \
    CELLS='{"us":{"default":true},"br":{"label":"Brasil","region":"sa-east-1"}}' \
    ./node_modules/.bin/tsx ../../scripts/e2e-api-entry.mts) >"$RUN/e2e-api.log" 2>&1 &
  API_PID=$!
  local ok=0
  for _ in $(seq 1 120); do
    if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$port/healthz"; then ok=1; break; fi
    kill -0 "$API_PID" 2>/dev/null || break
    sleep 1
  done
  if [ $ok -ne 1 ]; then
    c_red "  ✗ la API efímera no respondió /healthz (log: $RUN/e2e-api.log)"; tail -n 25 "$RUN/e2e-api.log" | sed 's/^/      │ /'
    SUMMARY+=("✗ e2e: API efímera no arrancó"); FAILED=1; stop_api; return
  fi
  # Contra la API efímera (en el orden del README). E2E_DATA_DIR: las suites que cuentan archivos en el almacenamiento
  # local de la API (productividad, equipos) lo miran ahí; sin eso, ese conteo se saltea.
  # No levanta la PKI de laboratorio (scripts/dev-pki.mts): B-LT/B-LTA y el sello de empresa quedan salteados.
  export E2E_DATA_DIR="$data"
  for t in e2e e2e-integrations e2e-signer e2e-productivity e2e-teams e2e-experience e2e-scale e2e-platform \
           e2e-identity e2e-evidence e2e-mcp e2e-billing e2e-ai e2e-agreements e2e-oneshot e2e-white-label e2e-api e2e-password; do
    run "$t" . node "scripts/$t.mjs" "$base"
  done
  run "e2e-data" . node scripts/e2e-data.mjs "$base" --data-dir "$data"
  unset E2E_DATA_DIR
  # Los SDKs contra la misma API (sin CALASIGN_TEST_BASE, la integración del SDK de Node se saltea en el unit).
  # Si no llega a la API, vitest la marca "skipped" y sale con 0: un salteo acá es una falla.
  run "sdk-node contra la API" packages/sdk-node sh -c 'out=$(CALASIGN_TEST_BASE="$0" ./node_modules/.bin/vitest run --reporter=dot test/integration.test.ts 2>&1); rc=$?; echo "$out"; [ $rc -eq 0 ] && ! echo "$out" | grep -q skipped' "$base"
  run "sdk python contra la API" . python3 -I sdks/python/smoke_test.py "$base"
  stop_api
  # Las que levantan su propia API y simuladores (puertos fijos 4115/4117/4118: van de a una).
  for t in e2e-crm e2e-connectors e2e-lowcode e2e-certsign; do
    run "$t" . node "scripts/$t.mjs"
  done
}

# ───────────────────────────── navegador ─────────────────────────────
web_tests() {
  echo "▶ web en navegador (Playwright)"
  run "build web" . env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --filter @calasign/web build
  # Chromium de escritorio y de celular; WebKit con E2E_WEBKIT=1 (necesita las librerías del sistema).
  run "playwright" apps/web ./node_modules/.bin/playwright test --reporter=line
}

echo "QA $MODE — $(git rev-parse --short HEAD)$([ -z "$(git status --porcelain --untracked-files=no)" ] || echo ' (con cambios sin commitear)') — logs en $RUN/"
case $MODE in
  rapido) static_checks ;;
  completo) static_checks; unit_tests ;;
  e2e) static_checks; unit_tests; e2e_tests; web_tests ;;
  solo-e2e) e2e_tests; web_tests ;;
  web) web_tests ;;
esac

TOTAL=$(( $(date +%s) - T0 ))
echo
if [ $FAILED -eq 0 ]; then
  c_green "✓ QA $MODE verde en ${TOTAL}s"
  [ "${QA_KEEP:-0}" = "1" ] || rm -rf "$RUN"
  exit 0
fi
c_red "✗ QA $MODE en ROJO (${TOTAL}s):"
for l in "${SUMMARY[@]}"; do case "$l" in ✗*) echo "  $l" ;; esac; done
echo "  logs: $RUN/"
exit 1
