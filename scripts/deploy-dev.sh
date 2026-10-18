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
DOMAIN=dev.calasign.com
INSTANCE="${INSTANCE_ID:-$(cd infra/dev && terraform output -raw instance_id)}"
REL="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)$(git diff --quiet || echo -dirty)"

# El estado local de Terraform guarda SECRET_KEY en claro: que solo lo lea el usuario.
chmod 600 infra/dev/terraform.tfstate* 2>/dev/null || true

export AWS_PROFILE="${AWS_PROFILE:-bootstrap-terraform}"
# Las credenciales se guardan primero en una variable: con `eval "$(...)"` una falla de assume-role no corta
# el script (set -e no mira la sustitución) y lo que sigue correría con las credenciales por defecto, de otra cuenta.
CREDS=$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/OrganizationAccountAccessRole" --role-session-name deploy-dev \
  --query Credentials --output json | python3 -c "import sys,json;c=json.load(sys.stdin);print(f\"export AWS_ACCESS_KEY_ID={c['AccessKeyId']} AWS_SECRET_ACCESS_KEY={c['SecretAccessKey']} AWS_SESSION_TOKEN={c['SessionToken']}\")")
[ -n "$CREDS" ] || { echo "No se pudo asumir el rol en la cuenta $ACCOUNT" >&2; exit 1; }
eval "$CREDS"
unset AWS_PROFILE
export AWS_REGION=$REGION

echo "▶ compilando web"
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --filter @calasign/web build >/dev/null

echo "▶ empaquetando $REL"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# Nunca viajan: var/ (claves de desarrollo), ni planes/estados/variables de Terraform.
# `git ls-files -c` también lista los versionados borrados en el working tree (aún sin `git rm`): se saltean,
# porque tar aborta con "Cannot stat" y el deploy debe reflejar el working tree tal cual.
{ git ls-files -co --exclude-standard; find apps/web/dist -type f; } | sort -u \
  | grep -vE '^var/|(^|/)tfplan$|\.tfplan$|\.tfstate|\.tfvars$' \
  | while IFS= read -r f; do if [ -e "$f" ]; then printf '%s\n' "$f"; fi; done > "$TMP/files"
tar -czf "$TMP/rel.tgz" -T "$TMP/files"
aws s3 cp --only-show-errors "$TMP/rel.tgz" "s3://$BUCKET/releases/$REL.tgz"

read -r -d '' REMOTE <<EOF || true
set -euo pipefail
export AWS_REGION=$REGION PATH=/opt/node/bin:/usr/local/bin:\$PATH
D=/opt/calasign/releases/$REL
mkdir -p \$D
PKG=\$(mktemp /var/tmp/calasign-rel.XXXXXX)
aws s3 cp --only-show-errors s3://$BUCKET/releases/$REL.tgz \$PKG
# En líneas separadas: con "tar ... && rm", set -e no corta si tar falla (disco lleno, paquete corrupto) y el
# deploy seguía con una versión a medio extraer.
tar -xzf \$PKG -C \$D
rm -f \$PKG
chown -R calasign:calasign \$D
cd \$D
sudo -u calasign env HOME=/var/lib/calasign PATH=\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true \
  corepack pnpm install --frozen-lockfile --filter '@calasign/api...' 2>&1 | tail -3

# Backup previo obligatorio, antes de tocar nada del host (secretos, hardening, Caddy): la versión nueva aplica
# sus migraciones al arrancar y el rollback de abajo solo vuelve al código anterior, no deshace el esquema.
# Sin backup no se despliega, y la versión activa sigue con su configuración intacta.
H=\$D/infra/dev/host
install -m 0755 \$H/calasign-backup.sh /usr/local/bin/calasign-backup.sh
install -m 0644 \$H/calasign-backup.service /etc/systemd/system/calasign-backup.service
install -m 0644 \$H/calasign-backup.timer /etc/systemd/system/calasign-backup.timer
systemctl daemon-reload
systemctl enable --now calasign-backup.timer >/dev/null
if ! /usr/local/bin/calasign-backup.sh; then
  echo "El backup previo al deploy falló: deploy abortado sin tocar la versión activa" >&2
  exit 1
fi

# Cadena del sello y secretos: se arman en temporales y se reemplazan con mv. Si SSM falla, el deploy corta
# antes de tocar los archivos vigentes (la versión activa y el rollback los siguen necesitando intactos).
CHAIN_TMP=\$(mktemp /etc/calasign/seal.chain.pem.XXXXXX)
aws ssm get-parameter --name /calasign-saas/dev/SEAL_CHAIN_PEM --query Parameter.Value --output text > \$CHAIN_TMP
grep -q "BEGIN CERTIFICATE" \$CHAIN_TMP || { rm -f \$CHAIN_TMP; echo "SEAL_CHAIN_PEM vacío o inválido en SSM: deploy abortado" >&2; exit 1; }
umask 077
SK=\$(aws ssm get-parameter --with-decryption --name /calasign-saas/dev/SECRET_KEY --query Parameter.Value --output text)
[ -n "\$SK" ] || { rm -f \$CHAIN_TMP; echo "SECRET_KEY vacío en SSM: deploy abortado" >&2; exit 1; }
# systemd interpreta comillas y barras invertidas en EnvironmentFile: cada valor va entre comillas dobles
# con \ y " escapados, para que llegue a la app tal cual.
envq() { local v; v=\$(printf '%s' "\$2" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'); printf '%s="%s"\\n' "\$1" "\$v"; }
SECRETS_TMP=\$(mktemp /etc/calasign/secrets.env.XXXXXX)
envq SECRET_KEY "\$SK" > \$SECRETS_TMP
# Un parámetro opcional que no existe se saltea; cualquier otro error de SSM (throttling, permisos, red) corta el
# deploy. Antes todo error se tragaba y la clave faltaba en secrets.env sin aviso (p. ej. SMTP_URL: los correos
# dejaban de salir después del deploy).
SSM_ERR=\$(mktemp)
for k in TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME TELEGRAM_WEBHOOK_SECRET WHATSAPP_TOKEN WHATSAPP_PHONE_NUMBER_ID SMTP_URL ANTHROPIC_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM VERIFF_API_KEY VERIFF_SHARED_SECRET TRUORA_API_KEY TRUORA_FLOW_ID TRUORA_WEBHOOK_SECRET GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET DROPBOX_CLIENT_ID DROPBOX_CLIENT_SECRET MS_CLIENT_ID MS_CLIENT_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET MP_ACCESS_TOKEN MP_WEBHOOK_SECRET; do
  if v=\$(aws ssm get-parameter --with-decryption --name /calasign-saas/dev/\$k --query Parameter.Value --output text 2>\$SSM_ERR); then
    if [ -n "\$v" ]; then envq "\$k" "\$v" >> \$SECRETS_TMP; fi
  elif ! grep -q ParameterNotFound \$SSM_ERR; then
    echo "No se pudo leer \$k de SSM: deploy abortado" >&2
    cat \$SSM_ERR >&2
    rm -f \$SSM_ERR \$SECRETS_TMP \$CHAIN_TMP
    exit 1
  fi
done
rm -f \$SSM_ERR
chmod 600 \$SECRETS_TMP
chmod 644 \$CHAIN_TMP
mv \$SECRETS_TMP /etc/calasign/secrets.env
mv \$CHAIN_TMP /etc/calasign/seal.chain.pem
umask 022

# Configuración del host (idempotente): hardening de systemd y Caddy (el backup ya se instaló arriba).
NEW_DROPIN=0
mkdir -p /etc/systemd/system/calasign.service.d
if ! cmp -s \$H/calasign-hardening.conf /etc/systemd/system/calasign.service.d/hardening.conf; then
  install -m 0644 \$H/calasign-hardening.conf /etc/systemd/system/calasign.service.d/hardening.conf
  NEW_DROPIN=1
  systemctl daemon-reload
fi
sed 's/__DOMAIN__/$DOMAIN/' \$H/Caddyfile > /etc/caddy/Caddyfile.new
if /usr/local/bin/caddy adapt --config /etc/caddy/Caddyfile.new >/dev/null 2>&1; then
  if ! cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile; then
    mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
    chmod 0640 /var/log/caddy-access.log 2>/dev/null || true
    systemctl reload caddy || systemctl restart caddy
  else
    rm -f /etc/caddy/Caddyfile.new
  fi
else
  echo "AVISO: el Caddyfile nuevo no valida; se mantiene el actual" >&2
  rm -f /etc/caddy/Caddyfile.new
fi

healthy() { for i in \$(seq 1 60); do curl -sf localhost:4000/healthz >/dev/null && return 0; sleep 1; done; return 1; }
# -e (no -f): en el primer deploy current no existe y "readlink -f" igual devuelve "/opt/calasign/current"; el
# rollback lo tomaba como versión anterior y dejaba current apuntando a sí mismo.
PREV=\$(readlink -e /opt/calasign/current || true)
ln -sfn \$D /opt/calasign/current
systemctl restart calasign
if ! healthy; then
  journalctl -u calasign -n 60 --no-pager
  # Rollback: vuelve a la versión anterior (y saca el hardening si recién se instaló, por si es la causa).
  if [ -n "\$PREV" ] && [ -d "\$PREV" ] && [ "\$PREV" != "\$D" ]; then
    ln -sfn "\$PREV" /opt/calasign/current
    if [ "\$NEW_DROPIN" = 1 ]; then rm -f /etc/systemd/system/calasign.service.d/hardening.conf; systemctl daemon-reload; fi
    systemctl restart calasign
    if healthy; then echo "ROLLBACK_OK \$PREV"; else echo "ROLLBACK_FALLIDO \$PREV"; fi
    echo "Si la versión nueva ya migró la base, restaurar el backup previo (README → Restaurar un backup)."
  fi
  exit 1
fi
curl -sf localhost:4000/healthz
# Conserva las 3 versiones más nuevas y nunca borra la activa.
CUR=\$(readlink -f /opt/calasign/current)
ls -1dt /opt/calasign/releases/* | tail -n +4 | { grep -vxF "\$CUR" || true; } | xargs -r rm -rf
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
