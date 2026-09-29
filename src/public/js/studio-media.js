/* Native microphone and monitor controls for the shared studio. */
(function () {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] }
  ];

  class SignalingSocket {
    constructor(socket) {
      this.socket = socket;
      this.waiters = [];
      this.onEvent = () => {};
      this.onClose = () => {};
      socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.action === 'error') {
          const waiter = this.waiters.shift();
          if (waiter) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(message.data?.message || 'Signaling error'));
          } else this.onEvent(message);
          return;
        }
        const index = this.waiters.findIndex(waiter => waiter.responses.includes(message.action));
        if (index !== -1) {
          const [waiter] = this.waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        } else this.onEvent(message);
      });
      socket.addEventListener('close', () => {
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('Signaling disconnected'));
        }
        this.onClose();
      });
    }

    static async open() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/ws`);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', () => reject(new Error('Cannot connect to audio server')), { once: true });
      });
      return new SignalingSocket(socket);
    }

    request(action, data, responses) {
      if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Audio server disconnected'));
      const accepted = Array.isArray(responses) ? responses : [responses];
      return new Promise((resolve, reject) => {
        const waiter = { responses: accepted, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          this.waiters = this.waiters.filter(entry => entry !== waiter);
          reject(new Error(`${action} timed out`));
        }, 12000);
        this.waiters.push(waiter);
        this.socket.send(JSON.stringify({ action, data }));
      });
    }

    close() { this.socket.close(); }
  }

  class PublisherMedia {
    constructor({ onStatus, onDevices, onLevel, onListeners }) {
      this.onStatus = onStatus;
      this.onDevices = onDevices;
      this.onLevel = onLevel;
      this.onListeners = onListeners;
      this.socket = null;
      this.transport = null;
      this.producer = null;
      this.stream = null;
      this.audioContext = null;
      this.meterTimer = null;
      this.active = false;
      this.stopping = false;
      this.channelId = null;
    }

    async start({ roomSlug, publisherId, channelName, deviceId }) {
      await this.stop();
      this.stopping = false;
      this.channelId = `${roomSlug}:${channelName}`;
      try {
        this.onStatus('Requesting microphone…');
        const constraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        if (deviceId) constraints.deviceId = { ideal: deviceId };
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        await this.refreshDevices();
        this.startMeter();

        this.onStatus('Connecting microphone…');
        this.socket = await SignalingSocket.open();
        this.socket.onEvent = message => {
          if (message.action === 'listener-count') this.onListeners(message.data?.count || 0);
          if (message.action === 'error') this.onStatus(message.data?.message || 'Broadcast error');
        };
        this.socket.onClose = () => {
          if (this.active && !this.stopping) {
            this.stopping = true;
            this.releaseLocal();
            this.onStatus('Disconnected. Press Start broadcast to reconnect.');
          }
        };

        const caps = await this.socket.request('get-rtpCapabilities', {}, 'rtpCapabilities');
        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: caps.data });
        const created = await this.socket.request('create-publisher-transport', {
          channelId: this.channelId,
          publisherId
        }, 'publisher-transport-created');
        this.transport = device.createSendTransport({ ...created.data, iceServers });
        this.transport.on('connect', ({ dtlsParameters }, callback, errback) => {
          this.socket.request('connect-publisher-transport', { dtlsParameters }, 'publisher-transport-connected')
            .then(callback, errback);
        });
        this.transport.on('produce', ({ rtpParameters }, callback, errback) => {
          this.socket.request('produce-audio', { channelId: this.channelId, rtpParameters }, 'produced')
            .then(message => callback({ id: message.data.id }), errback);
        });
        this.transport.on('connectionstatechange', state => {
          if ((state === 'failed' || state === 'closed') && !this.stopping) {
            this.stop().catch(() => {});
            this.onStatus('Connection lost. Press Start broadcast to retry.');
          }
        });
        this.producer = await this.transport.produce({ track: this.stream.getAudioTracks()[0] });
        this.active = true;
        this.onStatus(`Broadcasting to ${channelName}`);
      } catch (error) {
        await this.stop();
        this.onStatus(error.message);
        throw error;
      }
    }

    async refreshDevices() {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const selectedId = this.stream?.getAudioTracks()[0]?.getSettings()?.deviceId;
      this.onDevices(devices.filter(device => device.kind === 'audioinput'), selectedId);
    }

    startMeter() {
      try {
        this.audioContext = new AudioContext();
        const source = this.audioContext.createMediaStreamSource(this.stream);
        const analyser = this.audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const samples = new Uint8Array(analyser.frequencyBinCount);
        this.meterTimer = setInterval(() => {
          analyser.getByteFrequencyData(samples);
          const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
          this.onLevel(Math.min(100, Math.round(average * 1.2)));
        }, 100);
      } catch { this.onLevel(0); }
    }

    setMuted(muted) {
      for (const track of this.stream?.getAudioTracks() || []) track.enabled = !muted;
    }

    releaseLocal() {
      this.active = false;
      this.producer?.close();
      this.transport?.close();
      this.stream?.getTracks().forEach(track => track.stop());
      if (this.meterTimer) clearInterval(this.meterTimer);
      this.audioContext?.close().catch(() => {});
      this.producer = null;
      this.transport = null;
      this.stream = null;
      this.audioContext = null;
      this.meterTimer = null;
      this.onLevel(0);
      this.onListeners(0);
    }

    async stop() {
      this.stopping = true;
      if (this.socket?.socket.readyState === WebSocket.OPEN && this.active) {
        await this.socket.request('stop-broadcasting', { channelId: this.channelId }, 'broadcasting-stopped').catch(() => {});
      }
      this.releaseLocal();
      this.socket?.close();
      this.socket = null;
      this.channelId = null;
    }
  }

  class ListenerMedia {
    constructor({ audio, onStatus, onTracks }) {
      this.audio = audio;
      this.onStatus = onStatus;
      this.onTracks = onTracks;
      this.socket = null;
      this.transport = null;
      this.consumers = new Map();
      this.stream = null;
      this.active = false;
      this.stopping = false;
    }

    async start({ roomSlug, channelName }) {
      await this.stop();
      this.stopping = false;
      try {
        this.onStatus(`Connecting to ${channelName}…`);
        this.socket = await SignalingSocket.open();
        this.socket.onEvent = message => {
          if (message.action === 'consumer-created') this.addConsumers(message.data).catch(error => this.onStatus(error.message));
          if (message.action === 'producer-stopped') this.removeProducer(message.data?.producerId);
          if (message.action === 'error') this.onStatus(message.data?.message || 'Monitor error');
        };
        this.socket.onClose = () => {
          if (this.active && !this.stopping) {
            this.stopping = true;
            this.releaseLocal();
            this.onStatus('Monitor disconnected. Press Start listening to reconnect.');
          }
        };
        const caps = await this.socket.request('get-rtpCapabilities', {}, 'rtpCapabilities');
        const device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: caps.data });
        const created = await this.socket.request('create-listener-transport', {
          channelId: `${roomSlug}:${channelName}`,
          displayName: 'Studio monitor'
        }, 'listener-transport-created');
        this.transport = device.createRecvTransport({ ...created.data, iceServers });
        this.transport.on('connect', ({ dtlsParameters }, callback, errback) => {
          this.socket.request('connect-listener-transport', { dtlsParameters }, 'listener-transport-connected')
            .then(callback, errback);
        });
        this.transport.on('connectionstatechange', state => {
          if ((state === 'failed' || state === 'closed') && !this.stopping) {
            this.stop().catch(() => {});
            this.onStatus('Monitor connection lost. Press Start listening to retry.');
          }
        });
        this.stream = new MediaStream();
        this.audio.srcObject = this.stream;
        this.active = true;
        const response = await this.socket.request('consume-audio', {
          rtpCapabilities: device.rtpCapabilities
        }, ['consumer-created', 'waiting-for-publisher']);
        if (response.action === 'consumer-created') await this.addConsumers(response.data);
        else this.onStatus(`Waiting for a publisher on ${channelName}`);
      } catch (error) {
        await this.stop();
        this.onStatus(error.message);
        throw error;
      }
    }

    async addConsumers(data) {
      for (const item of Array.isArray(data) ? data : [data]) {
        if (!item || this.consumers.has(item.producerId)) continue;
        const consumer = await this.transport.consume(item);
        this.consumers.set(item.producerId, consumer);
        this.stream.addTrack(consumer.track);
      }
      this.onTracks(this.consumers.size);
      if (this.consumers.size) {
        this.onStatus(`Listening to ${this.consumers.size} publisher${this.consumers.size === 1 ? '' : 's'}`);
        this.audio.play().catch(() => this.onStatus('Press play to hear the monitor'));
      }
    }

    removeProducer(producerId) {
      const consumer = this.consumers.get(producerId);
      if (!consumer) return;
      consumer.close();
      this.stream?.removeTrack(consumer.track);
      this.consumers.delete(producerId);
      this.onTracks(this.consumers.size);
      if (!this.consumers.size) this.onStatus('Waiting for publisher');
    }

    releaseLocal() {
      this.active = false;
      for (const consumer of this.consumers.values()) consumer.close();
      this.consumers.clear();
      this.transport?.close();
      this.transport = null;
      this.stream = null;
      this.audio.srcObject = null;
      this.onTracks(0);
    }

    async stop() {
      this.stopping = true;
      if (this.socket?.socket.readyState === WebSocket.OPEN && this.active) {
        await this.socket.request('leave-channel', {}, 'left-channel').catch(() => {});
      }
      this.releaseLocal();
      this.socket?.close();
      this.socket = null;
    }
  }

  window.SoundcastStudioMedia = { PublisherMedia, ListenerMedia };
})();
