import { ShieldCheck } from 'lucide-react'
import { useConservative } from '../context/ConservativeMode'
import { cx } from './ui'

/**
 * Conservative mode hides weak/unresolved transmission edges everywhere, so the
 * story visibly shrinks to what the evidence can defend.
 */
export function ConservativeToggle() {
  const { conservative, toggle } = useConservative()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={conservative}
      onClick={toggle}
      title="Hide weak and unresolved links (keep only explicit + strong evidence)"
      className={cx(
        'flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[12px] transition',
        conservative
          ? 'border-good/50 bg-good/10 text-fg'
          : 'border-line bg-panel text-fg-2 hover:border-line-2',
      )}
    >
      <ShieldCheck size={14} className={conservative ? 'text-[#4cc94c]' : 'text-muted'} />
      <span>Conservative</span>
      <span
        className={cx(
          'relative h-4 w-7 rounded-full transition',
          conservative ? 'bg-good/70' : 'bg-line-2',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-3 w-3 rounded-full bg-fg transition-all',
            conservative ? 'left-3.5' : 'left-0.5',
          )}
        />
      </span>
    </button>
  )
}
