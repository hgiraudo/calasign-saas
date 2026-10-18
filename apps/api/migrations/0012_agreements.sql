-- Fase 6 — Plataforma de acuerdos: repositorio, documentos generados, cláusulas, workflows y negociación.

-- ───────────────────────────── Repositorio ─────────────────────────────

CREATE TABLE agreements (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  source              text NOT NULL CHECK (source IN ('envelope','external')),
  envelope_id         uuid UNIQUE REFERENCES envelopes(id) ON DELETE SET NULL,
  file_id             uuid NOT NULL REFERENCES files(id),
  file_name           text NOT NULL,
  title               text NOT NULL,
  counterparties      jsonb NOT NULL DEFAULT '[]'::jsonb,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','expired','terminated')),
  effective_date      date,
  expiry_date         date,
  renewal_date        date,
  notice_days         integer CHECK (notice_days IS NULL OR notice_days BETWEEN 0 AND 3650),
  value               numeric,
  currency            text,
  tags                text[] NOT NULL DEFAULT ARRAY[]::text[],
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  signatures          integer NOT NULL DEFAULT 0,
  owner_user_id       uuid REFERENCES users(id),
  created_by_api_key  uuid,
  completed_at        timestamptz,
  -- Búsqueda: texto extraído del PDF, sin acentos (se pliega en la aplicación: igual en Postgres y PGlite).
  text_folded         text NOT NULL DEFAULT '',
  search_vector       tsvector,
  expiry_notified_for date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agreements_tenant_idx ON agreements (tenant_id, created_at DESC, id DESC);
CREATE INDEX agreements_expiry_idx ON agreements (expiry_date) WHERE status = 'active' AND expiry_date IS NOT NULL;
CREATE INDEX agreements_search_idx ON agreements USING gin (search_vector);
CREATE INDEX agreements_tags_idx ON agreements USING gin (tags);

CREATE TABLE agreement_fields (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key         text NOT NULL,
  label       text NOT NULL,
  type        text NOT NULL CHECK (type IN ('text','number','date','select')),
  options     jsonb,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE agreement_views (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  filters     jsonb NOT NULL DEFAULT '{}'::jsonb,
  shared      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agreement_views_tenant_idx ON agreement_views (tenant_id);

-- ───────────────────────────── Documentos ─────────────────────────────

CREATE TABLE document_templates (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  name              text NOT NULL,
  description       text,
  locale            text NOT NULL DEFAULT 'es',
  source            text NOT NULL DEFAULT '',
  sample_data       jsonb,
  agreement_mapping jsonb,
  created_by        uuid REFERENCES users(id),
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_templates_tenant_idx ON document_templates (tenant_id, updated_at DESC);

CREATE TABLE clauses (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  slug        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  category    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

-- ───────────────────────────── Workflows ─────────────────────────────

CREATE TABLE workflows (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  name          text NOT NULL,
  description   text,
  active        boolean NOT NULL DEFAULT true,
  public_start  boolean NOT NULL DEFAULT false,
  public_slug   text UNIQUE,
  steps         jsonb NOT NULL,
  -- Secreto (cifrado) con el que se firman las llamadas HTTP del paso "llamar a un servicio".
  signing_secret_enc text NOT NULL,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflows_tenant_idx ON workflows (tenant_id, updated_at DESC);

CREATE TABLE workflow_runs (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  workflow_id       uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  -- Copia de los pasos al iniciar: editar el workflow no altera runs en curso.
  steps             jsonb NOT NULL,
  status            text NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','waiting','completed','failed','rejected','cancelled')),
  current_step      integer NOT NULL DEFAULT 0,
  context           jsonb NOT NULL DEFAULT '{"data":{},"documents":{},"envelopes":{},"http":{}}'::jsonb,
  started_by        uuid REFERENCES users(id),
  started_by_label  text,
  public_token_hash text UNIQUE,
  public_token_enc  text,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workflow_runs_workflow_idx ON workflow_runs (workflow_id, created_at DESC);
CREATE INDEX workflow_runs_tenant_idx ON workflow_runs (tenant_id, status);

CREATE TABLE workflow_run_steps (
  run_id       uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  idx          integer NOT NULL,
  step_id      uuid NOT NULL,
  type         text NOT NULL,
  name         text NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','waiting','completed','failed','skipped','cancelled')),
  attempts     integer NOT NULL DEFAULT 0,
  output       jsonb,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  PRIMARY KEY (run_id, idx)
);
-- Esperas por sobre (paso "esperar firma"): se resuelven con los eventos del sobre.
CREATE INDEX workflow_runs_waiting_envelope_idx ON workflow_runs ((context->'waitingEnvelope')) WHERE status = 'waiting';

-- ───────────────────────────── Negociación ─────────────────────────────

CREATE TABLE negotiations (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  title                 text NOT NULL,
  source                text NOT NULL DEFAULT 'template' CHECK (source IN ('template','pdf')),
  document_template_id  uuid REFERENCES document_templates(id) ON DELETE SET NULL,
  -- Instantánea de la plantilla al crear la negociación (fuente + cláusulas), para que no cambie bajo los pies.
  template_source       text NOT NULL DEFAULT '',
  template_locale       text NOT NULL DEFAULT 'es',
  clause_snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,
  negotiable            jsonb,
  data                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  clause_overrides      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','cancelled')),
  current_version       integer NOT NULL DEFAULT 1,
  message               text,
  -- Negociación sobre un PDF subido (solo comentarios).
  file_id               uuid REFERENCES files(id),
  envelope_id           uuid REFERENCES envelopes(id) ON DELETE SET NULL,
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX negotiations_tenant_idx ON negotiations (tenant_id, updated_at DESC);

CREATE TABLE negotiation_participants (
  id                uuid PRIMARY KEY,
  negotiation_id    uuid NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL,
  name              text NOT NULL,
  email             text NOT NULL,
  role              text,
  can_propose       boolean NOT NULL DEFAULT true,
  token_hash        text NOT NULL UNIQUE,
  token_enc         text NOT NULL,
  last_seen_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE negotiation_versions (
  negotiation_id  uuid NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  data            jsonb NOT NULL,
  clause_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
  text_snapshot   text NOT NULL,
  author_type     text NOT NULL CHECK (author_type IN ('user','participant')),
  author_name     text NOT NULL,
  summary         text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (negotiation_id, version)
);

CREATE TABLE negotiation_comments (
  id              uuid PRIMARY KEY,
  negotiation_id  uuid NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  author_type     text NOT NULL CHECK (author_type IN ('user','participant')),
  author_id       text,
  author_name     text NOT NULL,
  quote           text,
  start_offset    integer,
  end_offset      integer,
  body            text NOT NULL,
  resolved        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX negotiation_comments_idx ON negotiation_comments (negotiation_id, created_at);

CREATE TABLE negotiation_proposals (
  id              uuid PRIMARY KEY,
  negotiation_id  uuid NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  version         integer NOT NULL,
  author_type     text NOT NULL CHECK (author_type IN ('user','participant')),
  author_id       text,
  author_name     text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('variable','clause')),
  key             text NOT NULL,
  old_value       text NOT NULL,
  new_value       text NOT NULL,
  comment         text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX negotiation_proposals_idx ON negotiation_proposals (negotiation_id, status);
