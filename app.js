// The page: one route per URL hash, the tabbed family view and the owner view.
//   #f=<token>  the family link: full view, plus the meter update flow while a cycle is open
//               (the update card and sheets are family-page.js)
//   #r=<token>  an older report link: the same view, read only
//   #m=<token>  an older single-kid meter link: family-page.js renders it into #familyView
//   #owner      the owner (Supabase session): cycle tools plus the same tabs with upload/delete
//   no token    one neutral card, no data loaded
// Tokens come only from the hash, stay in memory and are sent only as x-access-token
// (store.js / family-page.js). Server and user strings never go into innerHTML unescaped.
(function () {
  'use strict';

  function routeOf(hash) {
    if (/^#f=/.test(hash)) return 'family';
    if (/^#m=/.test(hash)) return 'meter';
    if (/^#r=/.test(hash)) return 'report';
    if (hash === '#owner') return 'owner';
    if (/type=recovery/.test(hash)) return 'recovery';
    // A used or expired email link comes back as #error=...&error_code=otp_expired.
    if (/error_code=/.test(hash)) return 'linkError';
    return 'plain';
  }
  const ROUTE = routeOf(location.hash);
  document.documentElement.dataset.route = ROUTE;
  // Moving between routes (family -> #owner after sign-in, owner -> family) reloads cleanly.
  // The recovery route is exempt: supabase-js clears the token hash once it has read it, and
  // reloading then would drop Gal on the plain card before he can set the password.
  window.addEventListener('hashchange', () => {
    if (ROUTE !== 'recovery' && routeOf(location.hash) !== ROUTE) location.reload();
  });

  // Dev-only (e2e): on localhost a test may swap in a fake store before boot.
  if (location.hostname === 'localhost' && window.__devStore) Object.assign(window.store, window.__devStore);

  const KIDS = window.store.KID_ORDER;
  // Three slate tones that would blur together: each kid also gets its own dash pattern.
  const KID_STYLE = {
    'ירין': { color: '--kid-1', dash: '' },
    'גל': { color: '--kid-2', dash: '8 5' },
    'ניב': { color: '--kid-3', dash: '1 5' },
  };
  const kidStyle = (name) => KID_STYLE[name] || { color: '--muted', dash: '' };
  // Inline SVG swatch for the legend, drawn with the kid's own line.
  const swatch = (name) => {
    const k = kidStyle(name);
    return `<svg class="sw" width="28" height="8" viewBox="0 0 28 8" aria-hidden="true"><line x1="2" y1="4" x2="26" y2="4" ` +
      `style="stroke:var(${k.color})" stroke-width="3" stroke-linecap="round"${k.dash ? ` stroke-dasharray="${k.dash}"` : ''}/></svg>`;
  };
  const TABS = ['home', 'past', 'graphs', 'bills'];
  const TAB_KEY = 'hb.tab';
  const $ = (id) => document.getElementById(id);
  const ic = (name, size, sw) => window.icons.el(name, size, sw);
  const icStr = (name, size, sw) => window.icons.str(name, size, sw);
  const fmt = (n) => Number(n).toLocaleString('he-IL');

  let state = { kids: KIDS.map((name) => ({ name, lastReading: 0 })), history: [], documents: [] };
  let IS_OWNER = false;
  let supaReady = false;

  // ---------- small DOM helpers ----------
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
  // HTML-escape server/user strings (labels, storage paths) for the string renderers.
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtHebDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
    if (isNaN(d)) return '';
    return new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  }
  function shortDate(iso) {
    if (!iso) return '';
    const [, m, d] = iso.slice(0, 10).split('-').map(Number);
    return `${d}.${m}`;
  }
  function runCountUps(root) {
    (root || document).querySelectorAll('[data-countup]').forEach((n) => {
      if (n.dataset.done) return;
      n.dataset.done = '1';
      const target = Number(n.dataset.countup) || 0;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { n.textContent = fmt(target); return; }
      const dur = 900;
      const t0 = performance.now();
      (function step(t) {
        const p = Math.min(1, (t - t0) / dur);
        n.textContent = fmt(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step);
      })(t0);
    });
  }
  async function openDoc(path) {
    try { window.open(await window.store.signedUrl(path), '_blank'); }
    catch (e) { alert('הורדה נכשלה: ' + (e.message || e)); }
  }

  // ---------- page frame ----------
  function showMessage(title, body, iconName) {
    $('appMain').hidden = true;
    $('tabbar').hidden = true;
    $('app').classList.add('no-tabs');
    const fv = $('familyView');
    fv.hidden = false;
    fv.replaceChildren(el('div', { class: 'card center-card', id: 'messageCard' },
      el('div', { class: 'ic-wrap' }, ic(iconName || 'home', 24)),
      el('h2', {}, title),
      body ? el('p', {}, body) : null));
  }

  function showApp() {
    $('familyView').hidden = true;
    $('appMain').hidden = false;
    $('tabbar').hidden = false;
    $('app').classList.remove('no-tabs');
  }

  function setHeader(sub, title, actions) {
    $('top').hidden = false;
    $('topSub').textContent = sub;
    $('topTitle').textContent = title;
    $('topActions').replaceChildren(...(actions || []));
  }

  // ---------- tabs ----------
  function readTab() {
    try { const t = sessionStorage.getItem(TAB_KEY); return TABS.includes(t) ? t : 'home'; } catch (e) { return 'home'; }
  }
  function setTab(tab, focus) {
    TABS.forEach((t) => {
      const on = t === tab;
      const b = $('tabBtn-' + t);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $('tab-' + t).hidden = !on;
      if (on && focus) b.focus();
    });
    try { sessionStorage.setItem(TAB_KEY, tab); } catch (e) { /* storage blocked: the tab is just not remembered */ }
    window.scrollTo(0, 0);
  }
  function wireTabs() {
    document.querySelectorAll('#tabbar [data-icon]').forEach((s) => s.append(ic(s.dataset.icon, 18)));
    document.querySelectorAll('#tabbar .tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('tabbar').addEventListener('keydown', (e) => {
      const i = TABS.indexOf(document.activeElement && document.activeElement.dataset.tab);
      if (i < 0) return;
      // RTL: ArrowLeft moves to the next tab.
      const step = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
      if (e.key === 'Home') { e.preventDefault(); setTab(TABS[0], true); }
      else if (e.key === 'End') { e.preventDefault(); setTab(TABS[TABS.length - 1], true); }
      else if (step) { e.preventDefault(); setTab(TABS[(i + step + TABS.length) % TABS.length], true); }
    });
    setTab(readTab());
  }
  window.hbSetTab = setTab;

  // ---------- home: latest report summary ----------
  function spark(values) {
    const d = window.viewModel.sparkPath(values, 140, 34, 4);
    if (!d) return null;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 140 34');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', 'spark');
    svg.appendChild(p);
    return svg;
  }

  function renderSummary() {
    const host = $('summary');
    const m = window.viewModel.summaryModel(state.history, KIDS);
    if (!m) {
      host.replaceChildren(el('p', { class: 'card empty', id: 'sumEmpty' }, 'עוד אין דוח שפורסם'));
      return;
    }
    const meta = [m.label, m.gapDays != null ? `${m.gapDays} ימים` : null].filter(Boolean).join(' · ');
    const total = el('span', { 'data-countup': m.total }, '0');
    host.replaceChildren(
      el('div', { class: 'sec-head' }, el('h2', {}, 'הדוח האחרון'), el('span', { class: 'muted', id: 'sumMeta' }, meta)),
      el('div', { class: 'card sum-card', id: 'sumCard' },
        el('div', { class: 'sum-top' },
          el('div', {}, el('div', { class: 'muted' }, 'סה"כ להעברה'),
            el('div', { class: 'sum-total', id: 'sumTotal' }, total, ' ₪')),
          m.date ? el('span', { class: 'pill' }, `נדגם ${shortDate(m.date)}`) : null),
        el('div', { class: 'tiles3', id: 'sumKids' }, ...m.kids.map((k) =>
          el('div', { class: 'tile', 'data-kid': k.name }, el('div', { class: 'v' }, `${fmt(k.total)} ₪`), el('div', { class: 'l' }, k.name))))),
      el('div', { class: 'tiles2' },
        el('div', { class: 'card mini', id: 'sumTariff' }, el('div', { class: 'l' }, 'חשמל לקוט"ש'), spark(m.tariffSeries),
          el('div', { class: 'v' }, m.tariff != null ? `${m.tariff} ₪` : '-')),
        el('div', { class: 'card mini', id: 'sumWater' }, el('div', { class: 'l' }, 'מים לכל אחד'), spark(m.waterSeries),
          el('div', { class: 'v' }, m.waterShare != null ? `${fmt(m.waterShare)} ₪` : '-'))),
      el('button', { class: 'link-btn', id: 'sumMore', type: 'button', onclick: () => setTab('past') },
        'לפירוט המלא', ic('next', 16)));
    runCountUps(host);
  }

  // ---------- graphs: electricity ----------
  function buildChartData() {
    const cyclesByLabel = new Map();
    const rates = {};
    state.kids.forEach((k) => {
      const lut = {};
      window.dailySeries(state.history, k.name).forEach((p) => {
        lut[p.label] = p.rate;
        if (!cyclesByLabel.has(p.label)) cyclesByLabel.set(p.label, { label: p.label, date: p.date });
      });
      rates[k.name] = lut;
    });
    const cycles = [...cyclesByLabel.values()].sort((a, b) => new Date(a.date) - new Date(b.date));
    return { cycles, rates };
  }

  function renderTrends() {
    const card = $('trendCard');
    const hist = state.history;
    const { cycles, rates } = buildChartData();
    const hasChart = cycles.length >= 2;
    if (!hist.length) { card.hidden = true; return false; }
    card.hidden = false;
    const h = hist[hist.length - 1];
    const names = state.kids.map((k) => k.name).filter((n) => h.kids[n]);
    const totC = Math.round(names.reduce((s, n) => s + (h.kids[n].c || 0), 0));
    const totE = names.reduce((s, n) => s + (h.kids[n].e || 0), 0);
    let html =
      `<div class="card-head"><h2>חשמל</h2><span class="sub">צריכה יומית לאורך זמן</span></div>` +
      `<div class="chips"><span class="pill">${fmt(totC)} קוט"ש</span><span class="pill">${fmt(totE)} ₪</span>` +
      (h.tariff != null && !isNaN(h.tariff) ? `<span class="pill">תעריף ${esc(h.tariff)} ₪/קוט"ש</span>` : '') + `</div>`;
    if (hist.length >= 2) {
      const prv = hist[hist.length - 2];
      if (h.tariff != null && prv.tariff != null && Number(h.tariff) !== Number(prv.tariff)) {
        const up = Number(h.tariff) > Number(prv.tariff);
        const pct = window.pctChange(Number(h.tariff), Number(prv.tariff));
        html += `<div class="rate-alert" id="rateAlert">תעריף החשמל ${up ? 'עלה ' + icStr('up', 13, 2.4) : 'ירד ' + icStr('down', 13, 2.4)} ` +
          `מ-${esc(prv.tariff)} ל-<b>${esc(h.tariff)}</b> ₪/קוט"ש${pct != null ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''}</div>`;
      }
    }
    if (hasChart) {
      html += `<div class="legend" id="legend">` + state.kids.map((k) =>
        `<span class="lg" data-kid="${esc(k.name)}">${swatch(k.name)}${esc(k.name)}</span>`).join('') + `</div>`;
      html += `<div class="chart" id="chart">${chartSvg(cycles, rates)}</div>` +
        `<div class="hint">מנורמל לפי ימים בין קריאות: משווה עוצמת צריכה אמיתית, בלי תלות באורך התקופה.</div>`;
    }
    card.innerHTML = html;
    return true;
  }

  function chartSvg(cycles, rates) {
    const W = 520, H = 250, mL = 36, mR = 26, mT = 12, mB = 62;
    const px0 = mL, px1 = W - mR, py0 = mT, py1 = H - mB;
    let maxRate = 0;
    state.kids.forEach((k) => cycles.forEach((c) => {
      const r = rates[k.name][c.label];
      if (r != null && r > maxRate) maxRate = r;
    }));
    maxRate = Math.ceil(maxRate / 5) * 5 || 1;
    const X = (i) => px0 + (cycles.length === 1 ? 0 : (i * (px1 - px0)) / (cycles.length - 1));
    const Y = (r) => py1 - (r / maxRate) * (py1 - py0);
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" font-family="inherit" role="img" aria-label="צריכה יומית לפי ילד">`;
    const yMid = (py0 + py1) / 2;
    svg += `<text class="ch-lbl" x="11" y="${yMid}" text-anchor="middle" font-size="9" transform="rotate(-90 11 ${yMid})">קוט"ש/יום</text>`;
    [0, 0.5, 1].forEach((f) => {
      const y = py1 - f * (py1 - py0);
      svg += `<line class="ch-grid" x1="${px0}" y1="${y}" x2="${px1}" y2="${y}"/>`;
      svg += `<text class="ch-lbl" x="${px0 - 6}" y="${y + 3}" text-anchor="end" font-size="9">${Math.round(maxRate * f)}</text>`;
    });
    const lastI = cycles.length - 1;
    cycles.forEach((c, i) => {
      const x = X(i);
      const ly = py1 + 14;
      svg += `<text class="${i === lastI ? 'ch-now' : 'ch-lbl'}" x="${x}" y="${ly}" text-anchor="middle" font-size="8.5" transform="rotate(-30 ${x} ${ly})">${esc(c.label)}</text>`;
    });
    state.kids.forEach((k) => {
      const ks = kidStyle(k.name);
      const col = `var(${ks.color})`;
      const pts = cycles.map((c, i) => {
        const r = rates[k.name][c.label];
        return r == null ? null : `${X(i).toFixed(1)},${Y(r).toFixed(1)}`;
      }).filter(Boolean);
      svg += `<polyline class="ch-line" data-kid="${esc(k.name)}" points="${pts.join(' ')}" style="stroke:${col}"${ks.dash ? ` stroke-dasharray="${ks.dash}"` : ''}/>`;
      cycles.forEach((c, i) => {
        const r = rates[k.name][c.label];
        if (r == null) return;
        const now = i === lastI;
        svg += `<circle cx="${X(i).toFixed(1)}" cy="${Y(r).toFixed(1)}" r="${now ? 4.2 : 2.6}" style="fill:${col}${now ? ';stroke:var(--white);stroke-width:1.3' : ''}">` +
          `<title>${esc(k.name)} ${esc(c.label)}: ${r.toFixed(1)} קוט"ש/יום</title></circle>`;
      });
    });
    return svg + '</svg>';
  }

  // ---------- graphs: water ----------
  function barsSvg(series, valueOf, labelOf, cls) {
    if (series.length < 2) return '';
    const W = 520, H = 190, mL = 44, mR = 14, mT = 14, mB = 46;
    const px0 = mL, px1 = W - mR, py0 = mT, py1 = H - mB;
    const vals = series.map(valueOf);
    const min = Math.min(...vals), max = Math.max(...vals), range = Math.max(max - min, 1);
    const step = max > 500 ? 50 : 20;
    const lo = Math.max(0, Math.floor((min - range * 0.4 - step) / step) * step);
    const hi = Math.ceil((max + range * 0.1 + step) / step) * step;
    const Y = (v) => py1 - ((v - lo) / (hi - lo)) * (py1 - py0);
    const n = series.length, gap = 8, bw = ((px1 - px0) / n) - gap;
    let svg = `<svg viewBox="0 0 ${W} ${H}" font-family="inherit" role="img" aria-label="מגמה">`;
    [lo, (lo + hi) / 2, hi].forEach((t) => {
      const y = Y(t);
      svg += `<line class="ch-grid" x1="${px0}" y1="${y}" x2="${px1}" y2="${y}"/>` +
        `<text class="ch-lbl" x="${px0 - 6}" y="${y + 3}" text-anchor="end" font-size="9">${fmt(Math.round(t))}</text>`;
    });
    series.forEach((d, i) => {
      const x = px1 - (i + 1) * (bw + gap) + gap / 2; // RTL: newest on the right
      const v = valueOf(d);
      const y = Y(v), h = Math.max(py1 - y, 0), now = i === n - 1;
      svg += `<rect class="ch-bar ${cls}${now ? ' now' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4"><title>${esc(labelOf(d))}: ${fmt(v)} ₪</title></rect>`;
      if (now) svg += `<text class="ch-now" x="${(x + bw / 2).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="10">${fmt(v)}</text>`;
      const ly = py1 + 13;
      svg += `<text class="${now ? 'ch-now' : 'ch-lbl'}" x="${(x + bw / 2).toFixed(1)}" y="${ly}" text-anchor="middle" font-size="8" transform="rotate(-32 ${(x + bw / 2).toFixed(1)} ${ly})">${esc(labelOf(d))}</text>`;
    });
    return svg + '</svg>';
  }

  function deltaCell(row) {
    if (!row || row.pct === null || row.pct === undefined) return '<td class="delta zero">-</td>';
    const cls = row.pct > 0 ? 'up' : row.pct < 0 ? 'down' : 'zero';
    const arrow = row.pct > 0 ? icStr('up', 12, 2.4) + ' +' : row.pct < 0 ? icStr('down', 12, 2.4) + ' ' : '';
    return `<td class="delta ${cls}">${arrow}${row.pct}%</td>`;
  }

  function renderWaterInsight() {
    const card = $('waterInsight');
    const w = window.waterInsight(state.history);
    const trend = barsSvg(window.waterSeries(state.history), (d) => d.full, (d) => d.label, 'wbar');
    const hasTable = w && (w.previous || w.lastYear);
    if (!hasTable && !trend) { card.hidden = true; return false; }
    const dash = '<td class="delta zero">-</td>';
    const dataRow = (when, row, isNow, deltaHtml) =>
      `<tr class="${isNow ? 'now' : ''}"><td class="when">${when}<small>${esc(row.label)}</small></td>` +
      `<td class="full">${fmt(row.full)} ₪</td><td>${fmt(row.per)} ₪</td>${deltaHtml}</tr>`;
    let html = `<div class="card-head"><h2>מים, משק הבית</h2><span class="sub">השוואת חשבון</span></div>`;
    if (hasTable) {
      let rows = dataRow('עכשיו', w.current, true, dash);
      if (w.previous) rows += dataRow('תקופה קודמת', w.previous, false, deltaCell(w.previous));
      if (w.lastYear) rows += dataRow('שנה שעברה', w.lastYear, false, deltaCell(w.lastYear));
      html += `<table class="tbl"><thead><tr><th>תקופה</th><th>חשבון מלא</th><th>לאדם</th><th>השינוי</th></tr></thead>` +
        `<tbody>${rows}</tbody></table>` +
        `<div class="hint">השינוי באחוזים זהה למלא ולאדם (החלוקה ל-4 קבועה). ${icStr('up', 11, 2.4)} עלייה, ${icStr('down', 11, 2.4)} ירידה.</div>`;
    }
    if (trend) html += `<div class="sub-head"><h3>מגמת החשבון (₪)</h3></div><div class="water-chart">${trend}</div>`;
    card.innerHTML = html;
    card.hidden = false;
    return true;
  }

  // ---------- bills ----------
  function billRow(d, sub) {
    const title = d.kind === 'electricity_bill' ? 'חשבון חשמל' : d.kind === 'water_bill' ? 'חשבון מים' : (d.label || d.kind);
    const off = ROUTE !== 'owner' && !d.url;
    const row = el(off ? 'div' : 'button', {
      class: 'bill-row' + (off ? ' doc-off' : ''), type: off ? null : 'button', 'data-kind': d.kind,
      'aria-disabled': off ? 'true' : null,
      onclick: off ? null : () => openDoc(d.storage_path),
    }, el('span', { class: 'ic' }, ic(d.kind === 'water_bill' ? 'drop' : d.kind === 'electricity_bill' ? 'bolt' : 'doc', 18)),
    el('span', { class: 't' }, el('b', {}, title), el('span', {}, off ? 'לא זמין כרגע' : sub || 'פתיחת המסמך')),
    off ? null : ic('download', 18));
    return row;
  }

  function renderBills() {
    const card = $('billsCard');
    const periods = window.viewModel.billPeriods(state.history, state.documents);
    const head = el('div', { class: 'card-head' }, el('h2', {}, 'חשבונות חשמל ומים'));
    if (!periods.length) {
      card.replaceChildren(head, el('p', { class: 'empty' }, 'עוד אין חשבוניות'));
      return;
    }
    const list = el('div', { id: 'billList' });
    const select = el('select', { id: 'billPeriod', 'aria-label': 'תקופה' },
      ...periods.map((p, i) => el('option', { value: String(i) }, p.label)));
    const draw = () => {
      const p = periods[Number(select.value) || 0];
      list.replaceChildren(...p.docs.map((d) => billRow(d,
        d.kind === 'electricity_bill' && p.tariff != null ? `תעריף ${p.tariff} ₪/קוט"ש`
          : d.kind === 'water_bill' && p.waterShare != null ? `${fmt(p.waterShare)} ₪ לכל אחד` : null)));
    };
    select.addEventListener('change', draw);
    card.replaceChildren(head, el('label', { for: 'billPeriod' }, 'תקופה'), select, list);
    draw();
  }

  const PROVIDERS = [{ key: 'bezeq', name: 'בזק' }, { key: 'yes', name: 'yes' }];
  function provBlock(p) {
    const ins = window.otherBillInsight(state.otherBills, p.key);
    if (!ins) return null;
    const moLabel = (m) => { const [y, mm] = m.split('-'); return `${mm}/${y}`; };
    const dash = '<td class="delta zero">-</td>';
    const dataRow = (when, row, isNow, deltaHtml) =>
      `<tr class="${isNow ? 'now' : ''}"><td class="when">${when}<small>${esc(moLabel(row.month))}</small></td>` +
      `<td class="full">${fmt(row.amount)} ₪</td>${deltaHtml}</tr>`;
    let rows = dataRow('עכשיו', ins.current, true, dash);
    if (ins.previous) rows += dataRow('חודש קודם', ins.previous, false, deltaCell(ins.previous));
    if (ins.lastYear) rows += dataRow('שנה שעברה', ins.lastYear, false, deltaCell(ins.lastYear));
    let alertHtml = '';
    if (ins.previous && ins.previous.pct != null && Math.abs(ins.previous.pct) >= 5) {
      const up = ins.previous.pct > 0;
      alertHtml = `<div class="rate-alert">המחיר ${up ? 'עלה ' + icStr('up', 13, 2.4) : 'ירד ' + icStr('down', 13, 2.4)} ${up ? '+' : ''}${ins.previous.pct}% מהחודש הקודם</div>`;
    }
    const series = window.otherBillSeries(state.otherBills, p.key);
    const trend = barsSvg(series, (d) => d.amount, (d) => { const [y, mm] = d.month.split('-'); return `${mm}/${y.slice(2)}`; }, 'pbar');
    const block = el('div', { class: 'prov-block', 'data-provider': p.key });
    block.innerHTML = `<div class="sub-head"><h3>${esc(p.name)}</h3><span class="sub">מנוי חודשי קבוע</span></div>` + alertHtml +
      `<table class="tbl"><thead><tr><th>תקופה</th><th>חשבון</th><th>השינוי</th></tr></thead><tbody>${rows}</tbody></table>` +
      (trend ? `<div class="prov-chart">${trend}</div>` : '');
    const docs = (state.documents || []).filter((d) => d.kind === p.key).sort((a, b) => (a.label < b.label ? 1 : -1));
    if (docs.length) {
      block.append(el('div', { class: 'docs' }, ...docs.map((d) => {
        const off = ROUTE !== 'owner' && !d.url;
        return el('div', { class: 'doc' }, ic('doc', 16), off
          ? el('span', { class: 'doc-off', 'aria-disabled': 'true' }, d.label || '')
          : el('a', { class: 'ob-dl', href: '#', role: 'button', onclick: (e) => { e.preventDefault(); openDoc(d.storage_path); } }, d.label || ''));
      })));
    }
    return block;
  }

  function renderOtherBills() {
    const card = $('otherBills');
    const blocks = PROVIDERS.map(provBlock).filter(Boolean);
    if (!blocks.length) { card.hidden = true; return; }
    card.replaceChildren(el('div', { class: 'card-head' }, el('h2', {}, 'מנויים קבועים'), el('span', { class: 'sub' }, 'בזק ו-yes')), ...blocks);
    card.hidden = false;
  }

  // ---------- past periods ----------
  function periodKids(h) { return state.kids.map((k) => k.name).filter((n) => h.kids[n]); }

  function kidLine(h, name, ly, prevE, periodId, prevPeriodId) {
    const k = h.kids[name];
    const water = h.waterShare;
    const total = k.e + water;
    const pct = window.pctChange(k.electricity != null ? k.electricity : k.e, prevE && prevE[name] != null ? prevE[name] : null);
    let tag = '';
    if (pct !== null) {
      if (pct < 0) tag = `<span class="tag">${pct}% ${icStr('check', 11, 3)}</span>`;
      else if (pct >= window.ANOMALY_THRESHOLD) tag = `<span class="tag warn">+${pct}% חריג</span>`;
      else tag = `<span class="tag">+${pct}%</span>`;
    }
    let lyHtml = '';
    if (ly && ly.kids[name]) {
      const lyk = ly.kids[name];
      const yoy = window.pctChange(Math.round(k.c), Math.round(lyk.c));
      const yoyTxt = yoy === null ? '' : `, השנה <span class="${yoy >= 0 ? 'up' : 'down'}">${yoy >= 0 ? '+' : ''}${yoy}%</span>`;
      lyHtml = `<button type="button" class="ly-toggle" aria-expanded="false">צריכה לפני שנה <span class="chev">${icStr('chevDown', 14, 2.4)}</span></button>` +
        `<div class="ly-panel"><div class="inner"><span class="muted">לפני שנה (${esc(ly.label)}):</span> ` +
        `${Math.round(lyk.c)} קוט"ש · ${esc(lyk.e)} ₪${yoyTxt}</div></div>`;
    }
    let photoHtml = '';
    const pair = window.pairMeterPhoto(state.documents, periodId, prevPeriodId, name);
    if (pair.current && !(ROUTE !== 'owner' && !pair.current.url)) {
      const curR = k.reading;
      const prevEntry = prevPeriodId ? state.history.find((x) => x.id === prevPeriodId) : null;
      const prevR = prevEntry && prevEntry.kids[name] ? prevEntry.kids[name].reading : null;
      photoHtml =
        `<button type="button" class="ph-toggle" aria-expanded="false" data-cur="${esc(pair.current.storage_path)}" ` +
        `data-prev="${pair.previous ? esc(pair.previous.storage_path) : ''}">${icStr('photo', 15)} תצלומי מונה <span class="chev">${icStr('chevDown', 14, 2.4)}</span></button>` +
        `<div class="ph-panel"><div class="inner ph-grid" data-loaded="0">` +
        `<div class="ph-col"><div class="ph-cap">${prevR != null ? `קודם · ${esc(prevR)}` : 'קודם'}</div><div class="ph-img ph-prev"></div></div>` +
        `<div class="ph-col"><div class="ph-cap">${curR != null ? `עכשיו · ${esc(curR)}` : 'עכשיו'}</div><div class="ph-img ph-cur"></div></div>` +
        `<div class="ph-delta">הפרש ${Math.round(k.c)} קוט"ש</div></div></div>`;
    }
    return `<div class="kline" data-kid="${esc(name)}"><div class="top"><span class="nm">${esc(name)}</span><span class="amt">${fmt(total)} ₪</span></div>` +
      `<div class="brk"><span>חשמל ${esc(k.e)} + מים ${esc(water)}</span><span>· ${Math.round(k.c)} קוט"ש</span>${tag}</div>` +
      lyHtml + photoHtml + `</div>`;
  }

  function ownerDocsHtml(periodId) {
    const docs = (state.documents || []).filter((d) => d.period_id === periodId);
    const lines = docs.map((d) =>
      `<div class="doc">${icStr('doc', 16)}<a class="dl" role="button" tabindex="0" data-path="${esc(d.storage_path)}">${esc(d.label || d.kind)}</a>` +
      `<button type="button" class="del" data-id="${esc(d.id)}" data-path="${esc(d.storage_path)}">מחק</button></div>`).join('');
    return `<div class="docs">${lines}${uploadForm(periodId)}</div>`;
  }

  function uploadForm(periodId) {
    return `<div class="upload" data-pid="${esc(periodId)}">` +
      `<label class="u-lbl">סוג</label>` +
      `<select class="u-kind"><option value="electricity_bill">חשבון חשמל</option>` +
      `<option value="water_bill">חשבון מים</option><option value="meter_photo">תמונת מונה</option></select>` +
      `<span class="u-kid-wrap" hidden><label class="u-lbl">ילד</label>` +
      `<select class="u-kid"><option value="">בחירה</option>` +
      KIDS.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('') + `</select></span>` +
      `<input type="file" class="u-file" /><button type="button" class="btn sm u-go">העלאה</button></div>`;
  }

  function cardHtml(h, i, isNewest) {
    const hist = state.history;
    const prev = i > 0 ? hist[i - 1] : null;
    const names = periodKids(h);
    const total = names.reduce((s, n) => s + h.kids[n].e, 0) + h.waterShare * names.length;
    const gap = prev ? window.daysBetween(prev.date, h.date) : null;
    const ly = window.closestToYearAgo(hist, h.date);
    const prevE = {};
    if (prev) names.forEach((n) => { prevE[n] = prev.kids[n] ? prev.kids[n].e : null; });
    const chips =
      (h.date ? `<span class="pill">נדגם ב${esc(fmtHebDate(h.date))}</span>` : '') +
      (gap !== null ? `<span class="pill">${gap} ימים מאז ${esc(prev.label)}</span>` : '');
    const hero =
      `<div class="rep-hero"><div class="cap">סה"כ להעברה</div><div class="total">${fmt(total)} ₪</div>` +
      `<div class="sub">מים ${esc(h.waterShare)} ₪ לכל אחד · חשמל לפי צריכה · תעריף ${esc(h.tariff)} ₪/קוט"ש</div></div>`;
    const unitCmp = window.unitPriceBlockHtml(h, prev);
    const kidsHtml = names.map((n) => kidLine(h, n, ly, prevE, h.id, prev ? prev.id : null)).join('');
    const msg = window.formatMessage({
      period: h.label, waterTotal: h.waterShare * 4, tariff: h.tariff, waterShare: h.waterShare,
      kids: names.map((n) => ({ name: n, consumption: h.kids[n].c, electricity: h.kids[n].e, water: h.waterShare, total: h.kids[n].e + h.waterShare })),
    });
    return `<div class="rep card" data-period="${esc(h.id)}">` +
      `<div class="rep-top"><span><span class="rep-label">${esc(h.label)}</span>${isNewest ? '<span class="pill rep-badge">אחרון</span>' : ''}</span>` +
      `<button type="button" class="btn sm secondary wa-copy" aria-label="העתקת ההודעה לוואטסאפ">${icStr('copy', 15)} העתקה</button></div>` +
      `<div class="chips">${chips}</div>` + hero + unitCmp + kidsHtml +
      `<pre class="wa-text" hidden>${esc(msg)}</pre>` + (IS_OWNER ? ownerDocsHtml(h.id) : '') + `</div>`;
  }

  function renderPeriods() {
    const host = $('archive');
    const hist = state.history;
    $('pastCount').textContent = hist.length ? `${hist.length} תקופות` : '';
    if (!hist.length) { host.innerHTML = '<p class="card empty">עוד אין תקופות</p>'; return; }
    const newest = hist.length - 1;
    host.innerHTML = hist.map((h, i) => cardHtml(h, i, i === newest)).reverse().join('');
    wireReportActions(host);
    if (IS_OWNER) wireDocActions(host);
  }

  function wireReportActions(root) {
    root.querySelectorAll('.ly-toggle').forEach((btn) => btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      btn.nextElementSibling.classList.toggle('open', !open);
    }));
    root.querySelectorAll('.ph-toggle').forEach((btn) => btn.addEventListener('click', async () => {
      const panel = btn.nextElementSibling;
      const open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      panel.classList.toggle('open', !open);
      const grid = panel.querySelector('.ph-grid');
      if (open || grid.dataset.loaded === '1') return;
      grid.dataset.loaded = '1';
      // A photo whose signing failed has no url: a placeholder, never a broken image.
      const photo = async (path, alt) => {
        try { return el('img', { src: await window.store.signedUrl(path), alt }); }
        catch (e) { return el('span', { class: 'doc-off' }, 'לא זמין'); }
      };
      if (btn.dataset.cur) grid.querySelector('.ph-cur').replaceChildren(await photo(btn.dataset.cur, 'מונה עכשיו'));
      if (btn.dataset.prev) grid.querySelector('.ph-prev').replaceChildren(await photo(btn.dataset.prev, 'מונה קודם'));
      else grid.querySelector('.ph-prev').closest('.ph-col').hidden = true;
    }));
    root.querySelectorAll('.wa-copy').forEach((btn) => btn.addEventListener('click', async () => {
      const txt = btn.closest('.rep').querySelector('.wa-text').textContent;
      try { await navigator.clipboard.writeText(txt); } catch (e) { return; }
      btn.replaceChildren(ic('check', 15), ' הועתק');
      setTimeout(() => btn.replaceChildren(ic('copy', 15), ' העתקה'), 1500);
    }));
  }

  function wireDocActions(root) {
    root.querySelectorAll('.u-kind').forEach((sel) => {
      const wrap = sel.closest('.upload').querySelector('.u-kid-wrap');
      const toggle = () => { wrap.hidden = sel.value !== 'meter_photo'; };
      sel.addEventListener('change', toggle);
      toggle();
    });
    root.querySelectorAll('.dl').forEach((a) => {
      a.addEventListener('click', () => openDoc(a.dataset.path));
      a.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDoc(a.dataset.path); } });
    });
    root.querySelectorAll('.del').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('למחוק את המסמך?')) return;
      try {
        await window.store.deleteDocument({ id: b.dataset.id, storage_path: b.dataset.path });
        state.documents = await window.store.listDocuments();
        renderAll();
      } catch (e) { alert('מחיקה נכשלה: ' + (e.message || e)); }
    }));
    root.querySelectorAll('.u-go').forEach((btn) => btn.addEventListener('click', async () => {
      const box = btn.closest('.upload');
      const kind = box.querySelector('.u-kind').value;
      const kid = box.querySelector('.u-kid').value || null;
      const file = box.querySelector('.u-file').files[0];
      if (!file) { alert('נא לבחור קובץ'); return; }
      if (kind === 'meter_photo' && !kid) { alert('נא לבחור ילד לתמונת מונה'); return; }
      btn.disabled = true;
      btn.textContent = 'מעלה...';
      try {
        await window.store.uploadDocument(box.dataset.pid, kind, kind === 'meter_photo' ? kid : null, file);
        state.documents = await window.store.listDocuments();
        renderAll();
      } catch (e) { alert('העלאה נכשלה: ' + (e.message || e)); btn.disabled = false; btn.textContent = 'העלאה'; }
    }));
  }

  function renderAll() {
    renderSummary();
    const a = renderTrends();
    const b = renderWaterInsight();
    $('graphsEmpty').hidden = a || b;
    renderBills();
    renderOtherBills();
    renderPeriods();
  }

  // ---------- owner sign-in (the "ניהול" sheet) ----------
  function ensureSupabase() {
    if (!supaReady) { window.store.initSupabase(); supaReady = true; }
  }
  const isOwnerSession = (s) => !!(s && s.user && s.user.id === window.CONFIG.OWNER_UID);

  function openLoginSheet(onDone) {
    const err = el('div', { class: 'msg err', id: 'admErr', role: 'alert', hidden: true });
    const email = el('input', { id: 'admEmail', name: 'email', type: 'email', autocomplete: 'username', inputmode: 'email',
      autocapitalize: 'off', spellcheck: 'false', dir: 'ltr', required: true, 'data-autofocus': true });
    const pw = el('input', { id: 'admPw', name: 'password', type: 'password', autocomplete: 'current-password', dir: 'ltr', required: true });
    const go = el('button', { class: 'btn', id: 'admGo', type: 'submit' }, 'כניסה');
    const form = el('form', { id: 'admForm', method: 'post', action: '#', novalidate: true },
      el('div', { class: 'sheet-head' },
        el('div', {}, el('h2', { id: 'admTitle' }, 'כניסת מנהל'), el('div', { class: 'muted' }, 'לניהול המחזור בלבד')),
        el('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'סגירה', 'data-sheet-close': true }, ic('close', 14, 2.6))),
      el('label', { for: 'admEmail' }, 'אימייל'), email,
      el('label', { for: 'admPw' }, 'סיסמה'), pw, err, go);
    const info = el('div', { class: 'msg', id: 'admInfo', role: 'status', hidden: true });
    const forgot = el('button', { class: 'link-btn', id: 'admForgot', type: 'button' }, 'שכחתי סיסמה');
    forgot.addEventListener('click', async () => {
      err.hidden = true;
      info.hidden = true;
      if (!email.value.trim()) { err.textContent = 'נא למלא אימייל ואז ללחוץ שוב'; err.hidden = false; return; }
      forgot.disabled = true;
      try {
        ensureSupabase();
        const { error } = await window.store.sendPasswordReset(email.value.trim(), location.origin + location.pathname);
        if (error) throw error;
        info.textContent = 'נשלח קישור לאיפוס הסיסמה לאימייל. לפתוח אותו פעם אחת בלבד.';
        info.hidden = false;
      } catch (ex) {
        err.textContent = 'לא הצלחתי לשלוח, נסו שוב בעוד כמה דקות';
        err.hidden = false;
      } finally {
        forgot.disabled = false;
      }
    });
    form.append(forgot, info);
    const sh = window.sheet.open({ id: 'adminSheet', labelledBy: 'admTitle', content: form });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (!email.value.trim() || !pw.value) { err.textContent = 'נא למלא אימייל וסיסמה'; err.hidden = false; return; }
      go.disabled = true;
      go.textContent = 'נכנס...';
      try {
        ensureSupabase();
        const { data, error } = await window.store.signInWithPassword(email.value.trim(), pw.value);
        if (error) throw Object.assign(new Error('bad'), { auth: true });
        if (!isOwnerSession(data)) {
          await window.store.signOut();
          throw Object.assign(new Error('not owner'), { notOwner: true });
        }
        sh.close();
        onDone();
      } catch (ex) {
        err.textContent = ex.notOwner ? 'החשבון הזה אינו חשבון מנהל' : ex.auth ? 'האימייל או הסיסמה שגויים' : 'אין חיבור, נסו שוב';
        err.hidden = false;
        go.disabled = false;
        go.textContent = 'כניסה';
      }
    });
    return sh;
  }

  async function onAdmin() {
    ensureSupabase();
    let s = null;
    try { s = await window.store.getSession(); } catch (e) { s = null; }
    if (isOwnerSession(s)) { location.hash = '#owner'; return; }
    if (s) { try { await window.store.signOut(); } catch (e) { /* stale non-owner session */ } }
    openLoginSheet(() => { location.hash = '#owner'; });
  }

  // ---------- routes ----------
  async function bootReport() {
    let token = '';
    try { token = decodeURIComponent(/^#[fr]=([^&/]*)/.exec(location.hash)[1]); } catch (e) { /* malformed */ }
    setHeader('שלום, משפחה', 'חשבונות בית', ROUTE === 'family'
      ? [el('button', { class: 'pill-btn', id: 'adminBtn', type: 'button', onclick: onAdmin }, ic('lock', 14), 'ניהול')]
      : []);
    if (!token) { showMessage('הקישור אינו בתוקף', 'בקשו את הקישור המשפחתי העדכני מהקבוצה', 'link'); return; }
    try {
      state = await window.store.loadStateViaReport(token);
    } catch (e) {
      if (e.status === 401) showMessage('הקישור אינו בתוקף', 'בקשו את הקישור המשפחתי העדכני מהקבוצה', 'link');
      else showMessage('אין חיבור, נסו שוב', null, 'clock');
      return;
    }
    showApp();
    renderAll();
    wireTabs();
  }

  let ownerCtx = null;
  async function renderOwner() {
    const host = $('ownerHost');
    try {
      if (!ownerCtx) {
        ownerCtx = { store: window.store, reload: refreshOwner };
        ownerCtx.familyToken = await window.store.readFamilyLink();
      }
      ownerCtx.state = state;
      await window.ownerCycle.renderOwnerCard(host, ownerCtx);
    } catch (e) {
      host.replaceChildren(el('div', { class: 'msg err' }, 'טעינת כרטיס המחזור נכשלה: ' + (e.message || e)));
    }
  }

  async function refreshOwner() {
    state = await window.store.loadState();
    state.documents = await window.store.listDocuments();
    if (ownerCtx) ownerCtx.familyToken = await window.store.readFamilyLink();
    renderAll();
    await renderOwner();
  }

  function familyHash() {
    return ownerCtx && ownerCtx.familyToken ? '#f=' + encodeURIComponent(ownerCtx.familyToken) : '';
  }

  function renderBackup() {
    const btn = el('button', { class: 'btn secondary', id: 'exportBtn', type: 'button' }, ic('download', 18), 'ייצוא גיבוי (JSON)');
    btn.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `home-bills-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
    $('backupHost').replaceChildren(el('div', { class: 'card', id: 'backupCard' },
      el('div', { class: 'card-head' }, el('h2', {}, 'גיבוי נתונים')), btn,
      el('div', { class: 'hint' }, 'מוריד עותק JSON של כל הנתונים מהענן.')));
  }

  // A failed load (network, expired session) shows a card instead of a blank page.
  async function bootOwner() {
    try {
      await bootOwnerInner();
    } catch (e) {
      showMessage('טעינת הניהול נכשלה', 'נסו לרענן את הדף. ' + ((e && e.message) || ''), 'alert');
      $('messageCard').id = 'ownerError';
    }
  }

  async function bootOwnerInner() {
    setHeader('מצב מנהל', 'ניהול מחזור', []);
    ensureSupabase();
    let session = null;
    try { session = await window.store.getSession(); } catch (e) { session = null; }
    if (!isOwnerSession(session)) {
      if (session) { try { await window.store.signOut(); } catch (e) { /* ignore */ } }
      const login = () => openLoginSheet(() => location.reload());
      showMessage('כניסת מנהל', 'הכניסה רק לניהול המחזור. המשפחה משתמשת בקישור המשפחתי.', 'lock');
      $('messageCard').append(el('button', { class: 'btn', id: 'ownLoginOpen', type: 'button', onclick: login }, 'כניסה'));
      login();
      return;
    }
    IS_OWNER = true;
    state = await window.store.loadState();
    state.documents = await window.store.listDocuments();
    showApp();
    await renderOwner();
    const toFamily = el('button', { class: 'pill-btn', id: 'ownToFamily', type: 'button',
      onclick: () => { const h = familyHash(); if (h) location.hash = h; } }, ic('home', 14), 'למשפחה');
    toFamily.hidden = !familyHash();
    const signOut = el('button', { class: 'pill-btn', id: 'ownSignOut', type: 'button', onclick: async () => {
      const h = familyHash();
      try { await window.store.signOut(); } catch (e) { /* signed out locally anyway */ }
      // The route changes, so the hashchange handler reloads the page exactly once.
      location.hash = h || '';
    } }, ic('logout', 14), 'יציאה');
    setHeader('מצב מנהל', 'ניהול מחזור', [toFamily, signOut]);
    renderAll();
    renderBackup();
    wireTabs();
  }

  function bootRecovery() {
    setHeader('', 'חשבונות בית', []);
    ensureSupabase();
    const err = el('div', { class: 'msg err', role: 'alert', hidden: true });
    const input = el('input', { id: 'rcInput', type: 'password', autocomplete: 'new-password', dir: 'ltr' });
    const go = el('button', { class: 'btn', id: 'rcGo', type: 'submit' }, 'שמירת הסיסמה');
    const form = el('form', { action: '#' }, el('label', { for: 'rcInput' }, 'סיסמה חדשה'), input, err, go);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value || input.value.length < 6) { err.textContent = 'סיסמה חייבת לפחות 6 תווים'; err.hidden = false; return; }
      const { error } = await window.store.updatePassword(input.value);
      if (error) { err.textContent = 'שגיאה: ' + error.message; err.hidden = false; return; }
      await window.store.signOut();
      location.href = location.origin + location.pathname;
    });
    showMessage('הגדרת סיסמה חדשה', 'לחשבון המנהל', 'lock');
    $('messageCard').append(form);
  }

  if (ROUTE === 'plain') {
    // No token: nothing to load. The family opens the link pinned in the group.
    showMessage('חשבונות בית', 'פתחו את הקישור המשפחתי מהקבוצה', 'home');
    $('messageCard').id = 'plainCard';
  } else if (ROUTE === 'family' || ROUTE === 'report') {
    bootReport();
  } else if (ROUTE === 'owner') {
    bootOwner();
  } else if (ROUTE === 'recovery') {
    bootRecovery();
  } else if (ROUTE === 'linkError') {
    showMessage('הקישור כבר לא בתוקף', 'קישור מאימייל עובד פעם אחת בלבד', 'lock');
    $('messageCard').id = 'linkErrorCard';
    $('linkErrorCard').append(el('button', { class: 'btn', id: 'linkErrorLogin', type: 'button',
      onclick: () => openLoginSheet(() => { location.hash = '#owner'; }) }, 'כניסת מנהל או קישור חדש'));
  } else if (ROUTE === 'meter') {
    setHeader('', 'חשבונות בית', []);
    $('app').classList.add('no-tabs');
  }
}());
