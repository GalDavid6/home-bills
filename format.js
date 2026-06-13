function formatMessage(r) {
  const lines = [];
  lines.push(`🏠 חשבונות בית — ${r.period}`);
  lines.push('');
  lines.push(`💧 מים: ${r.waterTotal} ₪ ÷ 4 = ${r.waterShare} ₪ לכל אחד`);
  lines.push('');
  lines.push(`⚡ חשמל (תעריף ${r.tariff} ₪/קוט"ש):`);
  for (const k of r.kids) {
    lines.push(`• ${k.name}: ${Math.round(k.consumption)} קוט"ש × ${r.tariff} = ${k.electricity} ₪${compareSuffix(k)}`);
  }
  lines.push('');
  lines.push('💰 סה"כ להעברה להורים:');
  for (const k of r.kids) {
    lines.push(`• ${k.name}: ${k.electricity} + ${k.water} = ${k.total} ₪`);
  }
  const flagged = r.kids.filter((k) => k.anomaly);
  if (flagged.length) {
    lines.push('');
    lines.push('⚠️ שים לב לשינוי חריג בצריכה לעומת הפעם הקודמת:');
    for (const k of flagged) {
      lines.push(`• ${k.name}: ${signed(k.pct)}%`);
    }
  }
  return lines.join('\n');
}

// " (לעומת 880, +8%)" when previous data exists, else "".
function compareSuffix(k) {
  if (k.prevE === null || k.prevE === undefined) return '';
  const flag = k.anomaly ? ' ⚠️' : '';
  return ` (לעומת ${k.prevE}, ${signed(k.pct)}%${flag})`;
}

function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatMessage };
}
if (typeof window !== 'undefined') {
  window.formatMessage = formatMessage;
}
