-- Fase 2 — productividad: plantillas, nuevos tipos de campo (número, desplegable, empresa, cargo, adjunto)
-- y branding básico (logo y color de la organización).

-- ───────────── Archivos: adjuntos del firmante, logos y documentos de plantilla ─────────────

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_kind_check;
ALTER TABLE files ADD CONSTRAINT files_kind_check
  CHECK (kind IN ('original','signed','signature_image','attachment','logo','template'));

-- ───────────── Campos: tipos nuevos y propiedades ─────────────

ALTER TABLE fields DROP CONSTRAINT IF EXISTS fields_type_check;
ALTER TABLE fields ADD CONSTRAINT fields_type_check
  CHECK (type IN ('signature','initials','date_signed','name','email','text','checkbox',
                  'number','dropdown','company','title','attachment'));

ALTER TABLE fields ADD COLUMN IF NOT EXISTS options jsonb;                 -- desplegable: ["A","B"]
ALTER TABLE fields ADD COLUMN IF NOT EXISTS min_value double precision;    -- número: mínimo
ALTER TABLE fields ADD COLUMN IF NOT EXISTS max_value double precision;    -- número: máximo
ALTER TABLE fields ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false;  -- valor fijado por el remitente
ALTER TABLE fields ADD COLUMN IF NOT EXISTS attachment_file_id uuid REFERENCES files(id);

-- ───────────── Plantillas ─────────────

CREATE TABLE templates (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  name            text NOT NULL,
  description     text,
  subject         text,
  message         text,
  locale          text NOT NULL DEFAULT 'es',
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX templates_tenant_idx ON templates (tenant_id, updated_at DESC);

CREATE TABLE template_documents (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  template_id     uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  position        integer NOT NULL,
  name            text NOT NULL,
  file_id         uuid NOT NULL REFERENCES files(id),
  page_count      integer NOT NULL,
  pages           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX template_documents_tpl_idx ON template_documents (template_id, position);

CREATE TABLE template_roles (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  template_id     uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  name            text NOT NULL,
  role            text NOT NULL DEFAULT 'signer' CHECK (role IN ('signer','cc')),
  routing_order   integer NOT NULL DEFAULT 1,
  position        integer NOT NULL DEFAULT 0
);
CREATE INDEX template_roles_tpl_idx ON template_roles (template_id, routing_order, position);

CREATE TABLE template_fields (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  template_id     uuid NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  document_id     uuid NOT NULL REFERENCES template_documents(id) ON DELETE CASCADE,
  role_id         uuid NOT NULL REFERENCES template_roles(id) ON DELETE CASCADE,
  type            text NOT NULL,
  page            integer NOT NULL,
  x               double precision NOT NULL,
  y               double precision NOT NULL,
  width           double precision NOT NULL,
  height          double precision NOT NULL,
  required        boolean NOT NULL DEFAULT true,
  label           text,
  value           text,
  read_only       boolean NOT NULL DEFAULT false,
  options         jsonb,
  min_value       double precision,
  max_value       double precision
);
CREATE INDEX template_fields_tpl_idx ON template_fields (template_id);
