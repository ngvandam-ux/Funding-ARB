// Pure display formatters for the dashboard. No I/O. date-fns for relative time
// (CLAUDE.md: never raw Date arithmetic). Uses a real minus sign (−) for negatives.
// formatDistanceStrict takes an explicit baseDate so fmtRelTime is deterministic/testable.
import { formatDistanceStrict } from 'date-fns'

const DASH = '—'
const MINUS = '−'

function isBad(n: number | null | undefined): n is null | undefined {
  return n === null || n === undefined || !Number.isFinite(n)
}

export function fmtUsd(n: number | null | undefined): string {
  if (isBad(n)) return DASH
  return `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtSignedUsd(n: number | null | undefined): string {
  if (isBad(n)) return DASH
  const sign = n < 0 ? MINUS : '+'
  return `${sign}${fmtUsd(n)}`
}

export function fmtApr(n: number | null | undefined): string {
  if (isBad(n)) return DASH
  const sign = n < 0 ? MINUS : '+'
  return `${sign}${Math.abs(n).toFixed(2)}%`
}

export function fmtBps(n: number | null | undefined): string {
  if (isBad(n)) return DASH
  return `${Math.round(n)} bps`
}

export function fmtRelTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return DASH
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return DASH
  return formatDistanceStrict(d, now, { addSuffix: true })
}
