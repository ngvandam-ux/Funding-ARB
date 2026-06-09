# alert-watch

Supabase Edge Function (Deno), 5-min cron. Pings a Discord webhook on:
- newly-detected opportunities with `net_apr ≥ 30%` (above the auto-open bars — only "unusually fat"),
- positions liquidated in the last ~6 min.

Stateless dedup: a ~6-min time window over the existing `detected_at` / `closed_at` columns (no
dedup table). Message strings come from the tested `_shared/alerts.ts`. No-ops if `ALERT_WEBHOOK_URL`
is unset, so it is safe to deploy before the webhook is wired.

## Setup (Nick)

1. **Create a Discord webhook:** a channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy URL.
2. **Set the secret** (never in the repo):
   ```bash
   supabase secrets set ALERT_WEBHOOK_URL="https://discord.com/api/webhooks/…"
   ```
   (or dashboard → Edge Functions → Secrets).
3. **Deploy:** `supabase functions deploy alert-watch`
4. **Schedule the cron** (Frankfurt SQL editor):
   ```sql
   select cron.schedule(
     'alert-watch-5min', '*/5 * * * *',
     $$
     select net.http_post(
       url     := 'https://lfgmqpeaicqygzfgystu.supabase.co/functions/v1/alert-watch',
       headers := jsonb_build_object('Content-Type','application/json',
         'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name='service_role_key')),
       body := '{}'::jsonb);
     $$);
   ```
   Unschedule: `select cron.unschedule('alert-watch-5min');`

## Failure behavior

No silent retries (hard rule #7). DB read error or a non-2xx webhook post → structured `{fn,error}`
log + HTTP 500 (visible in `cron.job_run_details`); the next tick retries.
