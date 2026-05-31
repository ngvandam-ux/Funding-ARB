# detect-opportunities

Supabase Edge Function (Deno). Thin I/O wrapper around the pure, Vitest-tested
detector (`../_shared/detect.ts` ← `src/lib/detect.ts`). SPEC §8 Session 2, step 3.

Every 60s it:
1. reads the `latest_funding` view (latest snapshot per active instrument),
2. runs `detectOpportunities` — single-venue harvest net ≥ 10%, cross-venue basis
   arb net ≥ 15%, dropping any leg whose snapshot is > 5 min stale (cross needs
   both legs fresh),
3. reconciles the `opportunities` table to the live set, keyed by `dedup_key`:
   - INSERT newly-detected opps as `status='open'`,
   - UPDATE the APRs of an already-open opp in place (keeps original `detected_at`),
   - mark any previously-open opp no longer detected `status='expired'`.

No venue I/O — this function only touches our own DB via the **service-role** client.

## ⚠️ Required migration (run ONCE before scheduling)

The reconcile keys on a `dedup_key` column with a partial unique index. Run in the
Supabase SQL editor:

```sql
alter table public.opportunities add column if not exists dedup_key text;
create unique index if not exists opportunities_dedup_open
  on public.opportunities(dedup_key) where status = 'open';
```

`dedup_key` shapes: `single:HYPE:hyperliquid`,
`cross:BTC:binance_futures:hyperliquid` (venues alphabetically sorted for stability).
The function reconciles by reading open rows first (not `ON CONFLICT`), so the index
is a safety net against duplicate open rows under cron overlap.

## Local smoke test

```bash
supabase functions serve detect-opportunities --env-file .env.local
curl -i -X POST http://localhost:54321/functions/v1/detect-opportunities \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
# expect: {"snapshots":N,"detected":M,"inserted":...,"expired":...}
# then: select kind, base_symbol, net_apr, status, dedup_key
#       from opportunities order by detected_at desc;
```

## Deploy + schedule

```bash
supabase functions deploy detect-opportunities
```

Its OWN 60s cron (independent of the ingest crons):

```sql
select cron.schedule(
  'detect-opportunities-60s', '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/detect-opportunities',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);
```

Unschedule: `select cron.unschedule('detect-opportunities-60s');`

## Thresholds

This is the **DETECT** layer (emit ≥10% / ≥15%) — what the dashboard shows. The
higher **paper-OPEN** layer (≥15% / ≥20%) is Session 3's engine concern, not here
(two-layer model, vault Decisions 0001/0002).

## Failure behavior

No silent retries (hard rule #7). Any DB read/write error or a view-row shape
mismatch (zod) → log `{venue:"detector", error}` + HTTP 500. Cron retries next tick.
