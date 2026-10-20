-- Registros de evidencia append-only también en la base: envelope_events (cadena de hashes del sobre) y
-- account_audit_log (auditoría de la organización) rechazan UPDATE, DELETE y TRUNCATE. La cadena de hashes detecta una
-- edición, pero alguien con escritura en la base (o un error de la aplicación) podía reescribirla entera.
-- Excepciones:
--   · envelope_events: UPDATE que solo cambia `pos` (el secuenciador del feed de eventos, devapi/events.ts).
--   · envelope_events: DELETE de los eventos de un sobre que sigue en borrador (borrar un borrador, envelopes.ts).
--   · Mantenimiento explícito: SET LOCAL calasign.allow_evidence_write = 'on' dentro de la transacción.
-- No hay borrado de organizaciones ni retención que borre estas filas (la retención purga archivos y deja el evento
-- envelope.purged), y ninguna de las dos tablas tiene claves foráneas con ON DELETE CASCADE.
-- (El cuerpo de la función va en una sola línea: el runner, db.ts splitSql, corta en un punto y coma al final de línea.)
CREATE OR REPLACE FUNCTION calasign_envelope_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF coalesce(current_setting('calasign.allow_evidence_write', true), '') = 'on' THEN RETURN COALESCE(NEW, OLD); END IF; IF TG_OP = 'UPDATE' THEN IF (to_jsonb(NEW) - 'pos') = (to_jsonb(OLD) - 'pos') THEN RETURN NEW; END IF; ELSIF TG_OP = 'DELETE' THEN IF EXISTS (SELECT 1 FROM envelopes WHERE id = OLD.envelope_id AND status = 'draft') THEN RETURN OLD; END IF; END IF; RAISE EXCEPTION 'evidence_append_only: % no permitido en envelope_events', TG_OP USING ERRCODE = 'insufficient_privilege'; END $$;
CREATE OR REPLACE FUNCTION calasign_audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF coalesce(current_setting('calasign.allow_evidence_write', true), '') = 'on' THEN RETURN COALESCE(NEW, OLD); END IF; RAISE EXCEPTION 'evidence_append_only: % no permitido en account_audit_log', TG_OP USING ERRCODE = 'insufficient_privilege'; END $$;

DROP TRIGGER IF EXISTS envelope_events_append_only ON envelope_events;
CREATE TRIGGER envelope_events_append_only BEFORE UPDATE OR DELETE ON envelope_events FOR EACH ROW EXECUTE FUNCTION calasign_envelope_events_guard();
DROP TRIGGER IF EXISTS envelope_events_no_truncate ON envelope_events;
CREATE TRIGGER envelope_events_no_truncate BEFORE TRUNCATE ON envelope_events FOR EACH STATEMENT EXECUTE FUNCTION calasign_envelope_events_guard();

DROP TRIGGER IF EXISTS account_audit_log_append_only ON account_audit_log;
CREATE TRIGGER account_audit_log_append_only BEFORE UPDATE OR DELETE ON account_audit_log FOR EACH ROW EXECUTE FUNCTION calasign_audit_log_guard();
DROP TRIGGER IF EXISTS account_audit_log_no_truncate ON account_audit_log;
CREATE TRIGGER account_audit_log_no_truncate BEFORE TRUNCATE ON account_audit_log FOR EACH STATEMENT EXECUTE FUNCTION calasign_audit_log_guard();
