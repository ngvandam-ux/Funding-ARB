import { describe, it, expect } from 'vitest'
import { formatOppAlert, formatLiquidationAlert, ALERT_OPP_APR } from './alerts'

describe('ALERT_OPP_APR', () => {
  it('is the high-value opportunity threshold (above the auto-open bars)', () => {
    expect(ALERT_OPP_APR).toBe(30)
  })
})

describe('formatOppAlert', () => {
  it('formats a cross-venue opportunity with sign + 2dp', () => {
    expect(
      formatOppAlert({ baseSymbol: 'ETH', kind: 'cross_venue_basis_arb', netApr: 22.0028 }),
    ).toBe('🟢 New opp: ETH cross-venue +22.00% net APR')
  })
  it('labels single-venue and handles negative (shouldn\'t happen but be safe)', () => {
    expect(
      formatOppAlert({ baseSymbol: 'SOL', kind: 'single_venue_funding_harvest', netApr: 41.5 }),
    ).toBe('🟢 New opp: SOL single-venue +41.50% net APR')
  })
})

describe('formatLiquidationAlert', () => {
  it('formats a liquidated position with realized P&L', () => {
    expect(formatLiquidationAlert({ id: 7, realizedPnlUsd: -8.3 })).toBe(
      '🔴 Position #7 liquidated · realized −$8.30',
    )
  })
  it('handles a positive realized and a null', () => {
    expect(formatLiquidationAlert({ id: 3, realizedPnlUsd: 12 })).toBe(
      '🔴 Position #3 liquidated · realized +$12.00',
    )
    expect(formatLiquidationAlert({ id: 4, realizedPnlUsd: null })).toBe(
      '🔴 Position #4 liquidated · realized —',
    )
  })
})
