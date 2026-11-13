#!/bin/bash
# Mantenimiento diario (docs/estandares/tests-automatizados.md §4.5): después del QA nocturno (calasign-qa, 03:30: qa.sh
# --e2e, SAST completo, DAST activo y pasivo), un agente de Claude Code revisa los resultados y las alertas, corrige,
# documenta y commitea en un worktree propio. Después este script, no el agente, corre `qa.sh --e2e` sobre esos
# commits y, sólo en verde, hace push a origin/main, adelanta el main local (--ff-only) y despliega en dev.
#
#   ./scripts/mantenimiento.sh              una corrida ahora (lo mismo que hace el timer, 07:30)
#   ./scripts/mantenimiento.sh --sin-subir  revisa y commitea en la rama mant/<fecha>, sin push ni deploy
#   ./scripts/mantenimiento.sh --instalar   crea el worktree e instala el timer de systemd de usuario
#   ./scripts/mantenimiento.sh --estado     el último informe y el próximo disparo
#
# Informe del día en var/mantenimiento/<fecha>.md (lo escribe el agente; el script agrega push y deploy), log en
# var/mantenimiento/<fecha>.log y aviso de escritorio con la primera línea. Instrucciones del agente:
# scripts/mantenimiento/prompt.md.
#
# Credencial: el agente usa la sesión de `claude` del usuario. Para que no venza, `claude setup-token` y guardar el
# token en ~/.config/calasign-mantenimiento/token (chmod 600; nunca en el repo).
# Variables: MANT_DIR (worktree, por defecto ../calasign-mant), MANT_BUDGET_USD (20: tope de gasto del agente),
# MANT_HORAS (4: tope de tiempo del agente), MANT_MODELO (vacío: el de la cuenta), QA_NOCTURNO_DIR.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WT="${MANT_DIR:-$(dirname "$REPO")/calasign-mant}"
QA_WT="${QA_NOCTURNO_DIR:-$(dirname "$REPO")/calasign-qa}"
ESTADO="$REPO/var/mantenimiento"
UNITS="$HOME/.config/systemd/user"
TOKEN_FILE="$HOME/.config/calasign-mantenimiento/token"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

instalar() {
  [ -d "$WT" ] || git -C "$REPO" worktree add --detach "$WT" main || exit 1
  mkdir -p "$UNITS"
  sed "s|@REPO@|$REPO|g" "$REPO/scripts/mantenimiento/calasign-mantenimiento.service" >"$UNITS/calasign-mantenimiento.service"
  cp "$REPO/scripts/mantenimiento/calasign-mantenimiento.timer" "$UNITS/calasign-mantenimiento.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now calasign-mantenimiento.timer
  echo "Instalado. Worktree: $WT"
  [ -s "$TOKEN_FILE" ] || echo "⚠ Falta el token para correr sin sesión: claude setup-token, y guardarlo en $TOKEN_FILE (chmod 600)."
  systemctl --user list-timers calasign-mantenimiento.timer --no-pager
}

estado() {
  local u; u=$(ls -1t "$ESTADO"/*.md 2>/dev/null | head -1)
  if [ -n "$u" ]; then echo "$u"; head -1 "$u"; else echo "Nunca corrió."; fi
  systemctl --user list-timers calasign-mantenimiento.timer --no-pager 2>/dev/null
}

SUBIR=1
case "${1:-}" in
  --instalar) instalar; exit ;;
  --estado) estado; exit ;;
  --sin-subir) SUBIR=0 ;;
  "") ;;
  *) echo "opción desconocida: $1 (ver la cabecera de $0)" >&2; exit 2 ;;
esac

mkdir -p "$ESTADO"
exec 9>"$ESTADO/.lock"
flock -n 9 || { echo "Ya hay un mantenimiento corriendo."; exit 0; }
HOY=$(date +%F)
LOG="$ESTADO/$HOY.log"
INFORME="$ESTADO/$HOY.md"
RAMA="mant/$HOY"

avisar() {
  # Sin sesión gráfica notify-send falla: queda el informe.
  notify-send ${2:+-u critical} "CalaSign: mantenimiento $HOY" "$1" 2>/dev/null || true
}
anotar() { printf '%s\n' "$@" >>"$INFORME"; }

# Si systemd corta el servicio (TimeoutStartSec), que quede escrito.
trap 'anotar "" "✗ Cortado por timeout o señal a las $(date +%T). Log: $LOG"; avisar "Cortado. Log: $LOG" rojo; exit 143' TERM INT

(
  echo "Mantenimiento — $(date '+%F %T')"

  # 1. El QA nocturno de hoy: si está corriendo se espera (hasta 4 h); si no corrió hoy, se corre ahora.
  for _ in $(seq 1 240); do systemctl --user is-active -q calasign-qa.service || break; sleep 60; done
  if ! grep -q " — $HOY " "$REPO/var/qa-nocturno/ultimo.txt" 2>/dev/null; then
    echo "▶ el QA nocturno no corrió hoy: corre ahora"
    "$REPO/scripts/qa-nocturno.sh" || true
  fi
  QA_ULTIMO=$(cat "$REPO/var/qa-nocturno/ultimo.txt" 2>/dev/null || echo "sin resultado")
  QA_LOG=$(ls -1t "$REPO"/var/qa-nocturno/*.log 2>/dev/null | head -1)
  echo "QA nocturno: $QA_ULTIMO"

  # 2. Worktree limpio en una rama nueva desde main.
  [ -d "$WT" ] || git -C "$REPO" worktree add --detach "$WT" main || exit 1
  git -C "$WT" checkout --force -B "$RAMA" main && git -C "$WT" clean -fdq -e var/ || exit 1
  MAIN=$(git -C "$WT" rev-parse --short HEAD)
  (cd "$WT" && corepack pnpm install --frozen-lockfile --prefer-offline >/dev/null) || { echo "✗ pnpm install"; exit 1; }
  # Fuera del repo y en /var/tmp, por lo mismo que el QA nocturno (ver qa-nocturno.sh).
  export TMPDIR="/var/tmp/calasign-mant-$(id -u)"
  rm -rf "$TMPDIR" && mkdir -p "$TMPDIR" || exit 1

  # 3. El agente: revisa, corrige, documenta y commitea. Sin push ni deploy (también se los prohíbe la lista).
  : >"$INFORME"
  PROMPT=$(sed -e "s|{{WT}}|$WT|g" -e "s|{{RAMA}}|$RAMA|g" -e "s|{{MAIN}}|$MAIN|g" -e "s|{{REPO}}|$REPO|g" \
    -e "s|{{QA_WT}}|$QA_WT|g" -e "s|{{QA_LOG}}|${QA_LOG:-sin log}|g" -e "s|{{INFORME}}|$INFORME|g" \
    -e "s|{{QA_ULTIMO}}|${QA_ULTIMO//|/-}|g" "$REPO/scripts/mantenimiento/prompt.md")
  [ -s "$TOKEN_FILE" ] && CLAUDE_CODE_OAUTH_TOKEN=$(<"$TOKEN_FILE") && export CLAUDE_CODE_OAUTH_TOKEN
  echo "▶ agente (tope ${MANT_HORAS:-4} h y US\$ ${MANT_BUDGET_USD:-20})"
  (cd "$WT" && QA_WORKERS=3 timeout -k 1m "${MANT_HORAS:-4}h" claude -p "$PROMPT" \
    --permission-mode auto \
    --max-budget-usd "${MANT_BUDGET_USD:-20}" \
    ${MANT_MODELO:+--model "$MANT_MODELO"} \
    --add-dir "$REPO/var/qa-nocturno" "$QA_WT/var" "$ESTADO" \
    --disallowedTools "Bash(git push:*)" "Bash(*deploy-dev.sh*)" "Bash(sudo:*)" "Bash(systemctl:*)" \
    "Bash(terraform:*)" "Bash(aws:*)" "Bash(git -C $REPO:*)" \
    --output-format text) || echo "✗ el agente terminó con error (rc=$?)"
  [ -s "$INFORME" ] || anotar "✗ El agente no escribió el informe. Ver el log: $LOG"

  # Lo que el agente dejó sin commitear no viaja: se descarta (queda dicho).
  if [ -n "$(git -C "$WT" status --porcelain)" ]; then
    anotar "" "⚠ Quedaron cambios sin commitear en $WT; se descartaron:" "$(git -C "$WT" status --porcelain | head -20)"
    git -C "$WT" checkout --force -q HEAD && git -C "$WT" clean -fdq -e var/
  fi

  N=$(git -C "$WT" rev-list --count "main..$RAMA")
  anotar "" "---" "Script: $N commit(s) del agente sobre main $MAIN."
  if [ "$N" -eq 0 ]; then echo "sin commits: nada que subir"; exit 0; fi
  # Que main no haya avanzado mientras tanto (otra sesión): si avanzó, rebase; si choca, no se sube.
  if ! git -C "$WT" merge-base --is-ancestor main "$RAMA"; then
    git -C "$WT" rebase -q main || { git -C "$WT" rebase --abort; anotar "✗ main avanzó y la rama $RAMA no se puede rebasar: queda para revisar a mano."; exit 1; }
  fi
  if [ $SUBIR -eq 0 ]; then anotar "--sin-subir: los commits quedan en la rama $RAMA."; exit 0; fi

  # 4. Control independiente del agente: QA completo con e2e (deja la marca que usa deploy-dev.sh).
  echo "▶ qa.sh --e2e sobre $(git -C "$WT" rev-parse --short HEAD)"
  if ! (cd "$WT" && QA_WORKERS=3 E2E_WEBKIT=1 QA_TIMEOUT_VITEST_API=25m timeout -k 1m 90m ./scripts/qa.sh --e2e); then
    anotar "✗ QA --e2e en rojo sobre los commits del agente: no se subió nada. Rama: $RAMA (logs en $WT/var/qa/)."
    exit 1
  fi
  SHA=$(git -C "$WT" rev-parse HEAD)
  # 5. Push sin force (si origin/main avanzó, se rechaza) y main local por fast-forward.
  if ! git -C "$WT" push -q origin "$SHA:refs/heads/main"; then
    anotar "✗ push rechazado (¿origin/main avanzó?): rama $RAMA sin subir."
    exit 1
  fi
  anotar "✓ push: $(git -C "$WT" log --oneline "$MAIN..$SHA" | wc -l) commit(s) en origin/main ($(git -C "$WT" rev-parse --short "$SHA"))."
  # El checkout compartido puede tener cambios de otra sesión: --ff-only no pisa nada; si no puede, queda dicho. Si ese
  # checkout está en otra rama, se adelanta sólo la referencia (fetch también rechaza lo que no es fast-forward).
  if [ "$(git -C "$REPO" symbolic-ref --short -q HEAD)" = main ]; then
    git -C "$REPO" merge -q --ff-only "$SHA" 2>/dev/null
  else
    git -C "$REPO" fetch -q . "refs/heads/$RAMA:refs/heads/main" 2>/dev/null
  fi || anotar "⚠ main local sin adelantar (el checkout tiene cambios que chocan): git merge --ff-only origin/main en $REPO."
  # 6. Deploy desde el worktree (la marca del QA evita repetirlo). El id de la instancia sale del estado de Terraform,
  # que sólo está en el checkout principal.
  INSTANCE_ID=$(cd "$REPO/infra/dev" && terraform output -raw instance_id 2>/dev/null) || INSTANCE_ID=""
  if [ -z "$INSTANCE_ID" ]; then anotar "✗ sin INSTANCE_ID (terraform output en infra/dev): no se desplegó."; exit 1; fi
  if (cd "$WT" && INSTANCE_ID="$INSTANCE_ID" ./scripts/deploy-dev.sh); then
    anotar "✓ deploy en https://dev.calasign.com ($(git -C "$WT" rev-parse --short "$SHA"))."
  else
    anotar "✗ deploy falló (ver $LOG). Los commits ya están en origin/main."
    exit 1
  fi
) >"$LOG" 2>&1
RC=$?

RESUMEN=$(head -1 "$INFORME" 2>/dev/null)
if [ $RC -eq 0 ]; then avisar "${RESUMEN:-sin informe} — $INFORME"; else avisar "${RESUMEN:-sin informe} (rc=$RC) — $INFORME" rojo; fi
# Quedan los últimos 30 días.
ls -1t "$ESTADO"/*.log 2>/dev/null | tail -n +31 | xargs -r rm -f
ls -1t "$ESTADO"/*.md 2>/dev/null | tail -n +31 | xargs -r rm -f
cat "$INFORME"
exit $RC
