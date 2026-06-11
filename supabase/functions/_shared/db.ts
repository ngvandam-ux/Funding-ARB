// Shared Deno DB read layer: paged reads + zod row parsers for our own
// views. PostgREST caps a single response (Supabase default 1000 rows), so
// any read that can exceed the cap MUST page or it silently truncates — the
// funding_interval_rates view is already ~860 rows and grows with every
// instrument added. Fail loud on errors (hard rule #7). No `any`.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import type { LatestSnapshot } from './detect.ts'
import type { IntervalRate } from './stats.ts'

export async function readAllRows<T>(
  client: SupabaseClient,
  relation: string,
  select: string,
  parse: (raw: unknown) => T,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from(relation)
      .select(select)
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`db read ${relation} failed: ${error.message}`)
    const rows = data ?? []
    for (const r of rows) out.push(parse(r))
    if (rows.length < pageSize) return out
  }
}

// PostgREST returns numeric columns as strings — coerce, rejecting NaN.
export const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const LatestFundingRow = z.object({
  instrument_id: z.number(),
  venue_id: z.enum(['hyperliquid', 'binance_futures', 'bybit', 'okx']),
  base_symbol: z.string(),
  venue_symbol: z.string(),
  tier: z.enum(['major', 'mid', 'alt']),
  funding_rate_1h_apr: numeric,
  ts: z.string(),
})

export const LATEST_FUNDING_SELECT =
  'instrument_id, venue_id, base_symbol, venue_symbol, tier, funding_rate_1h_apr, ts'

export function parseLatestFundingRow(raw: unknown): LatestSnapshot {
  const row = LatestFundingRow.parse(raw)
  return {
    instrumentId: row.instrument_id,
    venueId: row.venue_id,
    baseSymbol: row.base_symbol,
    venueSymbol: row.venue_symbol,
    tier: row.tier,
    fundingRate1hApr: row.funding_rate_1h_apr,
    ts: new Date(row.ts),
  }
}

const IntervalRateRow = z.object({
  instrument_id: z.number(),
  interval_ts: z.string(),
  funding_rate_1h_apr: numeric,
})

export const INTERVAL_RATES_SELECT = 'instrument_id, interval_ts, funding_rate_1h_apr'

export function parseIntervalRateRow(raw: unknown): IntervalRate {
  const row = IntervalRateRow.parse(raw)
  return {
    instrumentId: row.instrument_id,
    intervalTs: new Date(row.interval_ts),
    fundingRate1hApr: row.funding_rate_1h_apr,
  }
}
