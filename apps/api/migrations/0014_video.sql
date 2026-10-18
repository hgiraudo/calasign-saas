-- Video (Fase 6): sala de firma por videollamada. WebRTC en malla (hasta 4 participantes), señalización por
-- WebSocket en la API, co-navegación, consentimiento de grabación, grabación cifrada en fragmentos y
-- confirmación de identidad en cámara. La evidencia (eventos encadenados) vive en envelope_events.

CREATE TABLE video_sessions (
  id                          uuid PRIMARY KEY,
  tenant_id                   uuid NOT NULL REFERENCES tenants(id),
  envelope_id                 uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  host_user_id                uuid NOT NULL REFERENCES users(id),
  status                      text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','ended')),
  scheduled_at                timestamptz,
  started_at                  timestamptz,
  ended_at                    timestamptz,
  invited_recipient_ids       uuid[] NOT NULL DEFAULT '{}',
  require_identity            boolean NOT NULL DEFAULT false,
  recording_enabled           boolean NOT NULL DEFAULT true,
  message                     text,
  created_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX video_sessions_envelope_idx ON video_sessions (envelope_id, created_at DESC);
-- Una sola sala abierta (programada o activa) por sobre.
CREATE UNIQUE INDEX video_sessions_one_open_idx ON video_sessions (envelope_id) WHERE status IN ('scheduled','active');

CREATE TABLE video_participants (
  id                          uuid PRIMARY KEY,
  session_id                  uuid NOT NULL REFERENCES video_sessions(id) ON DELETE CASCADE,
  kind                        text NOT NULL CHECK (kind IN ('host','recipient')),
  recipient_id                uuid REFERENCES recipients(id) ON DELETE CASCADE,
  user_id                     uuid REFERENCES users(id),
  display_name                text NOT NULL,
  joined_at                   timestamptz,
  left_at                     timestamptz,
  consented_at                timestamptz,
  identity_confirmed_at       timestamptz,
  identity_note               text,
  ip                          text,
  user_agent                  text,
  UNIQUE (session_id, recipient_id),
  UNIQUE (session_id, user_id)
);

CREATE TABLE video_recordings (
  id                          uuid PRIMARY KEY,
  session_id                  uuid NOT NULL REFERENCES video_sessions(id) ON DELETE CASCADE,
  tenant_id                   uuid NOT NULL REFERENCES tenants(id),
  envelope_id                 uuid NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  status                      text NOT NULL DEFAULT 'recording' CHECK (status IN ('recording','stored','failed','purged')),
  mime_type                   text NOT NULL DEFAULT 'video/webm',
  storage_prefix              text NOT NULL,
  chunks                      integer NOT NULL DEFAULT 0,
  bytes                       bigint NOT NULL DEFAULT 0,
  sha256                      text,
  started_at                  timestamptz NOT NULL DEFAULT now(),
  finished_at                 timestamptz,
  purged_at                   timestamptz
);
CREATE INDEX video_recordings_session_idx ON video_recordings (session_id);
CREATE INDEX video_recordings_envelope_idx ON video_recordings (envelope_id);

-- Cada fragmento se guarda cifrado (AES-256-GCM) en el almacén de archivos; acá queda su hash en claro.
CREATE TABLE video_recording_chunks (
  recording_id                uuid NOT NULL REFERENCES video_recordings(id) ON DELETE CASCADE,
  seq                         integer NOT NULL,
  bytes                       integer NOT NULL,
  sha256                      text NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (recording_id, seq)
);
