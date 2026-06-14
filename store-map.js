function rowsToState(periods, readings, baselines, kidOrder) {
  const sorted = periods.slice().sort((a, b) =>
    new Date(a.reading_date || a.created_at) - new Date(b.reading_date || b.created_at));
  const history = sorted.map((p) => {
    const kids = {};
    readings.filter((r) => r.period_id === p.id).forEach((r) => {
      kids[r.kid] = { c: Number(r.consumption), e: Number(r.electricity) };
    });
    return { id: p.id, label: p.label, date: p.reading_date, tariff: Number(p.tariff), waterTotal: Number(p.water_total), waterShare: Number(p.water_share), kids };
  });
  const kids = kidOrder.map((name) => {
    const b = baselines.find((x) => x.kid === name);
    return { name, lastReading: b ? Number(b.last_reading) : 0 };
  });
  return { kids, history };
}

function cycleToRows(results, readingDate) {
  const period = {
    label: results.label || results.period || '',
    reading_date: readingDate,
    tariff: results.tariff,
    water_total: results.waterTotal,
    water_share: results.waterShare,
  };
  const readings = results.kids.map((k) => ({ kid: k.name, consumption: k.consumption, electricity: k.electricity }));
  return { period, readings };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rowsToState, cycleToRows };
}
if (typeof window !== 'undefined') {
  window.rowsToState = rowsToState;
  window.cycleToRows = cycleToRows;
}
