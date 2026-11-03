import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtAmount, fmtDate, parseAmount, parseDate } from '@tallybook/core';
import { PickerInput, type Opt } from '../ui/PickerInput.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';

export interface GridCol {
  key: string;
  label: string;
  kind: 'picker' | 'amount' | 'text' | 'date';
  options?: Opt[] | ((row: GridRow) => Opt[]);
  title?: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  visible?: (row: GridRow) => boolean;
  readOnly?: boolean;
}

export interface GridRow {
  text: Record<string, string>;
  id: Record<string, string | number | null>;
}

export const blankRow = (): GridRow => ({ text: {}, id: {} });

export function gridRow(text: Record<string, string>, id: Record<string, string | number | null> = {}): GridRow {
  return { text, id };
}

const isBlank = (r: GridRow) => Object.values(r.text).every((t) => !t.trim());

export function EntryGrid({
  title,
  heading,
  cols,
  initial,
  derive,
  fresh,
  footer,
  hint = 'Enter: next   Ctrl+A: accept   Esc: cancel   Alt+R: remove line',
  placement = 'center',
  width = 640,
  validate,
  onAccept,
  onCancel,
}: {
  title: string;
  heading?: ReactNode;
  cols: GridCol[];
  initial: GridRow[];
  derive?: (rows: GridRow[], index: number, key: string) => GridRow[];
  fresh?: (rows: GridRow[]) => GridRow;
  footer?: (rows: GridRow[]) => ReactNode;
  hint?: string;
  placement?: 'center' | 'right';
  width?: number;
  validate?: (rows: GridRow[]) => string | null;
  onAccept: (rows: GridRow[]) => void;
  onCancel: () => void;
}) {
  const { company, toast } = useStore();
  const [rows, setRows] = useState<GridRow[]>(initial.length ? initial : [blankRow()]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const cur = useRef({ r: 0, c: 0 });
  const box = useRef<HTMLDivElement>(null);

  const focus = (r: number, c: number) =>
    setTimeout(() => {
      const el = box.current?.querySelector(`[data-cell="${r}-${c}"]`) as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.select?.();
      }
    }, 0);
  useEffect(() => {
    focus(0, 0);
  }, []);

  const setCell = (i: number, key: string, text: string, id?: string | number | null) => {
    setRows((rs) => {
      const next = rs.map((r, j) => (j === i ? { text: { ...r.text, [key]: text }, id: { ...r.id, [key]: id === undefined ? r.id[key] ?? null : id } } : r));
      return derive ? derive(next, i, key) : next;
    });
  };

  const visibleCols = (r: GridRow) => cols.map((c, ci) => ({ c, ci })).filter((x) => !x.c.visible || x.c.visible(r));

  const advance = (i: number, ci: number) => {
    const list = rowsRef.current;
    const vis = visibleCols(list[i]);
    const pos = vis.findIndex((x) => x.ci === ci);
    const nextCol = vis.slice(pos + 1).find((x) => !x.c.readOnly);
    if (nextCol) return focus(i, nextCol.ci);
    if (isBlank(list[i])) return accept();
    if (i === list.length - 1) {
      const f = fresh ? fresh(list) : blankRow();
      setRows((rs) => [...rs, f]);
    }
    const first = visibleCols(rowsRef.current[i + 1] ?? blankRow()).find((x) => !x.c.readOnly);
    focus(i + 1, first ? first.ci : 0);
  };

  const accept = () => {
    const live = rowsRef.current.filter((r) => !isBlank(r));
    const err = validate ? validate(live) : null;
    if (err) return toast(err, 'err');
    onAccept(live);
  };

  const removeLine = () => {
    const i = cur.current.r;
    setRows((rs) => (rs.length <= 1 ? [blankRow()] : rs.filter((_, j) => j !== i)));
    focus(Math.max(0, i - 1), 0);
  };

  useScreen({
    title,
    kind: 'modal',
    noPeriod: true,
    keys: { Escape: () => onCancel(), 'Ctrl+A': accept, 'Alt+R': removeLine },
    buttons: [
      { key: 'Ctrl+A', label: 'Accept', run: accept },
      { key: 'Alt+R', label: 'Remove Line', run: removeLine },
    ],
  });

  const optionsOf = (c: GridCol, r: GridRow): Opt[] => (typeof c.options === 'function' ? c.options(r) : c.options ?? []);
  const alignCls = (c: GridCol) => (c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left');
  const wrap = placement === 'right' ? 'fixed inset-0 z-50 bg-tb-top/35' : 'fixed inset-0 z-50 flex items-center justify-center bg-tb-top/35 pr-[400px]';
  const panel = placement === 'right' ? 'fixed bottom-6 right-0 top-[88px] flex flex-col overflow-hidden' : '';

  return (
    <div className={wrap} ref={box}>
      <div className={`${panel} border border-tb-ink bg-tb-paper shadow-[5px_5px_0_rgba(15,90,116,.3)]`} style={{ width }}>
        <div className="bg-tb-title px-3 py-1 text-sm font-semibold text-white">{title}</div>
        {heading ? <div className="border-b border-tb-line px-3 py-2 text-center">{heading}</div> : null}
        <div className={placement === 'right' ? 'min-h-0 flex-1 overflow-hidden' : ''}>
          <table className="w-full">
            <thead>
              <tr className="border-b border-tb-ink text-xs">
                {cols.map((c) => (
                  <th key={c.key} className={`px-2 py-1 font-semibold ${alignCls(c)}`} style={c.width ? { width: c.width } : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c, ci) => {
                    if (c.visible && !c.visible(r)) return <td key={c.key} />;
                    const text = r.text[c.key] ?? '';
                    const onFocus = () => {
                      cur.current = { r: i, c: ci };
                    };
                    if (c.kind === 'picker') {
                      return (
                        <td key={c.key} className="px-2 py-0.5">
                          <PickerInput
                            className="tb-input w-full"
                            value={text}
                            title={c.title ?? c.label}
                            options={optionsOf(c, r)}
                            inputRef={(el) => el?.setAttribute('data-cell', `${i}-${ci}`)}
                            onFocus={onFocus}
                            onChange={(t) => setCell(i, c.key, t, null)}
                            onPick={(o) => {
                              setCell(i, c.key, o.label, o.id);
                              setTimeout(() => advance(i, ci), 0);
                            }}
                            onEmptyEnter={isBlank(r) && i === rowsRef.current.length - 1 ? accept : undefined}
                            onNoMatch={() => toast(`${c.label}: choose from the list`, 'err')}
                          />
                        </td>
                      );
                    }
                    return (
                      <td key={c.key} className="px-2 py-0.5">
                        <input
                          className={`tb-input w-full ${c.kind === 'amount' ? 'tb-num' : ''}`}
                          data-cell={`${i}-${ci}`}
                          value={text}
                          readOnly={c.readOnly}
                          onFocus={onFocus}
                          onChange={(e) => setCell(i, c.key, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey) return;
                            e.preventDefault();
                            e.stopPropagation();
                            if (c.kind === 'amount') {
                              const a = parseAmount(text);
                              if (a === null) return toast(`${c.label}: enter a valid amount`, 'err');
                              setCell(i, c.key, a ? fmtAmount(a) : '');
                            } else if (c.kind === 'date' && text.trim()) {
                              const iso = parseDate(text, company?.fy_start);
                              if (!iso) return toast(`${c.label}: invalid date`, 'err');
                              setCell(i, c.key, fmtDate(iso));
                            }
                            setTimeout(() => advance(i, ci), 0);
                          }}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {footer ? <div className="border-t border-tb-line px-3 py-1">{footer(rows)}</div> : null}
        <div className="border-t border-tb-line px-3 py-1 text-xs text-tb-muted">{hint}</div>
      </div>
    </div>
  );
}
