// src/lib/api.ts
// The ONLY module that calls paper-engine edge functions. Browser is anon-only
// (CLAUDE.md hard rule #2) — the two invokable fns are deployed verify_jwt=false
// and use their own server-side service key. We pass the public anon key as bearer.
const URL = import.meta.env.VITE_SUPABASE_URL as string
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string

async function callFn<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      Authorization: `Bearer ${ANON}`,
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `${fn} failed (${res.status})`)
  return json
}

export function openPaperPosition(opportunityId: number): Promise<{ positionId: number; sizeUsd: number }> {
  return callFn('open-paper-position', { opportunityId })
}

export function closePaperPosition(positionId: number): Promise<{ positionId: number; status: string }> {
  return callFn('close-paper-position', { positionId })
}
