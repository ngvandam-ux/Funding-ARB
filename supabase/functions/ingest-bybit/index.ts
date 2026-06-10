// ingest-bybit — Supabase Edge Function (Deno).
//
// SPEC §8 Session 2. GETs the PUBLIC Bybit v5 linear tickers (all symbols in one
// call), normalizes one row per tracked instrument, inserts into funding_snapshots
// via the service-role client. Bybit's `openInterestValue` is already USD.
//
// Hard rules (CLAUDE.md): public market-data only, fetch only, no secrets, no
// `any` (zod parses), fail loud on venue/HTTP errors.
//
// ⚠️ Bybit fronts its API with CloudFront geo-blocking ("configured to block
// access from your country"). If this 500s with that message, the Supabase
// egress region is blocked — see README + vault Environment & Ops note.
//
// Deploy + schedule commands: see README.md in this folder.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { normalizeBybit } from '../_shared/normalize.ts'

const TICKERS = 'https://api.bybit.com/v5/market/tickers?category=linear'
const VENUE = 'bybit'

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

// v5 envelope: { retCode, retMsg, result: { list: [...] } }. We only need each
// item's symbol to locate tracked rows; normalizeBybit zod-parses the full item.
const TickersEnvelope = z.object({
  retCode: z.number(),
  retMsg: z.string(),
  result: z.object({
    list: z.array(z.object({ symbol: z.string() }).passthrough()),
  }),
})

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

    // Bybit fronts the API with CloudFront, which 403s programmatic requests that
    // lack a browser-like User-Agent. Send one (+ Accept) so the edge fetch isn't
    // mistaken for a bot. (Verified fix for the 403 seen from the Frankfurt egress.)
    const res = await fetch(TICKERS, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    })
    if (!res.ok) {
      console.error(JSON.stringify({ venue: VENUE, endpoint: TICKERS, status: res.status }))
      throw new Error(`bybit HTTP ${res.status}`)
    }
    const env = TickersEnvelope.parse(await res.json())
    if (env.retCode !== 0) {
      console.error(
        JSON.stringify({ venue: VENUE, endpoint: TICKERS, retCode: env.retCode, retMsg: env.retMsg }),
      )
      throw new Error(`bybit retCode ${env.retCode}: ${env.retMsg}`)
    }
    const bySymbol = new Map(env.result.list.map((it) => [it.symbol, it]))

    const ts = new Date()
    const rows = []
    for (const inst of tracked) {
      // Per-symbol resilience: a delisted/renamed symbol or one bad normalize
      // skips that instrument (logged loud) instead of killing the whole batch.
      try {
        const item = bySymbol.get(inst.venue_symbol)
        if (item === undefined) {
          throw new Error(`tracked symbol ${inst.venue_symbol} not in bybit tickers`)
        }
        const n = normalizeBybit({ item, baseSymbol: inst.base_symbol, ts })
        rows.push({
          instrument_id: inst.id,
          ts: n.ts.toISOString(),
          funding_rate_native: n.fundingRateNative,
          funding_rate_1h_apr: n.fundingRate1hApr,
          next_funding_ts: n.nextFundingTs ? n.nextFundingTs.toISOString() : null,
          mark_price: n.markPrice,
          index_price: n.indexPrice,
          open_interest_usd: n.openInterestUsd,
          raw: { item },
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
      throw new Error(`all ${tracked.length} tracked bybit symbols failed to normalize`)
    }

    const { error: insErr } = await supabase.from('funding_snapshots').insert(rows)
    if (insErr) throw new Error(`db insert funding_snapshots failed: ${insErr.message}`)

    return Response.json({ inserted: rows.length, skipped: tracked.length - rows.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ venue: VENUE, endpoint: TICKERS, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
