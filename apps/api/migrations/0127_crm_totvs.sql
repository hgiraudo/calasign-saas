-- TOTVS Protheus como proveedor de ERP (conexión por usuario y contraseña del REST de la organización). El CHECK se
-- redefine completo con todos los proveedores, como en 0051: así queda bien sin importar el orden en que corran las
-- migraciones de otras ramas. Aditiva: el código anterior nunca escribe 'totvs'.
ALTER TABLE crm_connections DROP CONSTRAINT IF EXISTS crm_connections_provider_check;
ALTER TABLE crm_connections ADD CONSTRAINT crm_connections_provider_check
  CHECK (provider IN ('hubspot','salesforce','siigo','alegra','zoho','pipedrive','rdstation','kommo','totvs'));
