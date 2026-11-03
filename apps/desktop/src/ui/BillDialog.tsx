import { useEffect, useMemo, useRef, useState } from 'react';
import { fmtAmount, fmtDate, outstandings, parseAmount, parseDate, type BillInput, type Ledger } from '@tallybook/core';
import { PickerInput, type Opt } from './PickerInput.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';

type Kind = 'new' | 'agst' | 'adv' | 'onacc';
const KINDS: Opt[] = [
  { id: 'new', label: 'New Ref' },
  { id: 'agst', label: 'Agst Ref' },
  { id: 'adv', label: 'Advance' },
  { id: 'onacc', label: 'On Account' },
];

interface Row {
  kind: Kind;
  kindText: string;
  name: string;
  due: string;
  amount: string;
}

const labelOf = (k: Kind) => KINDS.find((x) => x.id === k)!.label;

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

function dueOf(text: string, voucherDate: string, fy?: string): string | null {
  const t = text.trim();
  if (!t) return '';
  const days = /^(\d{1,4})\s*(days?)?$/i.exec(t);
  if (days) return addDays(voucherDate, Number(days[1]));
  return parseDate(t, fy, voucherDate);
}

export function BillDialog({
  ledger,
  amount,
  creditor,
  asOf,
  voucherDate,
  initial,
  onDone,
}: {
  ledger: Ledger;
  amount: number;
  creditor: boolean;
  asOf: string;
  voucherDate: string;
  initial: BillInput[];
  onDone: (bills: BillInput[] | null) => void;
}) {
  const { books, company, toast } = useStore();
  const sign = amount < 0 ? -1 : 1;
  const total = Math.abs(amount);
  const natural = creditor ? -1 : 1;
  const defaultKind: Kind = sign === natural ? 'new' : 'agst';
  const [pending, setPending] = useState<Opt[]>([]);
  const [dues, setDues] = useState<Map<string, string>>(new Map());
  const creditDue = ledger.credit_days ? `${ledger.credit_days} Days` : '';
  const dueText = (b: BillInput) => (b.due_date ? (b.bill_date && b.due_date > b.bill_date ? `${daysBetween(b.bill_date, b.due_date)} Days` : fmtDate(b.due_date)) : '');
  const [rows, setRows] = useState<Row[]>(() =>
    initial.length
      ? initial.map((b) => ({ kind: b.kind as Kind, kindText: labelOf(b.kind as Kind), name: b.name, due: dueText(b), amount: fmtAmount(Math.abs(b.amount)) }))
      : [{ kind: defaultKind, kindText: labelOf(defaultKind), name: '', due: defaultKind === 'new' ? creditDue : '', amount: fmtAmount(total) }]
  );
  const box = useRef<HTMLDivElement>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    void outstandings(books.db, creditor ? 'payable' : 'receivable', asOf, company?.fy_start ?? asOf).then((o) => {
      const l = o.ledgers.find((x) => x.ledger_id === ledger.id);
      setPending((l?.bills ?? []).map((b) => ({ id: b.name, label: b.name, sub: fmtAmount(b.pending) })));
      setDues(new Map((l?.bills ?? []).map((b) => [b.name, b.due_date ? fmtDate(b.due_date) : ''])));
    });
  }, [books, creditor, asOf, ledger.id, company]);

  const focus = (r: number, c: number) =>
    setTimeout(() => (box.current?.querySelector(`[data-cell="${r}-${c}"]`) as HTMLInputElement | null)?.focus(), 0);
  useEffect(() => {
    focus(0, 0);
  }, []);

  const update = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const sumOf = (rs: Row[]) => rs.reduce((s, r) => s + (parseAmount(r.amount) ?? 0), 0);

  const accept = () => {
    const rs = rowsRef.current;
    const out: BillInput[] = [];
    for (const r of rs) {
      const a = parseAmount(r.amount);
      if (!a) continue;
      if (r.kind !== 'onacc' && !r.name.trim()) return toast('Enter the bill reference name', 'err');
      const due = r.kind === 'new' || r.kind === 'adv' ? dueOf(r.due, voucherDate, company?.fy_start) : '';
      if (due === null) return toast(`Invalid due date or credit days for ${r.name}`, 'err');
      if (due && ledger.check_credit_days && ledger.credit_days && daysBetween(voucherDate, due) > ledger.credit_days) return toast(`Credit period for ${r.name} exceeds ${ledger.credit_days} days`, 'err');
      out.push({ kind: r.kind, name: r.kind === 'onacc' ? '' : r.name.trim(), amount: sign * a, bill_date: voucherDate, due_date: due });
    }
    const sum = out.reduce((s, b) => s + Math.abs(b.amount), 0);
    if (sum !== total) return toast(`Bill allocations (${fmtAmount(sum)}) must equal ${fmtAmount(total)}`, 'err');
    onDone(out);
  };

  useScreen({ title: 'Bill-wise Details', kind: 'modal', noPeriod: true, keys: { Escape: () => onDone(null), 'Ctrl+A': accept }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: accept }] });

  const afterAmount = (i: number) => {
    const rs = rowsRef.current;
    const rest = total - sumOf(rs);
    if (rest > 0 && i === rs.length - 1) {
      setRows((x) => [...x, { kind: 'onacc', kindText: labelOf('onacc'), name: '', due: '', amount: fmtAmount(rest) }]);
      focus(i + 1, 0);
    } else if (rest === 0) accept();
    else toast(`Allocated more than ${fmtAmount(total)}`, 'err');
  };

  const remaining = total - sumOf(rows);
  const opts = useMemo(() => pending, [pending]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-tb-top/35 pr-[400px]" ref={box}>
      <div className="w-[820px] border border-tb-ink bg-tb-paper shadow-[5px_5px_0_rgba(15,90,116,.3)]">
        <div className="bg-tb-title px-3 py-1 text-sm font-semibold text-white">
          Bill-wise Details for: {ledger.name} ({fmtAmount(total)} {sign > 0 ? 'Dr' : 'Cr'})
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-tb-ink text-left text-xs">
              <th className="px-3 py-1">Type of Ref</th>
              <th className="px-2 py-1">Name</th>
              <th className="w-44 px-2 py-1">Due Date, or Credit Days</th>
              <th className="px-3 py-1 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="w-40 px-2 py-0.5">
                  <PickerInput
                    className="tb-input w-full"
                    value={r.kindText}
                    title="Reference Types"
                    options={KINDS}
                    inputRef={(el) => el?.setAttribute('data-cell', `${i}-0`)}
                    onChange={(t) => update(i, { kindText: t })}
                    onPick={(o) => {
                      update(i, { kind: o.id as Kind, kindText: o.label, due: o.id === 'new' || o.id === 'adv' ? r.due || creditDue : '' });
                      focus(i, o.id === 'onacc' ? 2 : 1);
                    }}
                  />
                </td>
                <td className="px-2 py-0.5">
                  {r.kind === 'onacc' ? (
                    <span className="px-1 text-tb-muted">(On Account)</span>
                  ) : r.kind === 'agst' ? (
                    <PickerInput
                      className="tb-input w-full"
                      value={r.name}
                      title="Pending Bills"
                      options={opts}
                      inputRef={(el) => el?.setAttribute('data-cell', `${i}-1`)}
                      onChange={(t) => update(i, { name: t })}
                      onPick={(o) => {
                        const pend = Number(String(o.sub ?? '0').replace(/,/g, '')) * 100;
                        update(i, { name: o.label, amount: fmtAmount(Math.min(Math.round(pend), total)) });
                        focus(i, 2);
                      }}
                      onNoMatch={() => toast('Choose a pending bill from the list', 'err')}
                    />
                  ) : (
                    <input
                      className="tb-input w-full"
                      data-cell={`${i}-1`}
                      value={r.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          if (!r.name.trim()) return toast('Enter the bill reference name', 'err');
                          focus(i, 3);
                        }
                      }}
                    />
                  )}
                </td>
                <td className="w-44 px-2 py-0.5">
                  {r.kind === 'new' || r.kind === 'adv' ? (
                    <input
                      className="tb-input w-full"
                      data-cell={`${i}-3`}
                      value={r.due}
                      onChange={(e) => update(i, { due: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          if (dueOf(r.due, voucherDate, company?.fy_start) === null) return toast('Enter a date or number of days', 'err');
                          focus(i, 2);
                        }
                      }}
                    />
                  ) : (
                    <span className="px-1">{r.kind === 'agst' ? dues.get(r.name) ?? '' : ''}</span>
                  )}
                </td>
                <td className="w-40 px-2 py-0.5">
                  <input
                    className="tb-input tb-num w-full"
                    data-cell={`${i}-2`}
                    value={r.amount}
                    onChange={(e) => update(i, { amount: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        const a = parseAmount(r.amount);
                        if (a === null || a === 0) return toast('Enter a valid amount', 'err');
                        update(i, { amount: fmtAmount(a) });
                        setTimeout(() => afterAmount(i), 0);
                      }
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-between border-t border-tb-line px-3 py-1 text-xs text-tb-muted">
          <span>Enter: next   Ctrl+A: accept   Esc: cancel</span>
          <span className={remaining ? 'text-tb-danger' : ''}>Unallocated: {fmtAmount(remaining, false)}</span>
        </div>
      </div>
    </div>
  );
}
