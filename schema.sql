-- Funding-Rate Arb Scanner — Supabase schema
-- Paste this into the Supabase SQL editor and run.
-- Idempotent: safe to re-run.

-- =====================================================================
-- venues: static reference of supported exchanges
-- =====================================================================
create table if not exists public.venues (
  id              text primary key,                    -- 'hyperliquid', 'binance_futures', etc.
  display_name    text not null,
  funding_cadence_minutes integer not null,            -- 60 for HL, 480 for Binance/Bybit/OKX
  taker_fee_bps   numeric(8,4) not null,               -- 4.5 for HL = 0.0450%
  maker_fee_bps   numeric(8,4) not null,
  withdrawal_fee_usd numeric(10,2) not null default 0,
  kyc_required    boolean not null default false,
  notes           text,
  created_at      timestamptz not null default now()
);

insert into public.venues (id, display_name, funding_cadence_minutes, taker_fee_bps, maker_fee_bps, withdrawal_fee_usd, kyc_required, notes) values
  ('hyperliquid',     'Hyperliquid',     60,  4.5, 1.5, 1.00, false, 'On-chain, no KYC, hourly funding'),
  ('binance_futures', 'Binance Futures', 480, 4.0, 2.0, 0.00, true,  '8h funding, network gas for withdrawals'),
  ('bybit',           'Bybit',           480, 5.5, 2.0, 0.00, true,  '8h funding'),
  ('okx',             'OKX',             480, 5.0, 2.0, 0.00, true,  '8h funding')
on conflict (id) do update set
  display_name = excluded.display_name,
  funding_cadence_minutes = excluded.funding_cadence_minutes,
  taker_fee_bps = excluded.taker_fee_bps,
  maker_fee_bps = excluded.maker_fee_bps,
  withdrawal_fee_usd = excluded.withdrawal_fee_usd,
  kyc_required = excluded.kyc_required,
  notes = excluded.notes;

-- =====================================================================
-- instruments: per-venue perpetual contracts, linked by base_symbol
-- =====================================================================
create table if not exists public.instruments (
  id              bigserial primary key,
  venue_id        text not null references public.venues(id),
  venue_symbol    text not null,                       -- 'BTC' on HL, 'BTCUSDT' on Binance
  base_symbol     text not null,                       -- normalized: 'BTC', 'ETH', 'SOL'
  quote_symbol    text not null default 'USD',         -- 'USD' for HL, 'USDT' for most CEX
  tier            text not null default 'major',       -- 'major' | 'mid' | 'alt'  (affects slippage assumption)
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (venue_id, venue_symbol)
);

create index if not exists idx_instruments_base_symbol on public.instruments(base_symbol);
create index if not exists idx_instruments_active on public.instruments(is_active) where is_active;

-- =====================================================================
-- funding_snapshots: time-series of normalized funding rates
-- =====================================================================
create table if not exists public.funding_snapshots (
  id              bigserial primary key,
  instrument_id   bigint not null references public.instruments(id) on delete cascade,
  ts              timestamptz not null default now(),
  funding_rate_native      numeric(20,12) not null,    -- raw rate per venue's interval
  funding_rate_1h_apr      numeric(20,8) not null,     -- normalized: rate × intervals/year × 100
  next_funding_ts          timestamptz,
  mark_price               numeric(20,8),
  index_price              numeric(20,8),
  open_interest_usd        numeric(24,2),
  raw                      jsonb                       -- full payload for debugging
);

create index if not exists idx_funding_snapshots_instrument_ts
  on public.funding_snapshots(instrument_id, ts desc);

create index if not exists idx_funding_snapshots_ts on public.funding_snapshots(ts desc);

-- Convenience view: latest snapshot per instrument
create or replace view public.latest_funding as
select distinct on (instrument_id)
  fs.*,
  i.venue_id,
  i.venue_symbol,
  i.base_symbol,
  i.tier
from public.funding_snapshots fs
join public.instruments i on i.id = fs.instrument_id
where i.is_active
order by instrument_id, ts desc;

-- =====================================================================
-- opportunities: emitted by the detector
-- =====================================================================
create table if not exists public.opportunities (
  id              bigserial primary key,
  detected_at     timestamptz not null default now(),
  kind            text not null check (kind in ('single_venue_funding_harvest','cross_venue_basis_arb')),
  base_symbol     text not null,
  -- For single-venue: leg_a = the perp to short (assuming positive funding)
  -- For cross-venue: leg_a = receive-funding leg, leg_b = pay-funding leg
  leg_a_instrument_id  bigint not null references public.instruments(id),
  leg_a_side           text not null check (leg_a_side in ('long','short')),
  leg_a_funding_apr    numeric(10,4) not null,
  leg_b_instrument_id  bigint references public.instruments(id),
  leg_b_side           text check (leg_b_side in ('long','short')),
  leg_b_funding_apr    numeric(10,4),
  gross_apr            numeric(10,4) not null,
  est_fees_apr_drag    numeric(10,4) not null,
  est_slippage_apr_drag numeric(10,4) not null,
  net_apr              numeric(10,4) not null,
  min_position_usd     numeric(14,2) not null default 1000,
  status               text not null default 'open' check (status in ('open','expired','paper_traded')),
  expires_at           timestamptz,
  notes                text
);

create index if not exists idx_opportunities_status_net_apr
  on public.opportunities(status, net_apr desc) where status = 'open';
create index if not exists idx_opportunities_detected_at on public.opportunities(detected_at desc);

-- =====================================================================
-- paper_positions: simulated positions
-- =====================================================================
create table if not exists public.paper_positions (
  id              bigserial primary key,
  opportunity_id  bigint references public.opportunities(id),
  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,
  status          text not null default 'open' check (status in ('open','closed','at_risk','liquidated_paper')),
  position_size_usd numeric(14,2) not null,
  leg_a_instrument_id bigint not null references public.instruments(id),
  leg_a_side          text not null,
  leg_a_entry_price   numeric(20,8) not null,
  leg_b_instrument_id bigint references public.instruments(id),
  leg_b_side          text,
  leg_b_entry_price   numeric(20,8),
  cumulative_funding_usd numeric(14,4) not null default 0,
  cumulative_fees_usd    numeric(14,4) not null default 0,
  realized_pnl_usd       numeric(14,4),                -- set on close
  notes                  text
);

create index if not exists idx_paper_positions_status on public.paper_positions(status);

-- =====================================================================
-- paper_fills: each simulated execution against a paper_position
-- =====================================================================
create table if not exists public.paper_fills (
  id              bigserial primary key,
  position_id     bigint not null references public.paper_positions(id) on delete cascade,
  ts              timestamptz not null default now(),
  leg             text not null check (leg in ('a','b')),
  side            text not null check (side in ('long','short')),
  action          text not null check (action in ('open','close')),
  instrument_id   bigint not null references public.instruments(id),
  price           numeric(20,8) not null,
  size_usd        numeric(14,2) not null,
  fee_usd         numeric(10,4) not null,
  slippage_bps    numeric(8,4) not null
);

create index if not exists idx_paper_fills_position on public.paper_fills(position_id, ts);

-- =====================================================================
-- pnl_snapshots: mark-to-market over time
-- =====================================================================
create table if not exists public.pnl_snapshots (
  id              bigserial primary key,
  ts              timestamptz not null default now(),
  position_id     bigint references public.paper_positions(id) on delete cascade,  -- null = portfolio-level
  unrealized_pnl_usd numeric(14,4) not null,
  realized_pnl_usd   numeric(14,4) not null,
  cumulative_funding_usd numeric(14,4) not null,
  cumulative_fees_usd    numeric(14,4) not null,
  leg_a_mark      numeric(20,8),
  leg_b_mark      numeric(20,8),
  liquidation_distance_bps numeric(10,2)              -- min across legs; lower = closer to liquidation
);

create index if not exists idx_pnl_snapshots_position_ts on public.pnl_snapshots(position_id, ts desc);
create index if not exists idx_pnl_snapshots_ts on public.pnl_snapshots(ts desc);

-- =====================================================================
-- Realtime publication: enable websocket updates to the dashboard
-- =====================================================================
alter publication supabase_realtime add table public.funding_snapshots;
alter publication supabase_realtime add table public.opportunities;
alter publication supabase_realtime add table public.paper_positions;
alter publication supabase_realtime add table public.pnl_snapshots;

-- =====================================================================
-- Row Level Security
-- v1 is single-tenant (Nick only). Lock everything to authenticated.
-- =====================================================================
alter table public.venues             enable row level security;
alter table public.instruments        enable row level security;
alter table public.funding_snapshots  enable row level security;
alter table public.opportunities      enable row level security;
alter table public.paper_positions    enable row level security;
alter table public.paper_fills        enable row level security;
alter table public.pnl_snapshots      enable row level security;

-- Read-only for anon (dashboard read access without auth — v1 only)
create policy "anon_read_venues" on public.venues for select to anon using (true);
create policy "anon_read_instruments" on public.instruments for select to anon using (true);
create policy "anon_read_funding" on public.funding_snapshots for select to anon using (true);
create policy "anon_read_opps" on public.opportunities for select to anon using (true);
create policy "anon_read_positions" on public.paper_positions for select to anon using (true);
create policy "anon_read_fills" on public.paper_fills for select to anon using (true);
create policy "anon_read_pnl" on public.pnl_snapshots for select to anon using (true);

-- Writes only via service_role (Edge Functions). No anon writes.
