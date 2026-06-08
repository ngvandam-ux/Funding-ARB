import { describe, it, expect } from 'vitest'
import { fmtUsd, fmtSignedUsd, fmtApr, fmtBps, fmtRelTime } from './format'

describe('fmtUsd', () => {
  it('formats with $ and 2 decimals', () => {
    expect(fmtUsd(1234.5)).toBe('$1,234.50')
    expect(fmtUsd(0)).toBe('$0.00')
  })
  it('renders null/NaN as an em dash', () => {
    expect(fmtUsd(null)).toBe('—')
    expect(fmtUsd(Number.NaN)).toBe('—')
  })
})

describe('fmtSignedUsd', () => {
  it('prefixes + for positive, − for negative', () => {
    expect(fmtSignedUsd(12.3)).toBe('+$12.30')
    expect(fmtSignedUsd(-12.3)).toBe('−$12.30')
    expect(fmtSignedUsd(0)).toBe('+$0.00')
  })
})

describe('fmtApr', () => {
  it('formats an APR percent with sign and 2 decimals', () => {
    expect(fmtApr(9.4789)).toBe('+9.48%')
    expect(fmtApr(-3.2)).toBe('−3.20%')
    expect(fmtApr(null)).toBe('—')
  })
})

describe('fmtBps', () => {
  it('rounds to whole bps with a suffix', () => {
    expect(fmtBps(3283.4)).toBe('3283 bps')
    expect(fmtBps(null)).toBe('—')
  })
})

describe('fmtRelTime', () => {
  it('renders a relative string against a reference now', () => {
    const now = new Date('2026-06-08T12:00:30Z')
    expect(fmtRelTime('2026-06-08T12:00:00Z', now)).toMatch(/30 seconds? ago/)
  })
})
