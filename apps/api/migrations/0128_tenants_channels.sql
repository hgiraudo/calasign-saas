-- Canales de terceros por organización (SEG-30, docs/PROVEEDORES.md §5): SMS (Twilio), WhatsApp (Meta Cloud API) y
-- Telegram los habilita la plataforma por variables de entorno y antes se elegían solo destinatario por destinatario.
-- Con estas columnas una organización los apaga para toda la cuenta (Ajustes → Organización, PATCH
-- /v1/settings/organization): no se pueden elegir como canal de aviso ni como método del código de verificación, y si se
-- apagan después de crear un sobre, no se usan al enviar. Encendidos por defecto: para las existentes no cambia nada.
-- Columnas con DEFAULT constante: no reescriben la tabla.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS channel_sms_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS channel_whatsapp_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS channel_telegram_enabled boolean NOT NULL DEFAULT true;
