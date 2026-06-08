# auto-open

Supabase Edge Function (Deno), 5-min cron. SPEC §8 (30-day run). Opens one paper
position per `open` opportunity clearing the PAPER-OPEN bar — single-venue ≥15% net,
cross-venue ≥20% net — deduped so only one `open`/`at_risk` position exists per
opportunity `dedup_key`. Fixed size `PAPER_POSITION_USD` ($1000/leg). Reuses
`_shared/paper.ts` `openPaperPosition`. One opportunity failing is logged and skipped.

## Deploy + schedule (its own 5-min cron)

```bash
supabase functions deploy auto-open
```

```sql
select cron.schedule(
  'auto-open-5min', '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/auto-open',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);
```

Unschedule: `select cron.unschedule('auto-open-5min');`

## Failure behavior

No silent retries (hard rule #7). Top-level DB read error → `{fn, error}` log + 500.
Per-opportunity open errors are logged `{fn, oppId, error}` and skipped.
