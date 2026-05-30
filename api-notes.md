# Venue API Notes — current as of May 2026

Cross-reference these whenever a venue's response shape looks wrong. Endpoints and field names change.

---

## 1. Hyperliquid

**Why we start here:** cleanest API, no auth for market data, hourly funding (more data points), no KYC, US-accessible.

### Funding rate + mark + index

- **Endpoint:** `POST https://api.hyperliquid.xyz/info`
- **Headers:** `Content-Type: application/json`
- **Body:** `{ "type": "metaAndAssetCtxs" }`
- **Returns:** `[universe_meta, assetCtxs[]]` — `assetCtxs[i].funding` is the **hourly** rate (e.g. `"0.0000125"` = 0.00125% per hour ≈ 10.95% APR). `markPx`, `oraclePx`, `openInterest` also in the same payload.
- **Cadence:** safe to poll every 60s. Hyperliquid publishes a fresh funding rate every hour at the top of the hour.
- **Auth:** none for `info` endpoints. Trading endpoints require a wallet signature — DO NOT USE in v1.

### Normalization to APR

```ts
// Hyperliquid 'funding' field is hourly fractional rate
const apr = Number(ctx.funding) * 24 * 365 * 100  // percent
```

### Gotchas

- Asset universe is positional: `universe_meta[i].name` corresponds to `assetCtxs[i]`. Don't assume alphabetical.
- Some assets have leverage caps that change. Open interest in `openInterest` is in coin units — multiply by `markPx` for USD.
- Hyperliquid sometimes returns `"funding": "0"` exactly when there's a transition; treat as valid, not null.

### Docs

- https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- Fee schedule: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees

---

## 2. Binance USDⓈ-M Futures

### Funding rate (latest)

- **Endpoint:** `GET https://fapi.binance.com/fapi/v1/premiumIndex`
- **Auth:** none for market data
- **Returns:** array of `{ symbol, markPrice, indexPrice, lastFundingRate, nextFundingTime }` for every USDT-margined perp.
- **Cadence:** poll every 60s.

### Funding rate (historical)

- **Endpoint:** `GET https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=100`
- Use for backfill, not the live loop.

### Open interest

- **Endpoint:** `GET https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT`
- Have to query per-symbol. For v1, only fetch this for symbols we track.

### Normalization

```ts
// Binance 'lastFundingRate' is per-8h fractional
const apr = Number(item.lastFundingRate) * 3 * 365 * 100
```

### Gotchas

- Binance returns `lastFundingRate` as a string. Always `Number(...)`.
- `nextFundingTime` is ms epoch; convert with `new Date(ms)`.
- Funding caps at ±2% per period in normal markets, ±0.005% during pre-market trading on new listings. Cross-reference: https://www.binance.com/en/square/post/317792305455106
- Rate limits: 2400 weight per minute for `fapi`. `/fapi/v1/premiumIndex` (no symbol) is weight 40 — easily within limits.

### Docs

- https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data

---

## 3. Bybit

### Funding rate + tickers

- **Endpoint:** `GET https://api.bybit.com/v5/market/tickers?category=linear`
- **Auth:** none
- **Returns:** `result.list[]` with `symbol, markPrice, indexPrice, fundingRate, nextFundingTime, openInterest, openInterestValue` (the last one is in USD already — convenient).

### Normalization

```ts
// Bybit 'fundingRate' is per-8h fractional
const apr = Number(item.fundingRate) * 3 * 365 * 100
```

### Gotchas

- `category=linear` for USDT perps; `category=inverse` for coin-margined (we skip these in v1).
- Rate limit: 120 requests per 5 seconds per IP. One call gets us all symbols — we'll be at 1 req/min.
- `nextFundingTime` is a string of ms epoch. Cast to number.

### Docs

- https://bybit-exchange.github.io/docs/v5/market/tickers

---

## 4. OKX

### Funding rate

- **Endpoint:** `GET https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP`
- **Per-instrument**, so we hit it once per tracked symbol or use the batch endpoint:
- **Batch:** `GET https://www.okx.com/api/v5/public/funding-rate?instType=SWAP` — returns all swaps. Preferred.
- **Auth:** none

### Tickers (for mark + OI)

- **Endpoint:** `GET https://www.okx.com/api/v5/market/tickers?instType=SWAP`

### Normalization

```ts
// OKX 'fundingRate' is per-8h fractional (most pairs; some are 4h — check 'fundingTime' deltas)
const apr = Number(item.fundingRate) * 3 * 365 * 100
```

### Gotchas

- **Some OKX pairs fund every 4h, not 8h.** Detect from `fundingTime` vs `nextFundingTime` delta. If 4h, multiply by 6 not 3 when annualizing. This is the single most common bug in cross-venue arb code.
- Instrument naming: `BTC-USDT-SWAP` (the `-SWAP` suffix marks it as a perp).
- Rate limit: 20 req / 2s per IP for public endpoints. We poll once per minute.

### Docs

- https://www.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate

---

## 5. Cross-venue normalization rules (mandatory)

Implement in `lib/normalize.ts`:

```ts
type NormalizedFunding = {
  venueId: VenueId
  venueSymbol: string
  baseSymbol: string          // 'BTC', 'ETH', 'SOL'...
  fundingRateNative: number   // raw rate from venue (per their interval)
  fundingRate1hApr: number    // % annualized — ALWAYS USE THIS for comparisons
  nextFundingTs: Date | null
  markPrice: number
  indexPrice: number | null
  openInterestUsd: number | null
  ts: Date
}
```

Rule: **never compare `fundingRateNative` across venues.** The detector reads `fundingRate1hApr` only.

Base-symbol mapping (seed list):

| Venue          | venueSymbol  | baseSymbol |
|----------------|--------------|------------|
| hyperliquid    | BTC          | BTC        |
| hyperliquid    | ETH          | ETH        |
| hyperliquid    | SOL          | SOL        |
| binance_futures| BTCUSDT      | BTC        |
| binance_futures| ETHUSDT      | ETH        |
| binance_futures| SOLUSDT      | SOL        |
| bybit          | BTCUSDT      | BTC        |
| bybit          | ETHUSDT      | ETH        |
| bybit          | SOLUSDT      | SOL        |
| okx            | BTC-USDT-SWAP| BTC        |
| okx            | ETH-USDT-SWAP| ETH        |
| okx            | SOL-USDT-SWAP| SOL        |

Start with BTC/ETH/SOL across 4 venues = 12 instruments. After v1 lands, expand to top 30 by OI.

---

## 6. Fee schedule reference (v1 — baked into `venues` table)

| Venue          | Taker (bps) | Maker (bps) | Funding cadence | Notes |
|----------------|-------------|-------------|-----------------|-------|
| Hyperliquid    | 4.5         | 1.5         | 1h              | $1 USDC withdrawal, no KYC |
| Binance Futures| 4.0         | 2.0         | 8h              | KYC required US |
| Bybit          | 5.5         | 2.0         | 8h              | KYC required |
| OKX            | 5.0         | 2.0         | 8h (some 4h)    | KYC required |

These are the *base* taker fees with zero volume tier. They're conservative for paper trading — real users with volume get lower. That's a feature, not a bug, for v1.

---

## 7. Slippage assumptions (v1)

Bake into `lib/math.ts`:

```ts
const SLIPPAGE_BPS_BY_TIER = {
  major: 5,    // BTC, ETH, SOL
  mid:   15,   // top 30 by OI
  alt:   50,   // everything else
} as const
```

These are conservative on purpose. Paper P&L should under-estimate, not over-estimate.
