-- CalaSign SaaS — Fase 3: integraciones (webhooks, firma embebida).

-- ───────────────────────────── Webhooks ─────────────────────────────

CREATE TABLE webhook_endpoints (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  url                 text NOT NULL,
  description         text,
  events              text[] NOT NULL DEFAULT ARRAY[]::text[],   -- vacío = todos los eventos
  secret_enc          text NOT NULL,                             -- secreto HMAC cifrado (AES-256-GCM)
  secret_prefix       text NOT NULL,                             -- primeros caracteres visibles: whsec_ab12…
  active              boolean NOT NULL DEFAULT true,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id) WHERE active;

-- Una fila por (evento, endpoint). El payload queda congelado al momento del evento.
CREATE TABLE webhook_deliveries (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  endpoint_id         uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id            uuid NOT NULL,
  event_type          text NOT NULL,
  envelope_id         uuid,
  payload             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  attempts            integer NOT NULL DEFAULT 0,
  last_status_code    integer,
  last_response       text,                                      -- primeros 1000 caracteres
  last_error          text,
  last_attempt_at     timestamptz,
  next_retry_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  delivered_at        timestamptz
);
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
CREATE INDEX webhook_deliveries_tenant_idx ON webhook_deliveries (tenant_id, created_at DESC);

-- ───────────────────────────── Firma embebida ─────────────────────────────

-- Destinatarios que firman dentro de la aplicación del integrador: no reciben invitaciones.
ALTER TABLE recipients ADD COLUMN embedded boolean NOT NULL DEFAULT false;
ALTER TABLE recipients DROP CONSTRAINT IF EXISTS recipients_check;
ALTER TABLE recipients ADD CONSTRAINT recipients_contact_check CHECK (email IS NOT NULL OR phone IS NOT NULL OR embedded);

-- Orígenes autorizados a enmarcar la página de firma (CSP frame-ancestors), por organización.
ALTER TABLE tenants ADD COLUMN embed_frame_ancestors text[] NOT NULL DEFAULT ARRAY[]::text[];

-- Códigos de un solo uso para abrir la ceremonia embebida (vencen a los 5 minutos).
CREATE TABLE embed_sessions (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  envelope_id         uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id        uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  code_hash           text NOT NULL UNIQUE,
  return_url          text,
  frame_ancestors     text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_by_actor    text,
  expires_at          timestamptz NOT NULL,
  used_at             timestamptz,
  used_ip             text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX embed_sessions_recipient_idx ON embed_sessions (recipient_id, created_at DESC);
