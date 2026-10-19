-- Avisos a canales: además de Slack y Teams, Discord, Google Chat, Mattermost, Rocket.Chat y Webex (todos por webhook
-- entrante; ver modules/notify-integrations.ts). La lista tiene que coincidir con NOTIFICATION_KINDS de @calasign/shared.
ALTER TABLE notification_integrations DROP CONSTRAINT IF EXISTS notification_integrations_kind_check;
ALTER TABLE notification_integrations ADD CONSTRAINT notification_integrations_kind_check
  CHECK (kind IN ('slack','teams','discord','google_chat','mattermost','rocketchat','webex'));
