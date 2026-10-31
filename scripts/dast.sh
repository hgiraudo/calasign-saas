#!/bin/bash
# DAST de CalaSign con OWASP ZAP, sin Docker (docs/estandares/seguridad-y-cumplimiento.md, SEG-49).
#
#   ./scripts/dast.sh                 escaneo ACTIVO contra una API efímera (PGlite temporal en :4196): ZAP importa la
#                                     spec OpenAPI y ataca cada ruta autenticado con una API key (inyección, XSS,
#                                     path traversal, SSRF, cabeceras, errores que filtran internos…). ~20–40 min.
#   ./scripts/dast.sh --remoto URL    sólo PASIVO contra un entorno desplegado (p. ej. https://dev.calasign.com):
#                                     spider sin login, análisis pasivo de lo que responde y TLS con testssl.sh. No
#                                     manda ataques ni crea datos. ~5 min.
#
# Sale con ≠0 si hay una alerta de riesgo alto que no esté aceptada en scripts/dast/aceptadas.tsv (con su motivo).
# Informes en var/dast/<corrida>/ (zap.html para leer, zap.json, testssl.json). Lo corre el QA nocturno.
#
# Requisitos (sin Docker): Java 17+ y ZAP en ~/opt/ZAP_<versión> (o ZAP_HOME), testssl.sh en el PATH para --remoto.
# Variables: DAST_PORT (4196), ZAP_HOME, DAST_MAX_MIN (40: tope del escaneo activo), ZAP_XMX (1g).
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

MODE=local
TARGET=""
case "${1:-}" in
  "") ;;
  --remoto) MODE=remoto; TARGET="${2:-}"; [ -n "$TARGET" ] || { echo "falta la URL: ./scripts/dast.sh --remoto https://…" >&2; exit 2; } ;;
  -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
  *) echo "opción desconocida: $1 (ver ./scripts/dast.sh --help)" >&2; exit 2 ;;
esac

ZAP_HOME="${ZAP_HOME:-$(ls -d "$HOME"/opt/ZAP_* 2>/dev/null | sort -V | tail -1)}"
ZAP_JAR="$(ls "$ZAP_HOME"/zap-*.jar 2>/dev/null | head -1)"
[ -n "$ZAP_JAR" ] || { echo "✗ no encuentro ZAP (ZAP_HOME=$ZAP_HOME). Instalación: docs/estandares/seguridad-y-cumplimiento.md §5.2" >&2; exit 1; }
JAVA="$(command -v java || ls "$HOME"/opt/jdk-*/bin/java 2>/dev/null | tail -1)"
[ -x "$JAVA" ] || { echo "✗ no encuentro java (17+)" >&2; exit 1; }

RUN="var/dast/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN/zap-home"
RUN_ABS="$ROOT/$RUN"
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

# ───────── objetivo ─────────
if [ "$MODE" = local ]; then
  port="${DAST_PORT:-4196}"
  TARGET="http://127.0.0.1:$port"
  if curl -s -o /dev/null --max-time 2 "$TARGET/healthz"; then
    echo "✗ ya hay algo escuchando en :$port (¿otra sesión?): no se ataca una API ajena. Usá DAST_PORT=…" >&2; exit 1
  fi
  mkdir -p "$RUN/api-data"
  # APP_ENV=local: sin rate limit para 127.0.0.1 (si no, ZAP sólo vería 429). Sin TSA ni red: sello determinístico.
  (cd apps/api && exec env NODE_ENV=development APP_ENV=local PORT="$port" HOST=127.0.0.1 APP_URL="$TARGET" \
    DATA_DIR="$RUN_ABS/api-data" DATABASE_URL= LOG_LEVEL=warn KMS_MOCK=1 TSA_URL= \
    ./node_modules/.bin/tsx ../../scripts/e2e-api-entry.mts) >"$RUN/api.log" 2>&1 &
  API_PID=$!
  ok=0
  for _ in $(seq 1 120); do
    if curl -sf -o /dev/null --max-time 2 "$TARGET/healthz"; then ok=1; break; fi
    kill -0 "$API_PID" 2>/dev/null || break
    sleep 1
  done
  [ $ok -eq 1 ] || { echo "✗ la API efímera no arrancó (log: $RUN/api.log)" >&2; tail -n 20 "$RUN/api.log" >&2; exit 1; }
  node scripts/dast/seed.mjs "$TARGET" "$RUN" || exit 1
  API_KEY="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).apiKey)' "$RUN/auth.json")"
  curl -sf "$TARGET/v1/openapi.json" -o "$RUN/openapi.json" || { echo "✗ no pude bajar la spec OpenAPI" >&2; exit 1; }
fi

# ───────── plan de ZAP (Automation Framework) ─────────
PLAN="$RUN/plan.yaml"
{
  cat <<EOF
env:
  contexts:
    - name: calasign
      urls: ["$TARGET"]
      includePaths: ["$TARGET.*"]
      # Lo que cortaría el escaneo a la mitad (revocar la propia credencial, borrar la cuenta, cerrar la sesión).
      excludePaths:
        - "$TARGET/v1/api-keys/.*"
        - "$TARGET/v1/auth/logout.*"
        - "$TARGET/v1/account(/.*)?"
        - "$TARGET/v1/organization$"
  parameters:
    failOnError: true
    progressToStdout: true
jobs:
EOF
  if [ "$MODE" = local ]; then
    cat <<EOF
  - type: replacer
    parameters:
      deleteAllRules: true
    rules:
      - description: API key de la cuenta de ZAP
        url: ".*"
        matchType: req_header
        matchString: Authorization
        matchRegex: false
        replacementString: "Bearer $API_KEY"
  - type: openapi
    parameters:
      apiFile: "$RUN_ABS/openapi.json"
      targetUrl: "$TARGET"
      context: calasign
  - type: spider
    parameters:
      context: calasign
      url: "$TARGET/"
      maxDuration: 3
  - type: passiveScan-wait
    parameters:
      maxDuration: 10
  - type: activeScan
    parameters:
      context: calasign
      maxRuleDurationInMins: 5
      maxScanDurationInMins: ${DAST_MAX_MIN:-40}
      threadPerHost: 4
    policyDefinition:
      defaultStrength: medium
      defaultThreshold: medium
EOF
  else
    cat <<EOF
  - type: spider
    parameters:
      context: calasign
      url: "$TARGET/"
      maxDuration: 3
      maxChildren: 50
  - type: passiveScan-wait
    parameters:
      maxDuration: 10
EOF
  fi
  cat <<EOF
  - type: report
    parameters:
      template: traditional-json
      reportDir: "$RUN_ABS"
      reportFile: zap.json
  - type: report
    parameters:
      template: traditional-html
      reportDir: "$RUN_ABS"
      reportFile: zap.html
EOF
} >"$PLAN"

echo "▶ ZAP ($MODE) contra $TARGET — informe en $RUN/zap.html"
# -dir propio: no toca ~/.ZAP ni choca con otra instancia. Puerto 0: ZAP elige uno libre para su proxy.
"$JAVA" "-Xmx${ZAP_XMX:-1g}" -jar "$ZAP_JAR" -cmd -dir "$RUN_ABS/zap-home" -port 0 -nostdout \
  -config api.disablekey=true -autorun "$ROOT/$PLAN" >"$RUN/zap.log" 2>&1
zap_rc=$?
stop_api
[ -f "$RUN/zap.json" ] || { echo "✗ ZAP no generó el informe (rc=$zap_rc, log: $RUN/zap.log)" >&2; tail -n 30 "$RUN/zap.log" >&2; exit 1; }

# ───────── TLS (sólo remoto) ─────────
tls_bad=0
if [ "$MODE" = remoto ] && [[ "$TARGET" == https://* ]]; then
  if command -v testssl.sh >/dev/null; then
    echo "▶ testssl.sh"
    testssl.sh --quiet --warnings off --color 0 --severity MEDIUM --jsonfile "$RUN/testssl.json" "$TARGET" >"$RUN/testssl.log" 2>&1
    tls_bad=$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const bad = r.filter((x) => ["HIGH", "CRITICAL"].includes(x.severity));
      for (const x of bad) console.error(`  ✗ TLS ${x.severity} ${x.id}: ${x.finding}`);
      console.log(bad.length);' "$RUN/testssl.json")
  else
    echo "  ⚠ sin testssl.sh en el PATH: TLS sin revisar"
  fi
fi

# ───────── veredicto ─────────
node - "$RUN/zap.json" "scripts/dast/aceptadas.tsv" "$tls_bad" <<'EOF'
const fs = require("fs");
const [report, acceptedFile, tlsBad] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(report, "utf8"));
// aceptadas.tsv: pluginId <TAB> regex de URL <TAB> motivo. Las líneas con # son comentarios.
const accepted = fs.existsSync(acceptedFile)
  ? fs.readFileSync(acceptedFile, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => {
      const [id, url, why] = l.split("\t");
      return { id: id.trim(), url: new RegExp(url.trim()), why };
    })
  : [];
const RISK = { 3: "ALTO", 2: "MEDIO", 1: "BAJO", 0: "INFO" };
let high = 0;
const rows = [];
for (const site of [].concat(r.site ?? [])) {
  for (const a of site.alerts ?? []) {
    const inst = (a.instances ?? []).filter((i) => !accepted.some((x) => x.id === String(a.pluginid) && x.url.test(i.uri)));
    if (!inst.length) continue;
    const risk = Number(a.riskcode);
    if (risk === 3) high++;
    rows.push({ risk, line: `  ${RISK[risk].padEnd(5)} [${a.pluginid}] ${a.name} — ${inst.length} URL(s), p. ej. ${inst[0].method} ${inst[0].uri}` });
  }
}
rows.sort((a, b) => b.risk - a.risk);
for (const x of rows.filter((x) => x.risk >= 1)) console.log(x.line);
const info = rows.filter((x) => x.risk === 0).length;
console.log(`  (${info} alertas informativas en el informe)`);
if (high || Number(tlsBad)) {
  console.log(`✗ DAST en ROJO: ${high} alerta(s) de riesgo alto${Number(tlsBad) ? ` y ${tlsBad} problema(s) de TLS` : ""} sin aceptar`);
  process.exit(1);
}
console.log("✓ DAST sin alertas de riesgo alto");
EOF
