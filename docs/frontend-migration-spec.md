# Frontend Migration Technical Specification

**Status:** Draft after critique. Isolated API and desktop-browser baseline verification completed on 2026-09-29. Physical-device and live-media verification remain outstanding. Application source is unchanged.
**Source plan:** `docs/frontend-migration-plan.md`
**Scope:** Migrate the four browser pages (listener, publisher, studio, admin) from monolithic HTML files with inline scripts to Svelte components built with Vite. Preserve the existing Fastify API, WebSocket contracts, URLs, and mediasoup behavior, except defects listed in §2, which must not be ported as features.

This document is the technical companion to the migration plan. It records current source behavior, the baseline defect register, per-page acceptance, shared media/signaling mechanics, build and verification gates, and remaining user decisions.

**Evidence rule:** Source citations describe this tree. Section 12 records executed baseline checks and supersedes the earlier documentation-pass evidence labels. Passing a defect-reproduction assertion does not mean the feature works.

---

## 1. Current-state baseline (verified against source)

### 1.1 Server architecture

| Concern | Location | Notes |
| --- | --- | --- |
| HTTP server | `src/server.js` | Always starts. Registers static files, RNNoise vendor mount, captive portal, auth, API, page routes, root redirect, and WebSockets. |
| HTTPS server | `src/server.js` `createHttpsServer()` | Starts only when `./certs/server.key` and `server.crt` exist. Re-registers captive portal, public static, websocket, auth, API, page routes, and WS routes **by hand**. It does **not** register the RNNoise vendor mount. It does **not** register `GET /`. |
| Static file serving | `@fastify/static` rooted at `src/public` via `getPublicDir()` | `reply.sendFile()` serves page HTML. |
| RNNoise vendor assets | Second `@fastify/static` on the HTTP instance only: prefix `/vendor/web-noise-suppressor/`, root `node_modules/@sapphi-red/web-noise-suppressor/dist` (`src/server.js:220-229`) | HTTPS lacks this mount (`createHttpsServer()` at `src/server.js:2054-2120`). Token-publisher RNNoise on HTTPS is therefore not at HTTP parity. This is a baseline defect (DEF-HTTPS-01), not an intended feature. |
| Pre-built vendor bundles | `src/public/js/bundles/mediasoup-client.js` and `yjs.js`, produced by `npm run bundle` | Checked into the repo. |
| Captive portal routes | `registerCaptivePortalRoutes()` | Present on HTTP and HTTPS. Keep these server routes. They are not the commented-out Open-in-Chrome UI. |
| Cookie sessions | `src/auth.js` `sessions` Map | In-memory. `soundcast_session` HttpOnly cookie. Server restart drops every session. |

### 1.2 Page routes

| URL | File served | Access control | HTTP | HTTPS |
| --- | --- | --- | --- | --- |
| `/` | HTTP explicitly redirects to `/room/main/listen`, or serves `index.html` if room `main` is missing (`src/server.js:276-282`) | none | explicit route | Static index responds 200 without redirect (DEF-HTTPS-02). The explicit route is missing, not the HTTP response. |
| `/room/:slug/listen` | `index.html` | room existence, else 404 | yes | yes |
| `/room/:slug/publish` | `room-publish.html` | none at HTTP level; publisher auth is WS token/`publisherId` | yes | yes |
| `/studio` | `studio.html` | none at HTTP level; login is in-page via `/api/auth/login` | yes | yes |
| `/admin`, `/admin.html` | `admin.html` | `preHandler: requireAdmin` | yes | yes |

### 1.3 WebSocket endpoints and message contracts

The server exposes five WS endpoints. `transcripts/sync` already owns the transcript socket. Do not add `signaling/transcripts`.

| Endpoint | Registered in | Purpose | Client frame shape | Server frame shape |
| --- | --- | --- | --- | --- |
| `/ws` | `server.js` `registerMainWsRoutes` | SFU signaling (publish/listen/monitor transports, produce/consume) **plus legacy admin actions** | `{ action, data }` | `{ action, data }` |
| `/ws/room/:slug/listen` | `server.js` `registerRoomWsRoutes` | Room config for listeners | `{ type: 'get-config' }`, `{ type: 'webrtc_signal', data }` | `{ type: 'config', data: { iceServers, channels, roomSlug } }`, `{ type: 'error', data }` |
| `/ws/room/:slug/publish?token=…&publisherId=…` | `server.js` `registerRoomWsRoutes` | Room config, recording status, publisher chat for one publisher | `{ type: 'get-config' }`, `{ type: 'publisher-chat-history-request' }`, `{ type: 'publisher-chat-send', data: { text } }` | `{ type: 'config', data: { iceServers, channels, channelName, publisherId, isRecording, transcriptionActive, … } }`, `{ type: 'recording-status', … }`, `{ type: 'publisher-chat-history', data }`, `{ type: 'publisher-chat-message', data }` |
| `/ws/admin` | `server.js` `registerAdminWsRoutes` | Live channel/recording stats, admin↔publisher chat | `{ type: 'refresh' }`, `{ type: 'admin-chat-send', data }`, `{ type: 'admin-chat-history-request', data }` | `{ type: 'channel-stats', stats }`, `{ type: 'channel-update', … }`, `{ type: 'recording-stats', stats }`, `{ type: 'recording-status', … }`, `{ type: 'publisher-chat-message', data }`, `{ type: 'publisher-chat-history', data }` |
| `/ws/transcripts/:room_slug/:channel_name[?sessionId=…][&token=…]` | `src/transcription/runtime.js` `registerWsRoute` | Yjs binary sync + JSON error/pong | binary Yjs updates; `{ type: 'ping' }` | binary Yjs update (full state on open); `{ type: 'error', message }`, `{ type: 'pong' }` |

**Preserve `/ws/admin` and `adminClients`.** Studio and admin both connect to `/ws/admin` (`studio.html:235`, `admin.html:931`). `adminClients` is the live fan-out map (`src/server.js:343`, set at `1917`, deleted at `2024`). Decision D8 may later remove unused **legacy `/ws` `admin-*` actions**. D8 does not authorize removal of `/ws/admin`.

**SFU `/ws` action inventory (preserve byte-for-byte unless D8 later removes the legacy admin actions):**

- Requests: `get-rtpCapabilities`, `get-channels`, `create-publisher-transport`, `connect-publisher-transport`, `produce-audio`, `stop-broadcasting`, `create-listener-transport`, `connect-listener-transport`, `consume-audio`, `leave-channel`.
- Server pushes: `rtpCapabilities`, `channel-list`, `publisher-transport-created`, `publisher-transport-connected`, `produced`, `broadcasting-stopped`, `listener-transport-created`, `listener-transport-connected`, `consumer-created`, `waiting-for-publisher`, `producer-stopped`, `left-channel`, `forced-disconnect`, `listener-count`, `admin-channel-changed`, `error`.
- Legacy admin actions on the same socket: `admin-create-channel`, `admin-delete-channel`, `admin-get-channels-subscribers`, `admin-remove-subscriber`, `admin-get-publishers`, `admin-change-publisher-channel`. Current pages do not send these. Removal is a server contract change and waits for D8.

**SFU serialization:** frames have `{ action, data }` and **no request IDs**. `SignalingSocket.request` in `studio-media.js:51-62` pushes a waiter and matches the next message whose `action` is in `waiter.responses` (`studio-media.js:25-30`). Concurrent requests can steal responses. Do not blindly port that waiter as a safe FIFO. Listener and token-publisher pages do not use waiters. They switch on `action` in `handleSfuMessage`. Any extracted `signaling/sfu` must document this absence of request IDs and must not invent IDs without a server contract change.

### 1.4 REST API surface (unchanged by UI migration)

From `src/routes/api.js`, guarded by `authorizeRoomApi` except `/api/config`:

- Auth: `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout` (`src/auth.js`)
- Rooms: `POST /api/rooms`, `GET /api/rooms`, `GET /api/rooms/:slug`, `PUT /api/rooms/:slug`, `DELETE /api/rooms/:slug`, `PUT /api/rooms/:slug/access`, `GET/PUT /api/rooms/:slug/languages`
- Publishers: `POST/GET /api/rooms/:slug/publishers`, `PUT/DELETE /api/rooms/:slug/publishers/:id`
- Recordings: `POST .../recordings/start` (requires `event_name`, `src/routes/api.js:411-435`), `POST .../recordings/stop`, `GET .../recordings/status`, `GET .../recordings`
- Transcriptions: `GET .../transcriptions/current|sessions|sessions/:id|sessions/:id/channels/:name|channels/:name`, `POST .../sessions/:id/stop`, `POST .../channels/:name/restart`

Studio `api()` (`studio.html:143-147`) uses same-origin fetch credentials. Keep the development proxy same-origin from the browser's perspective. Explicit cross-origin credentials would also require compatible CORS and cookie policy and are not a substitute for correct proxy configuration.

### 1.5 Frontend asset build today

- `npm run bundle` (esbuild) regenerates vendor bundles into `src/public/js/bundles/`.
- No bundler for page code. Inline scripts. Global functions via `onclick=`.
- `package.json` scripts `test:db` and `test:transcription` point at `test/...` files. `test/` is gitignored (`.gitignore:21`). Those scripts have no committed targets on this branch.
- `test-api.sh` exists at repo root. It is unauthenticated `curl` against `http://localhost:3000/api`. It prints JSON with `jq`. It has no assertions and mutates whatever server it hits. It is not a baseline suite.
- Playwright is a devDependency. No Playwright specs are committed.
- Dockerfile copies `src/` and `scripts/`, runs `npm ci --only=production`, and does not run a frontend build.

### 1.6 Transcript authentication (source of truth)

`TranscriptionRuntime.authenticateTranscriptSocket` (`src/transcription/runtime.js:1495-1513`):

1. If `canAccessRoom(currentSession(request), roomSlug)` is true, the socket is `authMode: 'admin'`.
2. Else if `token` verifies as a publisher for that room, the socket is `authMode: 'publisher'`.
3. Else the socket is rejected.

`canAccessRoom` (`src/auth.js:58-60`) is true for owner sessions **and** for room-PIN sessions whose `roomSlug` matches. Therefore a studio room-session cookie is `authMode: 'admin'` for transcript purposes. Historical `sessionId` query params are allowed when `authMode === 'admin'` (`runtime.js:1571`). Publishers cannot pass `sessionId` (`runtime.js:1564-1567`).

Do not document room-session transcript access as a third mode. Do not claim only owner cookies can open historical sessions.

---

## 2. Baseline defect register

These are current behaviors. They are not intended features. Migration must not preserve them as acceptance. Fix, quarantine, or get an explicit user exception before cut-over.

| ID | Defect | Evidence | Intended behavior for migration |
| --- | --- | --- | --- |
| DEF-ADMIN-01 | Admin inline script contains five invalid standalone commas in `headers` objects. | `src/public/admin.html` lines **1597, 1644, 1856, 1887, 1969**. Critique reports `vm.Script` parse failure on the inline script (`admin.html:778-2472`). **This documentation update did not re-run `vm.Script`.** | Do not port the commas. Extracted `api/client` must send valid JSON headers. Cookie auth remains. |
| DEF-STUDIO-01 | **Fixed.** Studio recording start omitted required `event_name`. | Handler now prompts for event_name like admin. Start with a named event returns 200. Cancel creates no request. Full audio capture not run (no live publisher). |
| DEF-HTTPS-01 | **Fixed.** RNNoise static mount now shared via `registerSharedHttpSurface()`. | `GET /vendor/web-noise-suppressor/rnnoise.wasm` returns 200 on both HTTP and HTTPS. |
| DEF-HTTPS-02 | **Fixed.** `GET /` root redirect now shared via `registerSharedHttpSurface()`. | Both origins return 302 to `/room/main/listen`. |
| DEF-TEST-01 | No committed automated frontend/API assertions. | `test-api.sh` exists, unauthenticated, no assertions. `test/` gitignored. Playwright unused. | Baseline verification uses a new isolated harness. Do not call `test-api.sh` a passing suite. |

G7 (admin publisher panel) is **resolved**, not a defect to port:

- Hidden unused panel: `div#publishers-${slug}` at `admin.html:1334-1335` (`style="display: none;"`).
- Unused loader: `showPublishers` at `admin.html:1665`. No call sites.
- Live UI: `div#publishers-live-${slug}` at `admin.html:1304`, filled by `loadPublishersAndLiveStatus` (`admin.html:1348`).

The user approved removal of proven dead code. The hidden panel and `showPublishers` qualify as client cleanup candidates. Delete them separately after verification, without deleting the live table.

---

## 3. Shared mechanics

### 3.1 Publisher profiles (do not collapse)

| Mechanic | Token publisher (`room-publish.html`) | Studio publisher (`studio-media.js` `PublisherMedia`) |
| --- | --- | --- |
| Capture | `getUserMedia` with selected device constraints and 5s timeout (`room-publish.html:1461-1470`) | `getUserMedia` with echoCancellation/noiseSuppression/autoGainControl and optional `deviceId` (`studio-media.js:91-93`) |
| Noise | RNNoise AudioWorklet + WASM from `/vendor/web-noise-suppressor/`; fallback to browser `noiseSuppression` (`room-publish.html` RNNoise helpers) | Browser constraints only. No RNNoise. |
| ICE | `getIceServersFromConfig(roomConfig)` on send and monitor transports | Hardcoded Google STUN in `studio-media.js:3-6`. Ignores room config ICE. |
| Auth | Publish WS `?token=` or `?publisherId=` (`room-publish.html:1003-1004`). Transcript WS token query (`room-publish.html:764`). | REST cookie session creates/updates publisher, then SFU `create-publisher-transport` with `publisherId` (`studio-media.js:114-117`). No publish-room WS. |
| Resume | Auto-resume after SFU reconnect when `wasBroadcasting && lastAudioDeviceId` (`room-publish.html:1204-1213`) | No auto-resume. Disconnect tells the user to press Start (`studio-media.js:103-107`). |
| Switch | Mid-broadcast `restartMicrophoneCapture` with 100ms OS-release delay and a new producer | Device change invokes full `startBroadcast()` while active (`studio.html:326`). |
| Fallback | 440 Hz synthetic oscillator if mic fails (`room-publish.html:1471-1483`) | None. Failure calls `stop()` and surfaces `error.message`. |

Decision D13: preserve this split during UI migration. Unification is follow-up.

### 3.2 Listener versus monitor

Listener and monitors share transport actions but differ in track accumulation, producer de-duplication, producer removal, socket shutdown, and recovery. Publisher monitor replaces its stream on each consumer-created message and leaves its socket open on stop. These are baseline defect candidates, not policies to impose on the listener. Share consume mechanics with explicit policies. Listener mute must still coordinate consumer pause with playback gain through the controller.

### 3.3 Stop versus terminal dispose

| Operation | Meaning | Example today |
| --- | --- | --- |
| Stop | Leave the media session. May keep reconnect intent (`wasBroadcasting`). | `stopBroadcast(false)` on token publisher (`room-publish.html:1559-1566`). `PublisherMedia.stop()` sends `stop-broadcasting` then `releaseLocal` then closes the socket (`studio-media.js:185-194`). |
| Terminal dispose | Release sockets, tracks, timers, AudioContext, Yjs binding. Clear reconnect intent. Safe to call twice. | Listener `beforeunload` cleanup. `SoundcastTranscript.createBinding().destroy()` (`transcript-sync.js:127-134`). |

Reconnect that re-runs `start()` must cancel the previous generation first. `PublisherMedia.start()` already calls `await this.stop()` (`studio-media.js:86`). Extracted modules must keep a generation counter so an older `getUserMedia` or waiter cannot complete after a newer stop.

### 3.4 Recovery matrix (no universal auto-resume)

| Event | Cookie session | Token publisher media | Studio media | Admin/studio `/ws/admin` | Transcript Yjs |
| --- | --- | --- | --- | --- | --- |
| Tab reload | Cookie still valid until 12h expiry if process kept the Map | User must start again unless page logic restores `wasBroadcasting` (token publisher only, and only after SFU reconnect in the same page lifetime) | User must press Start | Client reconnects in 3s (`admin.html:1002-1005`, `studio.html:252`) | Status-only on close today (`transcript-sync.js:120-122`). No client reconnect. Keep that in migration (D9). |
| Server process restart | All in-memory sessions lost (`src/auth.js:4`). Authenticated operations require a new login. | Token remains valid if its publisher remains in the database. Existing retry may resume capture. Verify it. Session-backed identity needs reauthentication. | Media stops. A new login is required for authenticated operations. Current UI does not necessarily display a login wall automatically. | Reconnect fails until a new login. | Cookie-auth sockets require re-login. Token-auth sockets can reopen, but current bindings do not reconnect automatically. |
| SFU `/ws` drop | Unchanged | Token publisher: exponential reconnect, then auto-resume broadcast if `wasBroadcasting` | Studio: status "Press Start broadcast to reconnect." | N/A (different socket) | N/A |
| Room WS drop | Unchanged | Token publisher / listener: exponential reconnect, 50 attempts, 1s base, 1.5×, 30s cap | Studio does not use room WS | N/A | N/A |

Acceptance must name the cell under test. "Reconnect restores the session" is not a criterion.

### 3.5 Gesture-sensitive requirements (device-verifiable)

Do not use a categorical rule that "async handlers break autoplay." Use these checks. Each needs a real device unless marked otherwise.

| ID | Flow | Required construction on the originating gesture | Device evidence |
| --- | --- | --- | --- |
| GS-L1 | Listener start | `startListening()` constructs `AudioContext` before `connectToSfu()` (`index.html:1299-1304`). Migrated code must construct or resume `AudioContext` on that click, not after an unrelated `await`. | iOS Safari: first Start produces audible playback without a second tap. **Unverified in this update.** |
| GS-P1 | Token-publisher start | `getUserMedia` starts from the Start click (`room-publish.html:1444-1463`). Permission prompt must appear from that gesture. | Android Chrome: mic prompt appears on Start. **Unverified in this update.** |
| GS-S1 | Studio start | `publisherMedia.start()` is called from the Start click (`studio.html:319` → `296-313`). `getUserMedia` and `new AudioContext()` run inside `start()` after `await this.stop()`. If `stop()` awaits network, the mic prompt may lose the gesture. That risk is real and must be measured, not assumed. | Same Android Chrome / iOS Safari pass as GS-P1, on `/studio`. **Unverified in this update.** |
| GS-M1 | MediaSession mute | Listener mute via MediaSession handler still pauses consumer + gain. | Device MediaSession controls. **Unverified in this update.** |
| GS-W1 | Wake lock | Listener wake lock acquired on start and refreshed on the 20s keep-alive while visible (`index.html:661-676`). | Screen-off does not immediately drop playback policy. **Unverified in this update.** |

Desktop Playwright can drive clicks. It does not close GS-L1, GS-P1, GS-S1, GS-M1, or GS-W1.

---

## 4. Per-page acceptance matrix

Every row is either **preserve**, **fix defect**, or **remove with sign-off**. Features listed here are the intended contract. Defects from §2 are not rows to preserve.

### 4.1 Listener (`index.html`)

| Item | Rule |
| --- | --- |
| URL `/room/:slug/listen` and `/` on HTTP | Preserve. HTTPS `/` is DEF-HTTPS-02. |
| Room config via `/ws/room/:slug/listen` | Preserve. |
| Channel selector, `?channel=` deep link, single-channel auto-select | Preserve. |
| Dual reconnect (room + SFU): 50 attempts, 1s base, 1.5×, 30s cap | Preserve (D6). |
| Recv transport, multi-producer consume, `producer-stopped` | Preserve. |
| Volume, `setSinkId`, ScriptProcessor meter, mute (pause + gain + MediaSession) | Preserve. |
| Wake lock, 20s keep-alive, visibility resume, devicechange, `beforeunload` | Preserve. |
| `?debug` SFU config | Preserve. |
| Open-in-Chrome button (HTML-commented) and live helper functions | Remove after D7. Do not touch server captive routes. |
| Listener recovery after server restart | Verify existing retry and playback behavior. Do not impose manual restart as a new policy without approval. Listener access does not require a cookie. |

### 4.2 Token publisher (`room-publish.html`)

| Item | Rule |
| --- | --- |
| `?token=` / `?publisherId=` credentials | Preserve. |
| Dual reconnect loops (same caps as listener) | Preserve (D6). |
| RNNoise toggle and browser-suppression fallback | Preserve. HTTPS vendor mount is DEF-HTTPS-01. |
| Mic switch mid-broadcast | Preserve. |
| Synthetic 440 Hz fallback | Existing behavior, not automatically accepted. Decide separately whether to preserve, remove, or restrict to explicit diagnostics. Never silently add it to studio. |
| Auto-resume after **SFU reconnect in the same page lifetime** | Preserve for this profile only. |
| Auto-resume after **server restart** | Token authentication can survive a restart. Verify the existing recovery path rather than imposing manual restart. Session-backed publisher identity requires reauthentication. |
| Recording-status indicator, listener count | Preserve. |
| Monitor on a second `/ws` socket | Preserve. |
| Transcript tabs via `transcripts/sync` with publisher token, active session only | Preserve. |
| Floating admin chat | Preserve. |

### 4.3 Studio (`studio.html` + `studio-media.js`)

| Item | Rule |
| --- | --- |
| In-page login (room PIN or owner password), cookie session | Preserve. |
| Room/language/publisher REST CRUD within `authorizeRoomApi` | Preserve. Owner-only PIN and extra-room tools stay hidden for room sessions (`studio.html:162-166`). |
| `/ws/admin` live stats and chat | Preserve. |
| Mic + monitor via `PublisherMedia` / `ListenerMedia` | Preserve studio profile (no RNNoise, no synthetic fallback, no auto-resume). |
| Recording start/stop | **Fix DEF-STUDIO-01** for start. Stop body `{}` may remain if the API allows it. |
| Transcript UI | Studio has no transcript editor today. Do not invent one. |
| Server restart | Requires reauthentication and explicit media restart. Verify how the current UI surfaces session loss before specifying a new login-wall behavior. |

### 4.4 Admin (`admin.html`)

| Item | Rule |
| --- | --- |
| `/admin` + `requireAdmin` | Preserve. |
| Room cards, add/edit/delete, live `publishers-live-${slug}` table | Preserve. |
| Hidden `publishers-${slug}` + unused `showPublishers` | **Removed.** `admin.html` hidden panel and dead `showPublishers` deleted. Live `publishers-live-${slug}` table intact. Parse OK. Isolated `/admin` 200, live table renders. |
| Recording controls with `event_name` prompt | Preserve the prompt. Do not port DEF-ADMIN-01 commas. |
| Per-room transcript panels: session pagination, follow-active, channel tabs, restart, Yjs via `transcripts/sync` | Preserve. URL construction may pass `sessionId` because admin cookie is `authMode: 'admin'`. |
| Floating chat windows per publisher | Preserve. |
| `/ws/admin` 3s reconnect | Preserve delay (D6). After server restart, reconnect without a session must fail until re-login. |
| Inline script parse | **Fix DEF-ADMIN-01** before treating admin JS as executable baseline. Critique-reported `vm.Script` failure. |

---

## 5. Target architecture

Keep four entries (D5). Fastify still owns URLs.

| Module | Responsibility | Source of truth today |
| --- | --- | --- |
| `api/client` | JSON fetch, cookie credentials, error normalization, all REST in §1.4 | Studio `api()`; admin `fetch` |
| `signaling/room` | Room WS, `get-config`, reconnect | `connectToRoom` in listener and token publisher |
| `signaling/sfu` | `/ws` connect, **non-ID** correlation, transport signaling, reconnect | Duplicated switch statements; studio `SignalingSocket` is not a safe port |
| `signaling/admin` | `/ws/admin` events, stats/chat, reconnect | admin.html, studio.html |
| `transcripts/sync` | Yjs socket **and** document binding | `src/public/js/transcript-sync.js` already opens the WebSocket. Pages only build the URL. |
| `chat/client` | Messages, history, unread, bounds | floating-chat-widget.js plus page glue |
| `media/listener` | Recv transport and consume | index.html; share with monitor |
| `media/publisher` | Two profiles from §3.1 | room-publish.html vs studio-media.js |
| `media/monitor` | Separate recv transport wiring | publisher second socket; studio `ListenerMedia` |
| `media/playback` | Audio element extras | listener page |
| `pages/*` | UI composition | four entries |

**G3 is false.** The earlier proposal for `signaling/transcripts` is redundant. Do not add it.

### 5.1 Disposal matrix

| Resource | Owner | Stop | Terminal dispose |
| --- | --- | --- | --- |
| Room WS | `signaling/room` | close + optional reconnect timer | clear timer, close socket, generation++ |
| SFU WS | `signaling/sfu` | close; reject or drop waiters | same + no stolen waiter completions |
| Admin WS | `signaling/admin` | close + 3s reconnect if session still valid | clear timer, close |
| Transcript WS + Y.Doc | `transcripts/sync` | close socket (status disconnected) | destroy doc, remove textarea listeners |
| Send/Recv transport | `media/*` | `stop-broadcasting` / `leave-channel` then close transport | close transport, null refs |
| MediaStream tracks | `media/*` | stop tracks | stop tracks, null stream |
| AudioContext + meters | `media/*` + playback | close context | close context, clear intervals |
| Wake lock | `media/playback` | release | release |
| MediaSession | `media/playback` | null handlers | null handlers and metadata |

`dispose()` must be idempotent. Call it twice in checks.

### 5.2 Build, proxy, HTTPS asset map, coexistence, deterministic gates

| Gate | Requirement |
| --- | --- |
| Four entries | Vite emits listener, publisher, studio, admin. No client router (D5). |
| Dev coexistence | Vite dev server proxies API, WS upgrades, and `/vendor/web-noise-suppressor/` to Fastify. Pages load through one origin so cookies and WS stay first-party. Exact proxy config is chosen with D1/D2. |
| HTTP vs HTTPS asset map | Shared registration function must mount: public dir, RNNoise vendor (if package present), captive probes, page routes including `/`, auth, API, all five WS endpoints. `createHttpsServer()` must not drift again. |
| Deterministic vendor JS | Import `mediasoup-client` and `yjs` from npm in Vite (D3 recommendation). Drop committed bundles when cut-over completes. |
| Production / Docker | Frontend build runs in the image. Missing assets fail the image build. `npm ci --only=production` for the Node server must not require Vite at runtime if the build stage already emitted files. Air-gapped `docker save`/`load` in `docs/air-gapped-deployment.md` must keep working. |
| Fastify static root | Built HTML replaces `reply.sendFile('*.html')` without changing public URLs. |

---

## 6. Decisions the user must make

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| D1 | Frontend project location | (a) Vite at repo root with `frontend/` and npm workspaces; (b) separate `frontend/` package; (c) single package.json + Svelte/Vite as devDependencies | (b). Keeps backend production install free of Vite. |
| D2 | Static asset serving layout | (a) emit into `src/public/`; (b) emit into `dist/frontend/` and prefer it; (c) multi-root | (b). Missing assets become detectable. |
| D3 | mediasoup-client and yjs bundling | (a) Vite npm imports; (b) keep esbuild bundles | (a). |
| D4 | Svelte version and language | Svelte 5 vs 4; JS vs TS | Svelte 5 + plain JS. |
| D5 | Server page routes after migration | Four entries vs one SPA | **Four entries.** |
| D6 | Reconnect policy unification | (a) preserve per-page caps; (b) unify | (a) during migration. |
| D7 | Open-in-Chrome / captive-browser UI in listener | **Resolved.** User removed it because it did not work. | Delete unreachable UI, helpers, and `chrome.svg` in phase B. Keep server captive probes. |
| D8 | Proven dead-code removal | **Approved by user.** Verify callers and dependencies before removal. | Separate cleanup change. Preserve `/ws/admin` and `adminClients`. Record the external-client assumption for legacy `/ws` actions. |
| D9 | Transcript socket reconnect | Add vs keep status-only | Keep status-only in migration. |
| D10 | Admin state | Svelte stores vs port `StateStore` | Svelte stores. |
| D11 | Browser-check scope | Playwright only vs Playwright + devices | Devices required for §3.5. |
| D12 | `media/monitor` vs `media/listener` | Separate vs shared consume | Shared consume, separate wiring. |
| D13 | Studio vs token-publisher media profile | Preserve split vs unify | **Preserve split.** |

---

## 7. Gaps (updated)

G1. **Test infrastructure absent.** `test-api.sh` is not a suite. `test/` is gitignored. Playwright has no specs. Baseline verification in §9 is prerequisite work.

G2. **`media/playback` and consume ownership.** `media/listener` and `media/monitor` share consume. `media/playback` operates on an audio element plus optional stream.

G3. **Retracted.** `transcripts/sync` already owns the Yjs WebSocket. A `signaling/transcripts` module is redundant.

G4. **HTTPS parity.** Not only "add new routes in both places." HTTP has RNNoise mount and `/` redirect. HTTPS does not. Shared registration is part of the shell step and also a baseline defect fix.

G5. **Docker/build integration.** Wire frontend build into image build between shell and page cut-over. Fail if assets are missing.

G6. **Publisher profiles.** Token-publisher RNNoise/synthetic/auto-resume are not studio behavior. See §3.1 and D13.

G7. **Resolved.** Hidden `publishers-${slug}` + unused `showPublishers`. Live UI is `publishers-live-${slug}`.

G8. **Captive portal.** Listener Open-in-Chrome removal must not touch server captive routes.

G9. **Message-shape fixtures.** Capture WS fixtures with a local proxy or server logs before cut-over. Tooling is unspecified beyond that.

G10. **Committed bundles.** Delete `src/public/js/bundles/*.js` and `src/public/icons/chrome.svg` with D3/D7 cut-over, not before.

---

## 8. Acceptance criteria (checkable)

1. URLs in §1.2 keep current auth and room-existence behavior. HTTPS `/` and RNNoise assets follow the defect register, not silent omission.
2. Every matrix row in §4 is preserve, fix, or signed-off removal.
3. WS contracts in §1.3 have fixtures. `/ws/admin` remains.
4. No Svelte component imports `mediasoup-client` or `yjs`, or constructs a `WebSocket`. Enforce in CI.
5. `dispose()` twice leaves zero sockets, tracks, and timers (Playwright `page.evaluate` counters).
6. Recovery cells in §3.4 are tested by name. Server restart does not claim cookie auto-resume.
7. Gesture rows in §3.5 have real-device evidence. Desktop Playwright does not close them.
8. Unauthenticated `GET /admin` is 401. Room-session `GET /api/rooms/:other` is 403. Isolated HTTP tests, not `test-api.sh`.
9. Docker image from a clean checkout serves the four entries. `docker build` fails if frontend output is missing.
10. Captive probes stay unchanged.
11. SFU correlation does not assume request IDs.
12. Studio recording start sends `event_name` or the API change is an explicit decision.
13. Admin JS is syntactically valid. DEF-ADMIN-01 is not ported.

---

## 9. Safe verification sequence (baseline, before implementation)

Do not mutate production. Use a throwaway database file and a throwaway recordings directory.

1. **Isolate.** `DB_PATH` to a temp SQLite file. `RECORDING_DIR` to a temp directory. Do not point at production `soundcast.db` or `recordings/`.
2. **Static parse.** Extract the admin inline script (`admin.html` from the `<script>` after `floating-chat-widget.js` through `</script>`). Parse with `node:vm` `Script`. Expect failure on DEF-ADMIN-01 until that defect is fixed. Parse `studio-media.js`, `transcript-sync.js`, `common.js`, `floating-chat-widget.js` the same way. Record pass/fail. This documentation update did not run these parses.
3. **API baseline on the isolated server.** Authenticate with `/api/auth/login`. Assert status codes. Cover missing `event_name` on recording start (400). Do not use `test-api.sh` against a shared server. Do not treat unauthenticated 401s as suite success.
4. **HTTP vs HTTPS asset map.** On HTTP, `GET /` redirects when room `main` exists. `GET /vendor/web-noise-suppressor/index.js` matches RNNoise package presence. Repeat on HTTPS if certs exist. Record DEF-HTTPS-01/02 if they still fail.
5. **Browser evidence (Playwright, isolated server).** Login, room list, listen start click, publish start click, studio start click, admin live table `publishers-live-*`. Do not claim media policy from this step.
6. **Real device media evidence.** Execute GS-L1, GS-P1, GS-S1, GS-M1, GS-W1. Store device, OS, browser, and pass/fail. Unverified until run.
7. **Recovery sample.** Restart the isolated server with a live studio cookie and a live token-publisher tab. Confirm cookie 401 and the recovery matrix cells. No universal auto-resume.
8. **Stop.** Do not start module extraction until the user accepts the defect register and this evidence pack.

---

## 10. Next steps

The operational sequence is in `docs/frontend-migration-plan.md` under Next steps. Summary:

1. Repair DEF-ADMIN-01, DEF-STUDIO-01, and DEF-HTTPS-01/02. Re-verify each fix on an isolated server.
2. Remove proven dead code (D8 and G7) after admin parses. Preserve `/ws/admin` and `adminClients`.
3. Extract modules behind the current HTML pages. Media extraction needs a live publish/listen check.
4. Add the Vite/Svelte shell only after those slices stay working. Cut over studio, admin, listener, then publisher.
5. Release checks still open: live audio, transcript sidecar, restart media behavior, Docker, and a tracked test suite.

---

## 11. Evidence versus unverified (this documentation update)

**Verified by reading source in this update:**

- Admin standalone commas at 1597, 1644, 1856, 1887, 1969.
- Hidden `publishers-${slug}` at 1334-1335. Unused `showPublishers` at 1665. Live `publishers-live-${slug}` at 1304.
- Studio recording POST without `event_name` (`studio.html:279`) versus API requirement (`api.js:431-435`).
- HTTP RNNoise mount and `/` redirect. HTTPS `createHttpsServer()` omits both.
- `transcript-sync.js` opens the Yjs WebSocket. `authenticateTranscriptSocket` maps cookie `canAccessRoom` to `authMode: 'admin'`.
- `SignalingSocket` waiter has no request IDs.
- `/ws/admin` plus `adminClients` are live.
- `test-api.sh` exists and has no assertions. `test/` is gitignored.
- Studio versus token-publisher media split in §3.1.

**Critique-reported, not re-executed here:**

- `vm.Script` parse failure of the admin inline script.

**Unverified (not run here):**

- Playwright, real-device gesture rows, HTTP/HTTPS live responses, Docker build, isolated DB recording-start 400, server-restart cookie loss as a live probe.

Do not claim those tests were executed in the initial documentation pass. Subsequent results follow.

## 12. Executed baseline verification (2026-09-29)

Verification used temporary SQLite, recordings, TLS certificates, and loopback servers. It did not use production data. No application source changed. Both named browser sessions and the isolated server were stopped. No recordings were created.

### Results

| Check | Evidence and outcome |
| --- | --- |
| JavaScript parsing | Admin inline script fails with `SyntaxError: Unexpected token ','`. `studio-media.js`, `transcript-sync.js`, `common.js`, and `floating-chat-widget.js` pass `vm.Script` parsing. |
| Isolated auth/API assertions | Owner login and access, unauthenticated 401, cross-room 403, owner-only operations, PIN rotation and old-session revocation passed. These use an isolated harness with the real auth/API plugins. Harness-only admin responses are not full-page evidence. |
| Recording validation | Authenticated studio-shaped request returns 400 for missing `event_name`. Chromium Start recording reproduces the same error with request body `{"enable_transcription":false}`. Database recording count stays zero. DEF-STUDIO-01 confirmed. |
| Studio UI | Owner login renders room selection, recording controls, microphone, and Listen panes. Login and room-list requests return 200. A later page-load pass also rendered Start broadcast and Start recording without clicking them. |
| Listener page load | Isolated server at `127.0.0.1:57820`: `/` redirected to `/room/main/listen`. Channel combobox and Start Listening rendered. No console errors. Start was not clicked. Audio is not claimed. |
| Publisher page load | `/room/main/publish?token=` rendered microphone source, noise-suppression checkbox, Start Broadcasting, monitor controls, transcripts, and admin chat. No syntax error. Headless Chromium logged `NotAllowedError` for microphone permission. Capture was not started. |
| Admin UI | Before the fix, `/admin` stayed on Loading rooms because of the comma syntax error. DEF-ADMIN-01 is now fixed and re-verified. |
| DEF-ADMIN-01 fix | Five standalone header commas removed from `src/public/admin.html`. `vm.Script` parse passed. Isolated `/admin` on `127.0.0.1:63210` rendered the Main room. `loadRooms` is a function. No console errors. Admin WebSocket connected. Recordings stayed at 0. |
| HTTP deployment | Actual server redirects `/` to `/room/main/listen`. RNNoise `index.js` returns 200. |
| HTTPS deployment | Actual server serves static listener HTML at `/` with 200 and no redirect. The explicit room-listener route works. RNNoise `index.js` returns 404. DEF-HTTPS-01 confirmed and DEF-HTTPS-02 clarified. |

The harness reports 48 assertions: 45 passed and 3 failed. This is not a product acceptance score. Some passing assertions intentionally expect defects, and two failures represent the same HTTPS-root discrepancy in replica and full-server probes. Use the semantic results above rather than the aggregate as a release gate.

### Artifacts and limits

Artifacts are local temporary evidence at `/var/folders/vk/_7rc7r7j7hsdtssdx4wmj3680000gn/T/opencode/soundcast-baseline-verify-20260929T164620/`. `results.json` contains parser/API/route assertions, `harness.mjs` contains the harness, and `browser/` contains screenshots and browser evidence. Temporary artifacts are not a committed regression suite.

Browser verification used agent-browser with desktop Chromium. HTTPS used temporary certificates with certificate-error bypass. The initial certificate-error screenshot is a test-session setup issue, not an application defect.

Page-load artifacts are under `/var/folders/vk/_7rc7r7j7hsdtssdx4wmj3680000gn/T/opencode/soundcast-verify/`.

### Restart recovery (isolated, 2026-09-29)

Same temp SQLite across two `node src/server.js` processes on `127.0.0.1:57810`.

| Check | Result |
| --- | --- |
| Pre-restart owner cookie | `GET /api/auth/me` 200 |
| Pre-restart token WS | `ws://127.0.0.1:57810/ws/room/main/publish?token=...` opened and returned `config` after `{ type: "get-config" }` |
| Post-restart saved cookie | `GET /api/auth/me`, `GET /api/rooms`, and recordings list all 401 `Sign in required` |
| Post-restart token WS | New handshake succeeded. `config` returned `publisherId` 1 |
| Recordings | `recordings` and `recording_tracks` stayed 0 |

This is observed auth behavior. It does not prove media auto-resume. The kept-open socket was not held across SIGTERM. Proof is a new token handshake to the new process. HTTPS was not used. Login role in this code is `admin`, not a separate `owner` role.

Artifacts: `/var/folders/vk/_7rc7r7j7hsdtssdx4wmj3680000gn/T/opencode/soundcast-restart-verify-cc4kcrc2`

Outstanding: live publish/listen and receiver audio evidence, transcript sidecar integration, Docker build, and a tracked automated regression suite. Device-emulator gesture checks were cancelled because this is a web application. Desktop Chromium page load is not media-success evidence. No lint/typecheck script is defined in the current package manifest.
