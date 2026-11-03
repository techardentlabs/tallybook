import { useEffect, useRef, useState } from 'react';

export interface PanelItem {
  key: string | number;
  label: string;
  sub?: string;
}

export function ListPanel({
  title,
  create,
  items,
  sel,
  onPick,
  onHover,
  empty = 'No match',
}: {
  title: string;
  create?: string;
  items: PanelItem[];
  sel: number;
  onPick: (i: number) => void;
  onHover?: (i: number) => void;
  empty?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [more, setMore] = useState({ above: 0, below: 0 });
  const measure = () => {
    const el = list.current;
    const row = el?.querySelector('li');
    if (!el || !row) return setMore({ above: 0, below: 0 });
    const h = row.getBoundingClientRect().height || 20;
    setMore({ above: Math.floor(el.scrollTop / h), below: Math.max(0, Math.floor((el.scrollHeight - el.scrollTop - el.clientHeight) / h)) });
  };
  useEffect(measure, [items.length, sel]);
  return (
    <div className="fixed bottom-6 right-0 top-[98px] z-[60] flex w-[400px] flex-col border-l border-tb-line bg-tb-menu shadow-[-1px_0_4px_rgba(0,0,0,.15)]">
      <div className="bg-tb-top px-2 py-1 text-[15px] text-white">List of {title}</div>
      <div className="mt-3 pr-2 text-right text-[14px] leading-[20px]">{create ?? ' '}</div>
      <ul ref={list} onScroll={measure} className="min-h-0 flex-1 overflow-auto">
        {items.length === 0 ? (
          <li className="px-2 py-1 text-tb-muted">{empty}</li>
        ) : (
          items.map((it, i) => (
            <li
              key={it.key}
              ref={(el) => {
                if (el && i === sel) el.scrollIntoView({ block: 'nearest' });
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(i);
              }}
              onMouseEnter={() => onHover?.(i)}
              className={`flex cursor-pointer justify-between gap-3 px-2 py-px text-[15px] ${i === sel ? 'bg-tb-sel' : ''}`}
            >
              <span>{it.label}</span>
              {it.sub ? <i className="shrink-0">{it.sub}</i> : null}
            </li>
          ))
        )}
      </ul>
      {more.above + more.below > 0 && (
        <div className="flex justify-between px-2 text-[13px] text-tb-top">
          <span>{more.above ? `\u25B2 ${more.above}` : ''}</span>
          <span>{more.below ? `${more.below} \u25BC` : ''}</span>
        </div>
      )}
    </div>
  );
}
