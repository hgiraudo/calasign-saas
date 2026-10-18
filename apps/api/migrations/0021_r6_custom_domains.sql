-- Code review ronda 6 (dominio propio): un dominio pendiente ya no bloquea a otras organizaciones.
-- Antes, quien registraba primero un dominio ajeno (sin poder verificarlo) impedía que su dueño lo usara.
-- Ahora la unicidad vale solo para los verificados: gana quien prueba el control del DNS con su TXT.
ALTER TABLE custom_domains DROP CONSTRAINT custom_domains_domain_key;
CREATE UNIQUE INDEX custom_domains_verified_domain_uq ON custom_domains (domain) WHERE status = 'verified';
CREATE INDEX custom_domains_domain_idx ON custom_domains (domain);
