-- Fase 4 — Equipos: invitaciones, roles personalizados (RBAC), grupos, auditoría de cuenta,
-- retención y 2FA (TOTP).

-- ───────────── Roles ─────────────

CREATE TABLE roles (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  name            text NOT NULL,
  description     text,
  permissions     text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX roles_tenant_name_uq ON roles (tenant_id, lower(name));

ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner','admin','member','custom'));
ALTER TABLE memberships ADD COLUMN role_id uuid REFERENCES roles(id);
ALTER TABLE memberships ADD CONSTRAINT memberships_custom_role_check CHECK ((role = 'custom') = (role_id IS NOT NULL));

-- Las API keys existentes conservan el comportamiento anterior (equivalente a admin).
ALTER TABLE api_keys ADD COLUMN role text NOT NULL DEFAULT 'admin';
ALTER TABLE api_keys ADD COLUMN role_id uuid REFERENCES roles(id);
ALTER TABLE api_keys ADD CONSTRAINT api_keys_role_check CHECK (role IN ('admin','member','custom'));

-- ───────────── Invitaciones ─────────────

CREATE TABLE invitations (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  email           text NOT NULL,
  role            text NOT NULL CHECK (role IN ('owner','admin','member','custom')),
  role_id         uuid REFERENCES roles(id),
  token_hash      text NOT NULL UNIQUE,
  invited_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  accepted_by     uuid REFERENCES users(id),
  revoked_at      timestamptz
);
CREATE INDEX invitations_tenant_idx ON invitations (tenant_id, created_at DESC);

-- ───────────── Grupos y visibilidad compartida ─────────────

CREATE TABLE groups (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  name            text NOT NULL,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX groups_tenant_name_uq ON groups (tenant_id, lower(name));

CREATE TABLE group_members (
  group_id        uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  added_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user_idx ON group_members (user_id);

-- Sobres creados con una API key: para que una key sin envelopes:view_all vea los suyos.
ALTER TABLE envelopes ADD COLUMN created_by_api_key uuid REFERENCES api_keys(id);
CREATE INDEX envelopes_created_by_idx ON envelopes (tenant_id, created_by);

CREATE TABLE envelope_shares (
  envelope_id     uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  group_id        uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (envelope_id, group_id)
);
CREATE INDEX envelope_shares_group_idx ON envelope_shares (group_id);

-- Plantillas: por defecto visibles para toda la organización (comportamiento anterior);
-- 'restricted' = solo su creador, quienes tienen templates:manage y los grupos con los que se compartió.
ALTER TABLE templates ADD COLUMN visibility text NOT NULL DEFAULT 'organization';
ALTER TABLE templates ADD CONSTRAINT templates_visibility_check CHECK (visibility IN ('organization','restricted'));

CREATE TABLE template_shares (
  template_id     uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  group_id        uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, group_id)
);

-- ───────────── Auditoría de cuenta (append-only) ─────────────

CREATE TABLE account_audit_log (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  actor_type      text NOT NULL CHECK (actor_type IN ('user','api_key','system','anonymous')),
  actor_id        text,
  actor_label     text,
  action          text NOT NULL,
  target_type     text,
  target_id       text,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip              text,
  user_agent      text,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_audit_log_tenant_idx ON account_audit_log (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX account_audit_log_action_idx ON account_audit_log (tenant_id, action, occurred_at DESC);

-- ───────────── Retención ─────────────

ALTER TABLE tenants ADD COLUMN retention_days integer CHECK (retention_days IS NULL OR retention_days BETWEEN 1 AND 36500);
ALTER TABLE tenants ADD COLUMN require_2fa boolean NOT NULL DEFAULT false;
ALTER TABLE files ADD COLUMN purged_at timestamptz;
ALTER TABLE envelopes ADD COLUMN purged_at timestamptz;
CREATE INDEX envelopes_retention_idx ON envelopes (tenant_id, completed_at) WHERE status = 'completed' AND purged_at IS NULL;

-- ───────────── 2FA (TOTP) ─────────────

ALTER TABLE users ADD COLUMN totp_secret_enc text;
ALTER TABLE users ADD COLUMN totp_pending_enc text;
ALTER TABLE users ADD COLUMN totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN totp_recovery_hashes text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN totp_last_step bigint;

CREATE TABLE login_challenges (
  token_hash      text PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  attempts        integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);
