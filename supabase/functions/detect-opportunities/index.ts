// detect-opportunities — Supabase Edge Function (Deno).
//
// SPEC §8 Session 2, step 3 + momentum_harvest (design doc 2026-06-11). Thin
// I/O wrapper around the pure, tested detectors (_shared/detect.ts and
// _shared/stats.ts ← src/lib twins). Every 60s: read latest_funding +
// funding_interval_rates (paged — can exceed PostgREST's 1000-row cap), run
// detectOpportunities + detectMomentum, upsert funding_stats, then reconcile
// `opportunities` keyed by dedup_key (insert new / update APRs in place /
// expire no-longer-detected). Read-then-write (not ON CONFLICT) so the partial
// unique index `opportunities_dedup_open` stays a pure safety net.
//
// momentum_harvest is DETECT-ONLY: auto-open filters the kind out by query.
// Hard rules (CLAUDE.md): no secrets in code, no `any` (zod parses all rows),
// fail loud. No venue I/O here — this function only touches our own DB.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import {
  detectOpportunities,
  DEFAULT_THRESHOLDS,
  DEFAULT_MAX_STALENESS_MS,
  type DetectedOpportunity,
  type Side,
} from '../_shared/detect.ts'
import { detectMomentum, computeFundingStats } from '../_shared/stats.ts'
import {
  readAllRows,
  parseLatestFundingRow,
  parseIntervalRateRow,
  LATEST_FUNDING_SELECT,
  INTERVAL_RATES_SELECT,
} from '../_shared/db.ts'

const VENUE = 'detector'

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

const OpenOppRow = z.object({
  id: z.number(),
  dedup_key: z.string(),
  kind: z.string(),
  leg_a_side: z.enum(['long', 'short']),
})

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

    // 1. Latest snapshot per active instrument + settled per-interval rates.
    const { data: viewData, error: viewErr } = await supabase
      .from('latest_funding')
      .select(LATEST_FUNDING_SELECT)
    if (viewErr) throw new Error(`db read latest_funding failed: ${viewErr.message}`)
    const snapshots = (viewData ?? []).map(parseLatestFundingRow)
    const intervalRates = await readAllRows(
      supabase,
      'funding_interval_rates',
      INTERVAL_RATES_SELECT,
      parseIntervalRateRow,
    )

    // 2a. Current open opportunities, keyed by dedup_key (side feeds hysteresis).
    const { data: openData, error: openErr } = await supabase
      .from('opportunities')
      .select('id, dedup_key, kind, leg_a_side')
      .eq('status', 'open')
    if (openErr) throw new Error(`db read open opportunities failed: ${openErr.message}`)
    const openRows = (openData ?? []).map((r) => OpenOppRow.parse(r))
    const openByKey = new Map(openRows.map((r) => [r.dedup_key, r.id]))
    const openMomentum = new Map<string, Side>(
      openRows.filter((r) => r.kind === 'momentum_harvest').map((r) => [r.dedup_key, r.leg_a_side]),
    )

    // 2b. Pure detection. `now` is the function clock; staleness handled inside.
    const now = new Date()
    const detected = [
      ...detectOpportunities(snapshots, {
        now,
        maxStalenessMs: DEFAULT_MAX_STALENESS_MS,
        thresholds: DEFAULT_THRESHOLDS,
      }),
      ...detectMomentum(snapshots, intervalRates, {
        now,
        maxStalenessMs: DEFAULT_MAX_STALENESS_MS,
        openMomentum,
      }),
    ]
    const detectedByKey = new Map(detected.map((o) => [o.dedupKey, o]))

    // 3. Stats history: first write per (instrument, settled interval) wins.
    const stats = computeFundingStats(intervalRates, now).map((s) => ({
      instrument_id: s.instrumentId,
      interval_ts: s.intervalTs.toISOString(),
      n_intervals: s.nIntervals,
      mean_apr: s.meanApr,
      stddev_apr: s.stddevApr,
      current_apr: s.currentApr,
      z_score: s.zScore,
    }))
    if (stats.length > 0) {
      const { error } = await supabase
        .from('funding_stats')
        .upsert(stats, { onConflict: 'instrument_id,interval_ts', ignoreDuplicates: true })
      if (error) throw new Error(`db upsert funding_stats failed: ${error.message}`)
    }

    // 4a. Insert brand-new opps; update APRs of already-open ones in place.
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

    // 4b. Expire any previously-open opp no longer detected this tick.
    const staleIds = openRows.filter((r) => !detectedByKey.has(r.dedup_key)).map((r) => r.id)
    if (staleIds.length > 0) {
      const { error } = await supabase
        .from('opportunities')
        .update({ status: 'expired', expires_at: now.toISOString() })
        .in('id', staleIds)
      if (error) throw new Error(`db expire opportunities failed: ${error.message}`)
    }

    return Response.json({
      snapshots: snapshots.length,
      intervalRates: intervalRates.length,
      detected: detected.length,
      momentum: detected.filter((o) => o.kind === 'momentum_harvest').length,
      statsRows: stats.length,
      inserted: toInsert.length,
      expired: staleIds.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ venue: VENUE, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
