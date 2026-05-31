// ingest-okx — Supabase Edge Function (Deno).
//
// SPEC §8 Session 2. The trickiest venue. Two api-notes §4 corrections, both
// VERIFIED live 2026-05-31 (see README + vault Environment & Ops):
//   1. `market/tickers` does NOT carry markPx/idxPx. Mark comes from
//      `public/mark-price`, index from `market/index-tickers` (keyed by the
//      UNDERLYING, e.g. BTC-USDT-SWAP → BTC-USDT).
//   2. `funding-rate?instType=SWAP` is rejected (code 50014). funding-rate must
//      be queried per `instId`.
// 4h-vs-8h cadence detection lives in normalizeOkx (fundingTime delta → ×6 not ×3).
//
// Hard rules (CLAUDE.md): public market-data only, fetch only, no secrets, no
// `any` (zod parses), fail loud. OI is auxiliary; here oiUsd is a batch read so a
// missing entry just yields null (not fatal).
//
// Deploy + schedule commands: see README.md in this folder.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import {
  normalizeOkx,
  OkxFundingSchema,
  type OkxFunding,
} from '../_shared/normalize.ts'

const BASE = 'https://www.okx.com/api/v5'
const FUNDING_RATE = `${BASE}/public/funding-rate`
const MARK_PRICE = `${BASE}/public/mark-price?instType=SWAP`
const INDEX_TICKERS = `${BASE}/market/index-tickers?quoteCcy=USDT`
const OPEN_INTEREST = `${BASE}/public/open-interest?instType=SWAP`
const VENUE = 'okx'

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

const MarkPriceResp = z.object({
  code: z.string(),
  data: z.array(z.object({ instId: z.string(), markPx: z.string() })),
})
const IndexTickersResp = z.object({
  code: z.string(),
  data: z.array(z.object({ instId: z.string(), idxPx: z.string() })),
})
const OpenInterestResp = z.object({
  code: z.string(),
  data: z.array(z.object({ instId: z.string(), oiUsd: z.string() })),
})
const FundingResp = z.object({ code: z.string(), data: z.array(OkxFundingSchema) })

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) {
    console.error(JSON.stringify({ venue: VENUE, endpoint: url, status: res.status }))
    throw new Error(`okx HTTP ${res.status} for ${url}`)
  }
  return await res.json()
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

    // Batch reads: mark price, index price (by underlying), open interest (USD).
    const [markRaw, idxRaw, oiRaw] = await Promise.all([
      fetchJson(MARK_PRICE),
      fetchJson(INDEX_TICKERS),
      fetchJson(OPEN_INTEREST),
    ])
    const markMap = new Map(MarkPriceResp.parse(markRaw).data.map((d) => [d.instId, d.markPx]))
    const idxMap = new Map(IndexTickersResp.parse(idxRaw).data.map((d) => [d.instId, d.idxPx]))
    const oiMap = new Map(OpenInterestResp.parse(oiRaw).data.map((d) => [d.instId, d.oiUsd]))

    // funding-rate is per-instId (batch is rejected — api-notes §4 correction #2).
    const fundingByInst = new Map<string, OkxFunding>()
    for (const inst of tracked) {
      const raw = await fetchJson(`${FUNDING_RATE}?instId=${inst.venue_symbol}`)
      const parsed = FundingResp.parse(raw)
      const f = parsed.data[0]
      if (f === undefined) {
        throw new Error(`okx funding-rate returned no data for ${inst.venue_symbol}`)
      }
      fundingByInst.set(inst.venue_symbol, f)
    }

    const ts = new Date()
    const rows = tracked.map((inst) => {
      const funding = fundingByInst.get(inst.venue_symbol)
      const markPx = markMap.get(inst.venue_symbol)
      // index instId is the UNDERLYING: BTC-USDT-SWAP → BTC-USDT.
      const underlying = inst.venue_symbol.replace(/-SWAP$/, '')
      const idxPx = idxMap.get(underlying)
      if (funding === undefined || markPx === undefined || idxPx === undefined) {
        throw new Error(
          `okx missing data for ${inst.venue_symbol} ` +
            `(funding=${!!funding} mark=${!!markPx} idx=${!!idxPx})`,
        )
      }
      const oiUsd = oiMap.get(inst.venue_symbol)
      const n = normalizeOkx({
        funding,
        ticker: { instId: inst.venue_symbol, markPx, idxPx },
        baseSymbol: inst.base_symbol,
        openInterestUsd: oiUsd !== undefined ? Number(oiUsd) : null,
        ts,
      })
      return {
        instrument_id: inst.id,
        ts: n.ts.toISOString(),
        funding_rate_native: n.fundingRateNative,
        funding_rate_1h_apr: n.fundingRate1hApr,
        next_funding_ts: n.nextFundingTs ? n.nextFundingTs.toISOString() : null,
        mark_price: n.markPrice,
        index_price: n.indexPrice,
        open_interest_usd: n.openInterestUsd,
        raw: { funding, markPx, idxPx, oiUsd: oiUsd ?? null },
      }
    })

    const { error: insErr } = await supabase.from('funding_snapshots').insert(rows)
    if (insErr) throw new Error(`db insert funding_snapshots failed: ${insErr.message}`)

    return Response.json({ inserted: rows.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ venue: VENUE, endpoint: FUNDING_RATE, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
