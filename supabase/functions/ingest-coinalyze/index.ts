// ingest-coinalyze — Supabase Edge Function (Deno), 60s cron.
// Pulls Binance + Bybit funding / open interest / price from the Coinalyze data API
// (those venues block cloud IPs directly — see Decision 0004) and writes
// funding_snapshots rows tagged venue_id binance_futures / bybit. Downstream
// (detector, dashboard, paper engine) already handle those venue_ids unchanged.
//
// Hard rules (CLAUDE.md): no secrets in code (COINALYZE_API_KEY via env), no `any`
// (zod parses responses), fail loud. Normalization matches normalize.ts (8h venues)
// via the tested _shared/coinalyze.ts so cross-venue APR compare is apples-to-apples.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import type { VenueId } from '../_shared/domain.ts'
import { coinalyzeSymbol, fundingAprFromCoinalyze, nextFunding8hUtc } from '../_shared/coinalyze.ts'

const VENUE = 'ingest-coinalyze'
const BASE = 'https://api.coinalyze.net/v1'

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const InstrumentRow = z.object({
  id: z.number(),
  venue_id: z.enum(['binance_futures', 'bybit']),
  venue_symbol: z.string(),
})

const ValuePoint = z.object({ symbol: z.string(), value: numeric })
const OhlcvSeries = z.object({
  symbol: z.string(),
  history: z.array(z.object({ t: z.number(), c: numeric })),
})

async function coinalyzeGet<T>(path: string, params: Record<string, string>, apiKey: string, schema: z.ZodType<T>): Promise<T[]> {
  const url = new URL(`${BASE}${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url.toString(), { headers: { api_key: apiKey, Accept: 'application/json' } })
  if (!res.ok) {
    throw new Error(`coinalyze ${res.status} on ${path}: ${await res.text().catch(() => '')}`)
  }
  const json = (await res.json()) as unknown
  return z.array(schema).parse(json)
}

Deno.serve(async () => {
  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const apiKey = getEnv('COINALYZE_API_KEY')

    // 1. Our Binance/Bybit instruments → Coinalyze symbols.
    const { data: instrData, error: instrErr } = await supabase
      .from('instruments')
      .select('id, venue_id, venue_symbol')
      .in('venue_id', ['binance_futures', 'bybit'])
      .eq('is_active', true)
    if (instrErr) throw new Error(`db read instruments failed: ${instrErr.message}`)
    const instruments = (instrData ?? []).map((r) => InstrumentRow.parse(r))
    if (instruments.length === 0) return Response.json({ ingested: 0, note: 'no binance/bybit instruments' })

    const symbolByInstrument = new Map<number, string>()
    const instrumentBySymbol = new Map<string, number>()
    for (const i of instruments) {
      const sym = coinalyzeSymbol(i.venue_id as VenueId, i.venue_symbol)
      symbolByInstrument.set(i.id, sym)
      instrumentBySymbol.set(sym, i.id)
    }
    const csv = [...instrumentBySymbol.keys()].join(',')

    // 2. Batched Coinalyze reads.
    const nowMs = Date.now()
    const fromSec = Math.floor((nowMs - 10 * 60 * 1000) / 1000)
    const toSec = Math.floor(nowMs / 1000)
    const [funding, oi, ohlcv] = await Promise.all([
      coinalyzeGet('/funding-rate', { symbols: csv }, apiKey, ValuePoint),
      coinalyzeGet('/open-interest', { symbols: csv, convert_to_usd: 'true' }, apiKey, ValuePoint),
      coinalyzeGet('/ohlcv-history', { symbols: csv, interval: '1min', from: String(fromSec), to: String(toSec) }, apiKey, OhlcvSeries),
    ])

    const fundingBySym = new Map(funding.map((f) => [f.symbol, f.value]))
    const oiBySym = new Map(oi.map((o) => [o.symbol, o.value]))
    const markBySym = new Map<string, number>()
    for (const s of ohlcv) {
      const latest = s.history.reduce<{ t: number; c: number } | null>((a, b) => (!a || b.t > a.t ? b : a), null)
      if (latest) markBySym.set(s.symbol, latest.c)
    }

    // 3. Build + insert one snapshot per instrument that has a funding value.
    const nextTs = nextFunding8hUtc(nowMs)
    const rows: Record<string, unknown>[] = []
    let skipped = 0
    for (const [instrumentId, sym] of symbolByInstrument) {
      const value = fundingBySym.get(sym)
      if (value === undefined) {
        skipped++
        continue
      }
      // Coinalyze value is PERCENT-per-8h; store the fraction + annualize via the tested
      // helper (which does the ÷100). Without it the APR is 100× too big (caused a
      // live contamination incident — see lib/coinalyze.ts).
      const native = value / 100
      rows.push({
        instrument_id: instrumentId,
        funding_rate_native: native,
        funding_rate_1h_apr: fundingAprFromCoinalyze(value),
        next_funding_ts: nextTs,
        mark_price: markBySym.get(sym) ?? null,
        index_price: null,
        open_interest_usd: oiBySym.get(sym) ?? null,
        raw: { source: 'coinalyze', symbol: sym },
      })
    }

    if (rows.length > 0) {
      const { error: insErr } = await supabase.from('funding_snapshots').insert(rows)
      if (insErr) throw new Error(`db insert funding_snapshots failed: ${insErr.message}`)
    }

    return Response.json({ ingested: rows.length, skipped })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ venue: VENUE, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
