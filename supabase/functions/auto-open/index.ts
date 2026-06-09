// auto-open — Supabase Edge Function (Deno), 5-min cron. SPEC §8 30-day run.
// Opens one paper position per open opportunity that clears the PAPER-OPEN bar
// (single ≥15% net, cross ≥20% net), deduped so only one open/at_risk position
// exists per opportunity dedup_key. Reuses _shared/paper.ts openPaperPosition.
// Hard rules: no secrets, no `any` (zod), fail loud; one opp failure is logged
// and skipped so the rest still open.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { PAPER_POSITION_USD } from '../_shared/pnl.ts'
import { openPaperPosition, type OpportunityRow } from '../_shared/paper.ts'
import { shouldAutoOpen } from '../_shared/paper-open.ts'

const FN = 'auto-open'

function getEnv(name: string): string {
  const v = Deno.env.get(name)
  if (!v) throw new Error(`missing required env var: ${name}`)
  return v
}

const numeric = z
  .union([z.string(), z.number()])
  .transform((v) => Number(v))
  .refine((n) => Number.isFinite(n), { message: 'expected a finite number' })

const OppRow = z.object({
  id: z.number(),
  kind: z.enum(['single_venue_funding_harvest', 'cross_venue_basis_arb']),
  net_apr: numeric,
  leg_a_instrument_id: z.number(),
  leg_a_side: z.enum(['long', 'short']),
  leg_b_instrument_id: z.number().nullable(),
  leg_b_side: z.enum(['long', 'short']).nullable(),
  dedup_key: z.string(),
})

Deno.serve(async () => {
  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })

    const { data: oppData, error: oppErr } = await supabase
      .from('opportunities')
      .select('id, kind, net_apr, leg_a_instrument_id, leg_a_side, leg_b_instrument_id, leg_b_side, dedup_key')
      .eq('status', 'open')
    if (oppErr) throw new Error(`db read opportunities failed: ${oppErr.message}`)
    const opps = (oppData ?? []).map((r) => OppRow.parse(r))

    const { data: posData, error: posErr } = await supabase
      .from('paper_positions')
      .select('dedup_key')
      .in('status', ['open', 'at_risk'])
    if (posErr) throw new Error(`db read open positions failed: ${posErr.message}`)
    const openKeys = new Set((posData ?? []).map((r) => (r as { dedup_key: string | null }).dedup_key))

    let opened = 0
    let skipped = 0
    for (const opp of opps) {
      // Gate: clears the paper-open bar AND below the sanity ceiling (circuit breaker
      // against bad/misnormalized data — see _shared/paper-open.ts), and not already open.
      if (!shouldAutoOpen(opp.kind, opp.net_apr) || openKeys.has(opp.dedup_key)) {
        skipped++
        continue
      }
      try {
        await openPaperPosition(supabase, opp as OpportunityRow, PAPER_POSITION_USD)
        openKeys.add(opp.dedup_key)
        opened++
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        console.error(JSON.stringify({ fn: FN, oppId: opp.id, error: m }))
      }
    }

    return Response.json({ candidates: opps.length, opened, skipped })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ fn: FN, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
