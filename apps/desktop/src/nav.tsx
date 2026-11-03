import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface Item {
  id: number;
  node: ReactNode;
}

interface Nav {
  push: (node: ReactNode) => void;
  pop: () => void;
  replace: (node: ReactNode) => void;
  reset: (node: ReactNode) => void;
  depth: number;
}

const Ctx = createContext<Nav | null>(null);

export function NavProvider({ root, children }: { root: ReactNode; children: (items: Item[]) => ReactNode }) {
  const nextId = useRef(1);
  const [items, setItems] = useState<Item[]>([{ id: 0, node: root }]);
  const push = useCallback((node: ReactNode) => setItems((s) => [...s, { id: nextId.current++, node }]), []);
  const pop = useCallback(() => setItems((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const replace = useCallback((node: ReactNode) => setItems((s) => [...s.slice(0, -1), { id: nextId.current++, node }]), []);
  const reset = useCallback((node: ReactNode) => setItems([{ id: nextId.current++, node }]), []);
  const value = useMemo(() => ({ push, pop, replace, reset, depth: items.length }), [push, pop, replace, reset, items.length]);
  return <Ctx.Provider value={value}>{children(items)}</Ctx.Provider>;
}

export function useNav(): Nav {
  const n = useContext(Ctx);
  if (!n) throw new Error('NavProvider missing');
  return n;
}
