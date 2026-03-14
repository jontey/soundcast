# Soundcast Ground-Up Rebuild Architecture (Post-Transcription Reset)

## Summary

This document defines the target architecture for a future transcription subsystem after the full Whisper/Qwen teardown. It is implementation-ready as a planning artifact only; no runtime transcription code is currently active.

## Goals

- Reintroduce real-time transcription as an optional, isolated subsystem.
- Preserve stable core audio broadcasting and recording behavior if transcription is unavailable.
- Keep tenant boundaries explicit in storage, API, and event delivery.
- Support provider pluggability (local or remote ASR) without changing core SFU flows.

## Non-Goals

- Implementing provider-specific runtime code in this phase.
- Migrating or deleting dormant legacy transcript tables in this phase.
- Coupling core signaling/transport correctness to transcription availability.

## Failure Model

- Transcription failures are non-fatal to publish/listen/record paths.
- Per-session retries must be bounded and observable.
- Provider timeout/error events are surfaced to admin as degraded status, not transport errors.
- Backpressure in transcription queues must drop/defer transcription work, never stall RTP/audio forwarding.

## Scaling Model

- Unit of work: `(tenant_id, room_id, producer_id, channel_name)` session.
- Stateless coordinator in API server controls session lifecycle.
- Worker pool model for ASR execution:
  - Local mode: bounded process pool per node.
  - Remote mode: bounded async queue + circuit breaker.
- Horizontal scaling strategy:
  - sticky session routing for live session ownership, or
  - shared session registry with lease/heartbeat.

## Provider Boundary

Define a provider contract independent of transport details:

```ts
interface AsrProvider {
  startSession(input: SessionStart): Promise<ProviderSession>;
  ingestAudio(sessionId: string, chunk: AudioChunk): Promise<void>;
  stopSession(sessionId: string): Promise<void>;
  health(): Promise<ProviderHealth>;
}
```

- `AudioChunk` is normalized PCM with timestamp metadata.
- Provider output normalizes to text segments + confidence + language + timing.
- Provider implementations must not write DB directly.

## Data & Retention Model

- Keep existing dormant tables (`transcripts`, `embedding_metadata`, `transcript_embeddings`) inert until migration phase.
- New write path should target versioned tables (`transcripts_v2`, optional search index tables) to avoid mixed semantics.
- Retention policy must be tenant-configurable:
  - raw segments retention window
  - optional post-processed summary retention
  - hard delete workflow for compliance

## API and Event Contracts (Proposed)

### REST (versioned)

- `POST /api/v2/rooms/:slug/transcription/sessions`
- `DELETE /api/v2/rooms/:slug/transcription/sessions/:id`
- `GET /api/v2/rooms/:slug/transcription/sessions`
- `GET /api/v2/rooms/:slug/transcription/segments`

### WebSocket admin events

- `transcription.session.started`
- `transcription.session.stopped`
- `transcription.session.degraded`
- `transcription.segment.created`

### Publisher/listener events

- Optional and room-configurable; default off.
- If enabled, listener-facing event payload is sanitized and bounded in size.

## Migration Strategy (From Dormant Legacy Tables)

1. Keep current legacy schema untouched and inactive.
2. Introduce v2 schema via additive migration.
3. Dual-read tooling for offline verification only.
4. Optional one-time backfill job from legacy tables to v2.
5. Cutover by API version switch; legacy endpoints remain absent.

## Rollout Plan

1. `Phase A`: internal feature flag + health endpoints + no UI exposure.
2. `Phase B`: tenant-admin controlled pilot with explicit opt-in.
3. `Phase C`: general availability with retention and observability guardrails.
4. `Phase D`: evaluate legacy table archival/deletion.

## Observability

- Metrics: session count, queue depth, chunk latency, provider errors, segment throughput.
- Logs: structured by `tenant_id`, `room_id`, `session_id`, `provider`.
- Alerts: sustained provider error rate, queue saturation, session start failures.

## Security & Multi-Tenant Isolation

- Tenant auth required for all control and query endpoints.
- Session and segment queries scoped by tenant/room.
- Provider credentials/config stored per environment; never exposed to frontend.
- Audit log entries for session start/stop and retention actions.
