#!/bin/bash
# SAST de CalaSign sin Docker (docs/estandares/seguridad-y-cumplimiento.md, SEG-48 y SEG-21).
#
#   ./scripts/sast.sh             rápido (~1 min, lo corre qa.sh): reglas propias de Semgrep (scripts/semgrep/calasign.yml,
#                                 con su test) y gitleaks sobre TODO el historial de git
#   ./scripts/sast.sh --completo  además los rulesets públicos de Semgrep (TypeScript, Node, XSS, JWT, secretos),
#                                 osv-scanner sobre los lockfiles y Trivy sobre infra/ (lo corre el QA nocturno; red)
#
# Sale con ≠0 ante un hallazgo nuevo. Las excepciones, siempre con el motivo:
#   Semgrep   // nosemgrep: <regla> — <motivo>   en la línea
#   gitleaks  .gitleaks.toml (rutas de datos de prueba) y .gitleaksignore (fingerprint)
#   osv       se mira, no corta: las altas/críticas de producción ya las corta pnpm audit (SEG-41)
#   Trivy     .trivyignore
# Herramientas en ~/.local/bin (instalación: seguridad-y-cumplimiento.md §5.2). Informes en var/sast/<corrida>/.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
MODE=rapido
case "${1:-}" in
  "") ;;
  --completo) MODE=completo ;;
  -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
  *) echo "opción desconocida: $1" >&2; exit 2 ;;
esac
for t in semgrep gitleaks; do
  command -v "$t" >/dev/null || { echo "✗ falta $t (instalación: docs/estandares/seguridad-y-cumplimiento.md §5.2)" >&2; exit 1; }
done
RUN="var/sast/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$RUN"
FAILED=0
SG=(--metrics off --disable-version-check --quiet --error -j 2 --exclude .claude --exclude var --exclude scripts/semgrep)
TARGETS=(apps packages integrations sdks scripts)

echo "▶ semgrep: test de las reglas propias"
if ! (cd scripts/semgrep && semgrep --test --metrics off --disable-version-check .) >"$RUN/semgrep-test.log" 2>&1 ||
  ! grep -q "All tests passed" "$RUN/semgrep-test.log"; then
  echo "  ✗ las reglas no pasan su test ($RUN/semgrep-test.log)"; tail -n 15 "$RUN/semgrep-test.log"; FAILED=1
fi

echo "▶ semgrep: reglas propias"
semgrep scan --config scripts/semgrep/calasign.yml "${SG[@]}" --text -o "$RUN/semgrep-propias.txt" "${TARGETS[@]}" 2>"$RUN/semgrep-propias.err" ||
  { echo "  ✗ hallazgos (o error) de las reglas propias:"; cat "$RUN/semgrep-propias.txt" "$RUN/semgrep-propias.err" | head -60; FAILED=1; }

echo "▶ gitleaks: secretos en todo el historial"
gitleaks git . --config .gitleaks.toml --redact --no-banner --log-level warn \
  --report-format json --report-path "$RUN/gitleaks.json" >"$RUN/gitleaks.log" 2>&1 ||
  { echo "  ✗ posibles secretos (redactados en $RUN/gitleaks.json):"
    node -e 'for (const f of JSON.parse(require("fs").readFileSync(process.argv[1]))) console.log(`    ${f.RuleID} ${f.File}:${f.StartLine} (${f.Commit.slice(0, 8)}) fingerprint ${f.Fingerprint}`)' "$RUN/gitleaks.json"
    echo "  Si es un secreto real: rotarlo YA (está en el historial). Si no: .gitleaksignore con el motivo."; FAILED=1; }

if [ "$MODE" = completo ]; then
  echo "▶ semgrep: rulesets públicos"
  # Excluidas: dos heurísticas de Express (esta API es Fastify) que sólo daban falsos positivos (31-Oct-2026):
  #  - direct-response-write: marca cada reply.send de un PDF o un CSV, que llevan su content-type.
  #  - raw-html-format: marca el HTML armado a mano (offline.html de marca blanca) aunque todo vaya escapado.
  semgrep scan --config p/typescript --config p/nodejs --config p/javascript --config p/xss --config p/jwt --config p/secrets \
    "${SG[@]}" --exclude-rule javascript.express.security.audit.xss.direct-response-write.direct-response-write \
    --exclude-rule javascript.express.security.injection.raw-html-format.raw-html-format \
    --text -o "$RUN/semgrep-publicas.txt" "${TARGETS[@]}" 2>"$RUN/semgrep-publicas.err" ||
    { echo "  ✗ hallazgos de los rulesets públicos:"; head -60 "$RUN/semgrep-publicas.txt"; FAILED=1; }

  if command -v osv-scanner >/dev/null; then
    echo "▶ osv-scanner (informativo)"
    osv-scanner scan source --lockfile pnpm-lock.yaml --format table >"$RUN/osv.txt" 2>&1
    grep -E "^Total|packages affected" "$RUN/osv.txt" | sed 's/^/  /'
  else
    echo "  ⚠ sin osv-scanner"
  fi

  if command -v trivy >/dev/null; then
    echo "▶ trivy config infra/"
    trivy config --quiet --skip-version-check --ignorefile .trivyignore --exit-code 1 --severity MEDIUM,HIGH,CRITICAL \
      infra/dev >"$RUN/trivy.txt" 2>&1 || { echo "  ✗ configuración insegura nueva en infra/:"; head -40 "$RUN/trivy.txt"; FAILED=1; }
  else
    echo "  ⚠ sin trivy"
  fi
fi

if [ $FAILED -eq 0 ]; then echo "✓ SAST $MODE verde"; rm -rf "$RUN"; exit 0; fi
echo "✗ SAST $MODE en ROJO (informes en $RUN/)"; exit 1
