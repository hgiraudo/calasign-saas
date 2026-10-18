-- La firma por videollamada se descartó del producto (2026-10-18). Se eliminan sus tablas.
-- 0014_video.sql queda en el historial porque ya se aplicó en dev; no se editan migraciones aplicadas.
DROP TABLE IF EXISTS video_recording_chunks;
DROP TABLE IF EXISTS video_recordings;
DROP TABLE IF EXISTS video_participants;
DROP TABLE IF EXISTS video_sessions;
