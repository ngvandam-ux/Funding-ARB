// open-paper-position — Supabase Edge Function (Deno). SPEC §6.1.
// Input: POST { opportunityId: number, sizeUsd?: number }. Loads the opportunity,
// reads latest marks, computes fills (tested pnl.ts), inserts a paper_position +
// per-leg open fills via service role, flips the opportunity to paper_traded.
// Hard rules: no secrets in code, no `any` (zod), fail loud (500). No venue I/O.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { PAPER_POSITION_USD } from '../_shared/pnl.ts'
import { openPaperPosition, type OpportunityRow } from '../_shared/paper.ts'

const FN = 'open-paper-position'

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

const Body = z.object({
  opportunityId: z.number(),
  sizeUsd: z.number().positive().optional(),
})

const OppRow = z.object({
  id: z.number(),
  leg_a_instrument_id: z.number(),
  leg_a_side: z.enum(['long', 'short']),
  leg_b_instrument_id: z.number().nullable(),
  leg_b_side: z.enum(['long', 'short']).nullable(),
  dedup_key: z.string(),
})

Deno.serve(async (req) => {
  try {
    // Service-role-only: the public anon key is a valid JWT (so verify_jwt alone
    // wouldn't stop it). Require the bearer to equal the server-side service key.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    if (token !== getEnv('SUPABASE_SERVICE_ROLE_KEY')) {
      return Response.json({ error: 'forbidden: service role required' }, { status: 403 })
    }
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const body = Body.parse(await req.json())
    const sizeUsd = body.sizeUsd ?? PAPER_POSITION_USD

    const { data, error } = await supabase
      .from('opportunities')
      .select('id, leg_a_instrument_id, leg_a_side, leg_b_instrument_id, leg_b_side, dedup_key')
      .eq('id', body.opportunityId)
      .single()
    if (error) throw new Error(`db read opportunity failed: ${error.message}`)
    const opp = OppRow.parse(data) as OpportunityRow

    const positionId = await openPaperPosition(supabase, opp, sizeUsd)
    return Response.json({ positionId, sizeUsd })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ fn: FN, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
