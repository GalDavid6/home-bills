// Shape check for imported backups: true if `obj` looks like a backup this app can restore.
function isValidBackup(obj) {
  return !!obj &&
    Array.isArray(obj.kids) &&
    obj.kids.every((k) => k && typeof k.name === 'string') &&
    Array.isArray(obj.history);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isValidBackup };
}
if (typeof window !== 'undefined') {
  window.isValidBackup = isValidBackup;
}
