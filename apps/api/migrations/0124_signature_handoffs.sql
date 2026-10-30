-- Firma importada desde un archivo y firma dibujada en el celular («pase» de firma).

-- La firma adoptada puede venir de una imagen que subió el firmante (PNG o JPG convertido a PNG en el navegador): la
-- evidencia y adopted_signatures dicen cómo se hizo ('uploaded'), no la hacen pasar por dibujada.
ALTER TABLE adopted_signatures DROP CONSTRAINT IF EXISTS adopted_signatures_kind_check;
ALTER TABLE adopted_signatures ADD CONSTRAINT adopted_signatures_kind_check CHECK (kind IN ('drawn','typed','uploaded'));

-- Pase de firma: el firmante, desde su sesión en la computadora, pide un link corto (/h/<token>) para dibujar la firma
-- en el celular. El token (256 bits) se busca por su hash y se guarda además cifrado (AES-256-GCM) solo para poder
-- reenviar el mismo link por SMS, WhatsApp o Telegram; vence a los pocos minutos y sirve una sola vez (submitted_at).
-- Queda atado al destinatario, a su sobre y al link de firma vigente al crearlo (access_token_hash): una corrección del
-- contacto (link nuevo) lo invalida, igual que los tokens de vinculación de Telegram. La imagen enviada desde el celular
-- (PNG en base64, con el mismo tope que una firma dibujada) espera acá a que el firmante la adopte en la computadora;
-- al completar la firma se borra (queda la del archivo de la firma adoptada) y el barrido borra las filas de más de un
-- día.
CREATE TABLE IF NOT EXISTS signature_handoffs (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  envelope_id           uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  recipient_id          uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  access_token_hash     text NOT NULL,
  token_hash            text NOT NULL UNIQUE,
  token_enc             text NOT NULL,
  purpose               text NOT NULL CHECK (purpose IN ('signature','initials')),
  expires_at            timestamptz NOT NULL,
  submitted_at          timestamptz,
  submitted_ip          text,
  submitted_user_agent  text,
  image_png             text,
  image_sha256          text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signature_handoffs_recipient_idx ON signature_handoffs (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS signature_handoffs_created_idx ON signature_handoffs (created_at);

-- Cada envío del link de un pase por SMS, WhatsApp o Telegram: la espera entre envíos y los topes por destinatario y
-- por destino (los mismos números que el código OTP, config.otp) se cuentan acá; cada SMS o WhatsApp cuesta y el
-- teléfono lo escribe quien tiene el link de firma. El barrido borra las filas de más de un día.
CREATE TABLE IF NOT EXISTS signature_handoff_sends (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  handoff_id    uuid NOT NULL REFERENCES signature_handoffs(id) ON DELETE CASCADE,
  recipient_id  uuid NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  channel       text NOT NULL CHECK (channel IN ('sms','whatsapp','telegram')),
  destination   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signature_handoff_sends_recipient_idx ON signature_handoff_sends (recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS signature_handoff_sends_destination_idx ON signature_handoff_sends (destination, created_at);
CREATE INDEX IF NOT EXISTS signature_handoff_sends_created_idx ON signature_handoff_sends (created_at);
