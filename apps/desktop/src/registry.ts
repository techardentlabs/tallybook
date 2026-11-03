import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { ACCESS_DENIED, canAllCurrent, screenActions } from '@tallybook/core';

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

export interface ScreenGuard {
  deny: (message: string) => void;
}

export const ScreenGuardCtx = createContext<ScreenGuard | null>(null);

let deniedHandler: ((message: string) => void) | null = null;

export function onAccessDenied(fn: (message: string) => void): () => void {
  deniedHandler = fn;
  return () => {
    if (deniedHandler === fn) deniedHandler = null;
  };
}

export function showAccessDenied(message: string = ACCESS_DENIED): void {
  deniedHandler?.(message);
}

export function entryTitles(): string[] {
  return entries.map((e) => e.opts.title).reverse();
}

export function screenDenial(title: string, below: string[] = entryTitles()): string | null {
  return canAllCurrent(screenActions(title, below)) ? null : ACCESS_DENIED;
}

export function useScreen(opts: ScreenOpts): void {
  const id = useId();
  const ref = useRef<Entry>({ id, opts });
  ref.current.opts = opts;
  const guard = useContext(ScreenGuardCtx);
  useLayoutEffect(() => {
    if (!guard || opts.kind === 'modal') return;
    const below = entries.filter((e) => e !== ref.current).map((e) => e.opts.title).reverse();
    const denial = screenDenial(opts.title, below);
    if (denial) guard.deny(denial);
  }, [guard, opts.title, opts.kind]);
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
