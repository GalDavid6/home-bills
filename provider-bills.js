const HE_MONTHS = { 'ינואר': '01', 'פברואר': '02', 'מרץ': '03', 'אפריל': '04',
  'מאי': '05', 'יוני': '06', 'יולי': '07', 'אוגוסט': '08', 'ספטמבר': '09',
  'אוקטובר': '10', 'נובמבר': '11', 'דצמבר': '12' };

// Normalize: unify Hebrew gershayim/quote chars to ", collapse whitespace.
function norm(t) {
  return String(t).replace(/[״″“”]/g, '"').replace(/\s+/g, ' ');
}

// "total to pay" anchors. pdf.js extracts these RTL invoices with quirks (confirmed
// against real samples): Bezeq keeps label word-order but the amount lands BEFORE the
// label; yes emits the label tokens REVERSED with the amount AFTER. We try the
// real-extraction order first, then the natural reading order as a fallback. The labels
// are specific enough to never match the subtotal / VAT-base / prior-payment decoys.
const NUM = '([0-9][0-9,]*\\.[0-9]{2})';
const TOTAL_RE = {
  bezeq: [
    new RegExp(NUM + '\\s*₪?\\s*סה"כ\\s+לתשלום\\s+כולל\\s+מע"מ'),      // amount BEFORE label (real)
    new RegExp('סה"כ\\s+לתשלום\\s+כולל\\s+מע"מ\\s*₪?\\s*' + NUM),      // amount after (fallback)
  ],
  yes: [
    new RegExp('מע"מ\\s+כולל\\s+בש"ח\\s+לתשלום\\s+סה"כ\\s*' + NUM),    // reversed label, amount after (real)
    new RegExp('סה"כ\\s+לתשלום\\s+בש"ח\\s+כולל\\s+מע"מ\\s*₪?\\s*' + NUM), // natural order (fallback)
  ],
};

function matchTotal(text, provider) {
  for (const re of (TOTAL_RE[provider] || [])) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

function billingMonth(text, provider) {
  if (provider === 'bezeq') {
    // billing month appears as a Hebrew month name + year, either order ("מאי 2026" / "2026 מאי").
    const names = Object.keys(HE_MONTHS).join('|');
    let m = text.match(new RegExp(`(${names})\\s+(20\\d{2})`));
    if (m) return `${m[2]}-${HE_MONTHS[m[1]]}`;
    m = text.match(new RegExp(`(20\\d{2})\\s+(${names})`));
    if (m) return `${m[1]}-${HE_MONTHS[m[2]]}`;
    return null;
  }
  // yes: a "לחודש ... DD/MM/YYYY-DD/MM/YYYY" block ("חשבונית" may sit between, in any order).
  // Take MM/YYYY of the first date after the לחודש anchor.
  const m = text.match(/לחודש\D{0,20}\d{2}\/(\d{2})\/(\d{4})/);
  return m ? `${m[2]}-${m[1]}` : null;
}

// Returns { amount:Number, month:'YYYY-MM'|null } | null. provider: 'bezeq'|'yes'.
function parseInvoiceTotal(rawText, provider) {
  const text = norm(rawText);
  const raw = matchTotal(text, provider);
  if (raw == null) return null;
  const amount = Number(raw.replace(/,/g, ''));
  if (!isFinite(amount)) return null;
  return { amount, month: billingMonth(text, provider) };
}

// Water bills list the water + sewage tariffs as 3-decimal numbers (e.g. 11.650, 4.780) in a
// "פירוט תעריפים" table. The Hebrew labels extract as mojibake, but the digits are clean, so we key
// off numeric shape: water ~11–12 ₪/m³, sewage ~4–5. Returns { water, sewage } | null. A mid-period
// rate change puts more than one distinct rate on the bill; we can't safely auto-pick (sewage fell
// while water rose), so we return null and let the caller flag it for manual entry.
function parseWaterTariff(rawText) {
  // Standalone 3-decimal tokens only: the boundaries stop a match from landing inside a larger
  // number (e.g. a thousands-grouped total like "2,881.760" must not yield a stray "881.760").
  const nums = (String(rawText).match(/(?<![\d.,])\d{1,3}\.\d{3}(?![\d])/g) || []).map(Number);
  const water = [...new Set(nums.filter((n) => n >= 8))];
  const sewage = [...new Set(nums.filter((n) => n > 1 && n < 8))];
  if (water.length !== 1 || sewage.length !== 1) return null;
  return { water: water[0], sewage: sewage[0] };
}

// "dd/mm/yyyy" -> "yyyy-mm-dd", or null when it is not a real calendar date.
function ddmmyyyyToIso(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  if (d.getUTCFullYear() !== +m[3] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[1]) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// IEC (electricity) invoice. pdf.js extracts the summary line as
//   "3,060.45 חיוב בגין צריכה - סה"כ 5658 קוט"ש"   (charge before VAT, then kWh)
// and the period with the END date first: "06/08/2026 08/06/2026 עד -מ" = 08/06 .. 06/08 (dd/mm).
// The period is printed on every page (header and voucher); all copies must agree. Returns
// { charge, kwh, from, to, tariff } | null, where tariff = round2(charge / kwh * 1.18) (VAT incl.).
// Any missing, repeated-but-different or implausible value returns null.
function parseIecBill(rawText) {
  if (rawText == null) return null;
  const text = norm(rawText);
  const cons = [...text.matchAll(/([0-9][0-9,]*\.[0-9]{2})\s+חיוב בגין צריכה - סה"כ\s+([0-9][0-9,]*)\s+קוט"ש/g)];
  if (!cons.length || cons.some((m) => m[1] !== cons[0][1] || m[2] !== cons[0][2])) return null;
  const charge = Number(cons[0][1].replace(/,/g, ''));
  const kwh = Number(cons[0][2].replace(/,/g, ''));
  if (!(charge > 0) || !(kwh > 0)) return null;

  const per = [...text.matchAll(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+עד\s*-?\s*מ/g)];
  if (!per.length || per.some((m) => m[1] !== per[0][1] || m[2] !== per[0][2])) return null;
  const to = ddmmyyyyToIso(per[0][1]);
  const from = ddmmyyyyToIso(per[0][2]);
  if (!to || !from || from > to) return null;

  return { charge, kwh, from, to, tariff: Math.round(charge / kwh * 1.18 * 100) / 100 };
}

// Water (Kfar Saba) invoice total = water + sewage + VAT. pdf.js output for this bill is garbled
// (mojibake labels, reversed/duplicated blocks), so the label cannot be trusted; the numbers can.
// A total is accepted only when it reconciles on the bill itself: some two amounts a (water) and
// b (sewage) plus a third amount v with v ~ 18% of (a + b) (within 2 agorot, VAT is rounded
// per line) sum to it exactly. The total is repeated on the voucher and the detail table, so
// duplicates collapse to one value. Zero or several distinct reconciling totals returns null.
function parseWaterTotal(rawText) {
  if (rawText == null) return null;
  const toks = String(rawText).match(/(?<![\d.,])\d+(?:,\d{3})*\.\d{2}(?!\d|\.\d)/g) || [];
  const vals = [...new Set(toks.map((t) => Math.round(Number(t.replace(/,/g, '')) * 100)))]
    .filter((c) => c > 0).sort((x, y) => x - y);
  if (vals.length > 300) return null; // cubic scan below; a real bill has a few dozen amounts
  const set = new Set(vals);
  const totals = new Set();
  for (const t of vals) {
    for (let i = 0; i < vals.length; i++) {
      for (let j = i + 1; j < vals.length; j++) {
        const a = vals[i], b = vals[j], v = t - a - b;
        if (v <= 0 || !set.has(v) || a + b >= t) continue;
        if (Math.abs(v - 0.18 * (a + b)) <= 2) totals.add(t);
      }
    }
  }
  return totals.size === 1 ? [...totals][0] / 100 : null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseInvoiceTotal, parseWaterTariff, parseIecBill, parseWaterTotal, HE_MONTHS };
}
if (typeof window !== 'undefined') {
  window.parseWaterTariff = parseWaterTariff;
  window.parseIecBill = parseIecBill;
  window.parseWaterTotal = parseWaterTotal;
}
