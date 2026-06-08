// src/components/ui/Panel.tsx — titled card wrapper used by every dashboard panel.
import type { ReactNode } from 'react'

export function Panel({ title, right, children, className = '' }: {
  title: string
  right?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-lg border border-white/10 bg-white/[0.02] p-4 ${className}`}>
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-fg/70">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  )
}
