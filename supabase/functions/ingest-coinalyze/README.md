# ingest-coinalyze

Supabase Edge Function (Deno), 60s cron. Pulls Binance + Bybit funding / open interest /
price from the **Coinalyze** data API (those venues block cloud IPs directly — Decision 0004)
and writes `funding_snapshots` rows tagged `venue_id` `binance_futures` / `bybit`. Downstream
(detector, dashboard, paper engine) handle those venue_ids unchanged — they light up automatically.

Normalization (8h → APR) matches `normalize.ts` via the tested `_shared/coinalyze.ts`, so
cross-venue APR comparison stays apples-to-apples (CLAUDE.md hard rule #4). Symbol map:
Binance `<SYM>_PERP.A`, Bybit `<SYM>.6` (codes A=Binance, 6=Bybit, confirmed via `/exchanges`).

## Setup (Nick)

1. **Secret** (free key from coinalyze.net → API; never in the repo):
   ```bash
   supabase secrets set COINALYZE_API_KEY="…"
   ```
2. **Deploy:** `supabase functions deploy ingest-coinalyze`
3. **Schedule the 60s cron** (Frankfurt SQL editor). ⚠️ This is the moment the dataset goes
   from HL×OKX to 4-venue — note the timestamp for analysis segmentation.
   ```sql
   select cron.schedule(
     'ingest-coinalyze-60s', '* * * * *',
     $$
     select net.http_post(
       url     := 'https://lfgmqpeaicqygzfgystu.supabase.co/functions/v1/ingest-coinalyze',
       headers := jsonb_build_object('Content-Type','application/json',
         'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='service_role_key')),
       body := '{}'::jsonb);
     $$);
   ```
   Unschedule: `select cron.unschedule('ingest-coinalyze-60s');`

## Verify

```sql
select i.venue_id, i.base_symbol, lf.funding_rate_1h_apr, lf.mark_price, lf.open_interest_usd, lf.ts
from latest_funding lf join instruments i on i.id = lf.instrument_id
where i.venue_id in ('binance_futures','bybit') order by lf.ts desc;
```

## Failure behavior

No silent retries (hard rule #7). Missing env, Coinalyze non-2xx, or a DB write error →
structured `{venue,error}` log + HTTP 500; the 60s cron retries next tick. Instruments with no
funding value this tick are skipped (counted in `skipped`), not failed.
