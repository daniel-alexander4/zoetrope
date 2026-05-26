// transfer.js — small primitives used by /manage and / to send and receive
// files over the mTLS WS session. Pairs with transfer.go on the Go side.
//
// The Go side does the chunking; the browser just POSTs the raw file
// bytes to /api/sessions/{fp}/transfer (manager) or /api/network/transfer
// (client). Inbound notifications arrive via the existing SSE bus (event
// name "file-received") and the bytes are fetched lazily via /api/inbox/{id}
// only when the user clicks Save or Open.

(() => {
  'use strict';

  // pickAndSend opens a native file picker, then POSTs the selected file
  // to uploadURL with X-Transfer-Filename / X-Transfer-Mime headers. Returns
  // the server's JSON response on success, throws on failure.
  function pickAndSend(uploadURL) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) { resolve(null); return; }
        try {
          const res = await sendFile(uploadURL, file);
          resolve(res);
        } catch (err) {
          reject(err);
        }
      }, { once: true });
      // Some browsers gate file pickers on user-gesture context; this
      // function is always invoked from a click handler, so direct .click()
      // works. The input is appended to allow that.
      document.body.appendChild(input);
      input.click();
    });
  }

  async function sendFile(uploadURL, file) {
    const r = await fetch(uploadURL, {
      method: 'POST',
      headers: {
        'X-Zoetrope': '1',
        'X-Transfer-Filename': encodeURIComponent(file.name || 'untitled'),
        'X-Transfer-Mime': file.type || 'application/octet-stream',
      },
      body: file,
    });
    if (!r.ok) {
      const msg = (await r.text()).trim() || ('HTTP ' + r.status);
      throw new Error(msg);
    }
    return r.json().catch(() => ({}));
  }

  function inboxURL(id) {
    return '/api/inbox/' + encodeURIComponent(id);
  }

  async function dismissInbox(id) {
    try {
      await fetch(inboxURL(id), { method: 'DELETE', headers: { 'X-Zoetrope': '1' } });
    } catch (err) {
      /* best-effort — entry will TTL out server-side anyway */
    }
  }

  // formatBytes renders 1234 as "1.2 KB", 1_500_000 as "1.4 MB", etc.
  // Used in the inbound notification ("Received: foo.pdf (340 KB)").
  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '? B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + units[i];
  }

  // renderInboundNotification appends a small notification card to `host`,
  // describing the received file and exposing Save / Open / Dismiss. The
  // node removes itself on any action. Returns the created node so the
  // caller can pin / position it.
  function renderInboundNotification(host, ev) {
    if (!host) return null;
    const card = document.createElement('div');
    card.className = 'xfer-notification';
    card.dataset.transferId = ev.transfer_id;

    const label = document.createElement('div');
    label.className = 'xfer-label';
    label.textContent = 'Received: ' + (ev.name || 'untitled') + ' (' + formatBytes(ev.size_bytes) + ')';
    card.appendChild(label);

    const actions = document.createElement('div');
    actions.className = 'xfer-actions';
    const save = mkBtn('Save', () => {
      const a = document.createElement('a');
      a.href = inboxURL(ev.transfer_id);
      a.download = ev.name || '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // GET consumes the inbox entry; nothing further to dismiss.
      card.remove();
    });
    const open = mkBtn('Open', () => {
      window.open(inboxURL(ev.transfer_id), '_blank', 'noopener');
      card.remove();
    });
    const dismiss = mkBtn('Dismiss', () => {
      dismissInbox(ev.transfer_id);
      card.remove();
    }, 'xfer-dismiss');
    actions.appendChild(save);
    actions.appendChild(open);
    actions.appendChild(dismiss);
    card.appendChild(actions);

    host.appendChild(card);
    return card;
  }

  function mkBtn(label, fn, extraClass) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (extraClass) b.className = extraClass;
    b.addEventListener('click', fn);
    return b;
  }

  window.zoetropeTransfer = {
    pickAndSend,
    inboxURL,
    dismissInbox,
    formatBytes,
    renderInboundNotification,
  };
})();
