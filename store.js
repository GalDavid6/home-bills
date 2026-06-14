// Supabase-backed store. Wraps the pure mapping (store-map.js) with network I/O.
const KID_ORDER = ['ירין', 'גל', 'ניב'];
let _sb = null;

function initSupabase() {
  _sb = window.supabase.createClient(window.CONFIG.SUPABASE_URL, window.CONFIG.SUPABASE_ANON_KEY);
  return _sb;
}

async function loadState() {
  const [{ data: periods }, { data: readings }, { data: baselines }, { data: otherBills }] = await Promise.all([
    _sb.from('periods').select('*'),
    _sb.from('electricity_readings').select('*'),
    _sb.from('baselines').select('*'),
    _sb.from('other_bills').select('*'),
  ]);
  const st = window.rowsToState(periods || [], readings || [], baselines || [], KID_ORDER);
  st.otherBills = (otherBills || []).slice().sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  return st;
}

// Inserts the period + its readings and upserts baselines. Requires auth (RLS).
async function saveCycle(results, readingDate, baselineByName) {
  const { period, readings } = window.cycleToRows(results, readingDate);
  const { data: inserted, error: e1 } = await _sb.from('periods').insert(period).select().single();
  if (e1) throw e1;
  const rows = readings.map((r) => Object.assign({ period_id: inserted.id }, r));
  const { error: e2 } = await _sb.from('electricity_readings').insert(rows);
  if (e2) throw e2;
  const baseRows = KID_ORDER.map((name) => ({ kid: name, last_reading: baselineByName[name] }));
  const { error: e3 } = await _sb.from('baselines').upsert(baseRows);
  if (e3) throw e3;
}

async function getSession() {
  const { data } = await _sb.auth.getSession();
  return data.session;
}
async function signIn(email) {
  return _sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
}
async function signOut() { return _sb.auth.signOut(); }

async function listDocuments() {
  const { data, error } = await _sb.from('documents').select('*');
  if (error) throw error;
  return data || [];
}

async function uploadDocument(periodId, kind, kid, file) {
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const kidSlug = kid ? '-' + ({ 'ירין': 'yarin', 'גל': 'gal', 'ניב': 'niv' }[kid] || kid) : '';
  const path = `${periodId}/${kind}${kidSlug}.${ext}`;
  const up = await _sb.storage.from('documents').upload(path, file, { upsert: true });
  if (up.error) throw up.error;
  const label = kind === 'water_bill' ? 'חשבון מים' : kind === 'electricity_bill' ? 'חשבון חשמל' : `מונה ${kid || ''}`.trim();
  const { error } = await _sb.from('documents').insert({ period_id: periodId, kind, kid: kid || null, storage_path: path, label });
  if (error) throw error;
}

// Upsert one provider's monthly amount and (optionally) archive its PDF.
// provider: 'bezeq'|'yes'; month: 'YYYY-MM'; amount: Number|null; file: File|null.
async function saveProviderBill(provider, month, amount, file) {
  const row = { month, updated_at: new Date().toISOString() };
  if (amount != null && !isNaN(amount)) row[provider] = Number(amount);
  const { error: e1 } = await _sb.from('other_bills').upsert(row, { onConflict: 'month' });
  if (e1) throw e1;
  if (file) {
    const ext = (file.name.split('.').pop() || 'pdf').toLowerCase();
    const path = `other/${provider}/${month}.${ext}`;
    const up = await _sb.storage.from('documents').upload(path, file, { upsert: true });
    if (up.error) throw up.error;
    // Remove any prior row for this exact path, then insert (keeps one doc per provider-month).
    await _sb.from('documents').delete().eq('storage_path', path);
    const { error: e2 } = await _sb.from('documents').insert(
      { period_id: null, kind: provider, kid: null, storage_path: path, label: month });
    if (e2) throw e2;
  }
}

async function deleteProviderDoc(doc) { return deleteDocument(doc); }

async function signedUrl(path) {
  const { data, error } = await _sb.storage.from('documents').createSignedUrl(path, 60);
  if (error) throw error;
  return data.signedUrl;
}

async function deleteDocument(doc) {
  await _sb.storage.from('documents').remove([doc.storage_path]);
  const { error } = await _sb.from('documents').delete().eq('id', doc.id);
  if (error) throw error;
}

window.store = { initSupabase, loadState, saveCycle, getSession, signIn, signOut,
  listDocuments, uploadDocument, signedUrl, deleteDocument,
  saveProviderBill, deleteProviderDoc, KID_ORDER };
