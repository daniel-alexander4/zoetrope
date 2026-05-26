// Shared modal a11y helper. Each overlay registered here gets:
//   - Focus moved inside on show; previous focus restored on hide.
//   - Tab cycling kept within the overlay.
//   - Escape triggers the cancel button (if one was passed).
// The overlays themselves stay as <div hidden>; this script watches the
// `hidden` attribute via MutationObserver so nothing in the existing
// show/hide call sites has to change.
(function () {
  function focusableWithin(root) {
    return Array.from(root.querySelectorAll(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent !== null || el === document.activeElement);
  }

  function installModal(overlay, opts) {
    if (!overlay) return;
    opts = opts || {};
    const cancelSel = opts.cancelSelector || null;
    const initialSel = opts.initialSelector || null;
    let lastFocus = null;

    function onKeyDown(e) {
      if (e.key === 'Escape' && cancelSel) {
        const cancelBtn = overlay.querySelector(cancelSel);
        if (cancelBtn) {
          e.preventDefault();
          cancelBtn.click();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const focusables = focusableWithin(overlay);
      if (focusables.length === 0) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }

    function show() {
      lastFocus = document.activeElement;
      const initial = (initialSel && overlay.querySelector(initialSel)) || focusableWithin(overlay)[0];
      if (initial) initial.focus();
      document.addEventListener('keydown', onKeyDown, true);
    }
    function hide() {
      document.removeEventListener('keydown', onKeyDown, true);
      if (lastFocus && document.body.contains(lastFocus)) {
        try { lastFocus.focus(); } catch (_) {}
      }
      lastFocus = null;
    }

    // Initial state: if the overlay is already visible at install time,
    // wire focus immediately; otherwise wait for the next show.
    const isOpen = () => !overlay.hasAttribute('hidden') &&
      (overlay.className.indexOf('dialog') === -1 || overlay.classList.contains('open'));
    if (isOpen()) show();

    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.attributeName === 'hidden' || m.attributeName === 'class') {
          if (isOpen()) show(); else hide();
        }
      }
    });
    obs.observe(overlay, { attributes: true, attributeFilter: ['hidden', 'class'] });
  }

  window.installModalA11y = installModal;
})();
