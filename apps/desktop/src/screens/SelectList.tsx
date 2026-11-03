import { useEffect, useMemo, useRef, useState } from 'react';
import { useScreen } from '../registry.ts';
import { useNav } from '../nav.tsx';
import { ListPanel } from '../ui/ListPanel.tsx';

export interface ListItem {
  id: number | string;
  label: string;
  sub?: string;
}

function order(items: ListItem[]): ListItem[] {
  const names = [...new Set(items.map((i) => i.sub ?? ''))];
  return names.flatMap((n) => items.filter((i) => (i.sub ?? '') === n));
}

export function SelectList({
  title,
  heading,
  items,
  onSelect,
  onCreate,
  popOnSelect = false,
  grouped = false,
  empty = 'Nothing to show',
}: {
  title: string;
  heading: string;
  items: ListItem[];
  onSelect: (item: ListItem) => void;
  onCreate?: () => void;
  popOnSelect?: boolean;
  grouped?: boolean;
  empty?: string;
}) {
  const nav = useNav();
  const [text, setText] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return grouped ? order(items) : items;
    return [...items.filter((i) => i.label.toLowerCase().startsWith(q)), ...items.filter((i) => !i.label.toLowerCase().startsWith(q) && i.label.toLowerCase().includes(q))];
  }, [items, text, grouped]);
  const ref = useRef({ shown, sel });
  ref.current = { shown, sel };

  const choose = () => {
    const it = ref.current.shown[ref.current.sel];
    if (!it) return;
    if (popOnSelect) nav.pop();
    onSelect(it);
  };

  useScreen({
    title,
    keys: {
      ArrowDown: () => setSel((s) => Math.min(s + 1, ref.current.shown.length - 1)),
      ArrowUp: () => setSel((s) => Math.max(s - 1, 0)),
      Enter: choose,
      'Alt+C': onCreate ? () => onCreate() : () => false,
    },
    buttons: onCreate ? [{ key: 'Alt+C', label: 'Create', run: onCreate }] : [],
  });
  useEffect(() => setSel(0), [text]);
  useEffect(() => input.current?.focus(), []);

  if (!grouped) {
    return (
      <>
        <input ref={input} className="fixed -left-[999px] opacity-0" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="mx-auto mt-16 w-[420px] border border-tb-ink bg-white px-4 pb-4 pt-3">
          <div className="mb-3 text-center font-bold underline">{title}</div>
          <div className="flex items-center">
            <span className="w-40">Name</span>
            <span className="mr-2">:</span>
            <span className="h-6 flex-1 border border-tb-line bg-[#ffe3b0] px-1 leading-6">{text}</span>
          </div>
        </div>
        <ListPanel
          title={heading.replace(/^List of /, '')}
          create={onCreate ? 'Create' : undefined}
          items={shown.map((it) => ({ key: it.id, label: it.label, sub: it.sub }))}
          sel={sel}
          onHover={setSel}
          onPick={(i) => {
            ref.current.sel = i;
            choose();
          }}
          empty={empty}
        />
      </>
    );
  }
  return (
    <div className="mx-auto mt-6 w-[380px] border border-tb-line bg-tb-menu shadow-[1px_1px_5px_rgba(0,0,0,.3)]">
      <div className="bg-white px-3 pb-3 pt-2 text-center">
        <div className="mb-2 text-[14px] font-bold">{title}</div>
        <input ref={input} className="mx-auto block h-6 w-[85%] border border-tb-line bg-[#ffe3b0] px-1 text-left" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="bg-tb-top px-2 py-0.5 text-[14px] text-white">{heading}</div>
      <div className="pr-2 text-right text-[13px] leading-[18px]">{onCreate ? 'Create' : '\u00a0'}</div>
      {shown.length === 0 ? (
        <div className="px-3 py-3 text-tb-muted">{empty}</div>
      ) : (
        <ul className="max-h-[60vh] overflow-auto pb-2">
          {shown.map((it, i) => (
            <li key={it.id}>
              {grouped && !text.trim() && (i === 0 || shown[i - 1].sub !== it.sub) ? <div className="px-2 pt-1 text-[14px] font-bold">{it.sub}</div> : null}
              <div
                ref={(el) => {
                  if (el && i === sel) el.scrollIntoView({ block: 'nearest' });
                }}
                onMouseEnter={() => setSel(i)}
                onClick={() => {
                  ref.current.sel = i;
                  choose();
                }}
                className={`flex cursor-pointer justify-between py-px pr-2 text-[14px] ${grouped ? 'pl-6' : 'pl-3'} ${i === sel ? 'bg-tb-sel' : ''}`}
              >
                <span>
                  {!grouped && <span className="inline-block w-3">{i === sel ? '\u2666' : ''}</span>}
                  {it.label}
                </span>
                {it.sub && (!grouped || text.trim()) ? <small className="text-tb-muted">{it.sub}</small> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
