-- RD Station CRM y Kommo como proveedores de CRM (OAuth). El CHECK se redefine completo con todos los proveedores
-- (0015 hubspot/salesforce/siigo/alegra, 0046 zoho, 0047 pipedrive): así queda bien sin importar el orden en que
-- corran las migraciones de otras ramas. El nombre es el que Postgres le dio al CHECK de 0015_crm.sql.
ALTER TABLE crm_connections DROP CONSTRAINT IF EXISTS crm_connections_provider_check;
ALTER TABLE crm_connections ADD CONSTRAINT crm_connections_provider_check
  CHECK (provider IN ('hubspot','salesforce','siigo','alegra','zoho','pipedrive','rdstation','kommo'));
