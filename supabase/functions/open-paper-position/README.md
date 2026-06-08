# open-paper-position

Supabase Edge Function (Deno). SPEC §6.1. Opens one delta-neutral paper position
from an opportunity: reads latest marks, computes fills via the tested `pnl.ts`
(entry=mark, taker fee + slippage, liquidation prices), inserts `paper_positions`
+ per-leg `paper_fills` (action `open`) via the service-role client, and flips the
opportunity to `status='paper_traded'`. Shared open logic lives in `_shared/paper.ts`.

## Invoke

```bash
supabase functions serve open-paper-position --env-file .env.local
curl -i -X POST http://localhost:54321/functions/v1/open-paper-position \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"opportunityId": 123}'   # sizeUsd optional, defaults to $1000/leg
# expect: {"positionId": N, "sizeUsd": 1000}
```

## Deploy

```bash
supabase functions deploy open-paper-position
```

No cron — invoked by `auto-open` (via the shared helper) and the Session 4 dashboard CTA.

## Failure behavior

No silent retries (hard rule #7). Missing opportunity, missing fresh mark for a leg,
or a DB write error → structured `{fn, error}` log + HTTP 500.
