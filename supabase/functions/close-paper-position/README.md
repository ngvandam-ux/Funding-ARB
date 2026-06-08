# close-paper-position

Supabase Edge Function (Deno). SPEC §6.3. Closes one open paper position: reads it +
latest marks, settles funding + round-trip fees + slippage into `realized_pnl_usd`
(tested `pnl.ts` via `_shared/paper.ts`), writes per-leg close fills, sets
`status='closed'` + `closed_at`. Rejects an already-closed/liquidated position.

## Invoke

```bash
supabase functions serve close-paper-position --env-file .env.local
curl -i -X POST http://localhost:54321/functions/v1/close-paper-position \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"positionId": 1}'
# expect: {"positionId": 1, "status": "closed"}
```

## Deploy

```bash
supabase functions deploy close-paper-position
```

No cron — invoked by the Session 4 dashboard "Close" CTA. (Liquidation auto-close is
handled inside `snapshot-pnl`.)

## Failure behavior

No silent retries (hard rule #7). Missing position, already-closed, missing fresh
mark, or DB write error → `{fn, error}` log + HTTP 500.
