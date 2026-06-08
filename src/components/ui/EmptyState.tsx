// src/components/ui/EmptyState.tsx — placeholder for panels whose data isn't flowing yet.
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-32 items-center justify-center text-center text-sm text-fg/40">
      {message}
    </div>
  )
}
