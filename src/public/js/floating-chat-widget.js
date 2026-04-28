(function () {
  if (window.SoundcastFloatingChat) return;

  const STYLE_ID = 'soundcast-floating-chat-widget-style';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .sc-chat-fab {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 1200;
        border: none;
        border-radius: 999px;
        background: #2563eb;
        color: #fff;
        font-weight: 700;
        padding: 12px 16px;
        cursor: pointer;
        box-shadow: 0 8px 24px rgba(37, 99, 235, 0.35);
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      .sc-chat-fab:hover {
        background: #1d4ed8;
      }

      .sc-chat-badge {
        min-width: 18px;
        height: 18px;
        border-radius: 999px;
        background: #ef4444;
        color: #fff;
        font-size: 11px;
        display: none;
        align-items: center;
        justify-content: center;
        padding: 0 5px;
        box-sizing: border-box;
      }

      .sc-chat-panel {
        position: fixed;
        right: 20px;
        bottom: 74px;
        width: 360px;
        max-width: calc(100vw - 24px);
        max-height: min(500px, calc(100vh - 100px));
        border: 1px solid #cbd5e0;
        border-radius: 12px;
        padding: 12px;
        background: #f8fafc;
        display: none;
        z-index: 1200;
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.2);
      }

      .sc-chat-panel.open {
        display: block;
      }

      .sc-chat-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
      }

      .sc-chat-title {
        font-weight: 700;
        font-size: 14px;
        color: #1f2937;
      }

      .sc-chat-close {
        border: none;
        background: transparent;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
        color: #4a5568;
        padding: 2px 4px;
      }

      .sc-chat-log {
        max-height: 320px;
        overflow-y: auto;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        padding: 10px;
        margin: 8px 0;
        font-size: 13px;
      }

      .sc-chat-composer {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .sc-chat-input {
        flex: 1;
        min-width: 0;
        width: auto;
        margin: 0;
      }

      .sc-chat-send {
        width: auto;
        min-width: 88px;
        margin: 0;
        padding: 10px 16px;
        font-size: 14px;
        line-height: 1.2;
        flex: 0 0 auto;
      }

      @media (max-width: 600px) {
        .sc-chat-fab {
          right: 12px;
          bottom: 12px;
        }

        .sc-chat-panel {
          right: 12px;
          left: 12px;
          width: auto;
          bottom: 64px;
          max-width: none;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function createChatWidget(options = {}) {
    injectStyles();

    const config = {
      buttonLabel: options.buttonLabel || 'Chat',
      title: options.title || 'Chat',
      inputPlaceholder: options.inputPlaceholder || 'Type a message...',
      emptyMessage: options.emptyMessage || 'No messages yet.',
      sendButtonLabel: options.sendButtonLabel || 'Send',
      renderMessage: options.renderMessage || ((msg) => (msg && msg.text) ? String(msg.text) : ''),
      onSend: typeof options.onSend === 'function' ? options.onSend : async () => true
    };

    const root = document.createElement('div');
    root.className = 'sc-chat-widget';

    const fab = document.createElement('button');
    fab.className = 'sc-chat-fab';
    fab.type = 'button';
    fab.textContent = config.buttonLabel;

    const badge = document.createElement('span');
    badge.className = 'sc-chat-badge';
    badge.textContent = '0';
    fab.appendChild(badge);

    const panel = document.createElement('div');
    panel.className = 'sc-chat-panel';

    const header = document.createElement('div');
    header.className = 'sc-chat-header';

    const titleEl = document.createElement('div');
    titleEl.className = 'sc-chat-title';
    titleEl.textContent = config.title;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'sc-chat-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close chat panel');
    closeBtn.textContent = '\u00D7';

    const log = document.createElement('div');
    log.className = 'sc-chat-log';
    log.textContent = config.emptyMessage;

    const composer = document.createElement('div');
    composer.className = 'sc-chat-composer';

    const input = document.createElement('input');
    input.className = 'form-input sc-chat-input';
    input.type = 'text';
    input.placeholder = config.inputPlaceholder;

    const sendBtn = document.createElement('button');
    sendBtn.className = 'btn btn-primary sc-chat-send';
    sendBtn.type = 'button';
    sendBtn.textContent = config.sendButtonLabel;

    header.appendChild(titleEl);
    header.appendChild(closeBtn);
    composer.appendChild(input);
    composer.appendChild(sendBtn);
    panel.appendChild(header);
    panel.appendChild(log);
    panel.appendChild(composer);
    root.appendChild(fab);
    root.appendChild(panel);
    document.body.appendChild(root);

    function applyPosition(position) {
      if (!position || typeof position !== 'object') return;
      if (typeof position.right === 'number') {
        fab.style.right = `${position.right}px`;
        panel.style.right = `${position.right}px`;
      }
      if (typeof position.left === 'number') {
        fab.style.left = `${position.left}px`;
        panel.style.left = `${position.left}px`;
      }
      if (typeof position.fabBottom === 'number') {
        fab.style.bottom = `${position.fabBottom}px`;
      }
      if (typeof position.panelBottom === 'number') {
        panel.style.bottom = `${position.panelBottom}px`;
      }
    }

    applyPosition(options.position);

    let isOpen = false;
    let unreadCount = 0;
    let messages = [];
    let enabled = true;
    let emptyMessage = config.emptyMessage;

    function syncUnreadBadge() {
      if (unreadCount > 0) {
        badge.style.display = 'inline-flex';
        badge.textContent = String(Math.min(unreadCount, 99));
      } else {
        badge.style.display = 'none';
      }
    }

    function renderMessages() {
      if (!messages || messages.length === 0) {
        log.textContent = emptyMessage;
        return;
      }
      log.innerHTML = messages.map((msg) => config.renderMessage(msg)).join('');
      log.scrollTop = log.scrollHeight;
    }

    function setOpen(open) {
      isOpen = Boolean(open);
      if (isOpen) {
        panel.classList.add('open');
        unreadCount = 0;
        syncUnreadBadge();
        input.focus();
      } else {
        panel.classList.remove('open');
      }
    }

    async function send() {
      if (!enabled) return;
      const text = input.value.trim();
      if (!text) return;
      const ok = await config.onSend(text);
      if (ok !== false) {
        input.value = '';
      }
    }

    fab.addEventListener('click', () => setOpen(!isOpen));
    closeBtn.addEventListener('click', () => setOpen(false));
    sendBtn.addEventListener('click', send);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        send();
      }
    });

    return {
      setEnabled(value) {
        enabled = Boolean(value);
        root.style.display = enabled ? '' : 'none';
        if (!enabled) setOpen(false);
      },
      setTitle(title) {
        titleEl.textContent = title || config.title;
      },
      setEmptyMessage(message) {
        emptyMessage = message || config.emptyMessage;
        renderMessages();
      },
      setMessages(nextMessages, nextEmptyMessage) {
        messages = Array.isArray(nextMessages) ? nextMessages : [];
        if (typeof nextEmptyMessage === 'string') {
          emptyMessage = nextEmptyMessage;
        }
        renderMessages();
      },
      appendMessage(message, countUnread = true) {
        messages.push(message);
        if (messages.length > 100) {
          messages.splice(0, messages.length - 100);
        }
        renderMessages();
        if (!isOpen && countUnread) {
          unreadCount += 1;
          syncUnreadBadge();
        }
      },
      open() {
        setOpen(true);
      },
      close() {
        setOpen(false);
      },
      isOpen() {
        return isOpen;
      },
      incrementUnread(count = 1) {
        const next = Number(count);
        if (!Number.isFinite(next) || next <= 0) return;
        unreadCount += Math.floor(next);
        syncUnreadBadge();
      },
      setUnreadCount(count = 0) {
        const next = Number(count);
        unreadCount = Number.isFinite(next) ? Math.max(0, Math.floor(next)) : 0;
        syncUnreadBadge();
      },
      setPosition(position) {
        applyPosition(position);
      }
    };
  }

  window.SoundcastFloatingChat = { create: createChatWidget };
})();
