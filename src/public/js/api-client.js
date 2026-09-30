// Shared REST client for Soundcast pages.
// Thin wrapper over fetch that JSON-encodes bodies, parses JSON responses,
// and throws Error(message) on non-2xx. Exposes window.SoundcastApi.
(function () {
  'use strict';

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `Request failed (${response.status})`);
    return payload;
  }

  window.SoundcastApi = { request };
})();
