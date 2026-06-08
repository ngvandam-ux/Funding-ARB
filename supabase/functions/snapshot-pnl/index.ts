// snapshot-pnl — Supabase Edge Function (Deno), 5-min cron. SPEC §6.2.
// For each open/at_risk position: pull latest marks, accrue funding pro-rata since
// the last snapshot, mark to market, assess risk, insert a pnl_snapshots row and
// update the position. On liquidated_paper, force-close via _shared/paper.ts.
// Hard rules: no secrets, no `any` (zod), fail loud; one bad position is skipped.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { accrueFunding, computeUnrealizedPnl, assessRisk } from '../_shared/pnl.ts'
import { closePaperPosition, loadLatestMarks, type PositionRow } from '../_shared/paper.ts'

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

async function processPosition(supabase: ReturnType<typeof createClient>, pos: PosRowT, nowMs: number, nowIso: string): Promise<string> {
  const ids = [pos.leg_a_instrument_id]
  if (pos.leg_b_instrument_id !== null) ids.push(pos.leg_b_instrument_id)
  const marks = await loadLatestMarks(supabase, ids)
  const markA = marks.get(pos.leg_a_instrument_id)
  if (!markA) throw new Error(`no fresh mark for leg A instrument ${pos.leg_a_instrument_id}`)
  let markB = null as (typeof markA) | null
  if (pos.leg_b_instrument_id !== null) {
    markB = marks.get(pos.leg_b_instrument_id) ?? null
    if (!markB) throw new Error(`no fresh mark for leg B instrument ${pos.leg_b_instrument_id}`)
  }

  const dtMs = nowMs - (await lastSnapshotMs(supabase, pos.id, pos.opened_at))
  const fundingDelta = accrueFunding({
    legA: { side: pos.leg_a_side, fundingRate1hApr: markA.fundingRate1hApr },
    legB: markB && pos.leg_b_side ? { side: pos.leg_b_side, fundingRate1hApr: markB.fundingRate1hApr } : null,
    sizeUsd: pos.position_size_usd,
    dtMs,
  })
  const newCumFunding = pos.cumulative_funding_usd + fundingDelta

  const legA = { side: pos.leg_a_side, entryPrice: pos.leg_a_entry_price }
  const legB = markB && pos.leg_b_side && pos.leg_b_entry_price !== null ? { side: pos.leg_b_side, entryPrice: pos.leg_b_entry_price } : null
  const unrealized = computeUnrealizedPnl({ legA, legB, markA: markA.mark, markB: markB ? markB.mark : null, sizeUsd: pos.position_size_usd })
  const risk = assessRisk({ legA, legB, markA: markA.mark, markB: markB ? markB.mark : null })

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

  const { error: updErr } = await supabase
    .from('paper_positions')
    .update({ cumulative_funding_usd: newCumFunding, status: risk.status })
    .eq('id', pos.id)
  if (updErr) throw new Error(`db update paper_position failed: ${updErr.message}`)

  if (risk.status === 'liquidated_paper') {
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
    }
    await closePaperPosition(supabase, posForClose, 'liquidated_paper', nowIso)
  }
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
        'id, opened_at, position_size_usd, leg_a_instrument_id, leg_a_side, leg_a_entry_price, leg_b_instrument_id, leg_b_side, leg_b_entry_price, cumulative_funding_usd, cumulative_fees_usd',
      )
      .in('status', ['open', 'at_risk'])
    if (error) throw new Error(`db read paper_positions failed: ${error.message}`)
    const positions = (data ?? []).map((r) => PosRow.parse(r))

    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    let snapped = 0
    let liquidated = 0
    for (const pos of positions) {
      try {
        const status = await processPosition(supabase, pos, nowMs, nowIso)
        snapped++
        if (status === 'liquidated_paper') liquidated++
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        console.error(JSON.stringify({ fn: FN, positionId: pos.id, error: m }))
      }
    }
    return Response.json({ positions: positions.length, snapped, liquidated })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ fn: FN, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
