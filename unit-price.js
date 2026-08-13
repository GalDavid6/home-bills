// Pure builder for the per-report "unit price vs previous period" block. Electricity ₪/kWh comes
// from periods.tariff; water ₪/m³ is water+sewage combined. Reuses pctChange (integer %, or null)
// for consistency with the existing electricity rate-alert.
var _pctChange = (typeof window !== 'undefined' && window.pctChange)
  ? window.pctChange
  : require('./history').pctChange;

var round2 = (n) => Math.round(n * 100) / 100;

function _row(label, valueStr, pct, prevStr, tooltip) {
  let delta = '';
  if (pct !== null && pct !== undefined) {
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'zero';
    const arrow = pct > 0 ? '▲ +' : pct < 0 ? '▼ ' : '';
    delta = `<span class="uc-delta ${cls}">${arrow}${pct}%</span>` +
            `<span class="uc-prev">(היה ${prevStr})</span>`;
  }
  const t = tooltip ? ` title="${tooltip}"` : '';
  return `<div class="uc-row"${t}><span class="uc-label">${label}</span>` +
         `<span class="uc-val">${valueStr}</span>${delta}</div>`;
}

function unitPriceBlockHtml(cur, prev) {
  if (!cur) return '';
  const rows = [];

  if (cur.tariff != null) {
    const pv = prev && prev.tariff != null ? Number(prev.tariff) : null;
    const pct = pv != null ? _pctChange(Number(cur.tariff), pv) : null;
    rows.push(_row('⚡ חשמל', `${cur.tariff} ₪/קוט"ש`, pct, pv));
  }

  const wCur = (cur.waterTariff != null && cur.sewageTariff != null)
    ? round2(Number(cur.waterTariff) + Number(cur.sewageTariff)) : null;
  const wPrev = (prev && prev.waterTariff != null && prev.sewageTariff != null)
    ? round2(Number(prev.waterTariff) + Number(prev.sewageTariff)) : null;
  if (wCur != null) {
    const pct = wPrev != null ? _pctChange(wCur, wPrev) : null;
    rows.push(_row('💧 מים', `${wCur} ₪/מ"ק`, pct, wPrev,
      `מים ${cur.waterTariff} + ביוב ${cur.sewageTariff}`));
  }

  if (!rows.length) return '';
  return `<div class="unit-cmp"><div class="uc-head">מחיר ליחידה — מול המחזור הקודם</div>` +
         `${rows.join('')}</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { unitPriceBlockHtml };
}
if (typeof window !== 'undefined') {
  window.unitPriceBlockHtml = unitPriceBlockHtml;
}
