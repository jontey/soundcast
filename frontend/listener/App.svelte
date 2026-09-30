<script>
  import { onDestroy, onMount } from 'svelte';
  import { ListenerMedia } from '../src/lib/media.js';

  const roomSlug = new URLSearchParams(window.location.search).get('room') || 'main';

  let channels = $state([]);
  let selectedChannel = $state('');
  let status = $state('Connecting to room…');
  let trackCount = $state(0);
  let starting = $state(false);
  let audioEl = $state(null);

  let listener = $state(null);
  let configWs = null;

  onMount(() => {
    connectConfigSocket();
    return () => {
      teardown();
    };
  });

  onDestroy(() => {
    teardown();
  });

  function teardown() {
    try { configWs?.close(); } catch { /* already closed */ }
    configWs = null;
    if (listener) {
      listener.dispose().catch(() => {});
      listener = null;
    }
  }

  function connectConfigSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/room/${encodeURIComponent(roomSlug)}/listen`);
    configWs = ws;
    ws.onopen = () => {
      status = 'Connected, waiting for configuration…';
      ws.send(JSON.stringify({ type: 'get-config' }));
    };
    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'config') {
        channels = message.data?.channels || [];
        const requested = new URLSearchParams(window.location.search).get('channel');
        if (requested && channels.includes(requested)) selectedChannel = requested;
        else if (channels.length === 1) selectedChannel = channels[0];
        status = channels.length ? 'Select a channel and click Start Listening' : 'No channels available yet';
      } else if (message.type === 'error') {
        status = message.data?.message || 'Room error';
      }
    };
    ws.onerror = () => { if (configWs === ws) status = 'Room connection error'; };
    ws.onclose = () => { if (configWs === ws) status = 'Disconnected from room'; };
  }

  async function startListening() {
    if (!selectedChannel || starting) return;
    starting = true;
    try {
      if (listener) await listener.dispose();
      listener = new ListenerMedia({
        audio: audioEl,
        onStatus: (message) => { status = message; },
        onTracks: (count) => { trackCount = count; }
      });
      await listener.start({ roomSlug, channelName: selectedChannel });
    } catch (error) {
      status = error?.message || 'Failed to start listening';
    } finally {
      starting = false;
    }
  }

  async function stopListening() {
    if (listener) {
      await listener.stop();
      status = 'Listening stopped';
    }
  }
</script>

<main>
  <h1>Soundcast — Listener</h1>
  <p class="hint">Room: <strong>{roomSlug}</strong></p>

  <div class="field">
    <label for="channelSelect">Channel</label>
    <select id="channelSelect" bind:value={selectedChannel}>
      <option value="" disabled={channels.length === 0}>
        {channels.length === 0 ? 'No channels available yet' : 'Select a channel to listen to'}
      </option>
      {#each channels as channel}
        <option value={channel}>{channel}</option>
      {/each}
    </select>
  </div>

  <div class="actions">
    <button onclick={startListening} disabled={starting || !selectedChannel}>
      {starting ? 'Starting…' : 'Start Listening'}
    </button>
    <button class="secondary" onclick={stopListening} disabled={!listener?.active}>Stop Listening</button>
  </div>

  <p class="status" role="status">{status}</p>
  <p class="hint">{trackCount} audio stream{trackCount === 1 ? '' : 's'}</p>

  <audio bind:this={audioEl} controls autoplay playsinline></audio>
</main>

<style>
  :root { font-family: system-ui, sans-serif; color: #16233b; background: #f3f5fa; }
  main { max-width: 560px; margin: 24px auto; padding: 20px; background: white; border: 1px solid #dce2ec; border-radius: 14px; box-shadow: 0 3px 14px #192d560d; }
  h1 { font-size: 1.3rem; margin: 0 0 14px; }
  .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px; }
  label { font-weight: 600; font-size: .85rem; }
  select, button { font: inherit; min-height: 42px; border-radius: 8px; }
  select { border: 1px solid #b9c4d6; padding: 8px 10px; background: white; width: 100%; }
  .actions { display: flex; gap: 10px; margin-bottom: 14px; }
  button { flex: 1; padding: 9px 16px; border: 0; background: #2e54a6; color: white; font-weight: 650; cursor: pointer; }
  button.secondary { background: #e8edf8; color: #19345d; }
  button:disabled { opacity: .5; cursor: default; }
  .status { min-height: 1.3em; font-weight: 600; color: #234779; }
  .hint { color: #52637c; font-size: .87rem; }
  audio { width: 100%; margin-top: 12px; }
</style>
