#!/bin/bash
# Backup diario de la base de dev (pg_dump formato custom) al bucket del entorno, prefijo backups/postgres/.
# Lo corre calasign-backup.timer como root. La retención la maneja la regla de ciclo de vida del bucket (Terraform).
set -euo pipefail
export AWS_REGION=us-east-1 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BUCKET=$(sed -n 's/^S3_BUCKET=//p' /etc/calasign/base.env)
[ -n "$BUCKET" ] || { echo "S3_BUCKET no está en /etc/calasign/base.env" >&2; exit 1; }
TS=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
F=$(mktemp /var/tmp/calasign-backup.XXXXXX)
trap 'rm -f "$F"' EXIT
# Como calasign (dueño de la base), no como el superusuario postgres: la base la controla la app, y un pg_dump de
# superusuario sobre objetos ajenos es el vector de CVE-2024-7348. El archivo lo crea root (la redirección es de root).
runuser -u calasign -- pg_dump -Fc calasign > "$F"
# Que el dump se pueda leer antes de darlo por bueno (un archivo truncado o vacío no es un backup).
SIZE=$(stat -c %s "$F")
[ "$SIZE" -ge 4096 ] || { echo "backup demasiado chico ($SIZE bytes): no se sube" >&2; exit 1; }
pg_restore --list "$F" > /dev/null || { echo "el dump no se puede leer (pg_restore --list falló)" >&2; exit 1; }
KEY="backups/postgres/calasign-$TS.dump"
# Solo crear, nunca pisar (If-None-Match: *): la política del rol rechaza los PUT a backups/ sin ese encabezado.
# Una CLI vieja sin --if-none-match cae a s3 cp, que sirve hasta que se aplique esa política.
if ! OUT=$(aws s3api put-object --bucket "$BUCKET" --key "$KEY" --body "$F" --if-none-match '*' 2>&1 >/dev/null); then
  if grep -qi "unknown options" <<<"$OUT"; then
    echo "AVISO: la AWS CLI no admite --if-none-match; se sube con s3 cp" >&2
    aws s3 cp --only-show-errors "$F" "s3://$BUCKET/$KEY"
  else
    echo "$OUT" >&2
    exit 1
  fi
fi
echo "backup OK: s3://$BUCKET/$KEY ($SIZE bytes)"
# Latido para la alarma calasign-saas-dev-backup-missing (Terraform). No es fatal: si falta el permiso
# (antes del terraform apply) el backup igual sirve, y la alarma termina avisando por falta de datos.
# La dimensión va dentro de cada métrica: la CLI rechaza --dimensions junto con --metric-data.
aws cloudwatch put-metric-data --namespace CalaSign/Backup \
  --metric-data "MetricName=LastSuccess,Value=1,Unit=Count,Dimensions=[{Name=Environment,Value=dev}]" \
  "MetricName=SizeBytes,Value=$SIZE,Unit=Bytes,Dimensions=[{Name=Environment,Value=dev}]" \
  || echo "AVISO: no se pudo publicar la métrica del backup en CloudWatch" >&2
