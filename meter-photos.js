// Pair a kid's current meter photo (this period) with the previous one (prior period).
// Pure: takes the loaded documents array + period ids; returns { current, previous } docs
// (or null when absent). No I/O — the caller fetches signed URLs lazily.
function pairMeterPhoto(documents, periodId, prevPeriodId, kid) {
  const find = (pid) => pid == null ? null :
    (documents || []).find((d) => d.kind === 'meter_photo' && d.period_id === pid && d.kid === kid) || null;
  return { current: find(periodId), previous: find(prevPeriodId) };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { pairMeterPhoto };
if (typeof window !== 'undefined') window.pairMeterPhoto = pairMeterPhoto;
