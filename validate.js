// Input validation for a cycle, and a shape check for imported backups.

// Returns { errors, warnings }. Errors block calculation (missing/invalid
// numbers); warnings are advisory (e.g. a reading lower than the previous one,
// which usually means a typo but is occasionally legitimate).
function validateCycle(input) {
  const errors = [], warnings = [];
  if (!(input.waterTotal > 0)) errors.push('הזן סכום חשבון מים תקין');
  if (!(input.tariff > 0)) errors.push('הזן תעריף לקוט"ש תקין');
  input.kids.forEach((k) => {
    if (k.current === null || k.current === undefined || isNaN(k.current)) {
      errors.push(`הזן קריאה נוכחית עבור ${k.name}`);
    } else if (k.current < k.prev) {
      warnings.push(`${k.name}: הקריאה הנוכחית (${k.current}) נמוכה מהקודמת (${k.prev}) — ייתכן טעות הקלדה`);
    }
  });
  return { errors, warnings };
}

// True if `obj` looks like a backup this app can restore.
function isValidBackup(obj) {
  return !!obj &&
    Array.isArray(obj.kids) &&
    obj.kids.every((k) => k && typeof k.name === 'string') &&
    Array.isArray(obj.history);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateCycle, isValidBackup };
}
if (typeof window !== 'undefined') {
  window.validateCycle = validateCycle;
  window.isValidBackup = isValidBackup;
}
