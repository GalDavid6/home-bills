// Supabase-backed store. Wraps the pure mapping (store-map.js) with network I/O.
const KID_ORDER = ['ירין', 'גל', 'ניב'];
let _sb = null;

function initSupabase() {
  _sb = window.supabase.createClient(window.CONFIG.SUPABASE_URL, window.CONFIG.SUPABASE_ANON_KEY);
  return _sb;
}

async function loadState() {
  const [{ data: periods }, { data: readings }, { data: baselines }] = await Promise.all([
    _sb.from('periods').select('*'),
    _sb.from('electricity_readings').select('*'),
    _sb.from('baselines').select('*'),
  ]);
  return window.rowsToState(periods || [], readings || [], baselines || [], KID_ORDER);
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

window.store = { initSupabase, loadState, saveCycle, getSession, signIn, signOut, KID_ORDER };
