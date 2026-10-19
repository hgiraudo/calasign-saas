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
aws s3 cp --only-show-errors "$F" "s3://$BUCKET/backups/postgres/calasign-$TS.dump"
SIZE=$(stat -c %s "$F")
echo "backup OK: s3://$BUCKET/backups/postgres/calasign-$TS.dump ($SIZE bytes)"
# Latido para la alarma calasign-saas-dev-backup-missing (Terraform). No es fatal: si falta el permiso
# (antes del terraform apply) el backup igual sirve, y la alarma termina avisando por falta de datos.
# La dimensión va dentro de cada métrica: la CLI rechaza --dimensions junto con --metric-data.
aws cloudwatch put-metric-data --namespace CalaSign/Backup \
  --metric-data "MetricName=LastSuccess,Value=1,Unit=Count,Dimensions=[{Name=Environment,Value=dev}]" \
  "MetricName=SizeBytes,Value=$SIZE,Unit=Bytes,Dimensions=[{Name=Environment,Value=dev}]" \
  || echo "AVISO: no se pudo publicar la métrica del backup en CloudWatch" >&2
