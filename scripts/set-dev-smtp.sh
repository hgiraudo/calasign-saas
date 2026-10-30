#!/bin/bash
# Carga SMTP_URL de dev (SSM /calasign-saas/dev/SMTP_URL, SecureString) desde el CSV de credenciales SMTP de SES.
#
#   ./scripts/set-dev-smtp.sh ~/Descargas/credentials.csv
#
# El CSV es el que baja la consola de SES (us-east-2, cuenta 006121953992) en «SMTP settings → Create SMTP
# credentials»: columnas «IAM User Name», «Smtp Username», «Smtp Password». La contraseña no se muestra ni pasa por la
# línea de comandos (va a la CLI en un archivo temporal 600 que se borra). Llega a la app en el próximo deploy
# (scripts/deploy-dev.sh). Ver docs/CORREO-REBOTES.md, sección «Dónde está SES hoy».
set -euo pipefail
CSV="${1:?Uso: $0 <credentials.csv de SES>}"
[ -r "$CSV" ] || { echo "No se puede leer $CSV" >&2; exit 1; }
ACCOUNT=427064006935
HOST=email-smtp.us-east-2.amazonaws.com
TMP=$(mktemp -d)
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

# smtps (TLS implícito, puerto 465): la conexión nunca va en claro. Usuario y contraseña van codificados para URL
# (la contraseña de SES trae «/» y «+»).
python3 -I - "$CSV" "$HOST" > "$TMP/in.json" <<'PY'
import csv, json, sys
from urllib.parse import quote
path, host = sys.argv[1], sys.argv[2]
with open(path, newline="", encoding="utf-8-sig") as f:
    rows = list(csv.reader(f))
if len(rows) < 2:
    sys.exit("El CSV no tiene filas de credenciales")
head = [h.strip().lower() for h in rows[0]]
def col(word, default):
    for i, h in enumerate(head):
        if "smtp" in h and word in h:
            return i
    return default
u, p = rows[1][col("user", 1)].strip(), rows[1][col("pass", 2)].strip()
if not u.startswith("AKIA") or len(p) < 30:
    sys.exit("El CSV no parece de credenciales SMTP de SES (usuario AKIA…, contraseña larga)")
url = f"smtps://{quote(u, safe='')}:{quote(p, safe='')}@{host}:465"
json.dump({"Name": "/calasign-saas/dev/SMTP_URL", "Type": "SecureString", "Overwrite": True, "Value": url}, sys.stdout)
PY
chmod 600 "$TMP/in.json"

export AWS_PROFILE="${AWS_PROFILE:-bootstrap-terraform}"
if [ "$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)" != "$ACCOUNT" ]; then
  CREDS=$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/OrganizationAccountAccessRole" --role-session-name set-dev-smtp \
    --query Credentials --output json | python3 -c "import sys,json;c=json.load(sys.stdin);print(f\"export AWS_ACCESS_KEY_ID={c['AccessKeyId']} AWS_SECRET_ACCESS_KEY={c['SecretAccessKey']} AWS_SESSION_TOKEN={c['SessionToken']}\")")
  [ -n "$CREDS" ] || { echo "No se pudo asumir el rol en la cuenta $ACCOUNT" >&2; exit 1; }
  eval "$CREDS"
fi
unset AWS_PROFILE
aws ssm put-parameter --region us-east-1 --cli-input-json "file://$TMP/in.json" --query Version --output text >/dev/null
echo "SMTP_URL de dev cargado en SSM ($HOST:465). Falta el deploy (./scripts/deploy-dev.sh) para que la app lo use."
