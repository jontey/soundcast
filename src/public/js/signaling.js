/* Shared WebSocket signaling for Soundcast media modules.
 *
 * Extracted from the studio-media.js SignalingSocket pattern so listener,
 * publisher, studio, and monitor can share one request/response socket that
 * owns its connection and cleans up idempotently.
 *
 * Lifecycle:
 *   const sig = await SignalingChannel.open(path);   // path like '/ws' or '/ws/admin'
 *   sig.onEvent = (message) => {};                    // server-pushed messages
 *   sig.onClose = () => {};                           // abnormal close
 *   const res = await sig.request(action, data, responses);
 *   sig.dispose();                                    // idempotent; safe to call twice
 */
(function () {
  'use strict';

  const REQUEST_TIMEOUT_MS = 12000;

  class SignalingChannel {
    constructor(socket) {
      this.socket = socket;
      this.waiters = [];
      this.onEvent = () => {};
      this.onClose = () => {};
      this._disposed = false;

      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }

        if (message.action === 'error' || message.type === 'error') {
          const waiter = this.waiters.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(message.data?.message || 'Signaling error'));
          } else {
            this.onEvent(message);
          }
          return;
        }

        const action = message.action || message.type;
        const index = this.waiters.findIndex((waiter) => waiter.responses.includes(action));
        if (index !== -1) {
          const [waiter] = this.waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } else {
          this.onEvent(message);
        }
      });

      socket.addEventListener('close', () => {
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('Signaling disconnected'));
        }
        if (!this._disposed) this.onClose();
      });
    }

    static open(path) {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}${path}`);
      return new Promise((resolve, reject) => {
        socket.addEventListener('open', () => resolve(new SignalingChannel(socket)), { once: true });
        socket.addEventListener('error', () => reject(new Error('Cannot connect to audio server')), { once: true });
      });
    }

    request(action, data, responses) {
      if (this._disposed || this.socket.readyState !== WebSocket.OPEN) {
        return Promise.reject(new Error('Audio server disconnected'));
      }
      const accepted = Array.isArray(responses) ? responses : [responses];
      return new Promise((resolve, reject) => {
        const waiter = { responses: accepted, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          this.waiters = this.waiters.filter((entry) => entry !== waiter);
          reject(new Error(`${action} timed out`));
        }, REQUEST_TIMEOUT_MS);
        this.waiters.push(waiter);
        this.socket.send(JSON.stringify({ action, data }));
      });
    }

    // Idempotent terminal teardown. Safe to call multiple times.
    dispose() {
      if (this._disposed) return;
      this._disposed = true;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Signaling disposed'));
      }
      try { this.socket.close(); } catch { /* already closed */ }
    }
  }

  window.SoundcastSignaling = { SignalingChannel };
})();
