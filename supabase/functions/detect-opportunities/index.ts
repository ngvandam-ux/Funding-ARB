// detect-opportunities — Supabase Edge Function (Deno).
//
// SPEC §8 Session 2, step 3. Thin I/O wrapper around the pure, tested detector
// (_shared/detect.ts ← src/lib/detect.ts). Every 60s it:
//   1. reads the `latest_funding` view (latest snapshot per active instrument),
//   2. runs detectOpportunities (single ≥10%, cross ≥15%; stale legs dropped),
//   3. reconciles the `opportunities` table to the live set keyed by dedup_key:
//        - INSERT any newly-detected opp as status='open',
//        - UPDATE the APRs of an already-open opp in place (keep detected_at),
//        - mark any previously-open opp that is no longer detected 'expired'.
//
// We reconcile via an explicit read-then-write (not ON CONFLICT) so the partial
// unique index `opportunities_dedup_open` stays a pure safety net and the
// expire-when-gone half of the lifecycle is handled in the same pass.
//
// Hard rules (CLAUDE.md): no secrets in code, no `any` (zod parses the view rows),
// fail loud. No venue I/O here — this function only touches our own DB.
//
// Deploy + schedule commands: see README.md in this folder. Requires the additive
// migration in README (adds opportunities.dedup_key + the partial unique index).

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import {
  detectOpportunities,
  DEFAULT_THRESHOLDS,
  DEFAULT_MAX_STALENESS_MS,
  type LatestSnapshot,
  type DetectedOpportunity,
} from '../_shared/detect.ts'

const VENUE = 'detector'

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

// PostgREST returns numeric columns as strings — coerce, rejecting NaN.
const numeric = z
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

const OpenOppRow = z.object({ id: z.number(), dedup_key: z.string() })

function toRow(o: DetectedOpportunity) {
  return {
    kind: o.kind,
    base_symbol: o.baseSymbol,
    leg_a_instrument_id: o.legA.instrumentId,
    leg_a_side: o.legA.side,
    leg_a_funding_apr: o.legA.fundingApr,
    leg_b_instrument_id: o.legB ? o.legB.instrumentId : null,
    leg_b_side: o.legB ? o.legB.side : null,
    leg_b_funding_apr: o.legB ? o.legB.fundingApr : null,
    gross_apr: o.grossApr,
    est_fees_apr_drag: o.feeDragApr,
    est_slippage_apr_drag: o.slipDragApr,
    net_apr: o.netApr,
    min_position_usd: o.minPositionUsd,
    dedup_key: o.dedupKey,
  }
}

Deno.serve(async () => {
  try {
    const supabase = createClient(
      getEnv('SUPABASE_URL'),
      getEnv('SUPABASE_SERVICE_ROLE_KEY'),
      { auth: { persistSession: false } },
    )

    // 1. Read the latest snapshot per active instrument.
    const { data: viewData, error: viewErr } = await supabase
      .from('latest_funding')
      .select('instrument_id, venue_id, base_symbol, venue_symbol, tier, funding_rate_1h_apr, ts')
    if (viewErr) throw new Error(`db read latest_funding failed: ${viewErr.message}`)
    const snapshots: LatestSnapshot[] = (viewData ?? []).map((r) => {
      const row = LatestFundingRow.parse(r)
      return {
        instrumentId: row.instrument_id,
        venueId: row.venue_id,
        baseSymbol: row.base_symbol,
        venueSymbol: row.venue_symbol,
        tier: row.tier,
        fundingRate1hApr: row.funding_rate_1h_apr,
        ts: new Date(row.ts),
      }
    })

    // 2. Pure detection. `now` is the function clock; staleness handled inside.
    const now = new Date()
    const detected = detectOpportunities(snapshots, {
      now,
      maxStalenessMs: DEFAULT_MAX_STALENESS_MS,
      thresholds: DEFAULT_THRESHOLDS,
    })
    const detectedByKey = new Map(detected.map((o) => [o.dedupKey, o]))

    // 3a. Current open opportunities, keyed by dedup_key.
    const { data: openData, error: openErr } = await supabase
      .from('opportunities')
      .select('id, dedup_key')
      .eq('status', 'open')
    if (openErr) throw new Error(`db read open opportunities failed: ${openErr.message}`)
    const openByKey = new Map(
      (openData ?? []).map((r) => {
        const row = OpenOppRow.parse(r)
        return [row.dedup_key, row.id]
      }),
    )

    // 3b. Insert brand-new opps; update APRs of already-open ones in place.
    const toInsert = detected.filter((o) => !openByKey.has(o.dedupKey)).map(toRow)
    if (toInsert.length > 0) {
      const { error } = await supabase.from('opportunities').insert(toInsert)
      if (error) throw new Error(`db insert opportunities failed: ${error.message}`)
    }
    for (const o of detected) {
      const id = openByKey.get(o.dedupKey)
      if (id === undefined) continue
      const { dedup_key: _k, ...patch } = toRow(o) // don't rewrite the key
      const { error } = await supabase.from('opportunities').update(patch).eq('id', id)
      if (error) throw new Error(`db update opportunity ${id} failed: ${error.message}`)
    }

    // 3c. Expire any previously-open opp no longer detected this tick.
    const staleIds = (openData ?? [])
      .map((r) => OpenOppRow.parse(r))
      .filter((r) => !detectedByKey.has(r.dedup_key))
      .map((r) => r.id)
    if (staleIds.length > 0) {
      const { error } = await supabase
        .from('opportunities')
        .update({ status: 'expired', expires_at: now.toISOString() })
        .in('id', staleIds)
      if (error) throw new Error(`db expire opportunities failed: ${error.message}`)
    }

    return Response.json({
      snapshots: snapshots.length,
      detected: detected.length,
      inserted: toInsert.length,
      expired: staleIds.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ venue: VENUE, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
