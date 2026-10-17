#!/bin/bash
# Activa el bot de Telegram en dev.calasign.com.
#   1. Crear el bot con @BotFather (/newbot) y copiar el token.
#   2. ./scripts/setup-telegram-dev.sh <token>        (lee el token del argumento; no queda en el historial si se usa `read`)
# Guarda token, usuario del bot y un secreto de webhook en SSM, registra el webhook y redespliega.
set -euo pipefail
cd "$(dirname "$0")/.."
TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then read -r -s -p "Token del bot: " TOKEN; echo; fi

ACCOUNT=427064006935
export AWS_PROFILE="${AWS_PROFILE:-bootstrap-terraform}"
eval "$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/OrganizationAccountAccessRole" --role-session-name telegram-setup \
  --query Credentials --output json | python3 -c "import sys,json;c=json.load(sys.stdin);print(f\"export AWS_ACCESS_KEY_ID={c['AccessKeyId']} AWS_SECRET_ACCESS_KEY={c['SecretAccessKey']} AWS_SESSION_TOKEN={c['SessionToken']}\")")"
unset AWS_PROFILE
export AWS_REGION=us-east-1

USERNAME=$(curl -sf "https://api.telegram.org/bot$TOKEN/getMe" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['username'])")
SECRET=$(openssl rand -hex 24)
put() { aws ssm put-parameter --name "/calasign-saas/dev/$1" --value "$2" --type SecureString --overwrite >/dev/null; }
put TELEGRAM_BOT_TOKEN "$TOKEN"
put TELEGRAM_BOT_USERNAME "$USERNAME"
put TELEGRAM_WEBHOOK_SECRET "$SECRET"

curl -sf "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -d "url=https://dev.calasign.com/v1/integrations/telegram/webhook" \
  -d "secret_token=$SECRET" -d 'allowed_updates=["message"]' | python3 -c "import sys,json;print('webhook:', json.load(sys.stdin)['description'])"
echo "bot @$USERNAME configurado; redesplegando para cargar los secretos"
./scripts/deploy-dev.sh
