-- IA: el cupo de consultas del firmante se cuenta en ai_usage (no en la evidencia) y se consume al reservar, antes de
-- llamar al modelo, con la organización bloqueada (service.ts assertAiAvailable con signer). La reserva y el consumo
-- registrado (también el de una llamada fallida que se cobró) llevan el destinatario.
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS recipient_id uuid;

-- Consumo ya registrado de firmantes (actor_type 'recipient', actor_id = id del destinatario): sigue contando en su cupo.
UPDATE ai_usage SET recipient_id = actor_id::uuid
 WHERE recipient_id IS NULL AND actor_type = 'recipient'
   AND actor_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

CREATE INDEX IF NOT EXISTS ai_usage_recipient_idx ON ai_usage (envelope_id, recipient_id, created_at) WHERE recipient_id IS NOT NULL;
