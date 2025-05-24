// WebSocket connection
let socket;
let rtpCapabilities;
let transport;
let producer;
let consumer;
let statusElement;
let reconnectAttempts = 0;
let reconnectTimer;
let maxReconnectAttempts = 100;
let reconnectInterval = 1000; // Start with 1 second, will increase exponentially

// Connect to WebSocket server
function connectWebSocket() {
  // Clear any existing reconnect timer
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  
  socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    updateStatus('Connected to server', 'success');
    // Reset reconnect attempts on successful connection
    reconnectAttempts = 0;
    reconnectInterval = 1000;
    // Request RTP capabilities once connected
    onConnected(socket);
    socket.send(JSON.stringify({ action: 'get-rtpCapabilities' }));
  };
  
  socket.onclose = (event) => {
    updateStatus('Disconnected from server', 'error');
    attemptReconnect();
  };
  
  socket.onerror = (error) => {
    console.error('WebSocket error:', error);
    updateStatus('WebSocket error', 'error');
    // We don't attempt reconnect here as onclose will be called after an error
  };
  
  return socket;
}

// Attempt to reconnect with exponential backoff
function attemptReconnect() {
  if (reconnectAttempts >= maxReconnectAttempts) {
    updateStatus(`Failed to reconnect after ${maxReconnectAttempts} attempts`, 'error');
    return;
  }
  
  reconnectAttempts++;
  const delay = reconnectInterval * Math.pow(1.5, reconnectAttempts - 1); // Exponential backoff
  const cappedDelay = Math.min(delay, 30000); // Cap at 30 seconds
  
  updateStatus(`Reconnecting in ${Math.round(cappedDelay/1000)} seconds... (Attempt ${reconnectAttempts}/${maxReconnectAttempts})`, 'info');
  
  reconnectTimer = setTimeout(() => {
    updateStatus('Attempting to reconnect...', 'info');
    connectWebSocket();
  }, cappedDelay);
}

// Update status message
function updateStatus(message, type = 'info') {
  if (!statusElement) {
    statusElement = document.getElementById('status');
  }
  
  if (statusElement) {
    statusElement.textContent = message;
    statusElement.className = 'status ' + type;
  }
  
  console.log(`Status: ${message}`);
}

// Send message to WebSocket server
function sendMessage(action, data = {}) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action, data }));
    return true;
  } else {
    updateStatus('WebSocket not connected', 'error');
    return false;
  }
}

// Load mediasoup client
async function loadMediasoupClient() {
  if (!window.mediasoupClient) {
    updateStatus('Loading mediasoup client...', 'info');
    
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/js/bundles/mediasoup-client.js';
      script.onload = () => {
        updateStatus('mediasoup client loaded', 'success');
        resolve();
      };
      script.onerror = () => {
        updateStatus('Failed to load mediasoup client', 'error');
        reject(new Error('Failed to load mediasoup client'));
      };
      document.head.appendChild(script);
    });
  }
  
  return Promise.resolve();
}

// Create device with RTP capabilities
async function createDevice() {
  try {
    await loadMediasoupClient();
    
    const device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });
    
    return device;
  } catch (error) {
    console.error('Error creating device:', error);
    updateStatus('Error creating device: ' + error.message, 'error');
    throw error;
  }
}

// Get ICE servers configuration for WebRTC connections
function getIceServers() {
  return [
    { urls: ['stun:stun.l.google.com:19302'] },
    { urls: ['stun:stun1.l.google.com:19302'] },
    // Add your TURN server here if needed for production
    // { urls: ['turn:turn.example.com:443'], username: 'username', credential: 'credential' }
  ];
}

// Helper function to get URL parameters
function getUrlParam(name) {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(name);
}

// Format date
function formatDate(date) {
  return new Date(date).toLocaleString();
}

// Create a simple audio meter
function createAudioMeter(audioContext, clipLevel = 0.98, averaging = 0.95, clipLag = 750) {
  const processor = audioContext.createScriptProcessor(512);
  processor.onaudioprocess = volumeAudioProcess;
  processor.clipping = false;
  processor.lastClip = 0;
  processor.volume = 0;
  processor.clipLevel = clipLevel;
  processor.averaging = averaging;
  processor.clipLag = clipLag;

  // This will have no effect, since we don't copy the input to the output,
  // but works around a current Chrome bug.
  processor.connect(audioContext.destination);

  processor.checkClipping = function() {
    if (!this.clipping) return false;
    if ((this.lastClip + this.clipLag) < window.performance.now()) this.clipping = false;
    return this.clipping;
  };

  processor.shutdown = function() {
    this.disconnect();
    this.onaudioprocess = null;
  };

  return processor;
}

function volumeAudioProcess(event) {
  const buf = event.inputBuffer.getChannelData(0);
  const bufLength = buf.length;
  let sum = 0;
  let x;

  // Do a root-mean-square on the samples: sum up the squares...
  for (let i = 0; i < bufLength; i++) {
    x = buf[i];
    if (Math.abs(x) >= this.clipLevel) {
      this.clipping = true;
      this.lastClip = window.performance.now();
    }
    sum += x * x;
  }

  // ... then take the square root of the sum.
  const rms = Math.sqrt(sum / bufLength);

  // Now smooth this out with the averaging factor applied
  // to the previous sample - take the max here because we
  // want "fast attack, slow release."
  this.volume = Math.max(rms, this.volume * this.averaging);
}

// Update audio meter UI
function updateAudioMeter(meter, meterElement) {
  if (!meter || !meterElement) return;
  
  const volume = meter.volume * 100;
  meterElement.style.width = volume + '%';
  
  if (meter.checkClipping()) {
    meterElement.style.backgroundColor = '#e74c3c';
  } else {
    meterElement.style.backgroundColor = '#3498db';
  }
}
