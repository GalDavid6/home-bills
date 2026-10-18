// Bottom sheets: a dimmed backdrop plus a dialog that slides up from the bottom.
// window.sheet.open({ id, label | labelledBy, content, full, dismissable, onClose }) returns
// { el, body, close(), setContent(node) }. role="dialog" + aria-modal, the page behind is
// inert while a sheet is open, focus moves in (first [data-autofocus] or focusable) and
// returns to the opener on close, Tab stays inside, Escape and a backdrop tap close it
// (unless dismissable is false). onClose runs only for a user dismissal (Escape / backdrop /
// a [data-sheet-close] button), not for close() called by code.
(function () {
  const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const stack = [];

  function setInert(on) {
    Array.from(document.body.children).forEach((n) => {
      if (n.classList.contains('sheet-layer')) return;
      if (on) {
        if (!n.hasAttribute('inert')) { n.setAttribute('inert', ''); n.dataset.sheetInert = '1'; }
      } else if (n.dataset.sheetInert) {
        n.removeAttribute('inert');
        delete n.dataset.sheetInert;
      }
    });
  }

  function visibleFocusables(root) {
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
  }

  function focusInto(dlg) {
    const target = dlg.querySelector('[data-autofocus]') || visibleFocusables(dlg)[0] || dlg;
    try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
  }

  function open(opts) {
    const o = opts || {};
    const dismissable = o.dismissable !== false;
    const opener = document.activeElement;
    // Only the top sheet is interactive: an earlier one goes inert under the new one.
    stack.forEach((s) => s.layer.setAttribute('inert', ''));

    const layer = document.createElement('div');
    layer.className = 'sheet-layer';
    const backdrop = document.createElement('div');
    backdrop.className = 'sheet-backdrop';
    const dlg = document.createElement('div');
    dlg.className = 'sheet' + (o.full ? ' sheet--full' : '');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.tabIndex = -1;
    if (o.id) dlg.id = o.id;
    if (o.labelledBy) dlg.setAttribute('aria-labelledby', o.labelledBy);
    else if (o.label) dlg.setAttribute('aria-label', o.label);
    if (!o.full) {
      const handle = document.createElement('div');
      handle.className = 'sheet-handle';
      handle.setAttribute('aria-hidden', 'true');
      dlg.appendChild(handle);
    }
    const body = document.createElement('div');
    body.className = 'sheet-body';
    if (o.content) body.appendChild(o.content);
    dlg.appendChild(body);
    layer.append(backdrop, dlg);
    document.body.appendChild(layer);
    document.body.classList.add('sheet-open');
    setInert(true);
    requestAnimationFrame(() => layer.classList.add('in'));

    let closed = false;
    function close(byUser) {
      if (closed) return;
      closed = true;
      dlg.removeEventListener('keydown', onKey);
      layer.remove();
      const i = stack.indexOf(handle_);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length) {
        const top = stack[stack.length - 1];
        top.layer.removeAttribute('inert');
      } else {
        setInert(false);
        document.body.classList.remove('sheet-open');
      }
      // A re-rendered opener (same id, new node) still gets the focus back.
      const back = opener && (opener.isConnected ? opener : (opener.id && document.getElementById(opener.id)));
      if (back && typeof back.focus === 'function' && !stack.length) {
        try { back.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
      if (byUser === true && typeof o.onClose === 'function') o.onClose();
    }

    function onKey(e) {
      if (e.key === 'Escape' && dismissable) {
        e.preventDefault();
        close(true);
        return;
      }
      if (e.key !== 'Tab') return;
      const f = visibleFocusables(dlg);
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    dlg.addEventListener('keydown', onKey);
    if (dismissable) backdrop.addEventListener('click', () => close(true));
    dlg.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-sheet-close]');
      if (btn && dlg.contains(btn)) close(true);
    });

    const handle_ = {
      el: dlg,
      body,
      layer,
      close: () => close(false),
      setContent(node) { body.replaceChildren(node); },
      get open() { return !closed; },
    };
    stack.push(handle_);
    focusInto(dlg);
    return handle_;
  }

  window.sheet = { open, focusInto };
}());
