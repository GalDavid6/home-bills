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

// Zip filename for a provider's archived PDFs, e.g. 'bezeq-2025-2026.zip'.
function providerZipName(docs, provider) {
  const years = (docs || [])
    .map((d) => (d.label && /^(\d{4})-\d{2}$/.test(d.label)) ? d.label.slice(0, 4) : null)
    .filter(Boolean).sort();
  if (!years.length) return `${provider}.zip`;
  const lo = years[0], hi = years[years.length - 1];
  return lo === hi ? `${provider}-${lo}.zip` : `${provider}-${lo}-${hi}.zip`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseInvoiceTotal, providerZipName, HE_MONTHS };
}
if (typeof window !== 'undefined') {
  window.parseInvoiceTotal = parseInvoiceTotal;
  window.providerZipName = providerZipName;
}
