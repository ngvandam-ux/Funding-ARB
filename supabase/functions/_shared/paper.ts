// Shared Deno DB orchestration for the paper engine. Pure math lives in pnl.ts;
// this is thin I/O reused by open-paper-position/auto-open (open path) and
// close-paper-position/snapshot-pnl (close path). No `any`; fail loud.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import type { VenueId, Tier } from './domain.ts'
import { computeOpenFills, computeClose, type Side } from './pnl.ts'

// Latest snapshot fields we need per instrument (from the latest_funding view).
export interface LatestMark {
  mark: number
  tier: Tier
  venueId: VenueId
  fundingRate1hApr: number
}

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const MarkRow = z.object({
  instrument_id: z.number(),
  venue_id: z.enum(['hyperliquid', 'binance_futures', 'bybit', 'okx']),
  tier: z.enum(['major', 'mid', 'alt']),
  mark_price: numeric,
  funding_rate_1h_apr: numeric,
})

export async function loadLatestMarks(
  supabase: SupabaseClient,
  instrumentIds: number[],
): Promise<Map<number, LatestMark>> {
  const { data, error } = await supabase
    .from('latest_funding')
    .select('instrument_id, venue_id, tier, mark_price, funding_rate_1h_apr')
    .in('instrument_id', instrumentIds)
  if (error) throw new Error(`db read latest_funding failed: ${error.message}`)
  const map = new Map<number, LatestMark>()
  for (const r of data ?? []) {
    const row = MarkRow.parse(r)
    map.set(row.instrument_id, {
      mark: row.mark_price,
      tier: row.tier,
      venueId: row.venue_id,
      fundingRate1hApr: row.funding_rate_1h_apr,
    })
  }
  return map
}

// An opportunities row, as needed to open a position.
export interface OpportunityRow {
  id: number
  leg_a_instrument_id: number
  leg_a_side: Side
  leg_b_instrument_id: number | null
  leg_b_side: Side | null
  dedup_key: string
}

export async function openPaperPosition(
  supabase: SupabaseClient,
  opp: OpportunityRow,
  sizeUsd: number,
): Promise<number> {
  const ids = [opp.leg_a_instrument_id]
  if (opp.leg_b_instrument_id !== null) ids.push(opp.leg_b_instrument_id)
  const marks = await loadLatestMarks(supabase, ids)

  const markA = marks.get(opp.leg_a_instrument_id)
  if (!markA) throw new Error(`no fresh mark for leg A instrument ${opp.leg_a_instrument_id}`)
  let markB: LatestMark | null = null
  if (opp.leg_b_instrument_id !== null) {
    markB = marks.get(opp.leg_b_instrument_id) ?? null
    if (!markB) throw new Error(`no fresh mark for leg B instrument ${opp.leg_b_instrument_id}`)
  }

  const fills = computeOpenFills({
    legA: { venueId: markA.venueId, tier: markA.tier, side: opp.leg_a_side, mark: markA.mark },
    legB:
      markB && opp.leg_b_side
        ? { venueId: markB.venueId, tier: markB.tier, side: opp.leg_b_side, mark: markB.mark }
        : null,
    sizeUsd,
  })

  const { data: posData, error: posErr } = await supabase
    .from('paper_positions')
    .insert({
      opportunity_id: opp.id,
      status: 'open',
      position_size_usd: sizeUsd,
      leg_a_instrument_id: opp.leg_a_instrument_id,
      leg_a_side: fills.legA.side,
      leg_a_entry_price: fills.legA.entryPrice,
      leg_b_instrument_id: opp.leg_b_instrument_id,
      leg_b_side: fills.legB ? fills.legB.side : null,
      leg_b_entry_price: fills.legB ? fills.legB.entryPrice : null,
      cumulative_fees_usd: fills.feesUsd,
      dedup_key: opp.dedup_key,
    })
    .select('id')
    .single()
  if (posErr) throw new Error(`db insert paper_positions failed: ${posErr.message}`)
  const positionId = (posData as { id: number }).id

  const fillRows = [
    {
      position_id: positionId,
      leg: 'a',
      side: fills.legA.side,
      action: 'open',
      instrument_id: opp.leg_a_instrument_id,
      price: fills.legA.entryPrice,
      size_usd: sizeUsd,
      fee_usd: fills.legA.feeUsd,
      slippage_bps: fills.legA.slippageBps,
    },
  ]
  if (fills.legB && opp.leg_b_instrument_id !== null) {
    fillRows.push({
      position_id: positionId,
      leg: 'b',
      side: fills.legB.side,
      action: 'open',
      instrument_id: opp.leg_b_instrument_id,
      price: fills.legB.entryPrice,
      size_usd: sizeUsd,
      fee_usd: fills.legB.feeUsd,
      slippage_bps: fills.legB.slippageBps,
    })
  }
  const { error: fillErr } = await supabase.from('paper_fills').insert(fillRows)
  if (fillErr) throw new Error(`db insert paper_fills failed: ${fillErr.message}`)

  const { error: oppErr } = await supabase
    .from('opportunities')
    .update({ status: 'paper_traded' })
    .eq('id', opp.id)
  if (oppErr) throw new Error(`db update opportunity ${opp.id} failed: ${oppErr.message}`)

  return positionId
}

// A paper_positions row, as needed to close.
export interface PositionRow {
  id: number
  position_size_usd: number
  leg_a_instrument_id: number
  leg_a_side: Side
  leg_a_entry_price: number
  leg_b_instrument_id: number | null
  leg_b_side: Side | null
  leg_b_entry_price: number | null
  cumulative_funding_usd: number
}

export async function closePaperPosition(
  supabase: SupabaseClient,
  pos: PositionRow,
  finalStatus: 'closed' | 'liquidated_paper',
  closedAtIso: string,
): Promise<number> {
  const ids = [pos.leg_a_instrument_id]
  if (pos.leg_b_instrument_id !== null) ids.push(pos.leg_b_instrument_id)
  const marks = await loadLatestMarks(supabase, ids)

  const markA = marks.get(pos.leg_a_instrument_id)
  if (!markA) throw new Error(`no fresh mark for leg A instrument ${pos.leg_a_instrument_id}`)
  let markB: LatestMark | null = null
  if (pos.leg_b_instrument_id !== null) {
    markB = marks.get(pos.leg_b_instrument_id) ?? null
    if (!markB) throw new Error(`no fresh mark for leg B instrument ${pos.leg_b_instrument_id}`)
  }

  const result = computeClose({
    legA: {
      venueId: markA.venueId,
      tier: markA.tier,
      side: pos.leg_a_side,
      entryPrice: pos.leg_a_entry_price,
    },
    legB:
      markB && pos.leg_b_side && pos.leg_b_entry_price !== null
        ? { venueId: markB.venueId, tier: markB.tier, side: pos.leg_b_side, entryPrice: pos.leg_b_entry_price }
        : null,
    markA: markA.mark,
    markB: markB ? markB.mark : null,
    sizeUsd: pos.position_size_usd,
    cumulativeFundingUsd: pos.cumulative_funding_usd,
  })

  const closeRows = [
    {
      position_id: pos.id,
      leg: 'a',
      side: result.legA.side,
      action: 'close',
      instrument_id: pos.leg_a_instrument_id,
      price: result.legA.exitPrice,
      size_usd: pos.position_size_usd,
      fee_usd: result.legA.feeUsd,
      slippage_bps: result.legA.slippageBps,
    },
  ]
  if (result.legB && pos.leg_b_instrument_id !== null) {
    closeRows.push({
      position_id: pos.id,
      leg: 'b',
      side: result.legB.side,
      action: 'close',
      instrument_id: pos.leg_b_instrument_id,
      price: result.legB.exitPrice,
      size_usd: pos.position_size_usd,
      fee_usd: result.legB.feeUsd,
      slippage_bps: result.legB.slippageBps,
    })
  }
  const { error: fillErr } = await supabase.from('paper_fills').insert(closeRows)
  if (fillErr) throw new Error(`db insert close fills failed: ${fillErr.message}`)

  const { error: updErr } = await supabase
    .from('paper_positions')
    .update({
      status: finalStatus,
      closed_at: closedAtIso,
      realized_pnl_usd: result.realizedPnlUsd,
      cumulative_fees_usd: result.totalFeesUsd,
    })
    .eq('id', pos.id)
  if (updErr) throw new Error(`db update paper_position ${pos.id} failed: ${updErr.message}`)

  return pos.id
}
