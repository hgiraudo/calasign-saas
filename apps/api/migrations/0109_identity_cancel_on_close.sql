-- Verificaciones de identidad en curso (created/pending) de un sobre que se cierra (completado, rechazado, anulado o
-- vencido): se cancelan en el mismo UPDATE del estado, venga de donde venga la transición (anular, rechazar, vencer,
-- completar, flujos de acuerdos). Antes quedaban "en curso": el firmante seguía subiendo fotos de su documento a un sobre
-- cerrado y un webhook tardío las evaluaba. El destinatario que estaba "in_progress" vuelve a "pending".
-- Las fotos ya subidas las borra la retención al purgar el sobre (purgeableFiles incluye identity_captures).
-- (Cuerpo en una sola línea: el runner, db.ts splitSql, corta en un punto y coma al final de línea.)
CREATE OR REPLACE FUNCTION calasign_identity_cancel_on_envelope_closed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE identity_verifications SET status = 'canceled', updated_at = now() WHERE envelope_id = NEW.id AND status IN ('created', 'pending'); UPDATE recipients SET identity_status = 'pending' WHERE envelope_id = NEW.id AND identity_status = 'in_progress'; RETURN NEW; END $$;

DROP TRIGGER IF EXISTS envelopes_cancel_identity_verifications ON envelopes;
CREATE TRIGGER envelopes_cancel_identity_verifications AFTER UPDATE OF status ON envelopes FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('completed', 'declined', 'voided', 'expired')) EXECUTE FUNCTION calasign_identity_cancel_on_envelope_closed();

-- Las que ya quedaron colgadas en sobres cerrados.
UPDATE identity_verifications iv SET status = 'canceled', updated_at = now() FROM envelopes e WHERE e.id = iv.envelope_id AND iv.status IN ('created', 'pending') AND e.status IN ('completed', 'declined', 'voided', 'expired');
