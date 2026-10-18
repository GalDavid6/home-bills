// Owner tools for the active cycle: status card, per-kid manual entry, link issue/revoke,
// WhatsApp reminder/report and approve. A classic script (UMD, like calc.js) so the pure
// helpers below are unit-tested in Node; the ESM rules (rules.mjs) and the photo downscaler
// (family-page.js) are loaded with dynamic import() only when the card runs in the browser.
(function () {
  const SITE = 'https://galdavid6.github.io/home-bills/';
  const KIDS = ['ירין', 'גל', 'ניב'];
  const TZ = 'Asia/Jerusalem';
  const REMINDER_HEAD = 'היי 👋 הגיע הזמן לצלם את המונים לחשבון החשמל.';
  const MSG_REPLACE = 'ליצור קישור חדש? הקישור הקודם יפסיק לעבוד';
  const MSG_REPLACE_ALL = 'ליצור קישורים חדשים לשלושת הילדים? הקישורים הקודמים יפסיקו לעבוד';
  const MSG_REVOKE = 'לבטל את הקישור? הוא יפסיק לעבוד';
  const MSG_APPROVE = 'לאשר ולפרסם את המחזור? המשפחה תראה את הדוח';
  const MSG_OVERRIDE = 'בדקתי, לשמור';
  const MSG_BAD_READING = 'נא להזין מספר בלבד';
  const MSG_PHOTO = 'התמונה לא נתמכת או גדולה מדי';
  const STATUS_TEXT = { open: 'ממתין לקריאות', ready: 'מוכן לאישור', published: 'פורסם' };

  // ---------- pure helpers ----------

  function whatsappUrl(text) {
    return 'https://wa.me/?text=' + encodeURIComponent(text);
  }

  function linkUrl(kind, token) {
    return SITE + (kind === 'report' ? '#r=' : '#m=') + token;
  }

  // links: [{ kid, url }] in kid order.
  function reminderText(links) {
    return [REMINDER_HEAD].concat(links.map((l) => `${l.kid}: ${l.url}`)).join('\n');
  }

  // Link mode drops the site URL and the viewer-password lines: the family gets only the report link.
  function reportText(results, reportUrl, formatMessage) {
    return formatMessage(results, { linkMode: true }) + `\n\nלצפייה בדוח: ${reportUrl}`;
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
      canApprove: period.status === 'ready',
    };
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

  let rulesPromise = null;
  function loadRules() {
    if (!rulesPromise) rulesPromise = import('./rules.mjs');
    return rulesPromise;
  }

  async function preparePhoto(file, rules) {
    try {
      const { downscaleImage } = await import('./family-page.js');
      const blob = await downscaleImage(file);
      return new File([blob], 'meter.jpg', { type: 'image/jpeg' });
    } catch (e) {
      if (rules.checkPhoto({ type: file.type, size: file.size })) throw new Error(MSG_PHOTO);
      return file;
    }
  }

  // ctx: { state, links, store, reload(), out? }. reload() refetches state + links,
  // updates ctx.state/ctx.links and re-renders this card (and the rest of the page).
  async function renderOwnerCard(host, ctx) {
    const rules = await loadRules();
    const { store } = ctx;
    const state = ctx.state;
    const active = state.activeCycle;
    const model = active ? statusModel({ period: active.period, readings: active.readings, documents: state.documents }) : null;
    if (!ctx.out) ctx.out = el('div', { class: 'own-out', id: 'ownOut' });
    const out = ctx.out;
    const rerender = () => renderOwnerCard(host, ctx);
    const hasLink = (kind, kid) => (ctx.links || []).some((l) => l.kind === kind && (l.kid || null) === (kid || null));
    const markLink = (kind, kid, on) => {
      ctx.links = (ctx.links || []).filter((l) => !(l.kind === kind && (l.kid || null) === (kid || null)));
      if (on) ctx.links.push({ kind, kid: kid || null });
    };
    const errMsg = (e) => (e && e.message) || String(e);
    const showErr = (text) => out.replaceChildren(el('div', { class: 'msg err', id: 'ownErr' }, text));

    function showLink(title, url) {
      const input = el('input', { id: 'ownLinkUrl', readonly: true, value: url, dir: 'ltr' });
      const copy = el('button', { class: 'secondary own-sm', id: 'ownLinkCopy' }, 'העתק');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); copy.textContent = 'הועתק ✓'; }
        catch (e) { input.select(); }
      });
      out.replaceChildren(el('div', { class: 'own-linkbox' }, el('div', { class: 'own-title' }, title), input, copy));
    }

    function showWa(text) {
      const url = whatsappUrl(text);
      out.replaceChildren(
        el('pre', { id: 'ownWaText' }, text),
        el('a', { id: 'ownWaGo', class: 'own-wa', href: url, target: '_blank', rel: 'noopener' }, '📲 פתח WhatsApp'),
      );
      // Usually opens WhatsApp directly; if the browser blocks it, the button above does it in one tap.
      try { window.open(url, '_blank'); } catch (e) { /* the button stays */ }
    }

    async function issue(kind, kid, copyNow) {
      if (hasLink(kind, kid) && !window.confirm(MSG_REPLACE)) return;
      try {
        const token = await store.issueLink(kind, kid);
        markLink(kind, kid, true);
        const url = linkUrl(kind, token);
        rerender();
        showLink(kind === 'report' ? 'קישור לדוח' : `הקישור של ${kid}`, url);
        if (copyNow) {
          try { await navigator.clipboard.writeText(url); document.getElementById('ownLinkCopy').textContent = 'הועתק ✓'; }
          catch (e) { /* the copy button stays */ }
        }
      } catch (e) { showErr('יצירת הקישור נכשלה: ' + errMsg(e)); }
    }

    async function revoke(kind, kid) {
      if (!window.confirm(MSG_REVOKE)) return;
      try {
        await store.revokeLink(kind, kid);
        markLink(kind, kid, false);
        out.replaceChildren();
        rerender();
      } catch (e) { showErr('ביטול הקישור נכשל: ' + errMsg(e)); }
    }

    function linkButtons(kind, kid) {
      return [
        el('button', { class: 'secondary own-sm own-copy', onclick: () => issue(kind, kid, true) }, 'העתק קישור'),
        el('button', { class: 'secondary own-sm own-new', onclick: () => issue(kind, kid, false) }, 'קישור חדש'),
        hasLink(kind, kid) ? el('button', { class: 'secondary own-sm own-revoke', onclick: () => revoke(kind, kid) }, 'בטל קישור') : null,
      ];
    }

    function entryForm(k) {
      const input = el('input', { class: 'own-reading', type: 'text', inputmode: 'decimal', dir: 'ltr', placeholder: 'קריאת המונה' });
      const photo = el('input', { class: 'own-photo', type: 'file', accept: 'image/*' });
      const msg = el('div', { class: 'own-msg' });
      const save = el('button', { class: 'own-save' }, 'שמור');
      const form = el('div', { class: 'own-form', hidden: true },
        el('label', {}, `קריאה של ${k.kid}`), input,
        el('label', {}, 'תמונת מונה (לא חובה)'), photo, save, msg);
      input.addEventListener('input', () => msg.replaceChildren());

      async function doSave(reading) {
        save.disabled = true;
        msg.replaceChildren(el('div', { class: 'hint' }, 'שומר...'));
        try {
          const file = photo.files && photo.files[0] ? await preparePhoto(photo.files[0], rules) : null;
          await store.saveOwnerReading(model.id, k.kid, reading, file);
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
        const kidRow = (state.kids || []).find((x) => x.name === k.kid);
        const lastPub = (state.history || [])[(state.history || []).length - 1];
        const prevReading = lastPub && lastPub.kids[k.kid] && lastPub.kids[k.kid].reading != null
          ? lastPub.kids[k.kid].reading : (kidRow ? kidRow.lastReading : 0);
        const v = kidValidationInput({
          history: state.history, kid: k.kid, previous: prevReading,
          today: israelDate(new Date().toISOString()),
        });
        const check = rules.validateReading({
          reading, previous: v.previous, days: v.days, maxDailyHistory: rules.maxDailyConsumption(v.history),
        });
        if (check.level === 'ok') { doSave(reading); return; }
        // The owner may save past a block or a warning, but only after saying he checked this number.
        msg.replaceChildren(
          el('div', { class: 'msg ' + (check.level === 'block' ? 'err' : 'warn') }, check.message),
          el('button', { class: 'secondary own-override', onclick: () => doSave(reading) }, MSG_OVERRIDE),
        );
      });
      return form;
    }

    function kidRow(kid) {
      const k = model ? model.kids.find((x) => x.kid === kid) : null;
      let stateText = null;
      if (k) {
        stateText = k.done
          ? `✅ ${fmtSubmittedAt(k.at)} · ${k.reading}${k.by === 'owner' ? ' · הוזן ידנית' : ''}`
          : '⏳ ממתין';
      }
      const form = model && model.status !== 'published' ? entryForm(k) : null;
      const btns = el('div', { class: 'own-btns' },
        k && k.photo ? el('button', {
          class: 'secondary own-sm own-photo-btn',
          onclick: async () => {
            try { window.open(await store.signedUrl(k.photo.storage_path), '_blank'); }
            catch (e) { showErr('פתיחת התמונה נכשלה: ' + errMsg(e)); }
          },
        }, '📷 תמונה') : null,
        form ? el('button', {
          class: 'secondary own-sm own-edit',
          onclick: () => { form.hidden = !form.hidden; if (!form.hidden) form.querySelector('.own-reading').focus(); },
        }, k.done ? '✏️ תיקון' : '✏️ הזנה') : null,
        ...linkButtons('meter', kid));
      return el('div', { class: 'own-kid', 'data-kid': kid },
        el('div', { class: 'own-top' },
          el('span', { class: 'own-name' }, kid),
          stateText ? el('span', { class: 'own-state' }, stateText) : null),
        el('div', { class: 'own-linkstate' }, hasLink('meter', kid) ? '🔗 קישור פעיל' : 'אין קישור פעיל'),
        btns, form);
    }

    // rethrow: the approve flow reports its own message after a successful publish.
    async function sendReport(rethrow) {
      try {
        const results = reportResults(ctx.state.history, window.compareCycle);
        if (!results) throw new Error('אין עדיין מחזור שפורסם');
        const token = await store.issueLink('report', null);
        markLink('report', null, true);
        showWa(reportText(results, linkUrl('report', token), window.formatMessage));
      } catch (e) {
        if (rethrow) throw e;
        showErr('שליחת הדוח נכשלה: ' + errMsg(e));
      }
    }

    const children = [];
    children.push(el('div', { class: 'own-head' },
      el('h2', {}, model ? `🗂️ מחזור נוכחי · ${model.label}` : '🗂️ מחזור נוכחי'),
      el('div', { class: 'own-status', id: 'ownStatus' }, model ? `סטטוס: ${model.statusText}` : 'אין מחזור פתוח כרגע')));

    KIDS.forEach((kid) => children.push(kidRow(kid)));

    if (model) {
      const notes = [];
      if (model.missing.includes('tariff')) notes.push('חסר תעריף');
      if (model.missing.includes('water_total')) notes.push('חסר סכום מים');
      children.push(el('div', { class: 'own-bills', id: 'ownBills' },
        `חשבון חשמל ${model.bills.electricity ? '✅' : '⏳'} · חשבון מים ${model.bills.water ? '✅' : '⏳'}`
        + (notes.length ? ' · ' + notes.join(' · ') : '')));
    }

    children.push(el('div', { class: 'own-kid', 'data-kid': 'report' },
      el('div', { class: 'own-top' }, el('span', { class: 'own-name' }, 'קישור לדוח')),
      el('div', { class: 'own-linkstate' }, hasLink('report', null) ? '🔗 קישור פעיל' : 'אין קישור פעיל'),
      el('div', { class: 'own-btns' }, ...linkButtons('report', null))));

    const actions = el('div', { class: 'own-actions' });
    if (model && model.status === 'open') {
      actions.append(el('button', {
        class: 'secondary', id: 'ownRemind',
        onclick: async () => {
          if (KIDS.some((k) => hasLink('meter', k)) && !window.confirm(MSG_REPLACE_ALL)) return;
          try {
            const links = [];
            for (const kid of KIDS) {
              const token = await store.issueLink('meter', kid);
              markLink('meter', kid, true);
              links.push({ kid, url: linkUrl('meter', token) });
            }
            rerender();
            showWa(reminderText(links));
          } catch (e) { showErr('יצירת הקישורים נכשלה, נסו שוב: ' + errMsg(e)); }
        },
      }, '📣 שלח תזכורת'));
    }
    if (model && model.status !== 'published') {
      const date = el('input', {
        type: 'date', id: 'ownDate',
        value: defaultReadingDate(active.readings) || israelDate(new Date().toISOString()),
      });
      const approve = el('button', { id: 'ownApprove', disabled: !model.canApprove }, '✅ אשר ושלח');
      approve.addEventListener('click', async () => {
        if (!window.confirm(MSG_APPROVE)) return;
        if (hasLink('report', null) && !window.confirm(MSG_REPLACE)) return;
        approve.disabled = true;
        approve.textContent = 'מפרסם...';
        try {
          await store.publishCycle(model.id, date.value);
        } catch (e) {
          approve.disabled = false;
          approve.textContent = '✅ אשר ושלח';
          showErr('הפרסום נכשל: ' + errMsg(e));
          return;
        }
        try {
          await ctx.reload();
          await sendReport(true);
        } catch (e) {
          showErr('פורסם; שליחת הדוח נכשלה, לחצו שלח דוח אחרון');
        } finally {
          approve.disabled = !model.canApprove;
          approve.textContent = '✅ אשר ושלח';
        }
      });
      actions.append(el('label', { for: 'ownDate' }, 'תאריך הקריאה'), date, approve);
      if (!model.canApprove) actions.append(el('div', { class: 'hint' }, 'האישור יתאפשר כשכל הקריאות והחשבונות יגיעו'));
    }
    actions.append(el('button', {
      class: 'secondary', id: 'ownReport',
      onclick: () => { if (hasLink('report', null) && !window.confirm(MSG_REPLACE)) return; sendReport(); },
    }, '📤 שלח דוח אחרון'));
    children.push(actions, out);

    host.replaceChildren(el('div', { class: 'card', id: 'ownerCard' }, ...children));
  }

  const api = {
    whatsappUrl, linkUrl, reminderText, reportText, planPublish, previousByKid, statusModel, reportResults,
    defaultReadingDate, fmtSubmittedAt, kidValidationInput, renderOwnerCard,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ownerCycle = api;
}());
