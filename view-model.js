// Pure view models for the tabbed family view (no DOM, no I/O). A classic script (UMD, like
// calc.js) so the browser gets window.viewModel and Node tests can require it.
(function () {
  const SERIES_LEN = 8;

  function wholeDays(fromIso, toIso) {
    const t = (iso) => {
      const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
      return Date.UTC(y, m - 1, d);
    };
    return Math.round((t(toIso) - t(fromIso)) / 86400000);
  }

  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

  // Home tab summary of the newest published period: the total to transfer, each kid's
  // total (electricity + water share), days since the previous reading, and the recent
  // tariff / water-share series for the two small trend tiles.
  function summaryModel(history, kidOrder) {
    if (!history || !history.length) return null;
    const h = history[history.length - 1];
    const prev = history.length > 1 ? history[history.length - 2] : null;
    const names = kidOrder.filter((n) => h.kids && h.kids[n]);
    const water = num(h.waterShare) || 0;
    const kids = names.map((name) => ({ name, total: h.kids[name].e + water }));
    const recent = history.slice(-SERIES_LEN);
    return {
      id: h.id,
      label: h.label,
      date: h.date || null,
      total: kids.reduce((s, k) => s + k.total, 0),
      kids,
      gapDays: prev && prev.date && h.date ? wholeDays(prev.date, h.date) : null,
      tariff: num(h.tariff),
      waterShare: num(h.waterShare),
      tariffSeries: recent.map((x) => num(x.tariff)).filter((v) => v != null),
      waterSeries: recent.map((x) => num(x.waterShare)).filter((v) => v != null),
    };
  }

  // SVG path for a sparkline of `values` in a w x h box (oldest left, newest right).
  function sparkPath(values, w, h, pad = 3) {
    if (!values || values.length < 2) return '';
    const min = Math.min(...values);
    const max = Math.max(...values);
    const f = (n) => String(Math.round(n * 10) / 10);
    return values.map((v, i) => {
      const x = (i * w) / (values.length - 1);
      const y = max === min ? h / 2 : h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
      return `${i ? 'L' : 'M'}${f(x)} ${f(y)}`;
    }).join(' ');
  }

  // Bills tab: periods that have an electricity or water bill, newest first, with the first
  // document of each kind (repeat uploads of the same bill are not listed twice).
  function billPeriods(history, documents) {
    const docs = documents || [];
    return (history || []).slice().reverse().map((h) => {
      const found = ['electricity_bill', 'water_bill']
        .map((kind) => docs.find((d) => d.kind === kind && d.period_id === h.id))
        .filter(Boolean);
      return found.length
        ? { id: h.id, label: h.label, tariff: num(h.tariff), waterShare: num(h.waterShare), docs: found }
        : null;
    }).filter(Boolean);
  }

  const api = { summaryModel, sparkPath, billPeriods };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.viewModel = api;
}());
