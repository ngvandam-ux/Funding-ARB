# ingest-okx

Supabase Edge Function (Deno). The trickiest venue. Normalizes one row per tracked
OKX swap into `funding_snapshots`. SPEC §8 Session 2, step 1.

- Shared normalize logic: `../_shared/normalize.ts` → `normalizeOkx`, which detects
  4h-vs-8h funding cadence from the `fundingTime → nextFundingTime` delta and
  annualizes × 6 not × 3 for 4h pairs (api-notes §4 gotcha — the #1 cross-venue bug).
- Writes via the **service-role** client (RLS blocks anon writes).

## ⚠️ api-notes §4 corrections (VERIFIED live 2026-05-31)

The handoff `api-notes.md` §4 is wrong on two counts; this function uses the
corrected endpoints (all public, no auth):

1. **Mark/index are NOT in `market/tickers`.** That endpoint only has `last/askPx/
   bidPx/...`. Mark comes from `GET /api/v5/public/mark-price?instType=SWAP`
   (`markPx`); index from `GET /api/v5/market/index-tickers?quoteCcy=USDT` (`idxPx`,
   keyed by the **underlying** — `BTC-USDT-SWAP` → `BTC-USDT`).
2. **Batch funding-rate is rejected.** `funding-rate?instType=SWAP` → `code 50014`.
   funding-rate must be queried per `instId` (one call per tracked swap).

Open interest (already USD) comes from `GET /api/v5/public/open-interest?instType=SWAP`
(`oiUsd`). Per 60s tick: 3 funding calls + 3 batch reads = 6 GETs (OKX limit is
20 req / 2s, so well within budget). **api-notes.md §4 should be updated to match.**

## Local smoke test

```bash
supabase functions serve ingest-okx --env-file .env.local
curl -i -X POST http://localhost:54321/functions/v1/ingest-okx \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# expect: {"inserted": 3}   (BTC-USDT-SWAP, ETH-USDT-SWAP, SOL-USDT-SWAP)
```

## Deploy + schedule

```bash
supabase functions deploy ingest-okx
```

Its OWN 60s cron:

```sql
select cron.schedule(
  'ingest-okx-60s', '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/ingest-okx',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);
```

Unschedule: `select cron.unschedule('ingest-okx-60s');`

## Failure behavior

No silent retries (hard rule #7). Any HTTP error, missing mark/index/funding for a
tracked symbol, or shape mismatch → log `{venue, endpoint, status|error}` + HTTP 500.
Cron retries next tick.
