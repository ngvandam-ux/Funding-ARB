-- Seed instruments (13 rows) from seed_instruments.json. Idempotent.
insert into public.instruments (venue_id, venue_symbol, base_symbol, quote_symbol, tier) values
  ('hyperliquid', 'BTC', 'BTC', 'USD', 'major'),
  ('hyperliquid', 'ETH', 'ETH', 'USD', 'major'),
  ('hyperliquid', 'SOL', 'SOL', 'USD', 'major'),
  ('hyperliquid', 'HYPE', 'HYPE', 'USD', 'mid'),
  ('binance_futures', 'BTCUSDT', 'BTC', 'USDT', 'major'),
  ('binance_futures', 'ETHUSDT', 'ETH', 'USDT', 'major'),
  ('binance_futures', 'SOLUSDT', 'SOL', 'USDT', 'major'),
  ('bybit', 'BTCUSDT', 'BTC', 'USDT', 'major'),
  ('bybit', 'ETHUSDT', 'ETH', 'USDT', 'major'),
  ('bybit', 'SOLUSDT', 'SOL', 'USDT', 'major'),
  ('okx', 'BTC-USDT-SWAP', 'BTC', 'USDT', 'major'),
  ('okx', 'ETH-USDT-SWAP', 'ETH', 'USDT', 'major'),
  ('okx', 'SOL-USDT-SWAP', 'SOL', 'USDT', 'major')
on conflict (venue_id, venue_symbol) do update set
  base_symbol = excluded.base_symbol,
  quote_symbol = excluded.quote_symbol,
  tier = excluded.tier;
