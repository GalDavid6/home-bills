// Pure helpers for history-aware reporting: compare the current cycle to the
// most recent past cycle, flag anomalies, and expose a per-kid consumption series.

var ANOMALY_THRESHOLD = 40; // percent change (abs) that warrants a ⚠️ flag

function pctChange(current, previous) {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

// Returns a shallow copy of `results` where each kid gains: prevE, pct, anomaly.
// Comparison is against the last (most recent) entry in `history`.
function compareCycle(results, history) {
  const last = history && history.length ? history[history.length - 1] : null;
  const kids = results.kids.map((k) => {
    const prevE = last && last.kids[k.name] ? last.kids[k.name].e : null;
    const pct = pctChange(k.electricity, prevE);
    const anomaly = pct !== null && Math.abs(pct) >= ANOMALY_THRESHOLD;
    return Object.assign({}, k, { prevE, pct, anomaly });
  });
  return Object.assign({}, results, { kids });
}

function consumptionSeries(history, kidName) {
  return history
    .filter((h) => h.kids[kidName])
    .map((h) => ({ label: h.label, c: h.kids[kidName].c }));
}

function daysBetween(isoA, isoB) {
  if (!isoA || !isoB) return null;
  const a = new Date(isoA), b = new Date(isoB);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

// Per-cycle daily consumption rate (kWh/day) for a kid. Normalizing by the
// number of days since the previous reading removes the cycle-length artifact,
// so the series reflects real usage intensity and is comparable across cycles.
// The first cycle has no prior date, so the series starts at the second cycle.
function dailySeries(history, kidName) {
  const out = [];
  for (let i = 1; i < history.length; i++) {
    const h = history[i], prev = history[i - 1];
    if (!h.kids[kidName]) continue;
    const days = daysBetween(prev.date, h.date);
    if (!days || days <= 0) continue;
    out.push({ label: h.label, date: h.date, days, rate: h.kids[kidName].c / days });
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { compareCycle, consumptionSeries, dailySeries, daysBetween, pctChange, ANOMALY_THRESHOLD };
}
if (typeof window !== 'undefined') {
  window.compareCycle = compareCycle;
  window.consumptionSeries = consumptionSeries;
  window.dailySeries = dailySeries;
  window.pctChange = pctChange;
}
