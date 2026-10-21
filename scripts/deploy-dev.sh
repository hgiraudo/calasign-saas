#!/bin/bash
# Despliega el working tree actual en dev.calasign.com.
#   1. compila la web
#   2. empaqueta el repo (archivos versionados, con sus cambios sin commitear, + apps/web/dist) y lo sube a S3
#   3. por SSM (sin SSH): descarga, instala dependencias, rota el symlink, reinicia y espera /healthz
# Requiere: perfil AWS con permiso para asumir OrganizationAccountAccessRole en calasign-sandbox.
set -euo pipefail
cd "$(dirname "$0")/.."

ACCOUNT=427064006935
REGION=us-east-1
BUCKET="calasign-saas-dev-$ACCOUNT"
DOMAIN=dev.calasign.com
INSTANCE="${INSTANCE_ID:-$(cd infra/dev && terraform output -raw instance_id)}"
# Se empaquetan los archivos versionados (con sus cambios sin commitear): "dirty" si difieren de HEAD. Un archivo nuevo
# de código sin `git add` no viajaría (el server arrancaría sin él, después de migrar): se aborta. Lo mismo con la
# configuración del host (infra/dev/host): el script remoto instala esos archivos y corta si falta uno.
NEW_SRC="$(git ls-files -o --exclude-standard -- apps packages integrations infra/dev/host)"
if [ -n "$NEW_SRC" ]; then
  echo "Hay archivos nuevos sin versionar que no viajarían en el paquete (agregalos con git add o ignoralos):" >&2
  echo "$NEW_SRC" >&2
  exit 1
fi
REL="$(date -u +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD)$([ -z "$(git status --porcelain --untracked-files=no)" ] || echo -dirty)"

# El estado local de Terraform guarda SECRET_KEY en claro: que solo lo lea el usuario.
chmod 600 infra/dev/terraform.tfstate* 2>/dev/null || true

export AWS_PROFILE="${AWS_PROFILE:-bootstrap-terraform}"
# Si ya hay credenciales de la cuenta del entorno en el entorno (setup-telegram-dev.sh llama a este script
# después de asumir el rol), se usan tal cual: la CLI les da prioridad sobre AWS_PROFILE, y volver a asumir
# OrganizationAccountAccessRole desde la propia cuenta da AccessDenied (el rol solo confía en la cuenta de gestión).
if [ "$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)" != "$ACCOUNT" ]; then
  # Las credenciales se guardan primero en una variable: con `eval "$(...)"` una falla de assume-role no corta
  # el script (set -e no mira la sustitución) y lo que sigue correría con las credenciales por defecto, de otra cuenta.
  CREDS=$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT:role/OrganizationAccountAccessRole" --role-session-name deploy-dev \
    --query Credentials --output json | python3 -c "import sys,json;c=json.load(sys.stdin);print(f\"export AWS_ACCESS_KEY_ID={c['AccessKeyId']} AWS_SECRET_ACCESS_KEY={c['SecretAccessKey']} AWS_SESSION_TOKEN={c['SessionToken']}\")")
  [ -n "$CREDS" ] || { echo "No se pudo asumir el rol en la cuenta $ACCOUNT" >&2; exit 1; }
  eval "$CREDS"
fi
unset AWS_PROFILE
export AWS_REGION=$REGION

echo "▶ compilando integraciones y web"
# Las integraciones (skill, plugin, .mcpb, Gemini, Office) se generan en apps/web/public/integrations/ (no se
# versionan) y Vite las copia a dist, con la URL base del dominio que se despliega.
CALASIGN_BASE_URL="https://$DOMAIN" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --filter @calasign/integrations build >/dev/null
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm --filter @calasign/web build >/dev/null

echo "▶ empaquetando $REL"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# Nunca viajan: var/ (claves de desarrollo), ni planes/estados/variables de Terraform.
# `git ls-files -c` también lista los versionados borrados en el working tree (aún sin `git rm`): se saltean,
# porque tar aborta con "Cannot stat" y el deploy debe reflejar el working tree tal cual.
# Solo archivos regulares y tar sin recursión: un repo git anidado sin ignorar (p. ej. un clon de otro proyecto dentro
# del working tree) aparece en `git ls-files -o` como una sola entrada "dir/", y tar la metía entera sin pasar por el
# filtro de arriba (con su .git, su var/ y sus tfstate).
# core.quotePath=false: con el valor por defecto, git escribe una ruta con tildes como "docs/gu\303\255a.md" (entre
# comillas y con escapes), el [ -f ] de abajo no la encuentra y el archivo quedaba fuera del paquete sin aviso.
# Solo lo versionado (más el build de la web): un archivo suelto sin versionar (notas, pruebas locales) no viaja.
{ git -c core.quotePath=false ls-files -c; find apps/web/dist -type f; } | sort -u \
  | grep -vE '^var/|(^|/)tfplan$|\.tfplan$|\.tfstate|\.tfvars$' \
  | while IFS= read -r f; do if [ -f "$f" ]; then printf '%s\n' "$f"; fi; done > "$TMP/files"
tar --no-recursion -czf "$TMP/rel.tgz" -T "$TMP/files"
# El servidor verifica el paquete contra este hash: el rol de la instancia (el mismo que usa la app) puede escribir
# en el bucket, y un paquete cambiado entre la subida y la descarga correría como root (backup, Caddy, hardening).
SHA=$(sha256sum "$TMP/rel.tgz" | cut -d' ' -f1)
aws s3 cp --only-show-errors "$TMP/rel.tgz" "s3://$BUCKET/releases/$REL.tgz"

read -r -d '' REMOTE <<EOF || true
set -euo pipefail
export AWS_REGION=$REGION PATH=/opt/node/bin:/usr/local/bin:\$PATH
# Un deploy a la vez: dos en paralelo (dos terminales, un reintento con el anterior todavía corriendo en SSM) se pisaban
# el symlink current, secrets.env y el rollback. /run es de root; el lock se libera solo cuando termina el script.
exec 9>/run/calasign-deploy.lock
# Espera hasta 10 minutos: el timer de parches de seguridad (calasign-security-updates) toma el mismo lock mientras
# corre dnf, y un deploy que coincide con él no tiene que fallar.
flock -w 600 9 || { echo "Otro deploy o el timer de parches de seguridad (calasign-security-updates) sigue con el lock de la instancia después de 10 minutos: deploy abortado" >&2; exit 1; }
D=/opt/calasign/releases/$REL
# /opt/calasign y releases/ quedan de root (bootstrap los dejaba del usuario calasign, el de la app). Root crea, extrae
# y borra versiones ahí adentro: con la app comprometida, releases/ podía pasar a ser un symlink (p. ej. a /etc) y la
# limpieza de versiones viejas de abajo borraba como root todo lo que hubiera en ese destino. Primero /opt/calasign
# (/opt es de root, así que no se puede cambiar por un symlink); después ya nadie más puede reemplazar sus entradas.
if [ -L /opt/calasign ] || [ ! -d /opt/calasign ]; then echo "/opt/calasign no es un directorio: deploy abortado" >&2; exit 1; fi
chown root:root /opt/calasign
chmod 0755 /opt/calasign
[ -e /opt/calasign/releases ] || [ -L /opt/calasign/releases ] || mkdir /opt/calasign/releases
if [ -L /opt/calasign/releases ] || [ ! -d /opt/calasign/releases ]; then echo "/opt/calasign/releases no es un directorio: deploy abortado" >&2; exit 1; fi
chown root:root /opt/calasign/releases
chmod 0755 /opt/calasign/releases
if [ -e /opt/calasign/current ] && [ ! -L /opt/calasign/current ]; then echo "/opt/calasign/current no es un symlink: deploy abortado" >&2; exit 1; fi
# Sin -p: si la carpeta ya existe, el deploy corta en vez de extraer como root dentro de una carpeta ajena.
mkdir \$D
PKG=\$(mktemp /var/tmp/calasign-rel.XXXXXX)
# Lo que corre o se instala como root (script de backup, unidades, hardening, Caddyfile) sale de una copia solo de
# root: la carpeta de la versión pasa a ser del usuario calasign, y la app (o un postinstall de pnpm) podía cambiar
# esos archivos antes de que root los ejecute o instale.
HOSTCFG=\$(mktemp -d /var/tmp/calasign-host.XXXXXX)
# También los temporales de secretos y cadena de abajo: si SSM falla (set -e corta en la asignación), no quedan
# sueltos en /etc/calasign. Después del mv ya no existen y rm no hace nada.
trap 'rm -rf "\$PKG" "\$HOSTCFG" \${CHAIN_TMP:+"\$CHAIN_TMP"} \${SECRETS_TMP:+"\$SECRETS_TMP"} \${SSM_ERR:+"\$SSM_ERR"} \${SSM_JSON:+"\$SSM_JSON"}' EXIT
aws s3 cp --only-show-errors s3://$BUCKET/releases/$REL.tgz \$PKG
echo "$SHA  \$PKG" | sha256sum -c --quiet || { echo "El paquete descargado no coincide con el subido: deploy abortado" >&2; exit 1; }
tar -xzf \$PKG -C \$HOSTCFG infra/dev/host
# En líneas separadas: con "tar ... && rm", set -e no corta si tar falla (disco lleno, paquete corrupto) y el
# deploy seguía con una versión a medio extraer.
tar -xzf \$PKG -C \$D
rm -f \$PKG
# Dependencias: las instala un usuario de build dedicado (calasign-build), con HOME, store de pnpm y COREPACK_HOME en
# /var/cache/calasign-build (de ese usuario, 0700). Antes corría como calasign con HOME=/var/lib/calasign, escribible
# por la app: una app comprometida podía cambiar el pnpm cacheado por corepack (o el store) y su código corría en el
# próximo deploy con permiso de escritura sobre la versión nueva, antes del chown a root. Ni como root: pnpm 9 corre
# los scripts de instalación de las dependencias, y como root tendrían el host entero. El usuario de build no tiene
# shell ni nada más que escribir que su cache y, durante la instalación, la carpeta de la versión.
# Idempotente: si el grupo quedó de un intento anterior (usuario borrado a mano, useradd cortado), useradd sin -g
# fallaba con "group calasign-build exists" y el deploy abortaba.
if ! id calasign-build >/dev/null 2>&1; then
  if getent group calasign-build >/dev/null; then
    useradd --system -g calasign-build --no-create-home --home-dir /var/cache/calasign-build --shell /sbin/nologin calasign-build
  else
    useradd --system -U --no-create-home --home-dir /var/cache/calasign-build --shell /sbin/nologin calasign-build
  fi
fi
BUILD_HOME=/var/cache/calasign-build
if [ -L \$BUILD_HOME ] || { [ -e \$BUILD_HOME ] && [ ! -d \$BUILD_HOME ]; }; then echo "\$BUILD_HOME no es un directorio: deploy abortado" >&2; exit 1; fi
install -d -o calasign-build -g calasign-build -m 0700 \$BUILD_HOME
chown -R calasign-build:calasign-build \$D
cd \$D
# 9>&-: el lock del deploy no pasa a pnpm (ni a algo que deje corriendo).
# --prod: sin devDependencies (typescript, vitest, @types/*) en el host. Lo que la API usa al correr está en
# dependencies (tsx incluido: arranca server.ts, worker.ts y migrate.ts); solo esbuild y pkcs11js corren scripts de
# instalación ("pnpm".onlyBuiltDependencies del package.json raíz; pnpm 9 no la lee de pnpm-workspace.yaml).
sudo -u calasign-build env HOME=\$BUILD_HOME COREPACK_HOME=\$BUILD_HOME/corepack PATH=\$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true \
  corepack pnpm install --prod --frozen-lockfile --config.package-import-method=copy --config.store-dir=\$BUILD_HOME/pnpm-store \
  --filter '@calasign/api...' 9>&- 2>&1 | tail -3
# Instalado: el código queda de root (la app lo lee, no lo puede modificar), legible para todos sin depender del umask
# de quien desplegó (tar conserva los modos locales). Copia, no hardlinks al store de pnpm: el chown no lo alcanza.
chown -R root:root \$D
chmod -R u+rwX,go+rX,go-w \$D

# Backup previo obligatorio, antes de tocar nada del host (secretos, hardening, Caddy): la versión nueva aplica
# sus migraciones al arrancar y el rollback de abajo solo vuelve al código anterior, no deshace el esquema.
# Sin backup no se despliega, y la versión activa sigue con su configuración intacta.
H=\$HOSTCFG/infra/dev/host
# El script nuevo se prueba desde el paquete y recién se instala si el backup salió bien: si se instalaba antes y
# fallaba, el deploy abortaba pero el backup diario ya corría con el script roto.
if ! bash \$H/calasign-backup.sh; then
  echo "El backup previo al deploy falló: deploy abortado sin tocar la versión activa" >&2
  exit 1
fi
install -m 0755 \$H/calasign-backup.sh /usr/local/bin/calasign-backup.sh
install -m 0644 \$H/calasign-backup.service /etc/systemd/system/calasign-backup.service
install -m 0644 \$H/calasign-backup.timer /etc/systemd/system/calasign-backup.timer
systemctl daemon-reload
systemctl enable --now calasign-backup.timer >/dev/null

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
# El resto de los secretos: todos los parámetros de /calasign-saas/dev/ (el nombre del parámetro es el de la variable),
# salvo SECRET_KEY (arriba) y SEAL_CHAIN_PEM (va a un archivo). Un secreto nuevo se agrega con solo crear el parámetro;
# antes había que sumarlo a una lista fija acá, y si se olvidaba la app arrancaba sin él.
# Cualquier error de SSM (throttling, permisos, red) corta el deploy: un error tragado dejaba la clave fuera de
# secrets.env sin aviso (p. ej. SMTP_URL: los correos dejaban de salir después del deploy).
SSM_ERR=\$(mktemp)
SSM_JSON=\$(mktemp)
command -v jq >/dev/null || dnf -y -q install jq >/dev/null
if aws ssm get-parameters-by-path --path /calasign-saas/dev/ --with-decryption --output json > \$SSM_JSON 2>\$SSM_ERR; then
  # El while lee de una sustitución de proceso, cuyo error no corta el script: se valida el JSON antes.
  jq -e '.Parameters | type == "array"' \$SSM_JSON >/dev/null || { echo "Respuesta de SSM inválida: deploy abortado" >&2; exit 1; }
  # Nombre y valor separados por NUL (un valor puede tener saltos de línea; NUL no puede aparecer).
  while IFS= read -r -d '' k && IFS= read -r -d '' v; do
    case "\$k" in SECRET_KEY|SEAL_CHAIN_PEM) continue ;; esac
    # secrets.env se lee después de base.env y lo pisa: un parámetro con el nombre de una variable de base.env (o de
    # NODE_OPTIONS) cambiaba la base, el puerto, DATA_DIR o el tope de memoria de la app sin que se viera en el repo.
    case "\$k" in
      NODE_OPTIONS|NODE_ENV|APP_ENV|PORT|HOST|APP_URL|DATABASE_URL|DATA_DIR|S3_BUCKET|AWS_REGION|KMS_KEY_ID|SEAL_CHAIN_FILE|TSA_URL|TSA_REQUIRED|DEV_MAILBOX|WORKER_INLINE|MIGRATE_ON_START|COOKIE_SECURE)
        echo "AVISO: parámetro SSM \$k pisaría una variable fija de la app (base.env/NODE_OPTIONS): se ignora" >&2
        continue ;;
    esac
    if ! [[ "\$k" =~ ^[A-Z_][A-Z0-9_]*\$ ]]; then echo "AVISO: parámetro SSM \$k no es un nombre de variable válido: se ignora" >&2; continue; fi
    if [ -n "\$v" ]; then envq "\$k" "\$v" >> \$SECRETS_TMP; fi
  done < <(jq -j '.Parameters[] | (.Name | sub("^/calasign-saas/dev/"; "")) + "\\u0000" + .Value + "\\u0000"' \$SSM_JSON)
elif grep -q AccessDenied \$SSM_ERR; then
  # El rol de la instancia todavía no tiene ssm:GetParametersByPath (hace falta un terraform apply): lista fija, como
  # antes. Un parámetro de la lista que no existe se saltea.
  echo "AVISO: sin ssm:GetParametersByPath; se leen los secretos de la lista fija" >&2
  for k in TELEGRAM_BOT_TOKEN TELEGRAM_BOT_USERNAME TELEGRAM_WEBHOOK_SECRET WHATSAPP_TOKEN WHATSAPP_PHONE_NUMBER_ID WHATSAPP_TEMPLATE WHATSAPP_OTP_TEMPLATE WHATSAPP_COMPLETED_TEMPLATE WHATSAPP_VOIDED_TEMPLATE WHATSAPP_DECLINED_TEMPLATE SMTP_URL ANTHROPIC_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM VERIFF_API_KEY VERIFF_SHARED_SECRET VERIFF_INTEGRATION_LEVEL TRUORA_API_KEY TRUORA_FLOW_ID TRUORA_FLOW_ID_DOCUMENT TRUORA_FLOW_ID_DOCUMENT_SELFIE TRUORA_FLOW_ID_DOCUMENT_SELFIE_LIVENESS TRUORA_WEBHOOK_SECRET IDV_MOCK_ENABLED IDV_PENDING_TIMEOUT_HOURS IDV_FACE_MATCH_THRESHOLD GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET DROPBOX_CLIENT_ID DROPBOX_CLIENT_SECRET MS_CLIENT_ID MS_CLIENT_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET MP_ACCESS_TOKEN MP_WEBHOOK_SECRET; do
    if v=\$(aws ssm get-parameter --with-decryption --name /calasign-saas/dev/\$k --query Parameter.Value --output text 2>\$SSM_ERR); then
      if [ -n "\$v" ]; then envq "\$k" "\$v" >> \$SECRETS_TMP; fi
    elif ! grep -q ParameterNotFound \$SSM_ERR; then
      echo "No se pudo leer \$k de SSM: deploy abortado" >&2
      cat \$SSM_ERR >&2
      rm -f \$SSM_ERR \$SSM_JSON \$SECRETS_TMP \$CHAIN_TMP
      exit 1
    fi
  done
else
  echo "No se pudieron leer los parámetros de SSM: deploy abortado" >&2
  cat \$SSM_ERR >&2
  rm -f \$SSM_ERR \$SSM_JSON \$SECRETS_TMP \$CHAIN_TMP
  exit 1
fi
rm -f \$SSM_JSON
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
  # Copia del anterior: si la versión nueva no arranca, el rollback lo restaura (antes lo borraba y el servicio
  # quedaba sin hardening).
  if [ -f /etc/systemd/system/calasign.service.d/hardening.conf ]; then cp /etc/systemd/system/calasign.service.d/hardening.conf /root/hardening.conf.prev; else rm -f /root/hardening.conf.prev; fi
  install -m 0644 \$H/calasign-hardening.conf /etc/systemd/system/calasign.service.d/hardening.conf
  NEW_DROPIN=1
  systemctl daemon-reload
fi
# Caddy. API admin por socket unix (/run/caddy/admin.sock, ver el Caddyfile) en vez de localhost:2019, que la app podía
# usar para reconfigurar el proxy en memoria. El drop-in crea /run/caddy, fija el socket en ExecReload y pone
# Type=notify: systemctl restart/reload esperan a que Caddy cargue la config, e is-active refleja si arrancó de verdad.
mkdir -p /etc/systemd/system/caddy.service.d
if ! cmp -s \$H/caddy-calasign.conf /etc/systemd/system/caddy.service.d/calasign.conf; then
  install -m 0644 \$H/caddy-calasign.conf /etc/systemd/system/caddy.service.d/calasign.conf
  systemctl daemon-reload
fi
# Siempre se guarda el vigente (haya cambios o no): si el reload o el arranque fallan, se vuelve a ese y no a un .prev
# viejo de otro deploy.
if [ -f /etc/caddy/Caddyfile ]; then cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.prev; fi
sed 's/__DOMAIN__/$DOMAIN/' \$H/Caddyfile > /etc/caddy/Caddyfile.new
if /usr/local/bin/caddy adapt --config /etc/caddy/Caddyfile.new >/dev/null 2>&1; then
  if ! cmp -s /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile; then
    mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  else
    rm -f /etc/caddy/Caddyfile.new
  fi
else
  echo "AVISO: el Caddyfile nuevo no valida; se mantiene el actual" >&2
  rm -f /etc/caddy/Caddyfile.new
fi
chmod 0640 /var/log/caddy-access.log 2>/dev/null || true
CADDY_SOCK=/run/caddy/admin.sock
caddy_restore_prev() {
  journalctl -u caddy -n 20 --no-pager >&2 || true
  if [ -f /etc/caddy/Caddyfile.prev ]; then cp -p /etc/caddy/Caddyfile.prev /etc/caddy/Caddyfile; fi
}
# Siempre se recarga (ExecReload usa --force), haya cambiado o no el archivo: descarta cualquier config que se haya
# cargado en memoria por la API admin desde el deploy anterior. El reload habla con el socket: si no existe (primer
# deploy con el socket, el Caddy en marcha todavía escucha en :2019; o Caddy parado), restart, un corte de un segundo.
if [ -S \$CADDY_SOCK ]; then
  if ! systemctl reload caddy; then
    # El reload puede fallar por algo ajeno al archivo (socket ocupado, un timeout): solo si el Caddyfile en uso no
    # valida se vuelve al anterior; si valida, se reintenta el reload y, si tampoco, un restart con el mismo archivo.
    if /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      echo "AVISO: falló el reload de Caddy pero el Caddyfile valida; se reintenta (reload y, si no, restart)" >&2
      journalctl -u caddy -n 20 --no-pager >&2 || true
      systemctl reload caddy || systemctl restart caddy || true
    else
      echo "AVISO: falló el reload de Caddy y el Caddyfile nuevo no valida; se restaura el anterior" >&2
      caddy_restore_prev
      systemctl reload caddy || systemctl restart caddy || true
    fi
  fi
else
  systemctl restart caddy || true
fi
for i in \$(seq 1 10); do if [ -S \$CADDY_SOCK ]; then break; fi; sleep 1; done
if ! systemctl is-active -q caddy; then
  # "caddy adapt" no valida todo (p. ej. la dirección del admin): si no arranca con el archivo nuevo, vuelve al anterior.
  echo "AVISO: Caddy no arrancó con el Caddyfile nuevo; se restaura el anterior" >&2
  caddy_restore_prev
  systemctl restart caddy || echo "AVISO: Caddy sigue caído" >&2
fi
# Validación (solo avisos): el puerto 2019 ya no responde, root llega al socket y el usuario de la app no.
# Por el socket va Host 127.0.0.1: Caddy 2.7+ rechaza Host localhost en la API admin por socket (403).
#   a mano: ss -ltnp | grep 2019 (vacío); ls -ld /run/caddy /run/caddy/admin.sock (caddy:caddy 0750 / srw-rw----);
#   curl --unix-socket /run/caddy/admin.sock http://127.0.0.1/config/ (root: JSON);
#   runuser -u calasign -- curl --unix-socket /run/caddy/admin.sock http://127.0.0.1/config/ (Permission denied).
if curl -s -m 2 -o /dev/null http://127.0.0.1:2019/config/; then echo "AVISO: la API admin de Caddy sigue en localhost:2019" >&2; fi
if ! curl -sf -m 2 -o /dev/null --unix-socket \$CADDY_SOCK http://127.0.0.1/config/; then echo "AVISO: root no llega a la API admin de Caddy por \$CADDY_SOCK" >&2; fi
if runuser -u calasign -- curl -s -m 2 -o /dev/null --unix-socket \$CADDY_SOCK http://127.0.0.1/config/ 2>/dev/null; then
  echo "AVISO: el usuario calasign llega a la API admin de Caddy" >&2
fi

# Parches de seguridad del SO: timer propio (calasign-security-updates) en vez de dnf-automatic, que en AL2023 no
# aplicaba nada (el releasever queda fijo en la versión instalada y los parches salen en versiones nuevas del repo).
# Corre a diario "dnf upgrade --security --releasever=latest" sin postgresql* (no reinicia la base); no reinicia
# servicios ni el equipo por su cuenta (un kernel nuevo queda para el próximo reinicio) y no corre durante un deploy
# (lock de /run/calasign-deploy.lock). Node (/opt/node) y Caddy (/usr/local/bin) no son paquetes: se actualizan
# cambiando NODE_VERSION/CADDY_VERSION en bootstrap.sh. Si algo falla no corta el deploy.
install -m 0644 \$H/calasign-security-updates.service /etc/systemd/system/calasign-security-updates.service
install -m 0644 \$H/calasign-security-updates.timer /etc/systemd/system/calasign-security-updates.timer
systemctl daemon-reload
systemctl enable --now calasign-security-updates.timer >/dev/null 2>&1 || echo "AVISO: no se pudo activar calasign-security-updates.timer" >&2
# El deploy anterior instalaba dnf-automatic: se apaga su timer (el paquete queda, inofensivo).
systemctl disable --now dnf-automatic.timer >/dev/null 2>&1 || true

# pg_trgm (índice trigram de la búsqueda de acuerdos por título, migraciones 0088 y 0090) viene en el paquete contrib,
# que bootstrap no instalaba en las instancias viejas: sin él la migración no crea el índice y la búsqueda recorre
# todos los acuerdos de la organización. Idempotente; se instala el contrib de la versión de Postgres presente (16 o
# 15) y la extensión se crea como postgres, antes de reiniciar la app (que aplica las migraciones al arrancar).
# El contrib va con la versión EXACTA del server instalado: sin fijarla, dnf resuelve el contrib más nuevo del repo y
# arrastra el server (y las libs) a esa versión, actualizando la base fuera de la ventana de mantenimiento.
# Si algo falla no corta el deploy: la app funciona sin el índice (y avisa en el log al arrancar).
PG_MAJOR=
if rpm -q --quiet postgresql16-server; then PG_MAJOR=16; elif rpm -q --quiet postgresql15-server; then PG_MAJOR=15; fi
if [ -n "\$PG_MAJOR" ] && ! rpm -q --quiet postgresql\$PG_MAJOR-contrib; then
  PG_VR=\$(rpm -q --qf '%{VERSION}-%{RELEASE}' postgresql\$PG_MAJOR-server)
  dnf -y -q install "postgresql\$PG_MAJOR-contrib-\$PG_VR" >/dev/null 2>&1 || echo "AVISO: no se pudo instalar postgresql\$PG_MAJOR-contrib-\$PG_VR (sin pg_trgm)" >&2
fi
sudo -u postgres psql -d calasign -v ON_ERROR_STOP=1 -qc "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null 2>&1 || echo "AVISO: no se pudo crear la extensión pg_trgm" >&2

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
    if [ "\$NEW_DROPIN" = 1 ]; then
      if [ -f /root/hardening.conf.prev ]; then install -m 0644 /root/hardening.conf.prev /etc/systemd/system/calasign.service.d/hardening.conf
      else rm -f /etc/systemd/system/calasign.service.d/hardening.conf; fi
      systemctl daemon-reload
    fi
    systemctl restart calasign
    if healthy; then echo "ROLLBACK_OK \$PREV"; else echo "ROLLBACK_FALLIDO \$PREV"; fi
    echo "Si la versión nueva ya migró la base, restaurar el backup previo (README → Restaurar un backup)."
  fi
  exit 1
fi
curl -sf localhost:4000/healthz
# Conserva las 3 versiones más nuevas y nunca borra la activa. Nombres separados por NUL: una carpeta vieja con
# comillas o espacios en el nombre (creada cuando releases/ era del usuario de la app) hacía fallar xargs.
CUR=\$(readlink -f /opt/calasign/current)
find /opt/calasign/releases -mindepth 1 -maxdepth 1 -printf '%T@ %p\\0' | sort -z -rn | tail -z -n +4 | cut -z -d' ' -f2- \
  | { grep -zvxF "\$CUR" || true; } | xargs -0r rm -rf --
echo DEPLOY_OK $REL
EOF

echo "▶ desplegando en $INSTANCE por SSM"
# Tiempos coherentes con la espera del lock (hasta 10 minutos con flock -w 600) más el deploy en sí: 30 minutos de
# ejecución en SSM y el sondeo local algo más largo (400 × 5 s, más lo que tarda cada consulta), para no abandonar un
# deploy que todavía corre ni cortar justo antes de que SSM informe el TimedOut.
CMD=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --timeout-seconds 1800 \
  --parameters "$(python3 -c 'import json,sys;print(json.dumps({"commands":[sys.argv[1]],"executionTimeout":["1800"]}))' "$REMOTE")" \
  --query Command.CommandId --output text)
for i in $(seq 1 400); do
  ST=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)
  case "$ST" in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 5
done
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE" --query '[StandardOutputContent,StandardErrorContent]' --output text | tail -40
[ "$ST" = Success ] && echo "✅ https://dev.calasign.com ($REL)" || { echo "❌ deploy $ST"; exit 1; }
rm -rf "$TMP"
