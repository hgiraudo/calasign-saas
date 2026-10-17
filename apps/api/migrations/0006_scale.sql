-- Fase 4 — escala: lógica condicional y campos calculados, envío masivo y formularios web públicos.

-- ───────────── Lógica de campos ─────────────

ALTER TABLE fields ADD COLUMN IF NOT EXISTS conditions jsonb;          -- [{fieldId, operator, value}]
ALTER TABLE fields ADD COLUMN IF NOT EXISTS formula text;              -- número calculado: "{Precio} * {Cantidad}"
ALTER TABLE fields ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;  -- oculto por sus condiciones al firmar: no se estampa
ALTER TABLE template_fields ADD COLUMN IF NOT EXISTS conditions jsonb;
ALTER TABLE template_fields ADD COLUMN IF NOT EXISTS formula text;

-- ───────────── Envío masivo ─────────────

CREATE TABLE bulk_sends (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  template_id     uuid REFERENCES templates(id) ON DELETE SET NULL,
  template_name   text NOT NULL,
  name            text,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','cancelled')),
  total           integer NOT NULL,
  options         jsonb NOT NULL DEFAULT '{}'::jsonb,               -- subject, message, locale, expiresAt
  actor           jsonb NOT NULL,                                   -- quién lo creó (para la evidencia de cada sobre)
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  cancelled_at    timestamptz
);
CREATE INDEX bulk_sends_tenant_idx ON bulk_sends (tenant_id, created_at DESC);

CREATE TABLE bulk_send_items (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  bulk_send_id    uuid NOT NULL REFERENCES bulk_sends(id) ON DELETE CASCADE,
  row_number      integer NOT NULL,
  input           jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','cancelled')),
  envelope_id     uuid,
  error           text,
  processed_at    timestamptz,
  UNIQUE (bulk_send_id, row_number)
);
CREATE INDEX bulk_send_items_status_idx ON bulk_send_items (bulk_send_id, status, row_number);

-- ───────────── Formularios web públicos ─────────────

CREATE TABLE web_forms (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  template_id       uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  description       text,
  signer_role_id    uuid NOT NULL,
  fixed_recipients  jsonb NOT NULL DEFAULT '[]'::jsonb,
  prefill           jsonb NOT NULL DEFAULT '{}'::jsonb,
  active            boolean NOT NULL DEFAULT true,
  max_uses          integer,
  uses              integer NOT NULL DEFAULT 0,
  expires_at        timestamptz,
  require_otp       boolean NOT NULL DEFAULT false,
  embeddable        boolean NOT NULL DEFAULT false,
  collect_phone     boolean NOT NULL DEFAULT false,
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX web_forms_tenant_idx ON web_forms (tenant_id, created_at DESC);

-- Sobres creados desde un formulario o un envío masivo (el vínculo vive en metadata).
CREATE INDEX envelopes_web_form_idx ON envelopes (tenant_id, (metadata->>'webFormId'), created_at DESC);
CREATE INDEX envelopes_bulk_send_idx ON envelopes (tenant_id, (metadata->>'bulkSendId'));
