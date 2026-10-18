#!/bin/bash
# Activa el bot de Telegram en dev.calasign.com.
#   1. Crear el bot con @BotFather (/newbot) y copiar el token.
#   2. ./scripts/setup-telegram-dev.sh              (pide el token sin mostrarlo)
# Guarda token, usuario del bot y un secreto de webhook en SSM, registra el webhook y redespliega.
# El token nunca va en la línea de comandos (la verían `ps` y el historial): curl y aws lo leen por stdin.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "${1:-}" ]; then
  echo "No pases el token como argumento: queda en el historial y en ps. Corré el script sin argumentos." >&2
  exit 1
fi
read -r -s -p "Token del bot: " TOKEN; echo
[ -n "$TOKEN" ] || { echo "Token vacío" >&2; exit 1; }

ACCOUNT=427064006935
export AWS_PROFILE="${AWS_PROFILE:-bootstrap-terraform}"
# Las credenciales se guardan primero en una variable: con `eval "$(...)"` una falla de assume-role no corta
# el script (set -e no mira la sustitución) y lo que sigue correría con las credenciales por defecto, de otra cuenta.
CREDS=$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/OrganizationAccountAccessRole" --role-session-name telegram-setup \
  --query Credentials --output json | python3 -c "import sys,json;c=json.load(sys.stdin);print(f\"export AWS_ACCESS_KEY_ID={c['AccessKeyId']} AWS_SECRET_ACCESS_KEY={c['SecretAccessKey']} AWS_SESSION_TOKEN={c['SessionToken']}\")")
[ -n "$CREDS" ] || { echo "No se pudo asumir el rol en la cuenta $ACCOUNT" >&2; exit 1; }
eval "$CREDS"
unset AWS_PROFILE
export AWS_REGION=us-east-1

# curl lee la URL (que contiene el token) y el cuerpo desde stdin/config, no desde argv.
tg() { printf 'url = "https://api.telegram.org/bot%s/%s"\n' "$TOKEN" "$1" | curl -sf -K - "${@:2}"; }
USERNAME=$(tg getMe | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['username'])")
SECRET=$(openssl rand -hex 24)
BODY=$(umask 077; mktemp); PARAM=$(umask 077; mktemp); trap 'rm -f "$BODY" "$PARAM"' EXIT
# aws lee el parámetro completo (con el valor) desde un archivo 0600, no desde argv.
put() {
  printf '%s' "$2" \
    | python3 -c 'import json,sys;print(json.dumps({"Name":sys.argv[1],"Value":sys.stdin.read(),"Type":"SecureString","Overwrite":True}))' "/calasign-saas/dev/$1" > "$PARAM"
  aws ssm put-parameter --cli-input-json "file://$PARAM" >/dev/null
}
put TELEGRAM_BOT_TOKEN "$TOKEN"
put TELEGRAM_BOT_USERNAME "$USERNAME"
put TELEGRAM_WEBHOOK_SECRET "$SECRET"

printf 'url=%s&secret_token=%s&allowed_updates=%s' "https://dev.calasign.com/v1/integrations/telegram/webhook" "$SECRET" '["message"]' > "$BODY"
tg setWebhook --data "@$BODY" | python3 -c "import sys,json;print('webhook:', json.load(sys.stdin)['description'])"
echo "bot @$USERNAME configurado; redesplegando para cargar los secretos"
./scripts/deploy-dev.sh
