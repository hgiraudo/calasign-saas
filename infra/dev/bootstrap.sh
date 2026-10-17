#!/bin/bash
# Primer arranque del EC2 de dev (Amazon Linux 2023, arm64). Lo procesa templatefile() de Terraform.
set -euxo pipefail
exec > >(tee -a /var/log/calasign-bootstrap.log) 2>&1

NODE_VERSION=22.22.1
CADDY_VERSION=2.10.2

dnf -y update
dnf -y install tar gzip git jq

# Node.js
curl -fsSL "https://nodejs.org/dist/v$${NODE_VERSION}/node-v$${NODE_VERSION}-linux-arm64.tar.xz" -o /tmp/node.tar.xz
mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node
ln -sf /opt/node/bin/corepack /usr/local/bin/corepack
ln -sf /opt/node/bin/npm /usr/local/bin/npm

# PostgreSQL
dnf -y install postgresql16-server postgresql16 || dnf -y install postgresql15-server postgresql15
postgresql-setup --initdb
systemctl enable --now postgresql

# Usuario de la app (autenticación peer por socket: sin contraseña de base)
useradd --system --create-home --home-dir /var/lib/calasign --shell /sbin/nologin calasign || true
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE calasign LOGIN" || true
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE calasign OWNER calasign" || true

# Caddy (TLS automático con Let's Encrypt)
curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$${CADDY_VERSION}/caddy_$${CADDY_VERSION}_linux_arm64.tar.gz" -o /tmp/caddy.tgz
tar -xzf /tmp/caddy.tgz -C /usr/local/bin caddy
useradd --system --home /var/lib/caddy --create-home --shell /sbin/nologin caddy || true
mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<'EOF'
${domain} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:4000
	header Strict-Transport-Security "max-age=31536000"
	log {
		output file /var/log/caddy-access.log
	}
}
EOF
touch /var/log/caddy-access.log && chown caddy /var/log/caddy-access.log
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

# Configuración de la app (los secretos se leen de SSM en cada deploy)
mkdir -p /etc/calasign /opt/calasign/releases /var/lib/calasign/data
cat > /etc/calasign/base.env <<'EOF'
NODE_ENV=production
APP_ENV=dev
PORT=4000
HOST=127.0.0.1
APP_URL=https://${domain}
DATABASE_URL=postgresql://calasign@localhost/calasign?host=/var/run/postgresql
DATA_DIR=/var/lib/calasign/data
S3_BUCKET=${bucket}
AWS_REGION=us-east-1
KMS_KEY_ID=${kms_key_id}
SEAL_CHAIN_FILE=/etc/calasign/seal.chain.pem
TSA_URL=https://freetsa.org/tsr
TSA_REQUIRED=false
DEV_MAILBOX=true
WORKER_INLINE=true
MIGRATE_ON_START=1
COOKIE_SECURE=true
EOF
chown -R calasign:calasign /var/lib/calasign /opt/calasign

cat > /etc/systemd/system/calasign.service <<'EOF'
[Unit]
Description=CalaSign SaaS (API + worker)
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
User=calasign
Group=calasign
WorkingDirectory=/opt/calasign/current/apps/api
EnvironmentFile=/etc/calasign/base.env
EnvironmentFile=-/etc/calasign/secrets.env
ExecStart=/opt/calasign/current/apps/api/node_modules/.bin/tsx src/server.ts
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable caddy calasign
systemctl start caddy
echo "bootstrap OK"
