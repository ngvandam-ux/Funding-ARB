// Gate.tsx — lightweight password gate for the dashboard (paper-only v1).
// Compares a SHA-256 hash so the plaintext password is NOT in the bundle.
// Client-side only — keeps casual visitors out; it is NOT real auth (the anon
// key + edge fns are still reachable directly). Unlock persists in localStorage.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'

const PW_HASH = '8bf8aaf91dd310d48c7047b5d551fd08aeaec2ac774f5916e8e693ddde1d36ff'
const KEY = 'fa_gate_v1'

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function Gate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(false)
  const [pw, setPw] = useState('')
  const [err, setErr] = useState(false)

  useEffect(() => {
    if (localStorage.getItem(KEY) === PW_HASH) setUnlocked(true)
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if ((await sha256Hex(pw)) === PW_HASH) {
      localStorage.setItem(KEY, PW_HASH)
      setUnlocked(true)
    } else {
      setErr(true)
      setPw('')
    }
  }

  if (unlocked) return <>{children}</>

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg text-fg">
      <form onSubmit={submit} className="w-72 rounded-lg border border-white/10 bg-white/[0.02] p-6">
        <h1 className="mb-1 text-lg font-semibold">
          Funding-Arb <span className="text-magenta">·</span> <span className="text-cyan">paper</span>
        </h1>
        <p className="mb-4 text-xs text-fg/50">Enter password to continue.</p>
        <input
          type="password"
          autoFocus
          value={pw}
          onChange={(e) => {
            setPw(e.target.value)
            setErr(false)
          }}
          placeholder="Password"
          className="w-full rounded border border-white/10 bg-bg px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        {err && <p className="mt-2 text-xs text-rose-300">Wrong password.</p>}
        <button type="submit" className="mt-4 w-full rounded bg-magenta/20 py-2 text-sm text-magenta hover:bg-magenta/30">
          Unlock
        </button>
      </form>
    </div>
  )
}
