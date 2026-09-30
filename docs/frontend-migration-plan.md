# Frontend migration plan

## Goal

Make the four browser pages easier to maintain by separating UI, state, network protocols, and media lifecycles. Keep the existing Fastify API, WebSocket messages, URLs, and mediasoup behavior while migrating the UI to Svelte components built with Vite.

The user asked for the next-step plan after baseline verification. This update records that sequence. It does not start implementation.

## What stays

- Four page entries: listener, publisher, studio, and admin.
- Fastify continues to serve page URLs and enforce route access.
- Incremental extraction: extract modules behind the current HTML pages, keep those pages working after each slice, then cut over one entry at a time.
- Shared modules with explicit inputs, outputs, and one idempotent `dispose()`.
- `/ws/admin` and the in-memory `adminClients` map remain. The user approved proven dead-code removal (D8), to be verified and performed separately from page migration.

## Architecture

Each entry owns its page-specific state and components. Shared code lives in modules. Page components must not open WebSockets or own mediasoup protocol.

| Module | Responsibility |
| --- | --- |
| `api/client` | JSON requests, cookie credentials, errors, and room/publisher/recording/transcription operations |
| `signaling/room` | Room WebSocket messages, reconnection, and configuration updates |
| `signaling/sfu` | SFU request/response correlation, transport signaling, connection state, and reconnection. Correlation must not assume request IDs. The current waiter is action-name matching without request IDs (`src/public/js/studio-media.js` `SignalingSocket.request`). Do not blindly port that FIFO. |
| `signaling/admin` | `/ws/admin` events, status, chat, and reconnection. Preserve `adminClients` on the server. |
| `media/listener` | mediasoup receive transport, multi-producer consumption, track lifecycle, and teardown |
| `media/publisher` | Two explicit profiles: token publisher (`room-publish.html`) and studio publisher (`studio-media.js` `PublisherMedia`). Capture, noise, ICE, auth, resume, switch, and fallback differ. See the spec §3. |
| `media/monitor` | Publisher/studio monitoring through a separate receive transport. Share consume implementation with `media/listener` where the difference is only wiring. |
| `media/playback` | Volume, mute, output device, meter, AudioContext, wake lock, and MediaSession. Operates on an audio element plus optional stream, not on consumers directly. |
| `transcripts/sync` | Yjs connection, document lifecycle, local edits, remote updates, and caret preservation. This module already owns the transcript WebSocket (`src/public/js/transcript-sync.js` `createBinding`). Do not add a redundant `signaling/transcripts` module. |
| `chat/client` | Chat messages, history, unread state, and bounded message lists |
| `pages/*` | Page state and UI composition |

Modules that own sockets, tracks, timers, AudioContexts, or Yjs documents must expose one idempotent `dispose()`. Distinguish **stop** (leave the media session, may keep reconnect intent) from **terminal dispose** (release every resource). Overlapping start/stop/reconnect must use cancellation generations so a stale attempt cannot recreate tracks after a newer stop.

Avoid shared mutable globals and dependencies on DOM element IDs. Use events or subscriptions to report state to page components.

## Next steps

Do not start Vite until the current pages are a working baseline and the first extractions stay on those pages.

### A. Repair the verified blockers

These are separate changes. They are not the Svelte migration.

1. Fix DEF-ADMIN-01. Remove the five standalone commas in `admin.html` fetch headers (`1597`, `1644`, `1856`, `1887`, `1969`). Re-parse the inline script. Reload `/admin` on an isolated server and confirm rooms render.
2. Fix DEF-STUDIO-01. Studio recording start must send `event_name`, matching the admin prompt and `routes/api.js`. Re-check that Start recording no longer returns 400 for a named event, and that cancelling the prompt still creates zero recordings.
3. Fix DEF-HTTPS-01 and DEF-HTTPS-02. Register the RNNoise vendor mount and the `/` redirect on the HTTPS server as well as HTTP. Prefer one shared registration function. Re-check both origins.

Do not extract admin modules before step 1. A script that does not parse is not an extraction source.

### B. Remove proven dead code

D8 is approved. Do this after step A.1 so the live admin table can be re-checked.

1. Delete the hidden `publishers-${slug}` panel and unused `showPublishers`. Keep `publishers-live-${slug}`.
2. Delete the six legacy `/ws` `admin-*` actions after a caller check. Record that unknown external clients are an assumption, not a verified absence.
3. Do not delete `/ws/admin`, `adminClients`, live `common.js` helpers, or server captive-portal routes.

D7 is resolved. The user removed Open-in-Chrome because it did not work. Delete the unreachable listener UI, helper functions, and `src/public/icons/chrome.svg` in the phase B cleanup. Do not touch server captive-portal routes.

### C. Extract behind the current pages

Keep the HTML entries. Each slice must leave the pages loading.

1. Extract `api/client`. Cover the REST surface in spec §1.5. Studio and admin are the first callers.
2. Extract `signaling/room`, `signaling/admin`, and `chat/client`. Preserve the live reconnect caps (D6). Do not add request IDs.
3. Keep transcript sockets in `transcripts/sync`. Move URL construction there. Do not add `signaling/transcripts`.
4. Extract `media/listener`, `media/publisher`, `media/monitor`, and `media/playback`. Keep the two publisher profiles (D13). Distinguish stop from terminal dispose. Add a generation counter so a stale `getUserMedia` cannot attach after stop.
5. Accept the media slice only after a live publish/listen check. Desktop page-load is not that check. Synthetic 440 Hz fallback stays a separate decision. Do not copy it into studio.

### D. Shell, then cut-over

Start this only after phase C slices stay working.

1. Add Vite and Svelte as a separate `frontend/` package (D1b). Emit to `dist/frontend/` (D2b). Import `mediasoup-client` and `yjs` from npm (D3a). Use Svelte 5 and plain JS (D4).
2. Keep four entries and the current URLs (D5). Fastify serves the built entry for each route.
3. Add a same-origin dev proxy for API, WebSocket upgrades, and `/vendor/web-noise-suppressor/`.
4. Cut over studio, then admin, then listener, then publisher.
5. Fail the Docker image build if frontend assets are missing.

### E. Release checks still outstanding

These do not block phase A. They block calling the migration done.

1. Live publish and listen, with a second client receiving audio.
2. Transcript sidecar integration, including historical `sessionId` for an admin cookie and token rejection of `sessionId`.
3. Process-restart media behavior. Cookie loss and token handshake survival are already verified. Media resume is not.
4. Docker build from a clean checkout.
5. A tracked regression suite. `test/` is gitignored today. New tests must be tracked.

## Decisions treated as accepted for this sequence

Object if any of these should change before phase C.

- D1b, D2b, D3a, D4 (Svelte 5, plain JS), D5, D6a, D13.
- D8 and G7 are approved and scheduled in phase B.
- D9 stays status-only during the migration.
- D10 uses Svelte stores. D12 shares consume mechanics and keeps monitor wiring separate.

Still open, and not blocking phase A:

- Whether the token-publisher 440 Hz fallback stays, goes, or becomes an explicit diagnostic.

## Acceptance criteria

- The four existing URLs and API/WebSocket contracts continue to work, except defects listed in the baseline defect register, which must not be ported as features.
- Every item in the per-page acceptance matrix is preserved, fixed as a named defect, or explicitly marked for removal with user sign-off.
- No component directly owns mediasoup signaling or reconnect timers.
- Every live resource has a defined owner, a stop path, a terminal dispose path, and a cancellation generation. Reconnecting does not duplicate tracks, sockets, timers, or Yjs listeners.
- Studio publisher and token publisher keep their documented profiles unless a later decision unifies them.
- Transcript access follows current server rules: cookie `canAccessRoom` is `authMode: 'admin'` for both owner and room sessions. Publisher token is `authMode: 'publisher'`. Room-session clients can open historical `sessionId` sockets the same way owner sessions can. Do not invent a third auth mode.
- Admin access remains enforced by `requireAdmin` and the API `authorizeRoomApi` hook. Empty request headers do not mean unauthenticated access: the server uses the `soundcast_session` cookie. Cookie sessions are in-memory. A server restart drops them. There is no universal auto-resume after restart.
- SFU signaling must not silently mis-associate responses. Current `/ws` frames have no request IDs.
- Production starts with built frontend assets available, including in the Docker image. The image build fails if those assets are missing.
- Gesture-sensitive media flows have device-verifiable evidence. Categorical claims about async event handlers are not acceptance.

## Evidence rule

Source citations describe the tree. Spec §12 distinguishes executed parser/API/desktop-browser checks from outstanding physical-device and live-media verification. No application fixes or migration implementation ran during baseline verification.
