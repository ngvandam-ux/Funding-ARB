# ingest-bybit

Supabase Edge Function (Deno). GETs the **public** Bybit v5 linear tickers (all
symbols in one call), normalizes one row per tracked Bybit instrument, and inserts
into `funding_snapshots`. SPEC §8 Session 2, step 1.

- Endpoint hit: `GET https://api.bybit.com/v5/market/tickers?category=linear` (public, no auth).
- Shared normalize logic: `../_shared/normalize.ts` → `normalizeBybit` (× 3 × 365 × 100; 8h funding). `openInterestValue` is already USD.
- Writes via the **service-role** client (RLS blocks anon writes).

## ⚠️ Geo-restriction (verify at deploy)

`api.bybit.com` is fronted by CloudFront with country blocking — restricted IPs get
`{error:The Amazon CloudFront distribution is configured to block access from your
country}`. The Supabase egress region must be allowed or this function 500s every
tick. Verified blocked from the dev machine 2026-05-31. Confirm after first deploy.

## Local smoke test

```bash
supabase functions serve ingest-bybit --env-file .env.local
curl -i -X POST http://localhost:54321/functions/v1/ingest-bybit \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# expect: {"inserted": 3}
```

## Deploy + schedule

```bash
supabase functions deploy ingest-bybit
```

Its OWN 60s cron:

```sql
select cron.schedule(
  'ingest-bybit-60s', '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/ingest-bybit',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);
```

Unschedule: `select cron.unschedule('ingest-bybit-60s');`

## Failure behavior

No silent retries (hard rule #7). HTTP error, `retCode != 0`, or shape mismatch →
log `{venue, endpoint, status|retCode|error}` + HTTP 500. Cron retries next tick.
