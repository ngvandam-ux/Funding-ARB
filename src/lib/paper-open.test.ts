import { describe, it, expect } from 'vitest'
import { shouldAutoOpen, paperOpenBar, SINGLE_OPEN_APR, CROSS_OPEN_APR, MAX_SANE_APR } from './paper-open'

describe('bars', () => {
  it('single-venue ≥15, cross-venue ≥20, sanity ceiling 200', () => {
    expect(SINGLE_OPEN_APR).toBe(15)
    expect(CROSS_OPEN_APR).toBe(20)
    expect(MAX_SANE_APR).toBe(200)
    expect(paperOpenBar('single_venue_funding_harvest')).toBe(15)
    expect(paperOpenBar('cross_venue_basis_arb')).toBe(20)
  })
  it('momentum_harvest shares the single-venue bar (same single-leg economics)', () => {
    expect(paperOpenBar('momentum_harvest')).toBe(SINGLE_OPEN_APR)
  })
})

describe('shouldAutoOpen', () => {
  it('opens when at/above the bar and below the sanity ceiling', () => {
    expect(shouldAutoOpen('single_venue_funding_harvest', 15)).toBe(true)
    expect(shouldAutoOpen('single_venue_funding_harvest', 41.5)).toBe(true)
    expect(shouldAutoOpen('cross_venue_basis_arb', 20)).toBe(true)
    expect(shouldAutoOpen('cross_venue_basis_arb', 22)).toBe(true)
  })
  it('skips below the bar', () => {
    expect(shouldAutoOpen('single_venue_funding_harvest', 10)).toBe(false)
    expect(shouldAutoOpen('cross_venue_basis_arb', 18)).toBe(false)
  })
  it('momentum_harvest: opens at/above 15, skips below, ceiling applies', () => {
    expect(shouldAutoOpen('momentum_harvest', 15)).toBe(true)
    expect(shouldAutoOpen('momentum_harvest', 14.99)).toBe(false)
    expect(shouldAutoOpen('momentum_harvest', 1076.7)).toBe(false)
  })
  it('CIRCUIT BREAKER: skips absurd APR above the sanity ceiling (bad data)', () => {
    expect(shouldAutoOpen('single_venue_funding_harvest', 1076.7)).toBe(false) // the incident value
    expect(shouldAutoOpen('cross_venue_basis_arb', 250)).toBe(false)
    expect(shouldAutoOpen('cross_venue_basis_arb', 200)).toBe(true) // boundary: 200 is allowed
    expect(shouldAutoOpen('cross_venue_basis_arb', 200.01)).toBe(false)
  })
  it('skips non-finite', () => {
    expect(shouldAutoOpen('single_venue_funding_harvest', Number.NaN)).toBe(false)
  })
})
