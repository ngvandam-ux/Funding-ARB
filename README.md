# Funding-ARB

Funding-rate arbitrage scanner — paper trading engine. Built with Claude Code.

---


## What's in here

| File | Purpose |
|---|---|
| `CLAUDE.md` | Project rules for Claude Code. Read first. |
| `SPEC.md` | Architecture, arb math, paper-trade engine, dashboard panels, build order |
| `schema.sql` | Supabase Postgres schema — paste into SQL editor, run once |
| `api-notes.md` | Current (May 2026) venue API endpoints, auth, gotchas |
| `acceptance.md` | Definition of done for v1 |
| `seed_instruments.json` | The 13 instruments to track at launch |

## How to use this

1. Create a new repo (or folder). Drop all six files in the root.
2. Create a Supabase project. Run `schema.sql` in the SQL editor.
3. Open the repo in Claude Code (or Cursor, or whatever).
4. First prompt to Claude Code:

> Read CLAUDE.md, SPEC.md, and api-notes.md. Then begin Session 1 as defined in SPEC.md §8. Stop after the Hyperliquid ingestion is landing rows in funding_snapshots every 60 seconds.

5. After each session, verify against the relevant items in `acceptance.md` before moving to the next.

## Project goal (the one sentence)

Build a scanner + paper-trade engine that generates 30 days of real, logged data telling us whether funding-rate arb is +EV for this stack — without risking a dollar.

## What this is NOT

- Not a real-money trading bot in v1
- Not a clone of the Instagram screenshot (visual inspiration only)
- Not high-frequency anything — funding settles on schedules measured in hours

## Sources behind the design decisions

- Funding-rate arb 8–20% APY baseline: [ArbitrageScanner guide](https://arbitragescanner.io/blog/crypto-funding-rate-arbitrage-guide)
- Phemex Q1 2026 funding-arb bot returns: [Phemex top 10 bots Q1 2026](https://phemex.com/blogs/top-10-profitable-bot-strategies-q1-2026)
- Hyperliquid fees + hourly funding cadence: [Hyperliquid docs](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees)
- Cross-venue arb realism check: [r/arbitragebetting prediction market arb 2026](https://www.reddit.com/r/arbitragebetting/comments/1sbp9bw/prediction_market_arbitrage_in_2026_what_actually/)
- Why latency arb on CEXs is dead for retail: [WunderTrading 2026 arb guide](https://wundertrading.com/journal/en/what-is-arbitrage-trading)
