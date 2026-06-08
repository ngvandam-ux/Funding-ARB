// close-paper-position — Supabase Edge Function (Deno). SPEC §6.3.
// Input: POST { positionId: number }. Reads the position + latest marks, settles
// funding + round-trip fees + slippage into realized_pnl_usd (tested pnl.ts via
// _shared/paper.ts), writes close fills, marks the position 'closed'.
// Hard rules: no secrets, no `any` (zod), fail loud (500). No venue I/O.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { closePaperPosition, type PositionRow } from '../_shared/paper.ts'

const FN = 'close-paper-position'

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const Body = z.object({ positionId: z.number() })

const PosRow = z.object({
  id: z.number(),
  status: z.string(),
  position_size_usd: numeric,
  leg_a_instrument_id: z.number(),
  leg_a_side: z.enum(['long', 'short']),
  leg_a_entry_price: numeric,
  leg_b_instrument_id: z.number().nullable(),
  leg_b_side: z.enum(['long', 'short']).nullable(),
  leg_b_entry_price: numeric.nullable(),
  cumulative_funding_usd: numeric,
})

Deno.serve(async (req) => {
  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const body = Body.parse(await req.json())

    const { data, error } = await supabase
      .from('paper_positions')
      .select(
        'id, status, position_size_usd, leg_a_instrument_id, leg_a_side, leg_a_entry_price, leg_b_instrument_id, leg_b_side, leg_b_entry_price, cumulative_funding_usd',
      )
      .eq('id', body.positionId)
      .single()
    if (error) throw new Error(`db read paper_position failed: ${error.message}`)
    const row = PosRow.parse(data)
    if (row.status === 'closed' || row.status === 'liquidated_paper') {
      throw new Error(`position ${row.id} already ${row.status}`)
    }

    const pos: PositionRow = {
      id: row.id,
      position_size_usd: row.position_size_usd,
      leg_a_instrument_id: row.leg_a_instrument_id,
      leg_a_side: row.leg_a_side,
      leg_a_entry_price: row.leg_a_entry_price,
      leg_b_instrument_id: row.leg_b_instrument_id,
      leg_b_side: row.leg_b_side,
      leg_b_entry_price: row.leg_b_entry_price,
      cumulative_funding_usd: row.cumulative_funding_usd,
    }
    await closePaperPosition(supabase, pos, 'closed', new Date().toISOString())
    return Response.json({ positionId: pos.id, status: 'closed' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ fn: FN, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
