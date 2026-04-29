(async function initTranscriptSync() {
  const Y = await import('/js/bundles/yjs.js');

  function isNearBottom(textarea, threshold = 24) {
    const remaining = textarea.scrollHeight - textarea.scrollTop - textarea.clientHeight;
    return remaining <= threshold;
  }

  function applyTextDiff(ydoc, ytext, oldText, newText) {
    if (oldText === newText) return;

    let left = 0;
    const minLen = Math.min(oldText.length, newText.length);
    while (left < minLen && oldText[left] === newText[left]) left += 1;

    let oldRight = oldText.length;
    let newRight = newText.length;
    while (oldRight > left && newRight > left && oldText[oldRight - 1] === newText[newRight - 1]) {
      oldRight -= 1;
      newRight -= 1;
    }

    ydoc.transact(() => {
      const deleteLen = oldRight - left;
      if (deleteLen > 0) ytext.delete(left, deleteLen);
      const insertText = newText.slice(left, newRight);
      if (insertText) ytext.insert(left, insertText);
    }, 'local-input');
  }

  async function createBinding({ wsUrl, textarea, onStatus }) {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('transcript');
    let socket = null;
    let applyingRemote = false;
    let followTail = true;

    function renderFromY() {
      const next = ytext.toString();
      if (textarea.value === next) return;

      const hadFocus = document.activeElement === textarea;
      const shouldFollow = followTail || isNearBottom(textarea);
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      applyingRemote = true;
      textarea.value = next;
      applyingRemote = false;

      if (hadFocus) {
        const max = textarea.value.length;
        textarea.setSelectionRange(Math.min(start, max), Math.min(end, max));
      }

       if (shouldFollow) {
        textarea.scrollTop = textarea.scrollHeight;
      }
    }

    ytext.observe(() => {
      renderFromY();
    });

    const onInput = () => {
      if (applyingRemote) return;
      applyTextDiff(ydoc, ytext, ytext.toString(), textarea.value);
    };
    const onScroll = () => {
      followTail = isNearBottom(textarea);
    };
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('scroll', onScroll);

    ydoc.on('update', (update, origin) => {
      if (origin === 'remote') return;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(update);
      } catch { }
    });

    await new Promise((resolve, reject) => {
      socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';
      const timeout = setTimeout(() => {
        reject(new Error('Transcript socket connection timed out'));
      }, 10000);

      socket.onopen = () => {
        clearTimeout(timeout);
        if (onStatus) onStatus('connected');
        resolve();
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('Transcript socket failed to connect'));
      };
    });

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === 'error') {
            if (onStatus) onStatus('error', payload.message || 'Transcript socket error');
          } else if (payload.type === 'pong') {
            // No-op
          }
        } catch {
          // No-op
        }
        return;
      }

      const update = new Uint8Array(event.data);
      Y.applyUpdate(ydoc, update, 'remote');
    };

    socket.onclose = () => {
      if (onStatus) onStatus('disconnected');
    };

    return {
      ydoc,
      ytext,
      destroy() {
        textarea.removeEventListener('input', onInput);
        textarea.removeEventListener('scroll', onScroll);
        try {
          socket?.close();
        } catch { }
        ydoc.destroy();
      }
    };
  }

  window.SoundcastTranscript = {
    createBinding
  };
})();
