# ingest-binance

Supabase Edge Function (Deno). GETs the **public** Binance USDⓈ-M `premiumIndex`
(all symbols, weight 40), normalizes one row per tracked Binance instrument, and
inserts into `funding_snapshots`. SPEC §8 Session 2, step 1.

- Endpoints hit (public, no auth):
  - `GET https://fapi.binance.com/fapi/v1/premiumIndex` — funding/mark/index for all symbols.
  - `GET https://fapi.binance.com/fapi/v1/openInterest?symbol=<sym>` — per tracked symbol (OI in base units → × markPrice for USD).
- Shared normalize logic: `../_shared/normalize.ts` → `normalizeBinance` (× 3 × 365 × 100; Binance funds every 8h).
- Writes via the **service-role** client (RLS blocks anon writes).

## ⚠️ Geo-restriction (verify at deploy)

`fapi.binance.com` returns `{"code":0,"msg":"Service unavailable from a restricted
location ..."}` from US/other restricted IPs. The Supabase **egress region** must
not be restricted or this function will 500 on every tick. Verified blocked from
the dev machine 2026-05-31; Hyperliquid is not blocked. Confirm after first deploy
(check the function logs / a `funding_snapshots` row for `binance_futures`).

## Required Edge Function secrets

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically in the
deployed runtime; set them explicitly only for local `supabase functions serve`.

## Local smoke test

```bash
supabase functions serve ingest-binance --env-file .env.local
curl -i -X POST http://localhost:54321/functions/v1/ingest-binance \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# expect: {"inserted": 3}   (BTCUSDT, ETHUSDT, SOLUSDT)
```

## Deploy + schedule

```bash
supabase functions deploy ingest-binance
```

Its OWN 60s cron (pausing one venue must not break others — CLAUDE.md / SPEC §8):

```sql
select cron.schedule(
  'ingest-binance-60s', '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/ingest-binance',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);
```

Unschedule: `select cron.unschedule('ingest-binance-60s');`

## Failure behavior

No silent retries (hard rule #7). Funding endpoint error or shape mismatch → log
`{venue, endpoint, status|error}` + HTTP 500. **Open-interest** failures are logged
(`{venue, endpoint, oiError}`) but non-fatal (OI is nullable and unused by the
detector); the funding row still lands.
