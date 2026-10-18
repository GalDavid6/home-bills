// Owner tools for the active cycle: status card, per-kid manual entry, the family link
// (copy / replace), WhatsApp reminder/report and approve. Bills, tariff and water total come
// only from email (the daily ingest); the card shows them read-only. A classic script (UMD, like calc.js) so the pure
// helpers below are unit-tested in Node; the ESM rules (rules.mjs) and the photo downscaler
// (family-page.js) are loaded with dynamic import() only when the card runs in the browser.
(function () {
  const SITE = 'https://galdavid6.github.io/home-bills/';
  const KIDS = ['ירין', 'גל', 'ניב'];
  const TZ = 'Asia/Jerusalem';
  const REMINDER_HEAD = 'היי 👋 הגיע הזמן לצלם את המונים לחשבון החשמל.';
  const MSG_REPLACE = 'ליצור קישור חדש? הקישור הקודם יפסיק לעבוד';
  const MSG_APPROVE = 'לאשר ולפרסם את המחזור? המשפחה תראה את הדוח';
  const MSG_OVERRIDE = 'בדקתי, לשמור';
  const MSG_CONFIRM = 'כן, המספר נכון';
  const MSG_BAD_READING = 'נא להזין מספר בלבד';
  const MSG_PHOTO = 'התמונה לא נתמכת או גדולה מדי';
  const STATUS_TEXT = { open: 'ממתין לקריאות', ready: 'מוכן לאישור', published: 'פורסם' };

  // ---------- pure helpers ----------

  function whatsappUrl(text) {
    return 'https://wa.me/?text=' + encodeURIComponent(text);
  }

  // The one permanent family link: the report to view, plus the meter update while a cycle is open.
  function familyUrl(token) {
    return SITE + '#f=' + token;
  }

  function reminderText(url) {
    return `${REMINDER_HEAD}\nלעדכון: ${url}`;
  }

  // Link mode drops the site URL and the viewer-password lines: the family gets only its link.
  function reportText(results, url, formatMessage) {
    return formatMessage(results, { linkMode: true }) + `\n\nלצפייה בדוח: ${url}`;
  }

  // For display only: the card shows the start of the token, the copy button the whole link.
  function shortLink(url) {
    const m = /^(.*#f=)(.*)$/.exec(url || '');
    if (!m || m[2].length <= 8) return url || '';
    return m[1] + m[2].slice(0, 6) + '…';
  }

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  function israelParts(iso) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(iso));
    const p = {};
    parts.forEach((x) => { p[x.type] = x.value; });
    return p;
  }

  function israelDate(iso) {
    const p = israelParts(iso);
    return `${p.year}-${p.month}-${p.day}`;
  }

  // Spec: reading_date = the date of the last of the three readings (Israel calendar day).
  function defaultReadingDate(readings) {
    const times = (readings || [])
      .filter((r) => r.submitted_at && r.current_reading != null)
      .map((r) => new Date(r.submitted_at).getTime())
      .filter((t) => !isNaN(t));
    if (!times.length) return null;
    return israelDate(new Date(Math.max.apply(null, times)).toISOString());
  }

  function fmtSubmittedAt(iso) {
    if (!iso) return '';
    const p = israelParts(iso);
    return `${p.hour}:${p.minute} · ${Number(p.day)}.${Number(p.month)}`;
  }

  function wholeDays(fromIso, toIso) {
    const t = (iso) => {
      const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
      return Date.UTC(y, m - 1, d);
    };
    return Math.round((t(toIso) - t(fromIso)) / 86400000);
  }

  // Validation inputs for an owner entry: the kid's previous reading (previousByKid), whole
  // days since the last published reading date (at least 1), and the kid's history.
  function kidValidationInput({ history, kid, previous, today }) {
    const dated = (history || []).filter((h) => h.date)
      .slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const hist = dated
      .filter((h) => h.kids && h.kids[kid] && h.kids[kid].c != null && !isNaN(h.kids[kid].c))
      .map((h) => ({ date: h.date, consumption: h.kids[kid].c }));
    const last = dated.length ? dated[dated.length - 1].date : null;
    const days = last ? Math.max(wholeDays(last, today), 1) : 1;
    return { previous: Number(previous), days, history: hist };
  }

  // Each kid's previous reading = the previous published period's own current_reading;
  // baselines.last_reading only when that is missing. Baselines are output-only for publish,
  // so a publish that stopped after advancing them cannot skew a retry.
  function previousByKid({ prevReadings, baselines }) {
    const out = {};
    KIDS.forEach((name) => {
      const r = (prevReadings || []).find((x) => x.kid === name && x.current_reading != null);
      const b = (baselines || []).find((x) => x.kid === name && x.last_reading != null);
      out[name] = r ? Number(r.current_reading) : b ? Number(b.last_reading) : null;
    });
    return out;
  }

  // Everything publishCycle writes, computed with calc.js's computeCycle.
  // deps: { computeCycle, labelFromDate }.
  // previous: { kid: reading } from previousByKid.
  function planPublish({ period, readings, previous, readingDate }, deps) {
    if (period.tariff == null || period.tariff === '' || isNaN(Number(period.tariff))) {
      throw new Error('חסר תעריף חשמל, אי אפשר לפרסם');
    }
    if (period.water_total == null || period.water_total === '' || isNaN(Number(period.water_total))) {
      throw new Error('חסר סכום חשבון המים, אי אפשר לפרסם');
    }
    if (!readingDate) throw new Error('חסר תאריך קריאה');
    const kids = KIDS.map((name) => {
      const row = (readings || []).find((r) => r.kid === name);
      if (!row || row.current_reading == null) throw new Error(`חסרה קריאה של ${name}`);
      const prev = previous ? previous[name] : null;
      if (prev == null || isNaN(prev)) throw new Error(`חסרה קריאה קודמת של ${name}`);
      return { name, prev: Number(prev), current: Number(row.current_reading) };
    });
    const label = deps.labelFromDate(readingDate);
    const results = deps.computeCycle({
      period: label, waterTotal: Number(period.water_total), tariff: Number(period.tariff), kids,
    });
    const baselineMap = {};
    kids.forEach((k) => { baselineMap[k.name] = k.current; });
    return {
      label,
      readingDate,
      waterShare: results.waterShare,
      results,
      rows: results.kids.map((k) => ({ kid: k.name, consumption: round2(k.consumption), electricity: k.electricity })),
      baselines: baselineMap,
    };
  }

  function statusModel({ period, readings, documents }) {
    if (!period) return null;
    const docs = (documents || []).filter((d) => d.period_id === period.id);
    const kids = KIDS.map((name) => {
      const r = (readings || []).find((x) => x.period_id === period.id && x.kid === name);
      const done = !!(r && r.current_reading != null);
      return {
        kid: name,
        done,
        reading: done ? Number(r.current_reading) : null,
        at: done ? r.submitted_at || null : null,
        by: done ? r.submitted_by || null : null,
        photo: docs.find((d) => d.kind === 'meter_photo' && d.kid === name) || null,
      };
    });
    const missing = [];
    if (period.tariff == null || period.tariff === '') missing.push('tariff');
    if (period.water_total == null || period.water_total === '') missing.push('water_total');
    return {
      id: period.id,
      label: period.label || '',
      status: period.status,
      statusText: STATUS_TEXT[period.status] || period.status,
      kids,
      bills: {
        electricity: docs.some((d) => d.kind === 'electricity_bill'),
        water: docs.some((d) => d.kind === 'water_bill'),
      },
      missing,
      tariff: period.tariff == null || period.tariff === '' ? null : Number(period.tariff),
      canApprove: period.status === 'ready',
    };
  }

  // The approve sheet's checklist: both bills, the three meters and the tariff.
  function approveChecks(model) {
    const done = model.kids.filter((k) => k.done).length;
    return [
      { key: 'electricity', ok: model.bills.electricity, text: 'חשבון חשמל' },
      { key: 'water', ok: model.bills.water, text: 'חשבון מים' },
      { key: 'meters', ok: done === KIDS.length, text: done === KIDS.length ? '3 מונים' : `${done} מתוך 3 מונים` },
      { key: 'tariff', ok: model.tariff != null, text: model.tariff != null ? `תעריף ${model.tariff} ₪` : 'תעריף' },
      { key: 'waterTotal', ok: !model.missing.includes('water_total'), text: 'סכום מים' },
    ];
  }

  // A kid's previous reading as the owner card sees it: the last published period's own
  // reading, else the baseline (same order as saveOwnerReading's previousReadings).
  function ownerPrevious(state, kid) {
    const hist = state.history || [];
    const last = hist[hist.length - 1];
    if (last && last.kids && last.kids[kid] && last.kids[kid].reading != null) return last.kids[kid].reading;
    const row = (state.kids || []).find((x) => x.name === kid);
    return row ? row.lastReading : 0;
  }

  // What approving the active cycle would send: the WhatsApp text (with the family link, or
  // a placeholder when none was issued yet) and each kid's reading and consumption.
  // deps: { computeCycle, labelFromDate, compareCycle, formatMessage }. null without a cycle;
  // { ok: false, error } when the cycle cannot be published yet.
  function approvePreview({ state, readingDate, token }, deps) {
    const active = state.activeCycle;
    if (!active) return null;
    const previous = {};
    KIDS.forEach((k) => { previous[k] = ownerPrevious(state, k); });
    let plan;
    try {
      plan = planPublish({ period: active.period, readings: active.readings, previous, readingDate }, deps);
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const results = deps.compareCycle(plan.results, state.history || []);
    const url = token ? familyUrl(token) : SITE + '#f=…';
    const kids = plan.rows.map((r) => ({
      kid: r.kid,
      reading: Number(active.readings.find((x) => x.kid === r.kid).current_reading),
      consumption: r.consumption,
    }));
    return { ok: true, text: reportText(results, url, deps.formatMessage), kids, plan };
  }

  // formatMessage input for the newest published period, compared with the one before it.
  function reportResults(history, compareCycle) {
    if (!history || !history.length) return null;
    const h = history[history.length - 1];
    const names = KIDS.filter((n) => h.kids[n]);
    const waterTotal = h.waterTotal != null && !isNaN(h.waterTotal) ? h.waterTotal : h.waterShare * 4;
    const raw = {
      period: h.label,
      waterTotal,
      tariff: h.tariff,
      waterShare: h.waterShare,
      kids: names.map((n) => ({
        name: n, consumption: h.kids[n].c, electricity: h.kids[n].e,
        water: h.waterShare, total: h.kids[n].e + h.waterShare,
      })),
    };
    return compareCycle(raw, history.slice(0, -1));
  }

  // ---------- status card (browser only) ----------

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (v === false || v == null) return;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    kids.forEach((c) => { if (c != null && c !== false) n.append(c); });
    return n;
  }
  const ic = (name, size, sw) => window.icons.el(name, size, sw);
  const fmtN = (n, d) => (n == null || isNaN(n) ? '-' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d || 0 }));

  let rulesPromise = null;
  function loadRules() {
    if (!rulesPromise) rulesPromise = import('./rules.mjs?v=22ae56ce');
    return rulesPromise;
  }

  async function preparePhoto(file, rules) {
    try {
      const { downscaleImage } = await import('./family-page.js?v=62465187');
      const blob = await downscaleImage(file);
      return new File([blob], 'meter.jpg', { type: 'image/jpeg' });
    } catch (e) {
      if (rules.checkPhoto({ type: file.type, size: file.size })) throw new Error(MSG_PHOTO);
      return file;
    }
  }

  // ctx: { state, familyToken, store, reload(), out? }. reload() refetches state and the
  // stored family token, updates ctx and re-renders this card (and the rest of the page).
  async function renderOwnerCard(host, ctx) {
    const rules = await loadRules();
    const { store } = ctx;
    const state = ctx.state;
    const active = state.activeCycle;
    const model = active ? statusModel({ period: active.period, readings: active.readings, documents: state.documents }) : null;
    if (!ctx.out) ctx.out = el('div', { class: 'own-out', id: 'ownOut' });
    const out = ctx.out;
    const errMsg = (e) => (e && e.message) || String(e);
    const showErr = (text) => out.replaceChildren(el('div', { class: 'msg err', id: 'ownErr', role: 'alert' }, text));

    function showWa(text) {
      const url = whatsappUrl(text);
      out.replaceChildren(
        el('pre', { id: 'ownWaText' }, text),
        el('a', { id: 'ownWaGo', class: 'own-wa', href: url, target: '_blank', rel: 'noopener' }, 'פתיחה בוואטסאפ'),
      );
      // Usually opens WhatsApp directly; if the browser blocks it, the button above does it in one tap.
      try { window.open(url, '_blank'); } catch (e) { /* the button stays */ }
    }

    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
    }

    // The stored family link (issued on first use). The same link every time, so Gal can
    // pin it in the family group; replace only under "advanced" when it leaked.
    let famShown = null; // the link line in the family section, kept in step with ctx.familyToken
    async function familyLink() {
      const token = await store.getFamilyLink();
      ctx.familyToken = token;
      const u = familyUrl(token);
      if (famShown) famShown.textContent = shortLink(u);
      return u;
    }

    async function copyFamilyLink(btn, doneText) {
      try {
        const u = await familyLink();
        // The clipboard can refuse after the network wait (phones); then the link is shown whole to copy by hand.
        if (await copyText(u)) { if (btn) btn.replaceChildren(ic('check', 14, 2.6), doneText); return true; }
        out.replaceChildren(el('input', { id: 'ownLinkUrl', readonly: true, value: u, dir: 'ltr', 'aria-label': 'הקישור המשפחתי' }));
        return false;
      } catch (e) { showErr('הקישור לא נטען: ' + errMsg(e)); return false; }
    }

    function familySection() {
      const url = ctx.familyToken ? familyUrl(ctx.familyToken) : null;
      const shown = el('div', { class: 'own-famurl', id: 'ownFamUrl', dir: 'ltr' }, url ? shortLink(url) : 'עוד אין קישור');
      famShown = shown;
      const copy = el('button', { class: 'btn sm secondary', id: 'ownFamCopy', type: 'button' }, 'העתק');
      copy.addEventListener('click', () => copyFamilyLink(copy, 'הועתק'));
      const replace = el('button', { class: 'btn sm secondary', id: 'ownFamReplace', type: 'button' }, 'החלף קישור');
      replace.addEventListener('click', async () => {
        if (!window.confirm(MSG_REPLACE)) return;
        try {
          ctx.familyToken = await store.replaceFamilyLink();
          const u = familyUrl(ctx.familyToken);
          shown.textContent = shortLink(u);
          out.replaceChildren(el('input', { id: 'ownLinkUrl', readonly: true, value: u, dir: 'ltr', 'aria-label': 'הקישור המשפחתי' }));
          if (await copyText(u)) replace.replaceChildren(ic('check', 14, 2.6), 'הוחלף והועתק');
        } catch (e) { showErr('החלפת הקישור נכשלה: ' + errMsg(e)); }
      });
      return el('div', { class: 'own-section', id: 'ownFamily' },
        el('h3', { class: 'own-name' }, 'קישור משפחתי'),
        el('div', { class: 'btns' }, shown, copy),
        el('details', { class: 'own-adv', id: 'ownAdvanced' }, el('summary', {}, 'מתקדם'),
          el('div', { class: 'hint' }, 'אם הקישור דלף: קישור חדש, והקודם יפסיק לעבוד.'), replace));
    }

    // Per-kid entry or correction, in its own sheet.
    function openEdit(kid) {
      const k = model.kids.find((x) => x.kid === kid);
      const titleId = 'ownEditTitle';
      const input = el('input', { class: 'own-reading', type: 'text', inputmode: 'decimal', dir: 'ltr', id: 'ownEditReading',
        placeholder: 'קריאת המונה', 'data-autofocus': true, value: k.done ? String(k.reading) : '' });
      const photo = el('input', { class: 'own-photo', type: 'file', accept: 'image/*', id: 'ownEditPhoto' });
      const msg = el('div', { class: 'own-msg', role: 'status' });
      const save = el('button', { class: 'btn own-save', type: 'button' }, 'שמירה');
      const content = el('div', { class: 'own-form', 'data-kid': kid },
        el('div', { class: 'sheet-head' },
          el('h2', { id: titleId }, `${k.done ? 'תיקון' : 'הזנת'} קריאה של ${kid}`),
          el('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'סגירה', 'data-sheet-close': true }, ic('close', 14, 2.6))),
        el('label', { for: 'ownEditReading' }, `קריאה של ${kid}`), input,
        el('label', { for: 'ownEditPhoto' }, 'תמונת מונה (לא חובה)'), photo, msg, save);
      const sh = window.sheet.open({ id: 'ownEditSheet', labelledBy: titleId, content });
      // The reading the amber warning is about: its confirm button saves only that number.
      let pendingWarn = null;
      input.addEventListener('input', () => { pendingWarn = null; msg.replaceChildren(); });

      async function doSave(reading) {
        save.disabled = true;
        msg.replaceChildren(el('div', { class: 'hint' }, 'שומר...'));
        try {
          const file = photo.files && photo.files[0] ? await preparePhoto(photo.files[0], rules) : null;
          await store.saveOwnerReading(model.id, kid, reading, file);
          sh.close();
          await ctx.reload();
        } catch (e) {
          save.disabled = false;
          msg.replaceChildren(el('div', { class: 'msg err' }, 'שמירה נכשלה: ' + errMsg(e)));
        }
      }

      save.addEventListener('click', () => {
        const reading = rules.parseReadingInput(input.value);
        if (reading == null || reading <= 0) {
          msg.replaceChildren(el('div', { class: 'msg err' }, MSG_BAD_READING));
          return;
        }
        // Same previous as saveOwnerReading: the last published period's reading, else the baseline.
        const v = kidValidationInput({
          history: state.history, kid, previous: ownerPrevious(state, kid),
          today: israelDate(new Date().toISOString()),
        });
        const check = rules.validateReading({
          reading, previous: v.previous, days: v.days, maxDailyHistory: rules.maxDailyConsumption(v.history),
        });
        pendingWarn = null;
        if (check.level === 'ok') { doSave(reading); return; }
        if (check.level === 'warn') {
          // Same as the family page: amber warning, "yes, the number is right" saves exactly this number.
          pendingWarn = { reading };
          msg.replaceChildren(
            el('div', { class: 'msg warn' }, check.message),
            el('button', {
              class: 'btn warn own-confirm', type: 'button',
              onclick: () => { if (rules.confirmApplies(pendingWarn, reading)) doSave(reading); },
            }, MSG_CONFIRM));
          return;
        }
        // Blocked: the owner may still save, but only after saying he checked this number.
        msg.replaceChildren(
          el('div', { class: 'msg err' }, check.message),
          el('button', { class: 'btn secondary own-override', type: 'button', onclick: () => doSave(reading) }, MSG_OVERRIDE));
      });
      return sh;
    }

    function kidRow(kid) {
      const k = model.kids.find((x) => x.kid === kid);
      const editable = model.status !== 'published';
      return el('div', { class: 'own-kid', 'data-kid': kid },
        el('span', { class: 'own-name' }, kid),
        el('span', { class: 'own-state' + (k.done ? ' done' : '') }, ic(k.done ? 'check' : 'clock', 14, 2.4),
          el('span', {}, kidStatusText(k))),
        el('span', { class: 'own-btns' },
          k.photo ? el('button', {
            class: 'btn sm secondary own-photo-btn', type: 'button',
            onclick: async () => {
              try { window.open(await store.signedUrl(k.photo.storage_path), '_blank'); }
              catch (e) { showErr('פתיחת התמונה נכשלה: ' + errMsg(e)); }
            },
          }, ic('photo', 14), 'תמונה') : null,
          editable ? el('button', { class: 'btn sm secondary own-edit', type: 'button', onclick: () => openEdit(kid) },
            ic('edit', 14), k.done ? 'תיקון' : 'הזנה') : null));
    }

    function kidStatusText(k) {
      if (!k.done) return 'ממתין';
      return `${fmtSubmittedAt(k.at)} · ${k.reading}${k.by === 'owner' ? ' · הוזן ידנית' : ''}`;
    }

    function checksList() {
      return el('div', { class: 'ck-list', id: 'ownBills' }, ...approveChecks(model).map((c) =>
        el('div', { class: 'ck' + (c.ok ? '' : ' no'), 'data-check': c.key },
          el('i', { 'aria-hidden': 'true' }, c.ok ? ic('check', 11, 3.4) : ic('clock', 11, 3)),
          el('span', {}, c.text))));
    }

    // rethrow: the approve flow reports its own message after a successful publish.
    async function sendReport(rethrow) {
      try {
        const results = reportResults(ctx.state.history, window.compareCycle);
        if (!results) throw new Error('אין עדיין מחזור שפורסם');
        showWa(reportText(results, await familyLink(), window.formatMessage));
      } catch (e) {
        if (rethrow) throw e;
        showErr('שליחת הדוח נכשלה: ' + errMsg(e));
      }
    }

    function openApprove() {
      const deps = { computeCycle: window.computeCycle, labelFromDate: rules.labelFromDate,
        compareCycle: window.compareCycle, formatMessage: window.formatMessage };
      const date = el('input', { type: 'date', id: 'ownDate',
        value: defaultReadingDate(active.readings) || israelDate(new Date().toISOString()) });
      const preview = el('div', { class: 'wa-preview', id: 'ownPreview' });
      const rows = el('div', { id: 'ownApproveKids' });
      const msg = el('div', { role: 'alert' });
      const approve = el('button', { class: 'btn', id: 'ownApprove', type: 'button', disabled: !model.canApprove }, 'אשר ושלח');
      const copy = el('button', { class: 'icon-btn', id: 'ownApproveCopy', type: 'button', 'aria-label': 'העתק קישור משפחתי',
        title: 'העתק קישור משפחתי' }, ic('link', 20));
      let sh = null;
      function draw() {
        const p = approvePreview({ state, readingDate: date.value, token: ctx.familyToken }, deps);
        const readings = {};
        if (p && p.ok) p.kids.forEach((k) => { readings[k.kid] = k.reading; });
        rows.replaceChildren(...model.kids.map((k) => el('div', { class: 'appr-row', 'data-kid': k.kid },
          el('b', {}, k.kid),
          el('span', { class: 'num' }, k.done ? fmtN(readings[k.kid] != null ? readings[k.kid] : k.reading, 2) : 'ממתין'),
          el('button', { class: 'link-btn own-fix', type: 'button', 'data-kid': k.kid,
            onclick: () => { sh.close(); openEdit(k.kid); } }, k.done ? 'תיקון' : 'הזנה'))));
        preview.replaceChildren(el('div', { class: 't' }, 'ההודעה לוואטסאפ'),
          p && p.ok ? el('pre', { id: 'ownPreviewText' }, p.text) : el('div', { id: 'ownPreviewText' }, p ? p.error : ''));
      }
      date.addEventListener('change', draw);
      copy.addEventListener('click', async () => {
        if (await copyFamilyLink(null)) {
          copy.replaceChildren(ic('check', 20));
          setTimeout(() => copy.replaceChildren(ic('link', 20)), 1500);
        }
      });
      approve.addEventListener('click', async () => {
        if (!window.confirm(MSG_APPROVE)) return;
        approve.disabled = true;
        approve.textContent = 'מפרסם...';
        try {
          await store.publishCycle(model.id, date.value);
        } catch (e) {
          approve.disabled = false;
          approve.textContent = 'אשר ושלח';
          msg.replaceChildren(el('div', { class: 'msg err', id: 'ownApproveErr' }, 'הפרסום נכשל: ' + errMsg(e)));
          return;
        }
        sh.close();
        try {
          await ctx.reload();
          await sendReport(true);
        } catch (e) {
          showErr('פורסם; שליחת הדוח נכשלה, לחצו שלח דוח אחרון');
        }
      });
      const content = el('div', { class: 'approve' },
        el('div', { class: 'sheet-head' },
          el('div', {}, el('h2', { id: 'ownApproveTitle' }, 'אישור ושליחה'), el('div', { class: 'muted' }, model.label)),
          el('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'סגירה', 'data-sheet-close': true }, ic('close', 14, 2.6))),
        checksList(),
        rows,
        el('label', { for: 'ownDate' }, 'תאריך הקריאה'), date,
        preview,
        model.canApprove ? null : el('div', { class: 'hint' }, 'האישור יתאפשר כשכל הקריאות והחשבונות יגיעו'),
        msg,
        el('div', { class: 'appr-actions' }, approve, copy));
      draw();
      sh = window.sheet.open({ id: 'ownApproveSheet', labelledBy: 'ownApproveTitle', content });
      return sh;
    }

    const children = [];
    children.push(el('div', { class: 'own-head' },
      el('div', {}, el('div', { class: 'lbl' }, model ? `מחזור נוכחי · ${model.label}` : 'מחזור נוכחי')),
      el('span', { class: 'pill', id: 'ownStatus' }, model ? model.statusText : 'אין מחזור פתוח כרגע')));
    // Bills, tariff and water total come only from email: say plainly what is still missing.
    if (model && model.missing.length) {
      const notes = [];
      if (model.missing.includes('tariff')) notes.push('חסר תעריף');
      if (model.missing.includes('water_total')) notes.push('חסר סכום מים');
      children.push(el('div', { class: 'msg warn', id: 'ownMissing', role: 'status' }, notes.join(' · ')));
    }

    if (model) {
      children.push(el('div', { class: 'tiles3', id: 'ownTiles' }, ...model.kids.map((k) => {
        const used = k.done ? Math.round(k.reading - ownerPrevious(state, k.kid)) : null;
        return el('div', { class: 'tile', 'data-kid': k.kid }, el('div', { class: 'v' }, fmtN(used)),
          el('div', { class: 'l' }, `${k.kid} · קוט"ש`));
      })));
      KIDS.forEach((kid) => children.push(kidRow(kid)));
      children.push(checksList());
    }

    const actions = el('div', { class: 'btns own-actions' });
    if (model && model.status !== 'published') {
      actions.append(el('button', { class: 'btn', id: 'ownApproveOpen', type: 'button', onclick: openApprove },
        ic('check', 18, 2.4), 'אישור ושליחה'));
    }
    if (model && model.status === 'open') {
      actions.append(el('button', {
        class: 'btn secondary', id: 'ownRemind', type: 'button',
        onclick: async () => {
          try { showWa(reminderText(await familyLink())); }
          catch (e) { showErr('הקישור לא נטען, נסו שוב: ' + errMsg(e)); }
        },
      }, ic('bell', 18), 'שלח תזכורת'));
    }
    actions.append(el('button', { class: 'btn secondary', id: 'ownReport', type: 'button', onclick: () => sendReport() },
      ic('send', 18), 'שלח דוח אחרון'));
    children.push(actions, out, familySection());

    host.replaceChildren(el('div', { class: 'card', id: 'ownerCard' }, ...children));
  }

  const api = {
    whatsappUrl, familyUrl, reminderText, reportText, shortLink, planPublish, previousByKid, statusModel, reportResults,
    defaultReadingDate, fmtSubmittedAt, kidValidationInput, renderOwnerCard,
    approveChecks, ownerPrevious, approvePreview,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ownerCycle = api;
}());
