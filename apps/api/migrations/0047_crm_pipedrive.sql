-- Pipedrive como proveedor de CRM (OAuth; Deal y Person).
-- El CHECK se redefine completo e incluye también 'zoho' (0046_crm_zoho.sql, de otra rama): así queda bien aplicado
-- sin importar el orden en que corran 0046 y 0047. El nombre es el que Postgres le dio al CHECK de 0015_crm.sql.
ALTER TABLE crm_connections DROP CONSTRAINT IF EXISTS crm_connections_provider_check;
ALTER TABLE crm_connections ADD CONSTRAINT crm_connections_provider_check
  CHECK (provider IN ('hubspot','salesforce','siigo','alegra','zoho','pipedrive'));
