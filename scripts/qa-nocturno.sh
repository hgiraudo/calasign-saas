#!/bin/bash
# QA nocturno (docs/estandares/tests-automatizados.md §4.4): corre `qa.sh --e2e` y la seguridad sobre el último `main` local en un
# worktree propio (nunca en el checkout compartido, donde puede haber otra sesión trabajando).
#
#   ./scripts/qa-nocturno.sh             una corrida ahora (lo mismo que hace el timer)
#   ./scripts/qa-nocturno.sh --instalar  crea el worktree e instala el timer de systemd de usuario (03:30 cada noche)
#   ./scripts/qa-nocturno.sh --estado    la última corrida y el próximo disparo
#
# La señal de que el QA corre es `systemctl --user status calasign-qa` en verde y la fecha de var/qa-nocturno/ultimo.txt,
# no la ausencia de aviso. En rojo: aviso de escritorio (notify-send) y los logs de qa.sh quedan en el worktree.
#
# Después del QA corre la seguridad: scripts/sast.sh --completo, scripts/dast.sh (activo, API efímera) y
# scripts/dast.sh --remoto $DAST_REMOTO (pasivo; por defecto https://dev.calasign.com, vacío para saltearlo).
#
# Variables: QA_NOCTURNO_DIR (worktree, por defecto ../calasign-qa), QA_WORKERS (3: deja RAM a las otras sesiones),
# DAST_REMOTO.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
WT="${QA_NOCTURNO_DIR:-$(dirname "$REPO")/calasign-qa}"
ESTADO="$REPO/var/qa-nocturno"
UNITS="$HOME/.config/systemd/user"
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

instalar() {
  if [ ! -d "$WT" ]; then
    git -C "$REPO" worktree add --detach "$WT" main || exit 1
  fi
  mkdir -p "$UNITS"
  sed "s|@REPO@|$REPO|g" "$REPO/scripts/qa-nocturno/calasign-qa.service" >"$UNITS/calasign-qa.service"
  cp "$REPO/scripts/qa-nocturno/calasign-qa.timer" "$UNITS/calasign-qa.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now calasign-qa.timer
  echo "Instalado. Worktree: $WT"
  [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ] ||
    echo "⚠ Sin linger el timer sólo corre con la sesión abierta (Persistent=true lo recupera al volver). Para que corra" \
      "con la sesión cerrada: sudo loginctl enable-linger $USER"
  systemctl --user list-timers calasign-qa.timer --no-pager
}

estado() {
  [ -f "$ESTADO/ultimo.txt" ] && cat "$ESTADO/ultimo.txt" || echo "Nunca corrió."
  systemctl --user list-timers calasign-qa.timer --no-pager 2>/dev/null
}

case "${1:-}" in
  --instalar) instalar; exit ;;
  --estado) estado; exit ;;
  "") ;;
  *) echo "opción desconocida: $1 (ver la cabecera de $0)" >&2; exit 2 ;;
esac

mkdir -p "$ESTADO"
LOG="$ESTADO/$(date +%Y%m%d-%H%M%S).log"
avisar() {
  # Sin sesión gráfica notify-send falla: el estado queda igual en ultimo.txt y en systemctl.
  notify-send -u critical "CalaSign: QA nocturno en ROJO" "$1" 2>/dev/null || true
}

{
  echo "QA nocturno — $(date '+%F %T')"
  [ -d "$WT" ] || { echo "✗ no existe el worktree $WT (./scripts/qa-nocturno.sh --instalar)"; exit 1; }
  # main es una rama del mismo repo: el worktree la ve sin pull. --force descarta lo que haya quedado de una corrida vieja.
  git -C "$WT" checkout --force --detach main && git -C "$WT" clean -fdq -e var/ || exit 1
  echo "main = $(git -C "$WT" log -1 --format='%h %s')"
  (cd "$WT" && corepack pnpm install --frozen-lockfile --prefer-offline) || { echo "✗ pnpm install"; exit 1; }
  # De noche también WebKit (Safari): suma ~2 min que a mano molestan.
  cd "$WT" || exit 1
  rc=0
  QA_WORKERS="${QA_WORKERS:-3}" E2E_WEBKIT="${E2E_WEBKIT:-1}" ./scripts/qa.sh --e2e || rc=1
  # Seguridad (SEG-48/49): SAST completo, DAST activo contra una API efímera y pasivo contra dev. Uno a la vez, después
  # del QA: ZAP usa ~1 GB de RAM.
  echo; ./scripts/sast.sh --completo || rc=1
  echo; ./scripts/dast.sh || rc=1
  if [ -n "${DAST_REMOTO-https://dev.calasign.com}" ]; then echo; ./scripts/dast.sh --remoto "${DAST_REMOTO-https://dev.calasign.com}" || rc=1; fi
  exit $rc
} >"$LOG" 2>&1
RC=$?

COMMIT="$(git -C "$WT" log -1 --format='%h' 2>/dev/null)"
if [ $RC -eq 0 ]; then
  echo "✓ verde — $(date '+%F %T') — main $COMMIT — $LOG" >"$ESTADO/ultimo.txt"
else
  echo "✗ ROJO (rc=$RC) — $(date '+%F %T') — main $COMMIT — $LOG" >"$ESTADO/ultimo.txt"
  avisar "main $COMMIT. Log: $LOG"
fi
# Quedan los últimos 14 logs.
ls -1t "$ESTADO"/*.log 2>/dev/null | tail -n +15 | xargs -r rm -f
cat "$ESTADO/ultimo.txt"
exit $RC
