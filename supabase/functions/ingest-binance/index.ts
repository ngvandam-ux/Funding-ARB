// ingest-binance — Supabase Edge Function (Deno).
//
// SPEC §8 Session 2. GETs the PUBLIC Binance USDⓈ-M `premiumIndex` (all symbols),
// normalizes one row per tracked instrument, and inserts into funding_snapshots
// via the service-role client (RLS blocks anon writes).
//
// Hard rules (CLAUDE.md): public market-data only, fetch only (no SDKs), no
// secrets in code, no `any` (zod parses the payload), fail loud on venue/HTTP
// errors. Open interest is auxiliary (nullable, unused by the detector) so an OI
// fetch failure is logged loudly but does NOT fail the funding insert.
//
// ⚠️ Binance fapi geo-blocks some regions ("Service unavailable from a restricted
// location"). If this function 500s with that message, the Supabase egress region
// is restricted — see README + the vault Environment & Ops note.
//
// Deploy + schedule commands: see README.md in this folder.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { normalizeBinance } from '../_shared/normalize.ts'

const PREMIUM_INDEX = 'https://fapi.binance.com/fapi/v1/premiumIndex'
const OPEN_INTEREST = 'https://fapi.binance.com/fapi/v1/openInterest'
const VENUE = 'binance_futures'

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

// premiumIndex (no symbol) returns an array; we only need the symbol to locate
// our tracked items, then normalizeBinance zod-parses the full item.
const PremiumIndexArray = z.array(z.object({ symbol: z.string() }).passthrough())
const OpenInterestSchema = z.object({ openInterest: z.string(), symbol: z.string() })

async function fetchOpenInterestUsd(
  venueSymbol: string,
  markPrice: number,
): Promise<number | null> {
  const url = `${OPEN_INTEREST}?symbol=${venueSymbol}`
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const oi = OpenInterestSchema.parse(await res.json())
    // Binance openInterest is in base-asset units → × markPrice for USD.
    return Number(oi.openInterest) * markPrice
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Loud, but non-fatal: OI is nullable and unused by the detector.
    console.error(JSON.stringify({ venue: VENUE, endpoint: url, oiError: message }))
    return null
  }
}

Deno.serve(async () => {
  try {
    const supabase = createClient(
      getEnv('SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } },
    )

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

    const res = await fetch(PREMIUM_INDEX)
    if (!res.ok) {
      console.error(
        JSON.stringify({ venue: VENUE, endpoint: PREMIUM_INDEX, status: res.status }),
      )
      throw new Error(`binance HTTP ${res.status}`)
    }
    const items = PremiumIndexArray.parse(await res.json())
    const bySymbol = new Map(items.map((it) => [it.symbol, it]))

    const ts = new Date()
    const rows = []
    for (const inst of tracked) {
      // Per-symbol resilience: a delisted/renamed symbol or one bad normalize
      // skips that instrument (logged loud) instead of killing the whole batch.
      try {
        const item = bySymbol.get(inst.venue_symbol)
        if (item === undefined) {
          throw new Error(`tracked symbol ${inst.venue_symbol} not in binance premiumIndex`)
        }
        const n = normalizeBinance({
          item,
          baseSymbol: inst.base_symbol,
          openInterestUsd: null, // filled below once we have markPrice
          ts,
        })
        const openInterestUsd = await fetchOpenInterestUsd(inst.venue_symbol, n.markPrice)
        rows.push({
          instrument_id: inst.id,
          ts: n.ts.toISOString(),
          funding_rate_native: n.fundingRateNative,
          funding_rate_1h_apr: n.fundingRate1hApr,
          next_funding_ts: n.nextFundingTs ? n.nextFundingTs.toISOString() : null,
          mark_price: n.markPrice,
          index_price: n.indexPrice,
          open_interest_usd: openInterestUsd,
          raw: { item, openInterestUsd },
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
      throw new Error(`all ${tracked.length} tracked binance symbols failed to normalize`)
    }

    const { error: insErr } = await supabase.from('funding_snapshots').insert(rows)
    if (insErr) throw new Error(`db insert funding_snapshots failed: ${insErr.message}`)

    return Response.json({ inserted: rows.length, skipped: tracked.length - rows.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ venue: VENUE, endpoint: PREMIUM_INDEX, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
