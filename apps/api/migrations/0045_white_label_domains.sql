-- Marca blanca: dominios de correo propios (remitente con SPF/DKIM) y dominios web de las sub-marcas.

-- Dominio del remitente de los correos. La organización publica un TXT de propiedad y la clave pública DKIM; los
-- correos con un remitente de ese dominio salen firmados con la clave privada (cifrada con la clave de la plataforma).
CREATE TABLE email_domains (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain              text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified')),
  verification_token  text NOT NULL,
  dkim_selector       text NOT NULL,
  dkim_public_key     text NOT NULL,
  dkim_private_key_enc text NOT NULL,
  spf_ok              boolean,
  dmarc_ok            boolean,
  verified_at         timestamptz,
  last_checked_at     timestamptz,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, domain)
);
CREATE UNIQUE INDEX email_domains_verified_idx ON email_domains (domain) WHERE status = 'verified';

-- Dominio web propio de una sub-marca (la marca por defecto usa custom_domains). Mismo flujo: TXT + CNAME.
CREATE TABLE brand_domains (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  brand_id            uuid NOT NULL UNIQUE REFERENCES brands(id) ON DELETE CASCADE,
  domain              text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified')),
  verification_token  text NOT NULL,
  verified_at         timestamptz,
  last_checked_at     timestamptz,
  last_error          text,
  recheck_failures    integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brand_domains_verified_idx ON brand_domains (domain) WHERE status = 'verified';
