#!/bin/bash
# Backup diario de la base de dev (pg_dump formato custom) al bucket del entorno, prefijo backups/postgres/.
# Lo corre calasign-backup.timer como root. La retención la maneja la regla de ciclo de vida del bucket (Terraform).
set -euo pipefail
export AWS_REGION=us-east-1 PATH=/usr/local/bin:/usr/bin:/bin
BUCKET=$(sed -n 's/^S3_BUCKET=//p' /etc/calasign/base.env)
[ -n "$BUCKET" ] || { echo "S3_BUCKET no está en /etc/calasign/base.env" >&2; exit 1; }
TS=$(date -u +%Y%m%dT%H%M%SZ)
umask 077
F=$(mktemp /var/tmp/calasign-backup.XXXXXX)
trap 'rm -f "$F"' EXIT
runuser -u postgres -- pg_dump -Fc calasign > "$F"
aws s3 cp --only-show-errors "$F" "s3://$BUCKET/backups/postgres/calasign-$TS.dump"
echo "backup OK: s3://$BUCKET/backups/postgres/calasign-$TS.dump ($(stat -c %s "$F") bytes)"
