import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { canAllCurrent, currentUser, menuActions, onUserChange } from '@tallybook/core';
import { showAccessDenied, type KeyHandler } from '../registry.ts';

export interface MenuItem {
  label: string;
  run?: () => void;
  heading?: boolean;
  hotkey?: string;
  hint?: string;
  hotAt?: number;
  facility?: string | false;
}

const deniedItems = new WeakSet<MenuItem>();

export function menuItemDenied(menuTitle: string, it: MenuItem): boolean {
  if (it.heading || it.label === '' || it.facility === false) return false;
  return !canAllCurrent(it.facility ? [it.facility as `${string}.display`] : menuActions(menuTitle, it.label));
}

function activate(it: MenuItem | undefined) {
  if (!it) return;
  if (deniedItems.has(it)) return showAccessDenied();
  it.run?.();
}

function useSecurityUser() {
  return useSyncExternalStore(onUserChange, currentUser);
}

export function useMenu(items: MenuItem[]) {
  const skip = (i: MenuItem) => !!i.heading || i.label === '';
  const first = items.findIndex((i) => !skip(i));
  const [sel, setSel] = useState(first < 0 ? 0 : first);
  const ref = useRef({ items, sel });
  ref.current = { items, sel };

  const step = useCallback((dir: 1 | -1) => {
    const { items: its, sel: cur } = ref.current;
    let i = cur;
    for (let n = 0; n < its.length; n++) {
      i = (i + dir + its.length) % its.length;
      if (!skip(its[i])) break;
    }
    setSel(i);
  }, []);

  const keys = useMemo<Record<string, KeyHandler>>(() => {
    const k: Record<string, KeyHandler> = {
      ArrowDown: () => step(1),
      ArrowUp: () => step(-1),
      Home: () => setSel(ref.current.items.findIndex((i) => !skip(i))),
      End: () => {
        const its = ref.current.items;
        for (let i = its.length - 1; i >= 0; i--) if (!skip(its[i])) return setSel(i);
      },
      Enter: () => activate(ref.current.items[ref.current.sel]),
    };
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      k[letter] = () => {
        const its = ref.current.items;
        const marked = its.findIndex((i) => i.hotkey === letter);
        if (marked >= 0) {
          setSel(marked);
          activate(its[marked]);
          return;
        }
        const matches = its.map((it, idx) => ({ it, idx })).filter(({ it }) => !skip(it) && !it.hotkey && it.label.toUpperCase().startsWith(letter));
        if (!matches.length) return false;
        const after = matches.find((m) => m.idx > ref.current.sel) ?? matches[0];
        setSel(after.idx);
        if (matches.length === 1) activate(after.it);
      };
    }
    return k;
  }, [step]);

  useEffect(() => {
    if (items[sel] && skip(items[sel])) step(1);
  }, [items, sel, step]);

  return { sel, setSel, keys };
}

function Label({ it, dim }: { it: MenuItem; dim?: boolean }) {
  if (!it.hotkey) return <>{it.label}</>;
  const at = it.hotAt ?? it.label.toUpperCase().indexOf(it.hotkey);
  if (at < 0) return <>{it.label}</>;
  return (
    <>
      {it.label.slice(0, at)}
      <b className={dim ? '' : 'text-tb-top'}>{it.label[at]}</b>
      {it.label.slice(at + 1)}
    </>
  );
}

export function MenuCard({ title, items, sel, setSel, width = 332 }: { title: string; items: MenuItem[]; sel: number; setSel: (i: number) => void; width?: number }) {
  useSecurityUser();
  for (const it of items) {
    if (menuItemDenied(title, it)) deniedItems.add(it);
    else deniedItems.delete(it);
  }
  return (
    <div className="border border-tb-line bg-tb-menu shadow-[1px_1px_4px_rgba(0,0,0,.2)]" style={{ width }}>
      <h3 className="m-0 bg-tb-top py-1 pl-24 text-[15px] font-normal text-white">{title}</h3>
      <ul className="m-0 max-h-[calc(100vh-190px)] list-none overflow-auto pb-6 pt-3">
        {items.map((it, i) =>
          it.heading ? (
            <li key={i} className="pb-2 pl-24 pt-4 text-[12px] uppercase tracking-wide text-tb-line">
              {it.label}
            </li>
          ) : it.label === '' ? (
            <li key={i} className="h-4" />
          ) : (
            <li
              key={i}
              ref={(el) => {
                if (el && i === sel) el.scrollIntoView({ block: 'nearest' });
              }}
              onMouseEnter={() => setSel(i)}
              onClick={() => activate(it)}
              className={`flex cursor-pointer justify-between py-px pl-24 pr-4 text-[15px] ${i === sel ? 'bg-tb-sel' : ''} ${deniedItems.has(it) ? 'text-[#a7b0b8]' : ''}`}
            >
              <span>
                <Label it={it} dim={deniedItems.has(it)} />
              </span>
              {it.hint ? <span className="ml-6 text-xs opacity-70">{it.hint}</span> : null}
            </li>
          )
        )}
      </ul>
    </div>
  );
}
