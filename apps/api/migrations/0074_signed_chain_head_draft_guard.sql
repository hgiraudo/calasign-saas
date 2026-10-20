-- Verificación pública sin parsear el PDF: files.chain_head guarda el hash final del registro de eventos impreso en el
-- certificado de un PDF sellado (jobs.ts finalize; la renovación de archivo copia el del PDF anterior). verify.ts lo usa
-- cuando el SHA-256 del archivo subido coincide con un archivo sellado. NULL: sellado antes de esta columna (se lee del
-- PDF una vez y se guarda); cadena vacía: se leyó y el PDF no lo trae.
ALTER TABLE files ADD COLUMN IF NOT EXISTS chain_head text;

-- Complemento de 0072 (evidencia append-only). La excepción que permite borrar los eventos de un sobre en borrador se
-- apoyaba en envelopes.status = 'draft': bastaba con devolver el sobre a borrador (un UPDATE) para poder borrar su
-- evidencia. Ningún flujo de la aplicación vuelve un sobre a 'draft' desde otro estado: este trigger lo rechaza (salvo
-- mantenimiento explícito con SET LOCAL calasign.allow_evidence_write = 'on', como en 0072).
-- Alcance (corrige lo que el comentario de 0072 dejaba implícito): los triggers frenan errores de la aplicación y a
-- quien solo tiene DML (INSERT/UPDATE/DELETE) sobre las tablas. Contra quien tiene el rol dueño de las tablas (el que
-- usa la API y corre las migraciones) no alcanzan: puede activar el SET LOCAL, deshabilitar o borrar los triggers. Para
-- eso hace falta separar roles (dueño de las tablas solo para migraciones; la API con un rol sin propiedad). Ver
-- docs/EVIDENCIA-ROLES-BD.md.
-- (El cuerpo de la función va en una sola línea: el runner, db.ts splitSql, corta en un punto y coma al final de línea.)
CREATE OR REPLACE FUNCTION calasign_envelope_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF coalesce(current_setting('calasign.allow_evidence_write', true), '') = 'on' THEN RETURN NEW; END IF; RAISE EXCEPTION 'evidence_append_only: un sobre en estado % no vuelve a borrador', OLD.status USING ERRCODE = 'insufficient_privilege'; END $$;

DROP TRIGGER IF EXISTS envelopes_no_back_to_draft ON envelopes;
CREATE TRIGGER envelopes_no_back_to_draft BEFORE UPDATE OF status ON envelopes FOR EACH ROW WHEN (NEW.status = 'draft' AND OLD.status IS DISTINCT FROM 'draft') EXECUTE FUNCTION calasign_envelope_draft_guard();
