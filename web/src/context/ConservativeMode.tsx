import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

type Ctx = { conservative: boolean; setConservative: (v: boolean) => void; toggle: () => void }

const ConservativeCtx = createContext<Ctx | null>(null)

export function ConservativeProvider({ children }: { children: ReactNode }) {
  const [conservative, setConservative] = useState(false)
  const value = useMemo(
    () => ({
      conservative,
      setConservative,
      toggle: () => setConservative((c) => !c),
    }),
    [conservative],
  )
  return <ConservativeCtx.Provider value={value}>{children}</ConservativeCtx.Provider>
}

export function useConservative() {
  const ctx = useContext(ConservativeCtx)
  if (!ctx) throw new Error('useConservative outside provider')
  return ctx
}
