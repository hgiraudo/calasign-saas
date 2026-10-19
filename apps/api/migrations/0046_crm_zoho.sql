-- Conector nativo de Zoho CRM (y Bigin): nuevo proveedor en crm_connections. El centro de datos (accountsServer,
-- apiDomain) y el producto (crm | bigin) van en config.
ALTER TABLE crm_connections DROP CONSTRAINT IF EXISTS crm_connections_provider_check;
ALTER TABLE crm_connections ADD CONSTRAINT crm_connections_provider_check CHECK (provider IN ('hubspot','salesforce','zoho','siigo','alegra'));
