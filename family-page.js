// Family meter flow. Two entry points, both loaded by index.html:
//   #f=<token>  (the family link): app.js renders the tabs; this module adds the open-cycle
//               card on the home tab, the kid chooser sheet and the update sheet.
//   #m=<token>  (older per-kid link): the same update screen for that one kid, as the page.
// The token lives in memory only (never storage, never a URL query, never logged) and is
// sent only as the x-access-token header.
import * as rules from './rules.mjs?v=22ae56ce';
import { updateStats, fmtNum, liveCheck, daysSince } from './update-stats.mjs?v=89a77724';

const { checkPhoto, familyUpdateCard } = rules;
const MSG_UNAUTHORIZED = 'הקישור אינו בתוקף';
const MSG_NETWORK = 'אין חיבור, נסו שוב';
const MSG_NEED_PHOTO = 'נא לצלם את המונה';
const MSG_BAD_READING = 'נא להזין מספר בלבד';
const MSG_PHOTO = 'התמונה לא נתמכת או גדולה מדי';
const MSG_OK = 'נראה תקין';
const KIDS = ['ירין', 'גל', 'ניב'];

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

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null && c !== false && c !== '') n.append(c);
  return n;
}
const ic = (name, size, sw) => window.icons.el(name, size, sw);

// family: true for the #f= link (home card + sheets); false for #m= (the page is the form).
export function startFamilyPage(token, { family = false } = {}) {
  const pageRoot = document.getElementById('familyView');
  const homeHost = family ? document.getElementById('famUpdateHost') : null;
  let fam = null; // family context { family, cycle, kids } or 'invalid'
  let ctx = null; // the current kid's context, or 'invalid'
  let thanks = null;
  let chooser = null; // open chooser sheet
  let kidSheet = null; // open update sheet
  // Per-kid form state.
  let blob = null;
  let previewUrl = null;
  let text = '';
  let serverWarn = null;
  // A warned number is armed by the first save press; only a second press with that same
  // number sends confirm=1 (Enter never does). Changing the number disarms it.
  let pendingWarn = null;
  let flash = null;
  let busy = false;
  let replacing = false;
  let saved = null;
  let refs = null; // live nodes of the open form

  async function api(action, init = {}) {
    const res = await fetch(`${apiBase()}?action=${action}`, { ...init, headers: { 'x-access-token': token } });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    return { status: res.status, body };
  }

  function resetForm() {
    blob = null;
    serverWarn = null;
    pendingWarn = null;
    flash = null;
    text = '';
    refs = null;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  }

  // ---------- home card ----------
  function renderHome() {
    if (!homeHost) return;
    const model = fam && fam !== 'invalid' ? familyUpdateCard(fam) : null;
    if (!model) { homeHost.replaceChildren(); return; }
    const done = KIDS.length - model.remaining.length;
    homeHost.replaceChildren(el('div', { class: 'hero-card', id: 'famUpdateCard' },
      el('div', { class: 'hero-top' },
        el('h2', { id: 'famOpenTitle' }, 'מחזור חדש פתוח'),
        el('span', { class: 'hero-badge', id: 'famCount' }, `${done} מתוך 3`)),
      el('div', { class: 'hero-sub' }, fam.cycle.label || ''),
      el('div', { class: 'kid-chips', id: 'famRemaining', role: 'list', 'aria-label': model.line },
        ...KIDS.map((k) => {
          const isDone = !model.remaining.includes(k);
          return el('span', { class: 'kid-chip' + (isDone ? ' done' : ''), role: 'listitem', 'data-kid': k },
            isDone ? ic('check', 12, 3) : null, k);
        })),
      el('button', { class: 'hero-btn', id: 'famUpdateBtn', type: 'button', onclick: () => { thanks = null; openChooser(); } },
        ic('camera', 20), 'עדכון מונה')));
  }

  // ---------- chooser sheet ----------
  function chooserContent() {
    const open = fam.cycle && fam.cycle.status === 'open';
    const left = fam.kids.filter((k) => !k.submitted).length;
    const sub = fam.cycle ? `${fam.cycle.label}${open ? ` · נשאר לעדכן ${left} מתוך 3` : ''}` : '';
    const kids = [el('div', { class: 'sheet-head' },
      el('div', {}, el('h2', { id: 'famChooserTitle' }, 'את המונה של מי מעדכנים?'),
        sub ? el('div', { class: 'muted', id: 'famCycle' }, sub) : null),
      el('button', { class: 'icon-btn sm', id: 'famChooserClose', type: 'button', 'aria-label': 'סגירה', 'data-sheet-close': true },
        ic('close', 14, 2.6)))];
    if (thanks) kids.push(el('div', { class: 'note fam-okbox', role: 'status' }, thanks));
    if (!fam.cycle) kids.push(el('p', { class: 'fam-big', id: 'famNoCycle' }, 'אין צורך בקריאה כרגע'));
    else if (!open) kids.push(el('p', { class: 'fam-big', id: 'famAllIn' }, 'כל הקריאות התקבלו, תודה!'));
    fam.kids.forEach((k) => {
      const row = el('button', {
        class: 'fam-kid' + (k.submitted ? ' is-done' : ''), type: 'button', 'data-kid': k.kid,
        onclick: () => openKid(k.kid),
      },
      el('span', { class: 'av', 'aria-hidden': 'true' }, k.submitted ? ic('check', 20, 3) : k.kid.slice(0, 1)),
      el('span', { class: 'fam-kid-main' },
        el('span', { class: 'fam-kid-name' }, k.kid),
        el('span', { class: 'fam-kid-prev' }, k.submitted
          ? `עודכן · ${fmtNum(k.submitted.reading, 2)}` : `קריאה קודמת ${fmtNum(k.previous, 2)}`)),
      k.submitted ? el('span', { class: 'fam-kid-done' }, 'עודכן') : el('span', { class: 'chev-ic' }, ic('next', 18, 2.2)));
      if (!open) row.disabled = true;
      kids.push(row);
    });
    kids.push(el('p', { class: 'sheet-foot' }, 'כשכל שלושת המונים וחשבונות החשמל והמים מגיעים, הדוח נשלח לאישור.'));
    return el('div', { class: 'chooser' }, ...kids);
  }

  function openChooser() {
    if (!fam || fam === 'invalid') return;
    if (chooser && chooser.open) { chooser.setContent(chooserContent()); return; }
    chooser = window.sheet.open({
      id: 'famChooserSheet', labelledBy: 'famChooserTitle', content: chooserContent(),
      onClose: () => { chooser = null; thanks = null; },
    });
  }

  function closeChooser() {
    if (chooser) { chooser.close(); chooser = null; }
  }

  // ---------- update screen ----------
  function kidCtx(kid) {
    const k = fam.kids.find((x) => x.kid === kid);
    return { ...k, cycle: fam.cycle };
  }

  function openKid(kid) {
    ctx = kidCtx(kid);
    replacing = false;
    saved = null;
    resetForm();
    closeChooser();
    kidSheet = window.sheet.open({
      id: 'famKidSheet', labelledBy: 'famGreeting', full: true, content: kidView(),
      // Escape / backdrop close the whole flow; the back button returns to the chooser.
      onClose: () => { kidSheet = null; resetForm(); thanks = null; },
    });
  }

  function backToChooser() {
    if (kidSheet) { kidSheet.close(); kidSheet = null; }
    resetForm();
    thanks = null;
    reloadFamily().then(() => openChooser());
  }

  function render() {
    // Typing while a photo decodes: the rebuilt field keeps the focus.
    const typing = document.activeElement && document.activeElement.id === 'famReading';
    const view = kidView();
    if (family) { if (kidSheet) kidSheet.setContent(view); }
    else pageRoot.firstChild.replaceChildren(view);
    const input = typing && document.getElementById('famReading');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  function greeting() {
    const name = ctx && ctx !== 'invalid' ? ctx.kid : '';
    return family
      ? el('h2', { class: 'upd-who', id: 'famGreeting' }, el('span', { class: 'a' }, 'מעדכנים את המונה של'), ' ', el('span', { class: 'b' }, name))
      : el('h2', { class: 'upd-who', id: 'famGreeting' }, el('span', { class: 'a' }, 'שלום'), ' ', el('span', { class: 'b' }, name));
  }

  function backButton() {
    if (!family) return null;
    return el('button', { class: 'circ', id: 'famBackChooser', type: 'button', 'aria-label': 'לבחור מישהו אחר', onclick: backToChooser },
      ic('back', 18, 2.2));
  }

  // A body-only screen (states without the form): a bar with "back" on top, then the content.
  function plainScreen(...kids) {
    const bar = family ? el('div', { class: 'upd-photo bar-only' }, el('div', { class: 'upd-bar' }, backButton())) : null;
    return el('div', { class: 'upd' }, bar, el('div', { class: 'upd-body' + (bar ? '' : ' flat') }, ...kids));
  }

  function chipsRow() {
    const days = daysSince(ctx.previousDate, todayIso());
    return el('div', { class: 'upd-chips' },
      el('span', { class: 'pill' }, 'חשמל'),
      ctx.cycle ? el('span', { class: 'pill', id: 'famCycle' }, ctx.cycle.label) : null,
      ctx.previousDate ? el('span', { class: 'pill', id: 'famDays' }, `לפני ${days} ימים`) : null);
  }

  function kidView() {
    if (ctx === 'invalid') return plainScreen(el('h2', { class: 'fam-big' }, MSG_UNAUTHORIZED));
    if (!ctx) return plainScreen(el('p', { class: 'muted' }, 'טוען...'));
    if (ctx.closed) {
      return plainScreen(greeting(), el('p', { class: 'fam-big', id: 'famClosed' }, ctx.closed),
        family ? el('button', { class: 'btn secondary', type: 'button', onclick: backToChooser }, 'לבחור מישהו אחר') : null);
    }
    if (!ctx.cycle) return plainScreen(greeting(), el('p', { class: 'fam-big', id: 'famNoCycle' }, 'אין צורך בקריאה כרגע'));
    if (saved) {
      return plainScreen(greeting(), chipsRow(),
        el('p', { class: 'fam-big', id: 'famThanks' }, 'תודה! הקריאה נשמרה'),
        el('p', { class: 'fam-num', id: 'famSavedNum' }, String(saved.reading)),
        replaceButton());
    }
    if (ctx.submitted && !replacing) {
      return plainScreen(greeting(), chipsRow(),
        el('p', { class: 'muted', style: 'text-align:center;margin:0' }, family ? 'הקריאה כבר נשלחה' : 'הקריאה שלך כבר נשלחה'),
        el('p', { class: 'fam-num', id: 'famSubmittedNum' }, String(ctx.submitted.reading)),
        ctx.submitted.photoUrl ? el('img', { class: 'fam-photo', src: ctx.submitted.photoUrl, alt: 'תמונת המונה שנשלחה' }) : null,
        replaceButton());
    }
    return form();
  }

  function replaceButton() {
    return el('button', {
      class: 'btn secondary', id: 'famReplace', type: 'button',
      onclick: () => { replacing = true; saved = null; resetForm(); render(); },
    }, 'להחליף קריאה');
  }

  function vctx() {
    return { previous: ctx.previous, days: daysSince(ctx.previousDate, todayIso()), maxDaily: ctx.maxDaily };
  }

  function form() {
    // One input, no capture attribute: iOS then offers Take Photo / Photo Library / Choose File and
    // Android shows its chooser, so the user picks camera or gallery with one button.
    const fileInput = el('input', { type: 'file', accept: 'image/*', id: 'famFile', class: 'fam-file', onchange: onFile });
    const pick = () => fileInput.click();
    // The slate backdrop is always there; a picked photo sits on it as a rounded card, so any
    // photo color lands on slate instead of bleeding to the edges.
    const photo = previewUrl
      ? el('div', { class: 'upd-photo has-img' },
        el('div', { class: 'upd-bar' }, backButton() || el('span'),
          el('button', { class: 'circ', id: 'famShoot', type: 'button', onclick: pick }, ic('camera', 16), 'צילום אחר')),
        el('img', { class: 'photo-card', id: 'famPreview', src: previewUrl, alt: 'תמונת המונה' }))
      : el('div', { class: 'upd-photo' },
        el('div', { class: 'upd-bar' }, backButton()),
        el('button', { class: 'shoot-big', id: 'famShoot', type: 'button', onclick: pick }, ic('camera', 22), 'צילום או תמונה'));

    const statPrev = el('div', { class: 'v num', id: 'famStatPrev' }, fmtNum(ctx.previous, 2));
    const statUsed = el('div', { class: 'v num', id: 'famStatUsed' }, '-');
    const statDaily = el('div', { class: 'v num', id: 'famStatDaily' }, '-');
    const input = el('input', {
      id: 'famReading', type: 'text', inputmode: 'decimal', autocomplete: 'off', class: 'fam-reading',
      value: text, 'aria-describedby': 'famMsg',
      oninput: (e) => {
        text = e.target.value;
        flash = null;
        if (pendingWarn && !rules.confirmApplies(pendingWarn, rules.parseReadingInput(text))) pendingWarn = null;
        refresh();
      },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); submit({ fromEnter: true }); } },
    });
    const msg = el('div', { id: 'famMsg', role: 'status', 'aria-live': 'polite' });
    const save = el('button', { class: 'btn fam-submit', id: 'famSubmit', type: 'button', onclick: () => submit() }, 'שמירה');
    refs = { input, msg, save, statUsed, statDaily };

    const body = el('div', { class: 'upd-body' },
      greeting(),
      chipsRow(),
      el('div', { class: 'tiles3' },
        el('div', { class: 'tile stat' }, statPrev, el('div', { class: 'l' }, 'קריאה קודמת')),
        el('div', { class: 'tile stat' }, statUsed, el('div', { class: 'l' }, 'קוט"ש במחזור')),
        el('div', { class: 'tile stat' }, statDaily, el('div', { class: 'l' }, 'ממוצע ליום'))),
      el('div', { class: 'upd-field' },
        el('label', { for: 'famReading' }, 'המספר על המונה, בלי הספרה האדומה'), input),
      msg, save, fileInput);
    const node = el('div', { class: 'upd fam-form' }, photo, body);
    refresh();
    return node;
  }

  function note(level, message, extraClass) {
    const dot = el('span', { class: 'dot', 'aria-hidden': 'true' }, level === 'ok' ? ic('check', 12, 3) : '!');
    return el('div', { class: `note ${level} ${extraClass}` }, dot, el('span', {}, message));
  }

  // Live: stats, the ok / warn / block message and the save button follow the typed number.
  function refresh() {
    if (!refs) return;
    const c = liveCheck(text, vctx(), serverWarn, rules);
    const s = updateStats({ reading: c.reading, previous: ctx.previous, days: vctx().days });
    refs.statUsed.textContent = fmtNum(s.used);
    refs.statDaily.textContent = fmtNum(s.daily, 1);
    refs.input.className = 'fam-reading' + (c.level === 'ok' || c.level === 'warn' || c.level === 'block' ? ' ' + c.level : '');
    const m = [];
    if (flash) m.push(note('block', flash, 'fam-err'));
    else if (c.level === 'ok') m.push(note('ok', MSG_OK, 'fam-ok'));
    else if (c.level === 'warn') m.push(note('warn', c.message, 'fam-warn'));
    else if (c.level === 'block' || c.level === 'invalid') m.push(note('block', c.message, 'fam-err'));
    refs.msg.replaceChildren(...m);
    const save = refs.save;
    const armed = c.level === 'warn' && rules.confirmApplies(pendingWarn, c.reading);
    save.classList.toggle('warn', armed);
    save.textContent = busy ? 'שולח...' : armed ? 'המספר נכון, לשמור' : 'שמירה';
    save.disabled = busy || c.level === 'block' || c.level === 'invalid';
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    flash = null;
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

  async function submit({ fromEnter = false } = {}) {
    if (busy) return;
    flash = null;
    const c = liveCheck(text, vctx(), serverWarn, rules);
    if (!blob) { flash = MSG_NEED_PHOTO; return refresh(); }
    if (c.level === 'empty' || c.level === 'invalid') { flash = MSG_BAD_READING; return refresh(); }
    if (c.level === 'block') return refresh();
    const reading = c.reading;
    // Two steps at warn: the first press arms the warning for this number; only a second press
    // (never Enter) with the same number sends the confirm.
    let confirmed = false;
    if (c.level === 'warn') {
      if (fromEnter || !rules.confirmApplies(pendingWarn, reading)) {
        pendingWarn = { reading };
        return refresh();
      }
      confirmed = true;
    }
    busy = true;
    refresh();
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
      return refresh();
    }
    busy = false;
    const msg = (res.body && res.body.error) || MSG_NETWORK;
    if (res.status === 200 && res.body && res.body.saved && family) {
      // Back to the chooser with the new "עודכן" (the home card is rebuilt from the same fetch).
      const kid = ctx.kid;
      if (kidSheet) { kidSheet.close(); kidSheet = null; }
      resetForm();
      await reloadFamily();
      thanks = `תודה! הקריאה של ${kid} נשמרה`;
      return openChooser();
    }
    if (res.status === 200 && res.body && res.body.saved) {
      saved = { reading: res.body.saved.reading };
      replacing = false;
      resetForm();
    } else if (res.status === 401) {
      ctx = 'invalid';
    } else if (res.status === 422 && res.body && res.body.level === 'warn') {
      serverWarn = { message: msg, reading };
      pendingWarn = { reading };
      return refresh();
    } else if (res.status === 409) {
      // The cycle closed under us: show the reason and drop the form.
      ctx = { ...ctx, closed: msg };
    } else {
      flash = msg;
      return refresh();
    }
    return render();
  }

  // Family link: refetch the three kids' state (after a save, or when going back).
  async function reloadFamily() {
    try {
      const res = await api('meter');
      if (res.status === 200 && res.body && res.body.family) fam = res.body;
      else if (res.status === 401) fam = 'invalid';
    } catch { /* keep the last known state; the next action reports the network */ }
    renderHome();
  }

  if (family) {
    // The report itself is rendered by app.js; without a usable family context the page
    // simply has no update card.
    reloadFamily();
    return;
  }

  pageRoot.hidden = false;
  pageRoot.replaceChildren(el('div', { class: 'meter-wrap' }, kidView()));
  // #m= renders into a fixed wrapper; render() replaces the wrapper's content.
  const mount = () => pageRoot.firstChild;
  api('meter').then((res) => {
    if (res.status === 200 && res.body) ctx = res.body;
    else if (res.status === 401) ctx = 'invalid';
    else { ctx = null; mount().replaceChildren(plainScreen(el('p', { class: 'fam-err note block' }, (res.body && res.body.error) || MSG_NETWORK))); return; }
    mount().replaceChildren(kidView());
  }).catch(() => mount().replaceChildren(plainScreen(el('p', { class: 'fam-err note block' }, MSG_NETWORK))));
}

const f = /^#f=([^&/]*)/.exec(location.hash);
const m = f ? null : /^#m=([^&/]*)/.exec(location.hash);
if (f && document.getElementById('famUpdateHost')) {
  // An empty or malformed token gets the invalid-link card from app.js.
  let token = '';
  try { token = decodeURIComponent(f[1]); } catch { /* malformed escape */ }
  if (token) startFamilyPage(token, { family: true });
} else if (m && document.getElementById('familyView')) {
  let token = '';
  try { token = decodeURIComponent(m[1]); } catch { /* malformed escape: treated as an invalid link */ }
  const root = document.getElementById('familyView');
  if (token) {
    startFamilyPage(token);
  } else {
    root.hidden = false;
    root.replaceChildren(el('div', { class: 'card center-card' }, el('h2', {}, MSG_UNAUTHORIZED)));
  }
}
