// Supabase-backed store. Wraps the pure mapping (store-map.js) with network I/O.
const KID_ORDER = ['ירין', 'גל', 'ניב'];
let _sb = null;

function initSupabase() {
  // persistSession keeps the owner signed in across browser restarts (the #owner route).
  _sb = window.supabase.createClient(window.CONFIG.SUPABASE_URL, window.CONFIG.SUPABASE_ANON_KEY,
    { auth: { persistSession: true, autoRefreshToken: true } });
  return _sb;
}

// Shared by loadState and loadStateViaReport so both return exactly the same shape.
function buildState(periods, readings, baselines, otherBills) {
  const st = window.rowsToState(periods || [], readings || [], baselines || [], KID_ORDER);
  st.otherBills = (otherBills || []).slice().sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  return st;
}

// History holds published periods only. The owner also reads the single open/ready
// cycle; it is returned apart as activeCycle so the report cards never see a half cycle.
async function loadState() {
  const [{ data: periods }, { data: readings }, { data: baselines }, { data: otherBills }] = await Promise.all([
    _sb.from('periods').select('*'),
    _sb.from('electricity_readings').select('*'),
    _sb.from('baselines').select('*'),
    _sb.from('other_bills').select('*'),
  ]);
  const all = periods || [];
  const published = all.filter((p) => !p.status || p.status === 'published');
  const active = all.find((p) => p.status && p.status !== 'published') || null;
  const st = buildState(published, readings, baselines, otherBills);
  st.activeCycle = active
    ? { period: active, readings: (readings || []).filter((r) => r.period_id === active.id) }
    : null;
  return st;
}

// Report link mode (#r=<token>): the only data source is the `family` edge function.
// The token is sent as x-access-token only; never stored, logged or put in a URL.
// Signed document urls from the response are kept by storage path so signedUrl() can serve them.
let _reportUrls = null;

function reportApiBase() {
  // Dev-only: on localhost, ?mock=PORT points at scripts/mock-family.js.
  const m = /^\?mock=(\d{2,5})$/.exec(location.search);
  if (m && location.hostname === 'localhost') return `http://localhost:${m[1]}/functions/v1/family`;
  return `${window.CONFIG.SUPABASE_URL}/functions/v1/family`;
}

async function loadStateViaReport(token) {
  const res = await fetch(`${reportApiBase()}?action=report`, { headers: { 'x-access-token': token } });
  if (!res.ok) {
    const err = new Error(res.status === 401 ? 'unauthorized' : 'report failed');
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  _reportUrls = new Map((body.documents || []).map((d) => [d.storage_path, d.url || null]));
  const st = buildState(body.periods, body.readings, body.baselines, body.otherBills);
  // documents carry their signed url (null when signing failed) for the renderers.
  st.documents = body.documents || [];
  return st;
}

// Inserts the period + its readings and upserts baselines. Requires auth (RLS).
// The manual flow is a fallback for when no cycle is open: with an open or ready cycle it
// would publish a second period beside it, so it refuses.
async function saveCycle(results, readingDate, baselineByName) {
  const { data: act, error: e0 } = await _sb.from('periods').select('id').neq('status', 'published').limit(1);
  if (e0) throw e0;
  if (act && act.length) throw new Error('יש מחזור פתוח: יש להשלים אותו בכרטיס המחזור');
  const { period, readings } = window.cycleToRows(results, readingDate);
  const { data: inserted, error: e1 } = await _sb.from('periods').insert(period).select().single();
  if (e1) throw e1;
  const rows = readings.map((r) =>
    Object.assign({ period_id: inserted.id, current_reading: baselineByName[r.kid] ?? null }, r));
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
async function signInWithPassword(email, password) {
  return _sb.auth.signInWithPassword({ email, password });
}
async function signOut() { return _sb.auth.signOut(); }
async function updatePassword(password) {
  return _sb.auth.updateUser({ password });
}

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
  if (_reportUrls) {
    const u = _reportUrls.get(path);
    if (!u) throw new Error('document unavailable');
    return u;
  }
  const { data, error } = await _sb.storage.from('documents').createSignedUrl(path, 60);
  if (error) throw error;
  return data.signedUrl;
}

async function deleteDocument(doc) {
  await _sb.storage.from('documents').remove([doc.storage_path]);
  const { error } = await _sb.from('documents').delete().eq('id', doc.id);
  if (error) throw error;
}

// ---------- owner tools (#owner) ----------

const KID_SLUGS = { 'ירין': 'yarin', 'גל': 'gal', 'ניב': 'niv' };
const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };
const roundCents = (n) => Math.round(n * 100) / 100;

// The one permanent family link (#f=). Unlike the retired per-kid links its token is kept
// readable (owner-only RLS) so the owner can copy the same link again at any time; the
// family function still matches only its hash.
async function readFamilyLink() {
  const { data, error } = await _sb.from('access_links').select('token')
    .eq('kind', 'family').eq('active', true).maybeSingle();
  if (error) throw error;
  return (data && data.token) || null;
}

async function insertFamilyLink() {
  const { generateToken, hashToken } = await import('./tokens.mjs?v=4f6410d');
  const token = generateToken();
  const { error } = await _sb.from('access_links')
    .insert({ kind: 'family', kid: null, token, token_hash: await hashToken(token) });
  return { token, error };
}

// The stored family link, issued on first use. A second tab issuing at the same moment
// loses on the one-active-link index and then reads the winner's token.
async function getFamilyLink() {
  const stored = await readFamilyLink();
  if (stored) return stored;
  const { token, error } = await insertFamilyLink();
  if (!error) return token;
  if (error.code === '23505') {
    const winner = await readFamilyLink();
    if (winner) return winner;
  }
  throw error;
}

// For a leaked link: the old one stops working at once (its token is cleared too).
async function replaceFamilyLink() {
  const { error: e1 } = await _sb.from('access_links')
    .update({ active: false, revoked_at: new Date().toISOString(), token: null })
    .eq('kind', 'family').eq('active', true);
  if (e1) throw e1;
  const { token, error } = await insertFamilyLink();
  if (error) throw error;
  return token;
}

const MSG_CYCLE_EXISTS = 'כבר יש מחזור פתוח';

// Opens a cycle by hand (the IEC bill did not arrive or could not be read). The status is
// set explicitly: the column default is 'published', which would show an empty cycle to
// the family. Bill fields stay empty until the owner fills them in the card.
async function openCycleManually(todayIso) {
  const { labelFromDate } = await import('./rules.mjs?v=4f6410d');
  const { data: act, error: e0 } = await _sb.from('periods').select('id').neq('status', 'published').limit(1);
  if (e0) throw e0;
  if (act && act.length) throw new Error(MSG_CYCLE_EXISTS);
  const { data, error } = await _sb.from('periods').insert({
    status: 'open', label: labelFromDate(todayIso), tariff: null, water_total: null, water_share: null, reading_date: null,
  }).select().single();
  if (error) {
    if (error.code === '23505') throw new Error(MSG_CYCLE_EXISTS);
    throw error;
  }
  return data;
}

// Owner entry of the tariff and the water bill total on the active cycle. Never writes
// status itself; readiness then decides open -> ready as for any other input.
async function saveCycleAmounts(periodId, { tariff, waterTotal }) {
  const { data, error } = await _sb.from('periods').update({ tariff, water_total: waterTotal })
    .eq('id', periodId).in('status', ['open', 'ready']).select('id');
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error('המחזור כבר פורסם, אי אפשר לשנות');
  await markReadyIfComplete(periodId);
}

async function uploadCycleBill(periodId, kind, file) {
  if (kind !== 'electricity_bill' && kind !== 'water_bill') throw new Error('bad bill kind');
  await uploadDocument(periodId, kind, null, file);
  await markReadyIfComplete(periodId);
}

// Each kid's previous reading: the latest published period's own current_reading, or the
// baseline when that is missing (see previousByKid). Baselines are only written by publish.
async function previousReadings() {
  const { data: prev, error: e1 } = await _sb.from('periods').select('id').eq('status', 'published')
    .not('reading_date', 'is', null).order('reading_date', { ascending: false }).limit(1).maybeSingle();
  if (e1) throw e1;
  const [r, b] = await Promise.all([
    prev ? _sb.from('electricity_readings').select('kid, current_reading').eq('period_id', prev.id)
      : Promise.resolve({ data: [], error: null }),
    _sb.from('baselines').select('*'),
  ]);
  if (r.error || b.error) throw r.error || b.error;
  return window.ownerCycle.previousByKid({ prevReadings: r.data, baselines: b.data });
}

// Same rule as the family function: open -> ready once all three readings, both bills,
// the tariff and the water total are in. Never moves a cycle backwards or past ready.
async function markReadyIfComplete(periodId) {
  const { cycleReadiness } = await import('./rules.mjs?v=4f6410d');
  const [p, r, d] = await Promise.all([
    _sb.from('periods').select('status, tariff, water_total').eq('id', periodId).single(),
    _sb.from('electricity_readings').select('kid').eq('period_id', periodId).not('current_reading', 'is', null),
    _sb.from('documents').select('kind').eq('period_id', periodId).in('kind', ['electricity_bill', 'water_bill']),
  ]);
  if (p.error || r.error || d.error) throw p.error || r.error || d.error;
  if (p.data.status !== 'open') return;
  const kinds = new Set((d.data || []).map((x) => x.kind));
  const { ready } = cycleReadiness({
    tariff: p.data.tariff, waterTotal: p.data.water_total, kidsSubmitted: (r.data || []).map((x) => x.kid),
    hasElectricityBill: kinds.has('electricity_bill'), hasWaterBill: kinds.has('water_bill'),
  });
  if (!ready) return;
  const { error } = await _sb.from('periods').update({ status: 'ready' }).eq('id', periodId).eq('status', 'open');
  if (error) throw error;
}

// Owner entry or correction of one kid's reading in the active cycle. Writes
// submitted_by 'owner' (never 'link', so the HB409 trigger does not apply), updating the
// existing row instead of upserting. The photo is optional; when given it replaces the
// kid's meter photo the same way a family submission does.
async function saveOwnerReading(periodId, kid, reading, file) {
  if (!KID_ORDER.includes(kid)) throw new Error('bad kid');
  // A stale tab must not write into a cycle that was published meanwhile.
  const { data: per, error: ep } = await _sb.from('periods').select('status').eq('id', periodId).single();
  if (ep) throw ep;
  if (per.status !== 'open' && per.status !== 'ready') throw new Error('המחזור כבר פורסם, אי אפשר לשנות קריאה');
  const prev = (await previousReadings())[kid];
  if (prev == null) throw new Error('חסרה קריאה קודמת');
  let path = null;
  if (file) {
    path = `${periodId}/meter_photo-${KID_SLUGS[kid]}-${Date.now()}.${PHOTO_EXT[file.type] || 'jpg'}`;
    const up = await _sb.storage.from('documents').upload(path, file, { contentType: file.type || 'image/jpeg' });
    if (up.error) throw up.error;
  }
  const discard = async () => { if (path) await _sb.storage.from('documents').remove([path]); };
  const fields = {
    current_reading: reading,
    consumption: roundCents(reading - prev),
    electricity: null,
    submitted_by: 'owner',
    submitted_at: new Date().toISOString(),
  };
  const { data: existing, error: e0 } = await _sb.from('electricity_readings').select('id')
    .eq('period_id', periodId).eq('kid', kid).maybeSingle();
  if (e0) { await discard(); throw e0; }
  const w = existing
    ? await _sb.from('electricity_readings').update(fields).eq('id', existing.id)
    : await _sb.from('electricity_readings').insert(Object.assign({ period_id: periodId, kid }, fields));
  if (w.error) { await discard(); throw w.error; }
  if (path) {
    const { data: docs, error: e1 } = await _sb.from('documents').select('id, storage_path')
      .eq('period_id', periodId).eq('kind', 'meter_photo').eq('kid', kid);
    if (e1) throw e1;
    const docFields = { storage_path: path, label: `מונה ${kid}`, uploaded_at: new Date().toISOString() };
    const d = docs && docs.length
      ? await _sb.from('documents').update(docFields).in('id', docs.map((x) => x.id))
      : await _sb.from('documents').insert(Object.assign({ period_id: periodId, kind: 'meter_photo', kid }, docFields));
    if (d.error) throw d.error;
    const old = (docs || []).map((x) => x.storage_path).filter((p) => p && p !== path);
    if (old.length) await _sb.storage.from('documents').remove(old);
  }
  await markReadyIfComplete(periodId);
}

// ready -> published. Electricity is computed with calc.js (planPublish in owner-cycle.js)
// against the previous published period's readings; readings are updated without touching
// submitted_at, baselines advance (output only), reading_date and label are set, and the
// status flips last and only from 'ready'. A retry after a partial failure recomputes from
// the same previous readings, so it gives the same (or the corrected) numbers.
async function publishCycle(periodId, readingDate) {
  const { labelFromDate } = await import('./rules.mjs?v=4f6410d');
  const { data: period, error: ep } = await _sb.from('periods').select('*').eq('id', periodId).single();
  if (ep) throw ep;
  if (period.status !== 'ready') throw new Error('אפשר לאשר רק מחזור שמוכן לאישור');
  const { data: readings, error: er } = await _sb.from('electricity_readings').select('*').eq('period_id', periodId);
  if (er) throw er;
  const previous = await previousReadings();
  const plan = window.ownerCycle.planPublish({ period, readings, previous, readingDate },
    { computeCycle: window.computeCycle, labelFromDate });
  for (const row of plan.rows) {
    const { data, error } = await _sb.from('electricity_readings')
      .update({ consumption: row.consumption, electricity: row.electricity })
      .eq('period_id', periodId).eq('kid', row.kid).select('id');
    if (error) throw error;
    if (!data || data.length !== 1) throw new Error(`עדכון הקריאה של ${row.kid} נכשל`);
  }
  const { error: e2 } = await _sb.from('baselines')
    .upsert(KID_ORDER.map((kid) => ({ kid, last_reading: plan.baselines[kid] })));
  if (e2) throw e2;
  const { error: e3 } = await _sb.from('periods')
    .update({ reading_date: readingDate, label: plan.label, water_share: plan.waterShare })
    .eq('id', periodId).eq('status', 'ready');
  if (e3) throw e3;
  const { data: done, error: e4 } = await _sb.from('periods').update({ status: 'published' })
    .eq('id', periodId).eq('status', 'ready').select('id');
  if (e4) throw e4;
  if (!done || done.length !== 1) throw new Error('הפרסום נכשל, נסו שוב');
  return plan;
}

window.store = { initSupabase, loadState, loadStateViaReport, saveCycle, getSession, signInWithPassword, signOut,
  updatePassword, listDocuments, uploadDocument, signedUrl, deleteDocument,
  saveProviderBill, deleteProviderDoc, KID_ORDER,
  readFamilyLink, getFamilyLink, replaceFamilyLink, openCycleManually, saveCycleAmounts, uploadCycleBill,
  saveOwnerReading, publishCycle };
