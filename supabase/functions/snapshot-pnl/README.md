# snapshot-pnl

Supabase Edge Function (Deno), 5-min cron. SPEC §6.2. For each `open`/`at_risk`
paper position: pulls latest marks, accrues funding pro-rata since the last snapshot
(continuous model), marks to market, assesses liquidation risk, inserts a
`pnl_snapshots` row, and updates the position's `cumulative_funding_usd` + `status`.
On `liquidated_paper` it force-closes via `_shared/paper.ts`. Math is the tested
`pnl.ts`. One bad position is logged and skipped.

## Deploy + schedule (its own 5-min cron)

```bash
supabase functions deploy snapshot-pnl
```

```sql
select cron.schedule(
  'snapshot-pnl-5min', '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/snapshot-pnl',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);
```

Unschedule: `select cron.unschedule('snapshot-pnl-5min');`

## Failure behavior

No silent retries (hard rule #7). Top-level DB read error → `{fn, error}` + 500.
Per-position errors are logged `{fn, positionId, error}` and skipped.
