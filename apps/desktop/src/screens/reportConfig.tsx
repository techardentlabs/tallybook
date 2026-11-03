import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { useScreen, type Btn, type KeyHandler } from '../registry.ts';
import { useNav } from '../nav.tsx';

export interface OptionDef {
  key: string;
  label: string;
  default: boolean;
}

const listeners = new Set<() => void>();
let cache: Record<string, Record<string, boolean>> = {};

function read(report: string): Record<string, boolean> {
  if (cache[report]) return cache[report];
  try {
    cache[report] = JSON.parse(localStorage.getItem(`tb.rc.${report}`) ?? '{}');
  } catch {
    cache[report] = {};
  }
  return cache[report];
}

function write(report: string, v: Record<string, boolean>) {
  cache = { ...cache, [report]: v };
  try {
    localStorage.setItem(`tb.rc.${report}`, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function ReportConfigScreen({ report, title, defs }: { report: string; title: string; defs: OptionDef[] }) {
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const cur = read(report);
  const save = () => {
    const v = form.current?.submit();
    if (!v) return;
    write(report, Object.fromEntries(defs.map((d) => [d.key, !!v[d.key]])));
    nav.pop();
  };
  useScreen({ title: `${title} Configuration`, noPeriod: true, keys: { 'Ctrl+A': save }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: save }] });
  const fields: FieldDef[] = defs.map((d) => ({ key: d.key, label: d.label, kind: 'toggle', initial: cur[d.key] ?? d.default }));
  return (
    <div className="max-w-2xl">
      <Form ref={form} fields={fields} labelWidth={380} onDone={save} />
    </div>
  );
}

export function useReportOptions(report: string, title: string, defs: OptionDef[]) {
  const nav = useNav();
  const snapshot = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => read(report)
  );
  const values = useMemo(() => Object.fromEntries(defs.map((d) => [d.key, snapshot[d.key] ?? d.default])) as Record<string, boolean>, [snapshot, defs]);
  const open = useCallback(() => nav.push(<ReportConfigScreen report={report} title={title} defs={defs} />), [nav, report, title, defs]);
  const key: Record<string, KeyHandler> = { F12: open };
  const button: Btn = { key: 'F12', label: 'Configure', run: open };
  return { values, key, button };
}

export function useFilter() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  const toggle = useCallback(() => {
    setOpen((o) => !o);
    setText('');
  }, []);
  const q = text.trim().toLowerCase();
  const match = useCallback((...parts: (string | number | undefined)[]) => !q || parts.some((p) => String(p ?? '').toLowerCase().includes(q)), [q]);
  const bar: ReactNode = open ? (
    <div className="mb-2 flex items-center gap-2">
      <span className="font-bold">Filter:</span>
      <input
        ref={ref}
        className="tb-input w-72 bg-[#ffe3b0]"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget as HTMLInputElement).blur();
            if (e.key === 'Escape') toggle();
          }
        }}
      />
      <span className="text-xs italic text-[#7a7a7a]">Enter: apply   Esc: clear</span>
    </div>
  ) : null;
  return { match, bar, key: { 'Ctrl+F': toggle } as Record<string, KeyHandler>, button: { key: 'Ctrl+F', label: 'Filter', run: toggle } as Btn, active: !!q };
}
