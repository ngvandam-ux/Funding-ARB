import { createClient } from '@supabase/supabase-js'

// Browser-side singleton client. Uses the ANON key only — RLS-protected,
// read-only for the dashboard (CLAUDE.md hard rule #2: the service_role key
// is NEVER imported here; it lives only in Edge Function env).
const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY — check .env.local',
  )
}

export const supabase = createClient(url, anonKey)
