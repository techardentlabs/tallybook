import { createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ACCESS_DENIED, canVoucher, currentUser } from '@tallybook/core';
import { ScreenGuardCtx, onAccessDenied, useScreen, type ScreenGuard } from './registry.ts';

interface Item {
  id: number;
  node: ReactNode;
  replaces?: number;
}

interface Nav {
  push: (node: ReactNode) => void;
  pop: () => void;
  replace: (node: ReactNode) => void;
  reset: (node: ReactNode) => void;
  depth: number;
}

const Ctx = createContext<Nav | null>(null);

export function nodeDenial(node: ReactNode): string | null {
  if (!isValidElement(node)) return null;
  const p = node.props as { typeName?: unknown; voucherId?: unknown };
  if (typeof p.typeName !== 'string' || !p.typeName) return null;
  return canVoucher(currentUser(), p.typeName, undefined, p.voucherId ? 'alter' : 'create') ? null : ACCESS_DENIED;
}

function Guarded({ item, deny, settle, children }: { item: Item; deny: (id: number, message: string) => void; settle: (item: Item) => void; children: ReactNode }) {
  const guard = useMemo<ScreenGuard>(() => ({ deny: (message) => deny(item.id, message) }), [deny, item.id]);
  useLayoutEffect(() => {
    settle(item);
  }, [item, settle]);
  return <ScreenGuardCtx.Provider value={guard}>{children}</ScreenGuardCtx.Provider>;
}

function AccessDenied({ message, close }: { message: string; close: () => void }) {
  useScreen({
    title: 'Access Denied',
    kind: 'modal',
    swallow: true,
    noPeriod: true,
    keys: { Enter: close, Escape: close, Space: close },
    buttons: [],
  });
  useEffect(() => {
    const t = setTimeout(close, 4000);
    return () => clearTimeout(t);
  }, [close]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center" onClick={close}>
      <div className="min-w-[260px] max-w-[420px] border border-tb-ink bg-white px-6 pb-2 pt-4 text-center text-[15px] shadow-md">
        <div className="pb-4 font-bold">{message}</div>
        <div className="text-[12px] text-tb-muted">Press Enter or Esc to continue</div>
      </div>
    </div>
  );
}

export function NavProvider({ root, children }: { root: ReactNode; children: (items: Item[]) => ReactNode }) {
  const nextId = useRef(1);
  const denied = useRef(new Set<number>());
  const [items, setItems] = useState<Item[]>([{ id: 0, node: root }]);
  const [message, setMessage] = useState<string | null>(null);
  const block = useCallback((node: ReactNode) => {
    const d = nodeDenial(node);
    if (d) setMessage(d);
    return !!d;
  }, []);
  const push = useCallback((node: ReactNode) => {
    if (block(node)) return;
    setItems((s) => [...s, { id: nextId.current++, node }]);
  }, [block]);
  const pop = useCallback(() => setItems((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const replace = useCallback((node: ReactNode) => {
    if (block(node)) return;
    setItems((s) => (s.length ? [...s, { id: nextId.current++, node, replaces: s[s.length - 1].id }] : [{ id: nextId.current++, node }]));
  }, [block]);
  const reset = useCallback((node: ReactNode) => setItems([{ id: nextId.current++, node }]), []);
  const deny = useCallback((id: number, msg: string) => {
    denied.current.add(id);
    setMessage(msg);
    setItems((s) => (s.length > 1 ? s.filter((i) => i.id !== id) : s));
  }, []);
  const settle = useCallback((item: Item) => {
    if (item.replaces === undefined || denied.current.has(item.id)) return;
    const gone = item.replaces;
    setItems((s) => (s.some((i) => i.id === gone) ? s.filter((i) => i.id !== gone) : s));
  }, []);
  const close = useCallback(() => setMessage(null), []);
  useEffect(() => onAccessDenied(setMessage), []);
  const value = useMemo(() => ({ push, pop, replace, reset, depth: items.length }), [push, pop, replace, reset, items.length]);
  const wrapped = useMemo(
    () =>
      items.map((it) => ({
        id: it.id,
        node: (
          <Guarded item={it} deny={deny} settle={settle}>
            {it.node}
          </Guarded>
        ),
      })),
    [items, deny, settle]
  );
  return (
    <Ctx.Provider value={value}>
      {children(wrapped)}
      {message && <AccessDenied message={message} close={close} />}
    </Ctx.Provider>
  );
}

export function useNav(): Nav {
  const n = useContext(Ctx);
  if (!n) throw new Error('NavProvider missing');
  return n;
}
