-- Fase 6 (agentes) + facturación: links de descarga de corta vida (MCP), cobros dentro del flujo de firma
-- y planes/suscripción de la organización.

-- ───────────── Links de descarga de corta vida ─────────────
-- Los agentes (MCP) reciben una URL temporal en lugar de los bytes del PDF.
CREATE TABLE download_links (
  id                  uuid PRIMARY KEY,
  token_hash          text NOT NULL UNIQUE,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  envelope_id         uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  file_id             uuid NOT NULL REFERENCES files(id),
  created_by_label    text,
  expires_at          timestamptz NOT NULL,
  downloads           integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX download_links_expiry_idx ON download_links (expires_at);

-- ───────────── Cobros dentro del flujo de firma ─────────────
CREATE TABLE envelope_payments (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  envelope_id         uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id        uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider IN ('stripe','mercadopago','mock')),
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  currency            text NOT NULL,
  description         text NOT NULL,
  -- before_sign: hay que pagar para poder firmar. after_sign: el sobre se completa recién cuando se paga.
  timing              text NOT NULL DEFAULT 'after_sign' CHECK (timing IN ('before_sign','after_sign')),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','checkout_created','paid','failed','refunded')),
  checkout_id         text,
  checkout_url        text,
  checkout_nonce_hash text,
  provider_payment_id text,
  receipt             jsonb NOT NULL DEFAULT '{}'::jsonb,
  paid_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (envelope_id)
);
CREATE INDEX envelope_payments_checkout_idx ON envelope_payments (provider, checkout_id);

-- Eventos de proveedores ya procesados (idempotencia de webhooks).
CREATE TABLE payment_webhook_events (
  provider            text NOT NULL,
  event_id            text NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- ───────────── Plan y suscripción de la organización ─────────────
-- billing_plan NULL = plan por defecto del entorno (BILLING_DEFAULT_PLAN; en producción "free").
ALTER TABLE tenants
  ADD COLUMN billing_plan          text CHECK (billing_plan IN ('free','starter','business','enterprise')),
  ADD COLUMN billing_currency      text NOT NULL DEFAULT 'USD',
  ADD COLUMN billing_provider      text,
  ADD COLUMN billing_customer_id   text,
  ADD COLUMN subscription_id       text,
  ADD COLUMN subscription_status   text,
  ADD COLUMN plan_renews_at        timestamptz,
  ADD COLUMN plan_updated_at       timestamptz;

-- Las organizaciones que ya existen al introducir los planes quedan en Business (no se rompe nada).
UPDATE tenants SET billing_plan = 'business', plan = 'business', plan_updated_at = now() WHERE billing_plan IS NULL;

-- Sesiones de checkout de suscripción (para el proveedor de prueba y para conciliar los de verdad).
CREATE TABLE billing_checkouts (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  provider            text NOT NULL,
  plan                text NOT NULL,
  currency            text NOT NULL,
  amount              numeric(14,2) NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','expired')),
  provider_ref        text,
  nonce_hash          text,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz
);
CREATE INDEX billing_checkouts_tenant_idx ON billing_checkouts (tenant_id, created_at DESC);
