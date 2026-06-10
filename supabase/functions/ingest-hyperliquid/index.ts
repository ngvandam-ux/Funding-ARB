// ingest-hyperliquid — Supabase Edge Function (Deno).
//
// SPEC §8 Session 1, step 5. POSTs the PUBLIC Hyperliquid `metaAndAssetCtxs`
// info endpoint, normalizes one row per tracked instrument, and inserts into
// funding_snapshots via the service-role client (RLS blocks anon writes).
//
// Hard rules (CLAUDE.md):
//  - Public market-data endpoint ONLY. No signed/trade/order calls.
//  - fetch only — no exchange SDKs. (supabase-js is the DB client, not a venue SDK.)
//  - No secrets in code: env via Deno.env.get. HYPERLIQUID_PRIVATE_KEY is never read.
//  - No silent retries: on venue/HTTP error, log structured JSON and FAIL LOUD
//    (HTTP 500). The cron retries next tick.
//  - No `any`: the venue payload is zod-parsed; the schema defines the type.
//
// Deploy + schedule commands: see README.md in this folder.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  MetaAndAssetCtxsSchema,
  normalizeHyperliquid,
} from '../_shared/normalize.ts'

const HL_ENDPOINT = 'https://api.hyperliquid.xyz/info'
const VENUE = 'hyperliquid'

interface TrackedInstrument {
  id: number
  venue_symbol: string
  base_symbol: string
}

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

Deno.serve(async () => {
  try {
    const supabase = createClient(
      getEnv('SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } },
    )

    // 1. Tracked Hyperliquid instruments (active). RLS: read via service role.
    const { data: instruments, error: instErr } = await supabase
      .from('instruments')
      .select('id, venue_symbol, base_symbol')
      .eq('venue_id', VENUE)
      .eq('is_active', true)
    if (instErr) throw new Error(`db read instruments failed: ${instErr.message}`)
    const tracked = (instruments ?? []) as TrackedInstrument[]
    if (tracked.length === 0) {
      return Response.json({ inserted: 0, note: 'no active instruments' })
    }

    // 2. POST the public info endpoint. Fail loud on any non-200.
    const res = await fetch(HL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    })
    if (!res.ok) {
      console.error(
        JSON.stringify({ venue: VENUE, endpoint: HL_ENDPOINT, status: res.status }),
      )
      throw new Error(`hyperliquid HTTP ${res.status}`)
    }

    // 3. zod-parse the [meta, ctxs] envelope. A shape change fails loud here
    //    instead of inserting partial garbage.
    const payload = MetaAndAssetCtxsSchema.parse(await res.json())
    const [meta, ctxs] = payload

    // Positional universe (api-notes §1 gotcha): name → index → ctxs[index].
    const indexByName = new Map<string, number>()
    meta.universe.forEach((u, i) => indexByName.set(u.name, i))

    const ts = new Date()
    const rows = []
    for (const inst of tracked) {
      // Per-symbol resilience: a delisted/renamed symbol or one bad normalize
      // skips that instrument (logged loud) instead of killing the whole batch.
      try {
        const i = indexByName.get(inst.venue_symbol)
        if (i === undefined || ctxs[i] === undefined) {
          throw new Error(
            `tracked symbol ${inst.venue_symbol} not found in HL universe`,
          )
        }
        const ctx = ctxs[i]
        const n = normalizeHyperliquid({
          ctx,
          venueSymbol: inst.venue_symbol,
          baseSymbol: inst.base_symbol,
          ts,
        })
        rows.push({
          instrument_id: inst.id,
          ts: n.ts.toISOString(),
          funding_rate_native: n.fundingRateNative,
          funding_rate_1h_apr: n.fundingRate1hApr,
          next_funding_ts: n.nextFundingTs ? n.nextFundingTs.toISOString() : null,
          mark_price: n.markPrice,
          index_price: n.indexPrice,
          open_interest_usd: n.openInterestUsd,
          raw: { name: inst.venue_symbol, ctx }, // FULL raw asset ctx + its name
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(
          JSON.stringify({ venue: VENUE, instrument: inst.venue_symbol, skipError: message }),
        )
        continue
      }
    }

    // Every tracked symbol failed → the venue feed is genuinely dead. Fail loud
    // so the cron retries, instead of inserting nothing and looking healthy.
    if (rows.length === 0 && tracked.length > 0) {
      throw new Error(`all ${tracked.length} tracked hyperliquid symbols failed to normalize`)
    }

    // 4. Insert all rows. RLS: service-role client bypasses anon write block.
    const { error: insErr } = await supabase.from('funding_snapshots').insert(rows)
    if (insErr) throw new Error(`db insert funding_snapshots failed: ${insErr.message}`)

    return Response.json({ inserted: rows.length, skipped: tracked.length - rows.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(
      JSON.stringify({ venue: VENUE, endpoint: HL_ENDPOINT, error: message }),
    )
    return Response.json({ error: message }, { status: 500 })
  }
})
