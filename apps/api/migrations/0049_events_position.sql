-- API de eventos: posición propia del cursor (devapi/events.ts) en lugar del id de transacción de 0048.
-- 0048 ordenaba por el id de transacción de Postgres, que no sobrevive a un dump/restore ni a un cambio de cluster por
-- replicación lógica (el contador vuelve a empezar más abajo y la entrega se cortaba). Ahora cada registro recibe una
-- posición (`pos`) cuando ya está confirmado, de un único secuenciador con lock; `pos` es un dato más de la tabla.
CREATE SEQUENCE IF NOT EXISTS envelope_events_pos_seq;
ALTER TABLE envelope_events ADD COLUMN IF NOT EXISTS pos bigint;

-- Lo ya confirmado recibe su posición acá, en el orden de 0048 (tx_id, id) para no reordenar lo que un cliente ya leyó;
-- lo que siga abierto lo toma el secuenciador después.
UPDATE envelope_events ev SET pos = n.rn
  FROM (SELECT id, row_number() OVER (ORDER BY tx_id, id) AS rn FROM envelope_events) n
 WHERE ev.id = n.id;
SELECT setval('envelope_events_pos_seq', GREATEST((SELECT max(pos) FROM envelope_events), 1));

CREATE UNIQUE INDEX IF NOT EXISTS envelope_events_pos_idx ON envelope_events (pos);
CREATE INDEX IF NOT EXISTS envelope_events_tenant_pos_idx ON envelope_events (tenant_id, pos);
CREATE INDEX IF NOT EXISTS envelope_events_pending_idx ON envelope_events (id) WHERE pos IS NULL;
DROP INDEX IF EXISTS envelope_events_tenant_tx_idx;
ALTER TABLE envelope_events DROP COLUMN IF EXISTS tx_id;
