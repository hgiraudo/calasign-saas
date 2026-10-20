-- Links de descarga del MCP (download_signed_pdf): la credencial que lo pidió. Al descargar se revalida que siga
-- vigente (API key no revocada; token OAuth de una familia sin revocar y app sin revocar): revocar el acceso del
-- agente también corta los links que ya entregó. Los links anteriores (sin credencial) vencen solos en minutos.
ALTER TABLE download_links ADD COLUMN IF NOT EXISTS api_key_id uuid;
ALTER TABLE download_links ADD COLUMN IF NOT EXISTS oauth_token_id uuid;
