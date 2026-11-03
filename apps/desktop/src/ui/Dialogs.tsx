import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtDate, parseDate } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';

type Pending =
  | { kind: 'confirm'; message: ReactNode; title: string; yes: string; no: string; def: boolean; corner: boolean; resolve: (v: boolean) => void }
  | { kind: 'period'; from: string; to: string; resolve: (v: { from: string; to: string } | null) => void };

interface Dialogs {
  confirm: (message: ReactNode, opts?: { title?: string; yes?: string; no?: string; def?: boolean; corner?: boolean }) => Promise<boolean>;
  askPeriod: (from: string, to: string) => Promise<{ from: string; to: string } | null>;
}

const Ctx = createContext<Dialogs | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback<Dialogs['confirm']>(
    (message, opts = {}) =>
      new Promise((resolve) =>
        setPending({ kind: 'confirm', message, title: opts.title ?? 'Confirm', yes: opts.yes ?? 'Yes', no: opts.no ?? 'No', def: opts.def ?? true, corner: opts.corner ?? false, resolve })
      ),
    []
  );
  const askPeriod = useCallback<Dialogs['askPeriod']>((from, to) => new Promise((resolve) => setPending({ kind: 'period', from, to, resolve })), []);
  const close = () => setPending(null);
  return (
    <Ctx.Provider value={{ confirm, askPeriod }}>
      {children}
      {pending?.kind === 'confirm' && (
        <ConfirmDialog
          p={pending}
          done={(v) => {
            close();
            pending.resolve(v);
          }}
        />
      )}
      {pending?.kind === 'period' && (
        <PeriodDialog
          p={pending}
          done={(v) => {
            close();
            pending.resolve(v);
          }}
        />
      )}
    </Ctx.Provider>
  );
}

export function useDialogs(): Dialogs {
  const d = useContext(Ctx);
  if (!d) throw new Error('DialogProvider missing');
  return d;
}

function Shell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-500/35">
      <div className="min-w-[360px] max-w-[540px] border border-tb-ink bg-white shadow-lg">
        <div className="px-3 pt-3 text-center font-bold underline">{title}</div>
        {children}
      </div>
    </div>
  );
}

function ConfirmDialog({ p, done }: { p: Extract<Pending, { kind: 'confirm' }>; done: (v: boolean) => void }) {
  const [sel, setSel] = useState(p.def);
  const selRef = useRef(sel);
  selRef.current = sel;
  useScreen({
    title: p.title,
    swallow: true,
    kind: 'modal',
    noPeriod: true,
    keys: {
      Y: () => done(true),
      N: () => done(false),
      Escape: () => done(false),
      Enter: () => done(selRef.current),
      ArrowLeft: () => setSel((s) => !s),
      ArrowRight: () => setSel((s) => !s),
      Tab: () => setSel((s) => !s),
    },
    buttons: [],
  });
  return (
    <div className="fixed bottom-6 right-[155px] z-50 min-w-[110px] max-w-[340px] border border-tb-ink bg-white px-4 pb-1 pt-3 text-[15px] shadow-md">
      <div className="pb-6">{p.message}</div>
      <div className="text-[14px]">
        <span onClick={() => done(true)} className={`cursor-pointer font-bold ${sel ? 'bg-tb-sel' : 'text-tb-top'}`}>
          {p.yes}
        </span>{' '}
        or{' '}
        <span onClick={() => done(false)} className={`cursor-pointer font-bold ${!sel ? 'bg-tb-sel' : 'text-tb-top'}`}>
          {p.no}
        </span>
      </div>
    </div>
  );
}

function PeriodDialog({ p, done }: { p: Extract<Pending, { kind: 'period' }>; done: (v: { from: string; to: string } | null) => void }) {
  const { company, toast } = useStore();
  const [from, setFrom] = useState(fmtDate(p.from));
  const [to, setTo] = useState(fmtDate(p.to));
  const toRef = useRef<HTMLInputElement>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const state = useRef({ from, to });
  state.current = { from, to };
  const fy = company?.fy_start;

  const accept = useCallback(() => {
    const f = parseDate(state.current.from, fy, p.from);
    const t = parseDate(state.current.to, fy, p.to);
    if (!f || !t) return toast('Enter valid dates', 'err');
    if (f > t) return toast('From date cannot be after the To date', 'err');
    done({ from: f, to: t });
  }, [done, fy, p.from, p.to, toast]);

  useScreen({ title: 'Change Period', kind: 'modal', noPeriod: true, keys: { Escape: () => done(null), 'Ctrl+A': () => accept() }, buttons: [] });
  useEffect(() => {
    fromRef.current?.focus();
    fromRef.current?.select();
  }, []);
  return (
    <Shell title="Change Period">
      <div className="space-y-2 px-5 py-4">
        <div className="flex items-center gap-3">
          <label className="w-16 text-tb-muted">From</label>
          <input
            ref={fromRef}
            className="tb-input flex-1"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                toRef.current?.focus();
                toRef.current?.select();
              }
            }}
          />
        </div>
        <div className="flex items-center gap-3">
          <label className="w-16 text-tb-muted">To</label>
          <input
            ref={toRef}
            className="tb-input flex-1"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                accept();
              } else if (e.key === 'Backspace' && to === '') {
                fromRef.current?.focus();
              }
            }}
          />
        </div>
        <div className="pt-1 text-xs text-tb-muted">Enter: accept   Esc: cancel</div>
      </div>
    </Shell>
  );
}
