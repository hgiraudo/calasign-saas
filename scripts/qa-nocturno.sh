#!/bin/bash
# QA nocturno (docs/estandares/tests-automatizados.md §4.4): corre `qa.sh --e2e` sobre el último `main` local en un
# worktree propio (nunca en el checkout compartido, donde puede haber otra sesión trabajando).
#
#   ./scripts/qa-nocturno.sh             una corrida ahora (lo mismo que hace el timer)
#   ./scripts/qa-nocturno.sh --instalar  crea el worktree e instala el timer de systemd de usuario (03:30 cada noche)
#   ./scripts/qa-nocturno.sh --estado    la última corrida y el próximo disparo
#
# La señal de que el QA corre es `systemctl --user status calasign-qa` en verde y la fecha de var/qa-nocturno/ultimo.txt,
# no la ausencia de aviso. En rojo: aviso de escritorio (notify-send) y los logs de qa.sh quedan en el worktree.
#
# Variables: QA_NOCTURNO_DIR (worktree, por defecto ../calasign-qa), QA_WORKERS (3: deja RAM a las otras sesiones).
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
  cd "$WT" && QA_WORKERS="${QA_WORKERS:-3}" ./scripts/qa.sh --e2e
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
