-- CalaSign SaaS — esquema inicial (MVP, Fase 1).
-- Convenciones: ids UUIDv7 generados en la aplicación; timestamps timestamptz; todo dato de negocio lleva tenant_id.

-- ───────────────────────────── Identidad ─────────────────────────────

CREATE TABLE tenants (
  id              uuid PRIMARY KEY,
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  cell            text NOT NULL DEFAULT 'local',          -- celda regional donde viven sus datos
  plan            text NOT NULL DEFAULT 'free',
  default_locale  text NOT NULL DEFAULT 'es',
  branding        jsonb NOT NULL DEFAULT '{}'::jsonb,     -- { primaryColor, logoFileId } (Fase 2)
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id              uuid PRIMARY KEY,
  email           text NOT NULL,
  name            text NOT NULL,
  password_hash   text NOT NULL,
  locale          text NOT NULL DEFAULT 'es',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE memberships (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  role            text NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE sessions (
  token_hash      text PRIMARY KEY,                       -- sha256 del token de la cookie
  user_id         uuid NOT NULL REFERENCES users(id),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  ip              text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE api_keys (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  name            text NOT NULL,
  prefix          text NOT NULL,                          -- primeros caracteres visibles: cs_live_ab12…
  key_hash        text NOT NULL UNIQUE,
  scopes          text[] NOT NULL DEFAULT ARRAY['envelopes:write'],
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

-- ───────────────────────────── Archivos ─────────────────────────────

CREATE TABLE files (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  kind            text NOT NULL CHECK (kind IN ('original','signed','signature_image')),
  storage_key     text NOT NULL,                          -- clave en S3 / disco
  content_type    text NOT NULL,
  size_bytes      bigint NOT NULL,
  sha256          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_tenant_idx ON files (tenant_id);

-- ───────────────────────────── Sobres ─────────────────────────────

CREATE TABLE envelopes (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  created_by          uuid REFERENCES users(id),
  created_via         text NOT NULL DEFAULT 'web' CHECK (created_via IN ('web','api')),
  subject             text NOT NULL,
  message             text,
  locale              text NOT NULL DEFAULT 'es',
  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','sent','finalizing','completed','declined','voided','expired')),
  signature_level     text NOT NULL DEFAULT 'simple' CHECK (signature_level IN ('simple','advanced','qualified')),
  expires_at          timestamptz,
  sent_at             timestamptz,
  completed_at        timestamptz,
  voided_at           timestamptz,
  void_reason         text,
  signed_file_id      uuid REFERENCES files(id),
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb, -- datos libres del integrador (external_id, etc.)
  version             integer NOT NULL DEFAULT 1,         -- control de concurrencia optimista
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX envelopes_tenant_created_idx ON envelopes (tenant_id, created_at DESC, id DESC);
CREATE INDEX envelopes_tenant_status_idx  ON envelopes (tenant_id, status, created_at DESC);
CREATE INDEX envelopes_expiring_idx       ON envelopes (expires_at) WHERE status = 'sent';

CREATE TABLE documents (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  envelope_id         uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  position            integer NOT NULL,
  name                text NOT NULL,
  file_id             uuid NOT NULL REFERENCES files(id),
  page_count          integer NOT NULL,
  pages               jsonb NOT NULL,                     -- [{ width, height }] en puntos PDF
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_envelope_idx ON documents (envelope_id, position);

CREATE TABLE recipients (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  envelope_id         uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  role                text NOT NULL CHECK (role IN ('signer','cc')),
  routing_order       integer NOT NULL DEFAULT 1,         -- mismo número = paralelo
  name                text NOT NULL,
  email               text,
  phone               text,                                -- E.164
  locale              text,
  channels            text[] NOT NULL DEFAULT ARRAY['email'],   -- email, whatsapp, telegram
  telegram_chat_id    text,                                -- se completa al vincular el bot (o lo da el integrador)
  id_document_type    text,                                -- cedula, cpf, dni, pasaporte…
  id_document_number  text,
  status              text NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created','sent','viewed','signed','declined','completed')),
  auth_method         text NOT NULL DEFAULT 'link' CHECK (auth_method IN ('link','otp_email','otp_sms','otp_whatsapp')),
  access_token_hash   text UNIQUE,                         -- sha256 del token del link
  access_token_enc    text,                                -- token cifrado (AES-256-GCM) para reenvíos
  consented_at        timestamptz,
  sent_at             timestamptz,
  viewed_at           timestamptz,
  signed_at           timestamptz,
  declined_at         timestamptz,
  decline_reason      text,
  signed_ip           text,
  signed_user_agent   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX recipients_envelope_idx ON recipients (envelope_id, routing_order);

CREATE TABLE fields (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  envelope_id         uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  document_id         uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  recipient_id        uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  type                text NOT NULL CHECK (type IN ('signature','initials','date_signed','name','email','text','checkbox')),
  page                integer NOT NULL,                    -- 0-based
  x                   double precision NOT NULL,           -- 0..1 desde el borde izquierdo
  y                   double precision NOT NULL,           -- 0..1 desde el borde superior
  width               double precision NOT NULL,
  height              double precision NOT NULL,
  required            boolean NOT NULL DEFAULT true,
  label               text,
  value               text,
  filled_at           timestamptz,
  CHECK (x >= 0 AND y >= 0 AND width > 0 AND height > 0 AND x + width <= 1.0001 AND y + height <= 1.0001)
);
CREATE INDEX fields_envelope_idx  ON fields (envelope_id);
CREATE INDEX fields_recipient_idx ON fields (recipient_id);

-- Firma adoptada por cada firmante (imagen que se estampa en sus campos de firma / iniciales).
CREATE TABLE adopted_signatures (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  recipient_id        uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  purpose             text NOT NULL CHECK (purpose IN ('signature','initials')),
  kind                text NOT NULL CHECK (kind IN ('drawn','typed')),
  text                text,
  image_file_id       uuid NOT NULL REFERENCES files(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (recipient_id, purpose)
);

-- ───────────────────────────── Evidencia ─────────────────────────────

-- Append-only y encadenado por hash. En producción: particionado por mes, sin UPDATE/DELETE (GRANT).
CREATE TABLE envelope_events (
  id                  bigserial PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  envelope_id         uuid NOT NULL,
  seq                 integer NOT NULL,
  type                text NOT NULL,
  actor_type          text NOT NULL CHECK (actor_type IN ('user','api_key','recipient','system')),
  actor_id            text,
  actor_label         text,
  ip                  text,
  user_agent          text,
  data                jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at         timestamptz NOT NULL,
  prev_hash           text NOT NULL,
  hash                text NOT NULL,
  UNIQUE (envelope_id, seq)
);

-- ───────────────────────────── Asincronía ─────────────────────────────

CREATE TABLE jobs (
  id                  bigserial PRIMARY KEY,
  queue               text NOT NULL,
  payload             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 8,
  run_at              timestamptz NOT NULL DEFAULT now(),
  locked_at           timestamptz,
  locked_by           text,
  last_error          text,
  dedupe_key          text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs (queue, run_at) WHERE status = 'pending';

CREATE TABLE notifications (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  envelope_id         uuid,
  recipient_id        uuid,
  channel             text NOT NULL CHECK (channel IN ('email','whatsapp','telegram','sms')),
  template            text NOT NULL,                       -- invite, reminder, completed, declined…
  destination         text NOT NULL,
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  provider            text,
  provider_message_id text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX notifications_envelope_idx ON notifications (envelope_id);

CREATE TABLE idempotency_keys (
  tenant_id           uuid NOT NULL,
  key                 text NOT NULL,
  request_hash        text NOT NULL,
  status_code         integer NOT NULL,
  response            jsonb NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
