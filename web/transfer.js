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

  // entryURLFor returns the fetch URL for a file-received SSE event. The
  // server sends `entry_url` directly for bound entries (persisted under
  // the client dir) and we fall back to the legacy in-memory URL when
  // older events don't carry it.
  function entryURLFor(ev) {
    return ev.entry_url || inboxURL(ev.transfer_id);
  }

  async function dismissInbox(ev) {
    // Persistent (client-bound) entries delete via their entry_url;
    // in-memory entries delete via /api/inbox/{id}. The DELETE-on-
    // entry_url path also works for the persistent case.
    const url = entryURLFor(ev);
    try {
      await fetch(url, { method: 'DELETE', headers: { 'X-Zoetrope': '1' } });
    } catch (err) {
      /* best-effort — in-memory entries TTL out anyway, persistent entries can be re-dismissed from the Files card */
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
    const url = entryURLFor(ev);
    const save = mkBtn('Save', () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = ev.name || '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // For in-memory entries the GET consumed the entry. For bound
      // entries the file survives on disk and is managed from the
      // Files card; either way we drop this transient notification.
      card.remove();
    });
    const open = mkBtn('Open', () => {
      window.open(url, '_blank', 'noopener');
      card.remove();
    });
    const dismiss = mkBtn('Dismiss', () => {
      dismissInbox(ev);
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
    entryURLFor,
    dismissInbox,
    formatBytes,
    renderInboundNotification,
  };
})();
