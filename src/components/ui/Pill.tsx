// src/components/ui/Pill.tsx — small status/label chip.
import type { ReactNode } from 'react'

export function Pill({ children, tone = 'neutral' }: {
  children: ReactNode
  tone?: 'neutral' | 'good' | 'bad' | 'warn'
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-white/10 text-fg/80',
    good: 'bg-emerald-500/15 text-emerald-300',
    bad: 'bg-rose-500/15 text-rose-300',
    warn: 'bg-amber-500/15 text-amber-300',
  }
  return <span className={`inline-block rounded px-1.5 py-0.5 text-xs ${tones[tone]}`}>{children}</span>
}
