// Pure helpers for the meter update sheet: the three live stat tiles (previous reading,
// kWh this cycle, daily average) and the live ok / warn / block check of the typed number.
// No I/O and no globals; the shared rules module is passed in so this file stays importable
// from Node tests and from the browser (where rules.mjs sits next to it).

const MSG_BAD_READING = 'נא להזין מספר בלבד';

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

// used = reading - previous (may be negative); daily = used / days, only when used >= 0.
export function updateStats({ reading, previous, days }) {
  if (reading == null || Number.isNaN(reading)) return { previous, used: null, daily: null };
  const used = round(reading - previous, 2);
  const daily = used < 0 ? null : round(used / Math.max(days || 0, 1), 1);
  return { previous, used, daily };
}

// '13,660' / '12,830.18' / '-' for a missing value. Digits are Western, as on the meter.
export function fmtNum(n, maxDecimals = 0) {
  if (n == null || Number.isNaN(n)) return '-';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: maxDecimals });
}

// Whole calendar days from a YYYY-MM-DD date to today (YYYY-MM-DD), at least 1.
export function daysSince(fromIso, todayIso) {
  if (!fromIso) return 1;
  const t = (iso) => {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.max(Math.round((t(todayIso) - t(fromIso)) / 86400000), 1);
}

// Live check of the typed text. ctx: { previous, days, maxDaily }. serverWarn: { reading,
// message } when the function warned about a number the local rules passed; it applies only
// while that exact number is typed. rules: the shared rules module.
export function liveCheck(text, ctx, serverWarn, rules) {
  if (!String(text || '').trim()) return { level: 'empty', reading: null, message: null };
  const reading = rules.parseReadingInput(text);
  if (reading == null || reading <= 0) return { level: 'invalid', reading: null, message: MSG_BAD_READING };
  if (serverWarn && rules.confirmApplies(serverWarn, reading)) {
    return { level: 'warn', reading, message: serverWarn.message };
  }
  const check = rules.validateReading({
    reading, previous: ctx.previous, days: ctx.days, maxDailyHistory: ctx.maxDaily,
  });
  return { level: check.level, reading, message: check.message };
}
