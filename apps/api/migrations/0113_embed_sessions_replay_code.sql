-- Código de un solo uso de una URL de firma emitida por POST /v1/envelopes (creación rápida), cifrado: al repetir el
-- pedido con la misma Idempotency-Key se devuelve el mismo código mientras no se haya canjeado ni vencido, en vez de
-- emitir uno nuevo en cada repetición. Se borra al canjearlo.
ALTER TABLE embed_sessions ADD COLUMN IF NOT EXISTS replay_code_enc text;
