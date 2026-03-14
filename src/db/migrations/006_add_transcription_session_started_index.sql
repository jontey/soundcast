-- Migration: Add transcription session started-at index for history pagination
-- Date: 2026-03-14

CREATE INDEX IF NOT EXISTS idx_transcription_sessions_v2_room_started
ON transcription_sessions_v2(room_id, started_at);
