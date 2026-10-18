// Family meter flow. Two entry points, both loaded by index.html:
//   #m=<token>  (older per-kid link): one kid submits a meter photo + reading.
//   #f=<token>  (the one family link): index.html renders the report; this module adds the
//               "new cycle open" card on top, the kid chooser and the same single-kid flow.
// The token lives in memory only (never storage, never a URL query, never logged).
import { parseReadingInput, validateReading, checkPhoto, familyUpdateCard } from './rules.mjs';

const MSG_UNAUTHORIZED = 'הקישור אינו בתוקף';
const MSG_NETWORK = 'אין חיבור, נסו שוב';
const MSG_NEED_PHOTO = 'נא לצלם את המונה';
const MSG_BAD_READING = 'נא להזין מספר בלבד';
const MSG_PHOTO = 'התמונה לא נתמכת או גדולה מדי';

// Resizes to maxSide on the long edge and re-encodes as JPEG, honouring EXIF orientation.
export async function downscaleImage(file, maxSide = 1600) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await createImageBitmap(file);
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.85);
  });
}

// Dev-only: on localhost, ?mock=PORT points the page at the scripts/mock-family.js server.
function apiBase() {
  const m = /^\?mock=(\d{2,5})$/.exec(location.search);
  if (m && location.hostname === 'localhost') return `http://localhost:${m[1]}/functions/v1/family`;
  return `${window.CONFIG.SUPABASE_URL}/functions/v1/family`;
}

function wholeDaysSince(iso) {
  if (!iso) return 1;
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const now = new Date();
  const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(y, m - 1, d)) / 86400000);
  return Math.max(days, 1);
}

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids) n.append(c);
  return n;
}

// family: true for the #f= link. The page then starts on the report (view 'home').
export function startFamilyPage(token, { family = false } = {}) {
  const root = document.getElementById('familyView');
  const homeHost = family ? document.getElementById('famUpdateHost') : null;
  if (!family) root.style.display = 'block';
  let ctx = null; // the single kid's context (#m=, or the kid chosen on the family link)
  let fam = null; // the family context { family, cycle, kids }
  let view = family ? 'home' : 'kid';
  let thanks = null; // chooser notice after a save
  let blob = null;
  let previewUrl = null;
  let pendingWarn = null;
  let flash = null;
  let busy = false;
  let replacing = false;
  let saved = null;

  async function api(action, init = {}) {
    const res = await fetch(`${apiBase()}?action=${action}`, {
      ...init,
      headers: { 'x-access-token': token },
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    return { status: res.status, body };
  }

  function setView(...nodes) {
    root.replaceChildren(...nodes);
  }

  function card(...kids) {
    return el('div', { class: 'card fam-card' }, ...kids);
  }

  function notice(text, cls) {
    return el('div', { class: `fam-note ${cls}`, role: 'alert' }, text);
  }

  // Family link: switches between the report (home) and the update screens.
  function show(next) {
    view = next;
    const home = view === 'home';
    document.getElementById('homeView').style.display = home ? 'block' : 'none';
    document.getElementById('archiveView').style.display = 'none';
    root.style.display = home ? 'none' : 'block';
    window.scrollTo(0, 0);
    render();
  }

  function kidCtx(kid) {
    const k = fam.kids.find((x) => x.kid === kid);
    return { ...k, cycle: fam.cycle };
  }

  function renderHome() {
    const model = familyUpdateCard(fam);
    if (!model) return homeHost.replaceChildren();
    return homeHost.replaceChildren(el('div', { class: 'card fam-card fam-update', id: 'famUpdateCard' },
      el('h2', { id: 'famOpenTitle' }, 'מחזור חדש פתוח'),
      el('p', { class: 'fam-big', id: 'famRemaining' }, model.line),
      el('button', { class: 'fam-btn', id: 'famUpdateBtn', type: 'button', onclick: () => { thanks = null; show('chooser'); } },
        'עדכון מונה')));
  }

  function renderChooser() {
    const kids = [el('h2', { id: 'famChooserTitle' }, 'את המונה של מי מעדכנים?')];
    if (fam.cycle) kids.push(el('div', { class: 'fam-muted', id: 'famCycle' }, fam.cycle.label));
    if (thanks) kids.push(notice(thanks, 'fam-okbox'));
    const open = fam.cycle && fam.cycle.status === 'open';
    if (!fam.cycle) kids.push(el('p', { class: 'fam-big', id: 'famNoCycle' }, 'אין צורך בקריאה כרגע'));
    else if (!open) kids.push(el('p', { class: 'fam-big fam-ok', id: 'famAllIn' }, 'כל הקריאות התקבלו, תודה!'));
    fam.kids.forEach((k) => {
      const row = el('button', {
        class: 'fam-kid', type: 'button', 'data-kid': k.kid,
        onclick: () => { ctx = kidCtx(k.kid); replacing = false; saved = null; resetForm(); form.draft = ''; show('kid'); },
      },
      el('span', { class: 'fam-kid-name' }, k.kid),
      el('span', { class: 'fam-kid-prev' }, `קריאה קודמת ${k.previous}`),
      k.submitted ? el('span', { class: 'fam-kid-done' }, '✅ עודכן') : '');
      if (!open) row.disabled = true;
      kids.push(row);
    });
    kids.push(el('button', { class: 'secondary fam-btn', id: 'famBackHome', type: 'button', onclick: () => show('home') }, 'חזרה לדוח'));
    return setView(card(...kids));
  }

  function backToChooser() {
    return el('button', {
      class: 'secondary fam-btn', id: 'famBackChooser', type: 'button',
      onclick: () => { resetForm(); thanks = null; reloadFamily().then(() => show('chooser')); },
    }, 'לבחור מישהו אחר');
  }

  function render() {
    if (family && fam === 'invalid') {
      if (view === 'home') return homeHost.replaceChildren();
      return setView(card(el('h2', {}, MSG_UNAUTHORIZED)));
    }
    if (family && view === 'home') return fam ? renderHome() : undefined;
    if (family && view === 'chooser') return renderChooser();
    if (ctx === 'invalid') {
      return setView(card(el('h2', {}, MSG_UNAUTHORIZED)));
    }
    if (!ctx) return setView(card(el('p', { class: 'fam-muted' }, 'טוען...')));
    const title = family ? `מעדכנים את המונה של ${ctx.kid}` : `שלום ${ctx.kid}`;
    const back = family ? backToChooser() : '';
    if (ctx.closed) {
      return setView(card(el('h2', { id: 'famGreeting' }, title),
        el('p', { class: 'fam-big', id: 'famClosed' }, ctx.closed), back));
    }
    const head = el('div', { class: 'fam-head' },
      el('h2', { id: 'famGreeting' }, title),
      ctx.cycle ? el('div', { class: 'fam-muted', id: 'famCycle' }, ctx.cycle.label) : '');
    if (!ctx.cycle) {
      return setView(card(head, el('p', { class: 'fam-big', id: 'famNoCycle' }, 'אין צורך בקריאה כרגע'), back));
    }
    if (saved) {
      return setView(card(head,
        el('p', { class: 'fam-big fam-ok', id: 'famThanks' }, 'תודה! הקריאה נשמרה'),
        el('p', { class: 'fam-num', id: 'famSavedNum' }, String(saved.reading)),
        replaceButton()));
    }
    if (ctx.submitted && !replacing) {
      const kids = [head,
        el('p', { class: 'fam-muted' }, family ? 'הקריאה כבר נשלחה' : 'הקריאה שלך כבר נשלחה'),
        el('p', { class: 'fam-num', id: 'famSubmittedNum' }, String(ctx.submitted.reading))];
      if (ctx.submitted.photoUrl) kids.push(el('img', { class: 'fam-photo', src: ctx.submitted.photoUrl, alt: '' }));
      kids.push(replaceButton(), back);
      return setView(card(...kids));
    }
    return setView(card(head, form(), back));
  }

  function replaceButton() {
    return el('button', {
      class: 'secondary fam-btn', id: 'famReplace', type: 'button',
      onclick: () => { replacing = true; saved = null; resetForm(); render(); },
    }, 'להחליף קריאה');
  }

  function resetForm() {
    blob = null;
    pendingWarn = null;
    flash = null;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  }

  function form() {
    const fileInput = el('input', {
      type: 'file', accept: 'image/*', capture: 'environment', id: 'famFile', class: 'fam-file',
      onchange: onFile,
    });
    const shoot = el('button', {
      class: 'fam-btn', id: 'famShoot', type: 'button', onclick: () => fileInput.click(),
    }, '📸 צלם את המונה');
    const kids = [fileInput, shoot];
    if (previewUrl) kids.push(el('img', { class: 'fam-photo', id: 'famPreview', src: previewUrl, alt: '' }));
    kids.push(
      el('label', { for: 'famReading' }, 'קריאת המונה'),
      el('input', {
        id: 'famReading', type: 'text', inputmode: 'decimal', autocomplete: 'off',
        class: 'fam-reading', value: form.draft || '',
        oninput: (e) => {
          form.draft = e.target.value;
          // A changed number must be validated afresh: drop the warning (and its confirm button).
          if (pendingWarn && parseReadingInput(form.draft) !== pendingWarn.reading) {
            pendingWarn = null;
            render();
            const input = document.getElementById('famReading');
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
        },
      }),
      el('div', { class: 'fam-muted fam-hint', id: 'famHint' }, `קריאה קודמת: ${ctx.previous}`));
    if (flash) kids.push(notice(flash, 'fam-err'));
    if (pendingWarn) {
      kids.push(
        notice(pendingWarn.message, 'fam-warn'),
        el('div', { class: 'fam-actions' },
          el('button', { class: 'fam-btn', id: 'famConfirm', type: 'button', onclick: () => submit(true) }, 'כן, המספר נכון'),
          el('button', { class: 'secondary fam-btn', id: 'famFix', type: 'button', onclick: () => { pendingWarn = null; render(); } }, 'לתקן')));
    } else {
      kids.push(el('button', {
        class: 'fam-btn fam-submit', id: 'famSubmit', type: 'button', onclick: () => submit(false),
      }, busy ? 'שולח...' : 'אישור'));
    }
    return el('div', { class: 'fam-form' }, ...kids);
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    flash = null;
    pendingWarn = null;
    try {
      blob = await downscaleImage(file);
    } catch {
      // Formats the browser cannot decode (e.g. HEIC off-Safari): send the original if it is acceptable.
      blob = checkPhoto({ type: file.type, size: file.size }) === null ? file : null;
      if (!blob) flash = MSG_PHOTO;
    }
    if (blob && checkPhoto({ type: blob.type, size: blob.size }) !== null) {
      blob = null;
      flash = MSG_PHOTO;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = blob ? URL.createObjectURL(blob) : null;
    render();
  }

  async function submit(wantConfirm) {
    let confirmed = wantConfirm;
    if (busy) return;
    flash = null;
    const reading = parseReadingInput(form.draft || '');
    if (!blob) { flash = MSG_NEED_PHOTO; pendingWarn = null; return render(); }
    if (reading == null || reading <= 0) { flash = MSG_BAD_READING; pendingWarn = null; return render(); }
    // Confirm only ever applies to the exact number that was warned about.
    if (confirmed && (!pendingWarn || pendingWarn.reading !== reading)) confirmed = false;
    if (!confirmed) {
      const check = validateReading({
        reading, previous: ctx.previous, days: wholeDaysSince(ctx.previousDate), maxDailyHistory: ctx.maxDaily,
      });
      if (check.level === 'block') { flash = check.message; pendingWarn = null; return render(); }
      if (check.level === 'warn') { pendingWarn = { message: check.message, reading }; return render(); }
    }
    busy = true;
    render();
    const fd = new FormData();
    fd.append('photo', blob, 'meter.jpg');
    fd.append('reading', String(reading));
    if (family) fd.append('kid', ctx.kid);
    if (confirmed) fd.append('confirm', '1');
    let res;
    try {
      res = await api('submit', { method: 'POST', body: fd });
    } catch {
      busy = false;
      flash = MSG_NETWORK;
      return render();
    }
    busy = false;
    const msg = (res.body && res.body.error) || MSG_NETWORK;
    if (res.status === 200 && res.body && res.body.saved && family) {
      // Back to the chooser with the new ✅ (the home card is rebuilt from the same fetch).
      const kid = ctx.kid;
      resetForm();
      form.draft = '';
      await reloadFamily();
      thanks = `תודה! הקריאה של ${kid} נשמרה`;
      return show('chooser');
    } else if (res.status === 200 && res.body && res.body.saved) {
      saved = { reading: res.body.saved.reading };
      replacing = false;
      resetForm();
      form.draft = '';
    } else if (res.status === 401) {
      ctx = 'invalid';
    } else if (res.status === 422 && res.body && res.body.level === 'warn') {
      pendingWarn = { message: msg, reading };
    } else if (res.status === 409) {
      // The cycle closed under us: show the reason and drop the form.
      ctx = { ...ctx, closed: msg };
    } else {
      flash = msg;
    }
    render();
  }

  // Family link: refetch the three kids' state (after a save, or when going back).
  async function reloadFamily() {
    try {
      const res = await api('meter');
      if (res.status === 200 && res.body && res.body.family) fam = res.body;
      else if (res.status === 401) fam = 'invalid';
    } catch { /* keep the last known state; the next action reports the network */ }
    if (family && view === 'home') render();
  }

  if (family) {
    // The report itself is rendered by index.html; without a usable family context the
    // page simply has no update card.
    reloadFamily();
    return;
  }

  render();
  api('meter').then((res) => {
    if (res.status === 200 && res.body) { ctx = res.body; }
    else if (res.status === 401) { ctx = 'invalid'; }
    else { ctx = null; setView(card(el('p', { class: 'fam-err' }, (res.body && res.body.error) || MSG_NETWORK))); return; }
    render();
  }).catch(() => setView(card(el('p', { class: 'fam-err' }, MSG_NETWORK))));
}

const f = /^#f=([^&/]*)/.exec(location.hash);
const m = f ? null : /^#m=([^&/]*)/.exec(location.hash);
if (f && document.getElementById('famUpdateHost')) {
  // An empty or malformed token gets the invalid-link card from index.html's report boot.
  let token = '';
  try { token = decodeURIComponent(f[1]); } catch { /* malformed escape */ }
  if (token) startFamilyPage(token, { family: true });
} else if (m && document.getElementById('familyView')) {
  let token = '';
  try { token = decodeURIComponent(m[1]); } catch { /* malformed escape: treated as an invalid link */ }
  if (token) {
    startFamilyPage(token);
  } else {
    const root = document.getElementById('familyView');
    root.style.display = 'block';
    root.innerHTML = `<div class="card fam-card"><h2>${MSG_UNAUTHORIZED}</h2></div>`;
  }
}
