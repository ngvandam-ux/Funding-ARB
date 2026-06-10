// snapshot-pnl — Supabase Edge Function (Deno), 5-min cron. SPEC §6.2.
// For each open/at_risk position: pull latest marks (stale marks fail loud and the
// position is skipped), settle funding DISCRETELY for each venue funding boundary
// crossed since the last snapshot, mark to market, assess risk, insert a
// pnl_snapshots row and update the position. Liquidation and the negative-funding
// exit rule both close via _shared/paper.ts, which writes the terminal status,
// realized P&L and a final snapshot atomically.
// Hard rules: no secrets, no `any` (zod), fail loud; one bad position is skipped.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import {
  settleFundingDiscrete,
  computeUnrealizedPnl,
  assessRisk,
  nextNegativeFundingStreak,
  shouldAutoClose,
  VENUE_FUNDING_INTERVAL_HOURS,
  EXIT_NEGATIVE_TICKS,
} from '../_shared/pnl.ts'
import { closePaperPosition, loadLatestMarks, type PositionRow, type LatestMark } from '../_shared/paper.ts'

const FN = 'snapshot-pnl'

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const PosRow = z.object({
  id: z.number(),
  opened_at: z.string(),
  position_size_usd: numeric,
  leg_a_instrument_id: z.number(),
  leg_a_side: z.enum(['long', 'short']),
  leg_a_entry_price: numeric,
  leg_b_instrument_id: z.number().nullable(),
  leg_b_side: z.enum(['long', 'short']).nullable(),
  leg_b_entry_price: numeric.nullable(),
  cumulative_funding_usd: numeric,
  cumulative_fees_usd: numeric,
  negative_funding_streak: z.number(),
})
type PosRowT = z.infer<typeof PosRow>

async function lastSnapshotMs(supabase: ReturnType<typeof createClient>, positionId: number, openedAt: string): Promise<number> {
  const { data, error } = await supabase
    .from('pnl_snapshots')
    .select('ts')
    .eq('position_id', positionId)
    .order('ts', { ascending: false })
    .limit(1)
  if (error) throw new Error(`db read pnl_snapshots failed: ${error.message}`)
  const last = (data ?? [])[0] as { ts: string } | undefined
  return new Date(last ? last.ts : openedAt).getTime()
}

function settleLeg(side: 'long' | 'short', mark: LatestMark) {
  return {
    side,
    fundingRateNative: mark.fundingRateNative,
    intervalHours: VENUE_FUNDING_INTERVAL_HOURS[mark.venueId],
    anchorMs: mark.nextFundingMs,
  }
}

async function processPosition(supabase: ReturnType<typeof createClient>, pos: PosRowT, nowMs: number, nowIso: string): Promise<string> {
  const ids = [pos.leg_a_instrument_id]
  if (pos.leg_b_instrument_id !== null) ids.push(pos.leg_b_instrument_id)
  const marks = await loadLatestMarks(supabase, ids, nowMs)
  const markA = marks.get(pos.leg_a_instrument_id)
  if (!markA) throw new Error(`no fresh mark for leg A instrument ${pos.leg_a_instrument_id}`)
  let markB = null as (typeof markA) | null
  if (pos.leg_b_instrument_id !== null) {
    markB = marks.get(pos.leg_b_instrument_id) ?? null
    if (!markB) throw new Error(`no fresh mark for leg B instrument ${pos.leg_b_instrument_id}`)
  }

  const lastMs = await lastSnapshotMs(supabase, pos.id, pos.opened_at)
  const fundingDelta = settleFundingDiscrete({
    legA: settleLeg(pos.leg_a_side, markA),
    legB: markB && pos.leg_b_side ? settleLeg(pos.leg_b_side, markB) : null,
    sizeUsd: pos.position_size_usd,
    lastMs,
    nowMs,
  })
  const newCumFunding = pos.cumulative_funding_usd + fundingDelta

  const legA = { side: pos.leg_a_side, entryPrice: pos.leg_a_entry_price }
  const legB = markB && pos.leg_b_side && pos.leg_b_entry_price !== null ? { side: pos.leg_b_side, entryPrice: pos.leg_b_entry_price } : null
  const unrealized = computeUnrealizedPnl({ legA, legB, markA: markA.mark, markB: markB ? markB.mark : null, sizeUsd: pos.position_size_usd })
  const risk = assessRisk({ legA, legB, markA: markA.mark, markB: markB ? markB.mark : null })

  // Exit rule: net funding receipt at the current quoted rates — positive while
  // the position is still being paid to exist.
  const receiptApr =
    (pos.leg_a_side === 'short' ? markA.fundingRate1hApr : -markA.fundingRate1hApr) +
    (markB && pos.leg_b_side ? (pos.leg_b_side === 'short' ? markB.fundingRate1hApr : -markB.fundingRate1hApr) : 0)
  const streak = nextNegativeFundingStreak(receiptApr, pos.negative_funding_streak)

  const { error: snapErr } = await supabase.from('pnl_snapshots').insert({
    position_id: pos.id,
    unrealized_pnl_usd: unrealized,
    realized_pnl_usd: 0,
    cumulative_funding_usd: newCumFunding,
    cumulative_fees_usd: pos.cumulative_fees_usd,
    leg_a_mark: markA.mark,
    leg_b_mark: markB ? markB.mark : null,
    liquidation_distance_bps: risk.liquidationDistanceBps,
  })
  if (snapErr) throw new Error(`db insert pnl_snapshots failed: ${snapErr.message}`)

  const posForClose: PositionRow = {
    id: pos.id,
    position_size_usd: pos.position_size_usd,
    leg_a_instrument_id: pos.leg_a_instrument_id,
    leg_a_side: pos.leg_a_side,
    leg_a_entry_price: pos.leg_a_entry_price,
    leg_b_instrument_id: pos.leg_b_instrument_id,
    leg_b_side: pos.leg_b_side,
    leg_b_entry_price: pos.leg_b_entry_price,
    cumulative_funding_usd: newCumFunding,
    cumulative_fees_usd: pos.cumulative_fees_usd,
  }

  // Terminal paths close FIRST and only then carry the terminal status —
  // closePaperPosition writes status + realized P&L atomically, so a failure here
  // leaves the position open/at_risk and the next tick retries.
  if (risk.status === 'liquidated_paper') {
    await closePaperPosition(supabase, posForClose, 'liquidated_paper', nowIso)
    return 'liquidated_paper'
  }
  if (shouldAutoClose(streak)) {
    await closePaperPosition(
      supabase,
      posForClose,
      'closed',
      nowIso,
      `auto-closed: net funding receipt non-positive for ${EXIT_NEGATIVE_TICKS} consecutive ticks`,
    )
    return 'auto_closed'
  }

  const { error: updErr } = await supabase
    .from('paper_positions')
    .update({ cumulative_funding_usd: newCumFunding, status: risk.status, negative_funding_streak: streak })
    .eq('id', pos.id)
  if (updErr) throw new Error(`db update paper_position failed: ${updErr.message}`)
  return risk.status
}

Deno.serve(async () => {
  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const { data, error } = await supabase
      .from('paper_positions')
      .select(
        'id, opened_at, position_size_usd, leg_a_instrument_id, leg_a_side, leg_a_entry_price, leg_b_instrument_id, leg_b_side, leg_b_entry_price, cumulative_funding_usd, cumulative_fees_usd, negative_funding_streak',
      )
      .in('status', ['open', 'at_risk'])
    if (error) throw new Error(`db read paper_positions failed: ${error.message}`)
    const positions = (data ?? []).map((r) => PosRow.parse(r))

    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    let snapped = 0
    let liquidated = 0
    let autoClosed = 0
    for (const pos of positions) {
      try {
        const status = await processPosition(supabase, pos, nowMs, nowIso)
        snapped++
        if (status === 'liquidated_paper') liquidated++
        if (status === 'auto_closed') autoClosed++
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        console.error(JSON.stringify({ fn: FN, positionId: pos.id, error: m }))
      }
    }
    return Response.json({ positions: positions.length, snapped, liquidated, autoClosed })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ fn: FN, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
