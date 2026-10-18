#!/bin/bash
# Despliega el working tree actual en dev.calasign.com.
#   1. compila la web
#   2. empaqueta el repo (archivos versionados + no ignorados + apps/web/dist) y lo sube a S3
#   3. por SSM (sin SSH): descarga, instala dependencias, rota el symlink, reinicia y espera /healthz
# Requiere: perfil AWS con permiso para asumir OrganizationAccountAccessRole en calasign-sandbox.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT=427064006935
REGION=us-east-1
BUCKET="calasign-saas-dev-$ACCOUNT"
INSTANCE="${INSTANCE_ID:-$(cd infra/dev && terraform output -raw instance_id)}"
REL="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)"

export AWS_PROFILE="${AWS_PROFILE:-bootstrap-terraform}"
eval "$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/OrganizationAccountAccessRole" --role-session-name deploy-dev \
  --query Credentials --output json | python3 -c "import sys,json;c=json.load(sys.stdin);print(f\"export AWS_ACCESS_KEY_ID={c['AccessKeyId']} AWS_SECRET_ACCESS_KEY={c['SecretAccessKey']} AWS_SESSION_TOKEN={c['SessionToken']}\")")"
unset AWS_PROFILE
export AWS_REGION=$REGION

echo "▶ compilando web"
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --filter @calasign/web build >/dev/null

echo "▶ empaquetando $REL"
TMP=$(mktemp -d)
{ git ls-files -co --exclude-standard; find apps/web/dist -type f; } | sort -u | grep -v '^var/' > "$TMP/files"
tar -czf "$TMP/rel.tgz" -T "$TMP/files"
aws s3 cp --only-show-errors "$TMP/rel.tgz" "s3://$BUCKET/releases/$REL.tgz"

read -r -d '' REMOTE <<EOF || true
set -euo pipefail
export AWS_REGION=$REGION PATH=/opt/node/bin:/usr/local/bin:\$PATH
D=/opt/calasign/releases/$REL
mkdir -p \$D
aws s3 cp --only-show-errors s3://$BUCKET/releases/$REL.tgz /tmp/rel.tgz
tar -xzf /tmp/rel.tgz -C \$D && rm /tmp/rel.tgz
chown -R calasign:calasign \$D
cd \$D
sudo -u calasign env HOME=/var/lib/calasign PATH=\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true \
  corepack pnpm install --frozen-lockfile --filter '@calasign/api...' 2>&1 | tail -3
aws ssm get-parameter --name /calasign-saas/dev/SEAL_CHAIN_PEM --query Parameter.Value --output text > /etc/calasign/seal.chain.pem
umask 077
printf 'SECRET_KEY=%s\n' "\$(aws ssm get-parameter --with-decryption --name /calasign-saas/dev/SECRET_KEY --query Parameter.Value --output text)" > /etc/calasign/secrets.env
for k in TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME TELEGRAM_WEBHOOK_SECRET WHATSAPP_TOKEN WHATSAPP_PHONE_NUMBER_ID SMTP_URL ANTHROPIC_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM VERIFF_API_KEY VERIFF_SHARED_SECRET TRUORA_API_KEY TRUORA_FLOW_ID TRUORA_WEBHOOK_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET DROPBOX_CLIENT_ID DROPBOX_CLIENT_SECRET MS_CLIENT_ID MS_CLIENT_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET MP_ACCESS_TOKEN MP_WEBHOOK_SECRET; do
  v=\$(aws ssm get-parameter --with-decryption --name /calasign-saas/dev/\$k --query Parameter.Value --output text 2>/dev/null || true)
  [ -n "\$v" ] && printf '%s=%s\n' "\$k" "\$v" >> /etc/calasign/secrets.env
done
chmod 644 /etc/calasign/seal.chain.pem
ln -sfn \$D /opt/calasign/current
systemctl restart calasign
for i in \$(seq 1 60); do curl -sf localhost:4000/healthz && break; sleep 1; done
curl -sf localhost:4000/healthz >/dev/null || { journalctl -u calasign -n 60 --no-pager; exit 1; }
ls -1dt /opt/calasign/releases/* | tail -n +4 | xargs -r rm -rf
echo DEPLOY_OK $REL
EOF

echo "▶ desplegando en $INSTANCE por SSM"
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --timeout-seconds 900 \
  --parameters "$(python3 -c 'import json,sys;print(json.dumps({"commands":[sys.argv[1]],"executionTimeout":["900"]}))' "$REMOTE")" \
  --query Command.CommandId --output text)
for i in $(seq 1 180); do
  ST=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 5
done
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -40
[ "$ST" = Success ] && echo "✅ https://dev.calasign.com ($REL)" || { echo "❌ deploy $ST"; exit 1; }
rm -rf "$TMP"
