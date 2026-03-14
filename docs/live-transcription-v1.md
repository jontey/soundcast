# Live Transcription v1 (MLX + Yjs)

This document describes the current implementation.

## Runtime

- Node coordinates room-level transcription lifecycle.
- Python sidecar (`asr-sidecar/app.py`) runs `mlx-audio` with:
  - `mlx-community/Qwen3-ASR-0.6B-8bit`
- Scope: macOS Apple Silicon only for transcription.

## Lifecycle

1. Tenant admin starts recording with:
   - `event_name` (required)
   - `enable_transcription` (default `true`)
2. Node verifies sidecar readiness.
3. Recording starts, then transcription session starts.
4. Per-producer recording segments are polled and sent to sidecar.
5. Final ASR text is:
   - stored in `transcript_segments_v2`
   - appended to Yjs channel doc
6. Stop recording stops transcription and persists doc snapshots.

## Collaborative Editing

- WebSocket route: `/ws/transcripts/:room_slug/:channel_name`
- Auth:
  - admin `apiKey`, or
  - publisher `token`
- Both admin and publishers can view/edit all room channel docs.

## Storage

Active tables:
- `transcription_sessions_v2`
- `transcription_streams_v2`
- `transcript_segments_v2`
- `transcript_docs_v2`

Legacy transcript/embedding tables remain present and unused.
