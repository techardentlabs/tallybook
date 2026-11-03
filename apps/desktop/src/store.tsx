import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Books, Company } from '@tallybook/core';

export type ToastKind = '' | 'ok' | 'err';

interface Store {
  books: Books;
  company: Company | null;
  period: { from: string; to: string };
  setPeriod: (from: string, to: string) => void;
  reloadCompany: () => Promise<Company | null>;
  version: number;
  bump: () => void;
  toast: (msg: string, kind?: ToastKind) => void;
  status: { msg: string; kind: ToastKind };
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ books, initial, children }: { books: Books; initial: Company | null; children: ReactNode }) {
  const [company, setCompany] = useState<Company | null>(initial);
  const [period, setPeriodState] = useState(() => ({ from: initial?.fy_start ?? '', to: initial?.fy_end ?? '' }));
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<{ msg: string; kind: ToastKind }>({ msg: '', kind: '' });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback((msg: string, kind: ToastKind = '') => {
    clearTimeout(timer.current);
    setStatus({ msg, kind });
    if (msg && kind !== 'err') timer.current = setTimeout(() => setStatus({ msg: '', kind: '' }), 5000);
  }, []);

  const reloadCompany = useCallback(async () => {
    const c = await books.company();
    setCompany(c);
    if (c) setPeriodState((p) => (p.from ? p : { from: c.fy_start, to: c.fy_end }));
    return c;
  }, [books]);

  const value = useMemo<Store>(
    () => ({
      books,
      company,
      period,
      setPeriod: (from, to) => setPeriodState({ from, to }),
      reloadCompany,
      version,
      bump: () => setVersion((v) => v + 1),
      toast,
      status,
    }),
    [books, company, period, reloadCompany, version, toast, status]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('StoreProvider missing');
  return s;
}
