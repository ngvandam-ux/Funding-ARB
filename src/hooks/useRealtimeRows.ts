// src/hooks/useRealtimeRows.ts
// Shared data hook: initial select + Supabase Realtime patch for one table/view.
// Each domain hook supplies the table, a row→domain mapper, a stable key, and an
// optional sort. Subscribes in useEffect, removes the channel on cleanup
// (CLAUDE.md realtime pattern). Returns the uniform { data, isLoading, error }.
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

interface Options<TDomain> {
  table: string
  select: string
  channel: string
  map: (row: Record<string, unknown>) => TDomain
  key: (d: TDomain) => number
  // Optional client-side filter applied to every row (e.g. status === 'open').
  keep?: (d: TDomain) => boolean
  // Optional comparator for display order.
  sort?: (a: TDomain, b: TDomain) => number
  // Optional PostgREST filter string for the initial select, e.g. "status=eq.open".
  initialFilter?: string
  // Optional server-side order + row cap for the initial select. Without these,
  // PostgREST silently truncates unbounded selects at max_rows (1000) — and in
  // insertion order, i.e. the OLDEST rows for append-only tables.
  initialOrder?: { column: string; ascending: boolean }
  initialLimit?: number
  // Realtime is INSERT+UPDATE by default; views (latest_funding) can't be subscribed
  // directly — subscribe to the backing table instead via `realtimeTable`.
  realtimeTable?: string
}

export function useRealtimeRows<TDomain>(opts: Options<TDomain>): {
  data: TDomain[]
  isLoading: boolean
  error: string | null
} {
  const [data, setData] = useState<TDomain[]>([])
  const [isLoading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const apply = (rows: TDomain[]): TDomain[] => {
      const filtered = opts.keep ? rows.filter(opts.keep) : rows
      return opts.sort ? [...filtered].sort(opts.sort) : filtered
    }

    async function load() {
      let q = supabase.from(opts.table).select(opts.select)
      if (opts.initialFilter) {
        const [col, rest] = opts.initialFilter.split('=')
        const [op, val] = rest.split('.')
        // Only the operators we use here:
        q = op === 'eq' ? q.eq(col, val) : q.in(col, val.split(','))
      }
      const ordered = opts.initialOrder
        ? q.order(opts.initialOrder.column, { ascending: opts.initialOrder.ascending })
        : q
      const limited = opts.initialLimit ? ordered.limit(opts.initialLimit) : ordered
      const { data: rows, error: err } = await limited
      if (cancelled) return
      if (err) {
        setError(err.message)
        setLoading(false)
        return
      }
      setData(apply((rows ?? []).map((r) => opts.map(r as unknown as Record<string, unknown>))))
      setLoading(false)
    }
    load()

    const channel = supabase
      .channel(opts.channel)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: opts.realtimeTable ?? opts.table },
        () => {
          // Simplest correct strategy: re-pull on any change. Tables are small
          // (≤ a few hundred rows in v1) so a refetch per tick is cheap and avoids
          // payload-shape drift. Fail-loud is unnecessary here; load() sets error.
          load()
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.table, opts.channel, opts.initialFilter, opts.realtimeTable])

  return { data, isLoading, error }
}
