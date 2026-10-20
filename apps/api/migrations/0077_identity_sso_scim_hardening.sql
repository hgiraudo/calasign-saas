-- Endurecimiento de identidad (SSO / SCIM).

-- SCIM DELETE ya no borra la fila: queda con active = false y deleted_at (los GET/listados SCIM devuelven 404 para
-- los borrados, como pide el RFC 7644 §3.6). Sin la fila, el alta JIT por SSO volvía a sumar a quien el IdP borró.
ALTER TABLE scim_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- OIDC: por defecto se exige email_verified = true. Algunos IdP (Microsoft Entra ID, según el tipo de cuenta y la
-- configuración de claims opcionales) no mandan el claim: la organización puede confiar en el correo sin él.
ALTER TABLE sso_configs ADD COLUMN IF NOT EXISTS oidc_trust_unverified_email boolean NOT NULL DEFAULT false;

-- Duración (absoluta) de las sesiones abiertas por SSO, en horas. Antes eran 14 días fijos.
ALTER TABLE sso_configs ADD COLUMN IF NOT EXISTS session_ttl_hours integer NOT NULL DEFAULT 24;
ALTER TABLE sso_configs DROP CONSTRAINT IF EXISTS sso_configs_session_ttl_hours_chk;
ALTER TABLE sso_configs ADD CONSTRAINT sso_configs_session_ttl_hours_chk CHECK (session_ttl_hours BETWEEN 1 AND 336);

-- Anti-replay SAML: IDs de Assertion ya usados, hasta que la aserción deja de ser válida (limpieza en el barrido).
CREATE TABLE IF NOT EXISTS saml_assertion_ids (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  assertion_id  text NOT NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, assertion_id)
);
CREATE INDEX IF NOT EXISTS saml_assertion_ids_expires_idx ON saml_assertion_ids (expires_at);
