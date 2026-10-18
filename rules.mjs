// Pure shared rules (no I/O, no globals): imported by the browser, Deno and Node.

const KIDS = ['ירין', 'גל', 'ניב'];
const MSG_LOWER = 'המספר נמוך מהקריאה הקודמת, נא לבדוק';
const MSG_JUMP = 'הקפיצה גדולה מהרגיל, נא לוודא שהמספר נכון';
const MSG_PHOTO = 'התמונה לא נתמכת או גדולה מדי';
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const FALLBACK_DAILY = 60;

export function parseReadingInput(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim().replace(/\s+/g, '');
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`);
}

export function validateReading({ reading, previous, days, maxDailyHistory }) {
  if (reading < previous) return { level: 'block', message: MSG_LOWER };
  const perDay = maxDailyHistory == null ? FALLBACK_DAILY : maxDailyHistory * 1.5;
  if (reading - previous > perDay * days) return { level: 'warn', message: MSG_JUMP };
  return { level: 'ok', message: null };
}

function wholeDays(isoA, isoB) {
  const t = (iso) => {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(isoB) - t(isoA)) / 86400000);
}

export function maxDailyConsumption(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  let max = null;
  for (let i = 1; i < history.length; i++) {
    const days = wholeDays(history[i - 1].date, history[i].date);
    if (days <= 0) continue;
    const rate = history[i].consumption / days;
    if (max === null || rate > max) max = rate;
  }
  return max;
}

export function cycleReadiness({ tariff, waterTotal, kidsSubmitted = [], hasElectricityBill, hasWaterBill }) {
  const missing = KIDS.filter((k) => !kidsSubmitted.includes(k));
  if (!hasElectricityBill) missing.push('electricity_bill');
  if (!hasWaterBill) missing.push('water_bill');
  if (!tariff) missing.push('tariff');
  if (waterTotal == null) missing.push('water_total');
  return { ready: missing.length === 0, missing };
}

export function labelFromDate(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d}.${m}.${String(y).slice(-2)}`;
}

export function checkPhoto({ type, size }) {
  const ok = typeof type === 'string' && type.startsWith('image/') && size <= MAX_PHOTO_BYTES;
  return ok ? null : MSG_PHOTO;
}

// The kid named by a family-link request: exactly one of the three names, else null.
export function familyKid(value) {
  return typeof value === 'string' && KIDS.includes(value) ? value : null;
}

// The family link's home card: shown only while the cycle is 'open'. ctx is the family
// meter context { cycle, kids: [{ kid, submitted }] }.
export function familyUpdateCard(ctx) {
  if (!ctx || !ctx.cycle || ctx.cycle.status !== 'open') return null;
  const done = new Set((ctx.kids || []).filter((k) => k.submitted).map((k) => k.kid));
  const remaining = KIDS.filter((k) => !done.has(k));
  return { remaining, line: remaining.length ? `נשאר: ${remaining.join(', ')}` : 'כולם עדכנו' };
}
