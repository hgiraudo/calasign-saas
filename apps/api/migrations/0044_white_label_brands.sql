-- Marca blanca: sub-marcas por organización (una revendedora con varios clientes) y la marca de cada sobre.
-- La configuración de la marca por defecto sigue en tenants.branding (clave "whiteLabel"), junto al color, logo y pie
-- históricos; la de cada sub-marca va en brands.config con el mismo formato (BrandConfigInput, ver docs/MARCA-BLANCA.md).
CREATE TABLE brands (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  -- Público (URLs de logo/favicon/fuente y ?b= de la verificación): único en toda la plataforma.
  slug        text NOT NULL UNIQUE,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Archivos de la marca: { logo: {fileId, contentType}, logoDark, favicon, font }.
  assets      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX brands_tenant_name_idx ON brands (tenant_id, lower(name));

ALTER TABLE envelopes ADD COLUMN brand_id uuid REFERENCES brands(id) ON DELETE SET NULL;
CREATE INDEX envelopes_brand_idx ON envelopes (brand_id) WHERE brand_id IS NOT NULL;
