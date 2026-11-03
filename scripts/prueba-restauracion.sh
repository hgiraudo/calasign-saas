#!/bin/bash
# Prueba de restauración del backup de dev (SEG-43, una vez por trimestre). No toca la base en uso ni corta el servicio:
# restaura el último dump (o el que se pase) en una base aparte del mismo EC2, la verifica contra la que está en uso con
# scripts/verificar-restauracion.mts (esquema, filas, cadena de evidencia recalculada y los mismos hashes) y la borra.
#   ./scripts/prueba-restauracion.sh                         el último backup
#   ./scripts/prueba-restauracion.sh calasign-<TS>.dump      uno en particular
# Mide cuánto tarda cada paso: anotá la fecha y los tiempos en docs/estandares/seguridad-y-cumplimiento.md (SEG-43).
# Los pasos de la restauración real (parar el servicio, dropdb/createdb de calasign, volver el symlink) están en el
# README § Restaurar un backup; acá se ejercita lo que puede fallar: que el dump exista, se baje, se restaure con los
# mismos permisos (como calasign, sin las EXTENSION) y que lo restaurado sea la evidencia de verdad.
# Requiere: perfil AWS con permiso para asumir OrganizationAccountAccessRole en calasign-sandbox (como deploy-dev.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT=427064006935
REGION=us-east-1
DUMP="${1:-}"
[ -z "$DUMP" ] || [[ "$DUMP" =~ ^calasign-[0-9]{8}T[0-9]{6}Z\.dump$ ]] || { echo "nombre de dump inválido: $DUMP" >&2; exit 2; }
INSTANCE="${INSTANCE_ID:-$(cd infra/dev && terraform output -raw instance_id)}"

export AWS_PROFILE="${AWS_PROFILE:-bootstrap-terraform}"
if [ "$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)" != "$ACCOUNT" ]; then
  # Primero a una variable: con eval "$(...)" una falla de assume-role no corta el script (ver deploy-dev.sh).
  CREDS=$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/OrganizationAccountAccessRole" --role-session-name prueba-restauracion \
    --query Credentials --output json | python3 -c "import sys,json;c=json.load(sys.stdin);print(f\"export AWS_ACCESS_KEY_ID={c['AccessKeyId']} AWS_SECRET_ACCESS_KEY={c['SecretAccessKey']} AWS_SESSION_TOKEN={c['SessionToken']}\")")
  [ -n "$CREDS" ] || { echo "No se pudo asumir el rol en la cuenta $ACCOUNT" >&2; exit 1; }
  eval "$CREDS"
fi
unset AWS_PROFILE
export AWS_REGION=$REGION

# El verificador viaja en el comando (base64): no hace falta desplegarlo antes.
CHECK_B64=$(base64 -w0 scripts/verificar-restauracion.mts)

REMOTE=$(cat <<EOF
set -euo pipefail
export AWS_REGION=$REGION PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
BUCKET=\$(sed -n 's/^S3_BUCKET=//p' /etc/calasign/base.env)
DUMP="$DUMP"
if [ -z "\$DUMP" ]; then
  DUMP=\$(aws s3 ls s3://\$BUCKET/backups/postgres/ | awk '{print \$4}' | grep -E '^calasign-[0-9]{8}T[0-9]{6}Z\.dump$' | sort | tail -1)
fi
[ -n "\$DUMP" ] || { echo "no hay backups en s3://\$BUCKET/backups/postgres/" >&2; exit 1; }
DB=calasign_restore_\$(date -u +%Y%m%d%H%M%S)
umask 077
WORK=\$(mktemp -d /var/tmp/calasign-restore.XXXXXX)
chown calasign "\$WORK"
cleanup() {
  runuser -u postgres -- dropdb --if-exists "\$DB" || echo "AVISO: no se pudo borrar la base \$DB" >&2
  rm -rf "\$WORK"
}
trap cleanup EXIT
t() { date +%s.%N; }
el() { awk -v a="\$1" -v b="\$2" 'BEGIN{printf "%.1f s", b-a}'; }

echo "dump: s3://\$BUCKET/backups/postgres/\$DUMP"
T0=\$(t)
aws s3 cp --only-show-errors "s3://\$BUCKET/backups/postgres/\$DUMP" "\$WORK/restore.dump"
chown calasign "\$WORK/restore.dump"
T1=\$(t)
echo "bajar: \$(el \$T0 \$T1) (\$(stat -c %s "\$WORK/restore.dump") bytes)"

# Lo mismo que el README § Restaurar un backup, sobre otra base: como calasign, sin las entradas EXTENSION.
runuser -u postgres -- createdb -O calasign "\$DB"
# Las extensiones del dump se crean antes, como calasign: pg_trgm es «trusted» (el dueño de la base la puede crear,
# como hizo la migración 0088) y plpgsql ya viene. Una que no esté en la lista corta: no se restaura a ciegas.
for ext in \$(runuser -u calasign -- pg_restore -l "\$WORK/restore.dump" | awk '\$4 == "EXTENSION" && \$5 == "-" {print \$6}'); do
  case "\$ext" in
    plpgsql) ;;
    pg_trgm) runuser -u calasign -- psql -q -v ON_ERROR_STOP=1 -d "\$DB" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" ;;
    *) echo "el dump trae la extensión \$ext, que no está en la lista: revisar antes de restaurar" >&2; exit 1 ;;
  esac
done
runuser -u calasign -- pg_restore -l "\$WORK/restore.dump" | grep -vE ' EXTENSION - | COMMENT - EXTENSION ' > "\$WORK/restore.list"
# La lista la escribe root (la redirección es suya) con umask 077: sin el chown, pg_restore como calasign no la lee.
chown calasign "\$WORK/restore.list"
runuser -u calasign -- pg_restore --single-transaction --no-owner --no-privileges -L "\$WORK/restore.list" -d "\$DB" "\$WORK/restore.dump"
T2=\$(t)
echo "restaurar: \$(el \$T1 \$T2)"

echo "$CHECK_B64" | base64 -d > "\$WORK/verificar.mts"
chown calasign "\$WORK/verificar.mts"
API=\$(readlink -f /opt/calasign/current)/apps/api
echo "código: \$(basename \$(dirname \$(dirname "\$API")))"
rc=0
(cd "\$API" && runuser -u calasign -- env -i PATH=\$PATH HOME=/var/lib/calasign NODE_ENV=production APP_ENV=dev DATA_DIR="\$WORK/data" CALASIGN_API_DIR="\$API" \
  ./node_modules/.bin/tsx "\$WORK/verificar.mts" "\$DB" calasign) || rc=\$?
T3=\$(t)
echo "verificar: \$(el \$T2 \$T3)"
echo "total: \$(el \$T0 \$T3)"
exit \$rc
EOF
)

echo "▶ prueba de restauración en $INSTANCE por SSM"
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --timeout-seconds 1800 \
  --parameters "$(python3 -c 'import json,sys;print(json.dumps({"commands":[sys.argv[1]],"executionTimeout":["1800"]}))' "$REMOTE")" \
  --query Command.CommandId --output text)
for _ in $(seq 1 400); do
  ST=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 5
done
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -60
[ "$ST" = Success ] && echo "✅ restauración verificada ($(date -u +%Y-%m-%d))" || { echo "❌ prueba de restauración: $ST"; exit 1; }
