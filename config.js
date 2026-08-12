// Public Supabase config. The anon key is public by design; RLS protects writes.
window.CONFIG = {
  SUPABASE_URL: 'https://hxnmhgeqjhymqgiusmne.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh4bm1oZ2Vxamh5bXFnaXVzbW5lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyOTgzMTksImV4cCI6MjA5Njg3NDMxOX0.29sRDSx2b6Si_3onn5N0MkBPXPhKQ-NvnJErC4FS4qg',
  // Auth gate (emails are not secret; passwords live only in Supabase):
  OWNER_UID: '4c5fdcc0-edf5-4cd3-a00e-7c3c3ea2029e',
  EDITOR_EMAIL: 'galdavid806@gmail.com',
  VIEWER_EMAIL: 'family@home-bills.app',
};
