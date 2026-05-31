// Deno mirror of the shared domain unions in src/types/domain.ts.
// Edge Functions can't read the Vite/node module graph, so the _shared copies
// import these from here. Keep in sync with src/types/domain.ts.

export type VenueId = 'hyperliquid' | 'binance_futures' | 'bybit' | 'okx'

export type Tier = 'major' | 'mid' | 'alt'

export type OpportunityKind =
  | 'single_venue_funding_harvest'
  | 'cross_venue_basis_arb'
