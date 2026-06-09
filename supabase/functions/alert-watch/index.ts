// alert-watch — Supabase Edge Function (Deno), 5-min cron.
// Pings a Discord webhook on (a) newly-detected opportunities ≥ ALERT_OPP_APR and
// (b) positions liquidated in the last window. Stateless dedup: a time window
// (~6 min) over the existing detected_at / closed_at columns — no dedup table.
// Hard rules: no secrets in code, no `any` (zod), fail loud. No-ops if the webhook
// secret is unset, so it is safe to deploy before the webhook is wired.

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { z } from 'npm:zod@3'
import { formatOppAlert, formatLiquidationAlert, ALERT_OPP_APR } from '../_shared/alerts.ts'

const FN = 'alert-watch'
const WINDOW_MS = 6 * 60 * 1000 // > cron interval so we don't miss the gap between ticks

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
  base_symbol: z.string(),
  kind: z.enum(['single_venue_funding_harvest', 'cross_venue_basis_arb']),
  net_apr: numeric,
})

const LiqRow = z.object({
  id: z.number(),
  realized_pnl_usd: numeric.nullable(),
})

Deno.serve(async () => {
  try {
    const supabase = createClient(getEnv('SUPABASE_URL'), getEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    })
    const sinceIso = new Date(Date.now() - WINDOW_MS).toISOString()

    const { data: oppData, error: oppErr } = await supabase
      .from('opportunities')
      .select('base_symbol, kind, net_apr, detected_at')
      .eq('status', 'open')
      .gte('net_apr', ALERT_OPP_APR)
      .gte('detected_at', sinceIso)
    if (oppErr) throw new Error(`db read opportunities failed: ${oppErr.message}`)

    const { data: liqData, error: liqErr } = await supabase
      .from('paper_positions')
      .select('id, realized_pnl_usd, closed_at')
      .eq('status', 'liquidated_paper')
      .gte('closed_at', sinceIso)
    if (liqErr) throw new Error(`db read paper_positions failed: ${liqErr.message}`)

    const lines = [
      ...(oppData ?? []).map((r) => formatOppAlert(OppRow.parse(r))),
      ...(liqData ?? []).map((r) => formatLiquidationAlert(LiqRow.parse(r))),
    ]

    if (lines.length === 0) return Response.json({ alerts: 0 })

    const webhook = Deno.env.get('ALERT_WEBHOOK_URL')
    if (!webhook) {
      console.log(JSON.stringify({ fn: FN, note: 'ALERT_WEBHOOK_URL unset — skipping post', alerts: lines.length }))
      return Response.json({ alerts: lines.length, posted: false })
    }

    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: lines.join('\n') }),
    })
    if (!res.ok) {
      throw new Error(`discord webhook post failed: ${res.status} ${await res.text().catch(() => '')}`)
    }

    return Response.json({ alerts: lines.length, posted: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(JSON.stringify({ fn: FN, error: message }))
    return Response.json({ error: message }, { status: 500 })
  }
})
