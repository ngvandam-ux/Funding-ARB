-- Session 4 ops — RUN BY NICK in the Supabase SQL editor (Frankfurt project
-- lfgmqpeaicqygzfgystu). Idempotent. Makes the execution log fully live by adding
-- paper_fills to the realtime publication (Session 1 added the other four tables).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'paper_fills'
  ) then
    alter publication supabase_realtime add table public.paper_fills;
  end if;
end $$;

-- Verify:
--   select tablename from pg_publication_tables where pubname='supabase_realtime' order by 1;
