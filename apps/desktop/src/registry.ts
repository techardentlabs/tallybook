import { useEffect, useId, useRef, useSyncExternalStore } from 'react';

export interface Btn {
  key: string;
  label: string;
  run?: () => void;
  disabled?: boolean;
}

export type KeyHandler = (e: KeyboardEvent) => boolean | void;

export interface ScreenOpts {
  title: string;
  right?: string;
  keys?: Record<string, KeyHandler>;
  buttons?: Btn[];
  noPeriod?: boolean;
  swallow?: boolean;
  kind?: string;
}

interface Entry {
  id: string;
  opts: ScreenOpts;
}

const entries: Entry[] = [];
const listeners = new Set<() => void>();
let version = 0;

function emit() {
  version += 1;
  for (const l of listeners) l();
}

export function useScreen(opts: ScreenOpts): void {
  const id = useId();
  const ref = useRef<Entry>({ id, opts });
  ref.current.opts = opts;
  useEffect(() => {
    const entry = ref.current;
    entries.push(entry);
    emit();
    return () => {
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
      emit();
    };
  }, []);
  useEffect(() => {
    if (entries[entries.length - 1] === ref.current) emit();
  });
}

export function topEntry(): ScreenOpts | null {
  return entries.length ? entries[entries.length - 1].opts : null;
}

export function useTop(): ScreenOpts | null {
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => version
  );
  return topEntry();
}
