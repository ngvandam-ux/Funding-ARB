# ingest-hyperliquid

Supabase Edge Function (Deno). POSTs the **public** Hyperliquid `metaAndAssetCtxs`
info endpoint, normalizes one row per tracked Hyperliquid instrument, and inserts
into `funding_snapshots`. SPEC §8 Session 1, step 5.

- Endpoint hit: `POST https://api.hyperliquid.xyz/info` body `{"type":"metaAndAssetCtxs"}` (public, no auth).
- Shared normalize logic: `../_shared/normalize.ts` (Deno mirror of the Vitest-tested `src/lib/normalize.ts`).
- Writes via the **service-role** client (RLS blocks anon writes).

## Required Edge Function secrets

Set in the Supabase project (never in code):

```bash
supabase secrets set SUPABASE_URL=https://<project-ref>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
```

Note: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically in
the deployed Edge runtime, so the explicit `secrets set` is only needed for local
`supabase functions serve`. `HYPERLIQUID_PRIVATE_KEY` is NOT read (v1 is paper-only).

## Local smoke test

```bash
supabase functions serve ingest-hyperliquid --env-file .env.local
# in another shell:
curl -i -X POST http://localhost:54321/functions/v1/ingest-hyperliquid \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# expect: {"inserted": 4}
# then verify rows landed:
#   select instrument_id, funding_rate_1h_apr, mark_price, ts
#   from funding_snapshots order by ts desc limit 4;
```

## Deploy

```bash
supabase functions deploy ingest-hyperliquid
```

## Schedule every 60s (pg_cron + pg_net)

SPEC §8 step 6: rows must land every 60s. Schedule the deployed function with
`pg_cron` calling it over HTTP via `pg_net`. Run in the Supabase SQL editor
(replace `<project-ref>` and use a Vault-stored service-role key, not a literal):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Store the service-role key in Vault once (do NOT paste it into the cron body):
--   select vault.create_secret('<service-role-key>', 'service_role_key');

select cron.schedule(
  'ingest-hyperliquid-60s',
  '* * * * *',  -- every minute (pg_cron min granularity is 1 minute)
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/ingest-hyperliquid',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                    where name = 'service_role_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
```

pg_cron's finest granularity is 1 minute, which satisfies the 60s cadence
(api-notes §1: HL is safe to poll every 60s; it publishes a fresh funding rate
hourly). To unschedule: `select cron.unschedule('ingest-hyperliquid-60s');`.

## Failure behavior

No silent retries (CLAUDE.md hard rule #7). On a venue HTTP error or a payload
shape mismatch (zod parse failure), the function logs structured JSON
`{venue, endpoint, status|error}` and returns HTTP 500. The cron retries on the
next tick.
