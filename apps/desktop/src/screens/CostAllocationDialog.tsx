import { useEffect, useMemo, useState } from 'react';
import { fmtAmount, parseAmount } from '@tallybook/core';
import { costCategories, costCentres, type AllocationInput, type CostCategory, type CostCentre } from '@tallybook/core';
import { EntryGrid, gridRow, type GridCol, type GridRow } from './EntryGrid.tsx';
import { useStore } from '../store.tsx';
import type { Opt } from '../ui/PickerInput.tsx';

export function CostAllocationDialog({
  ledger,
  amount,
  initial = [],
  onDone,
}: {
  ledger: string;
  amount: number;
  initial?: AllocationInput[];
  onDone: (lines: AllocationInput[] | null) => void;
}) {
  const { books, version } = useStore();
  const [centres, setCentres] = useState<CostCentre[] | null>(null);
  const [cats, setCats] = useState<CostCategory[]>([]);
  useEffect(() => {
    void Promise.all([costCentres(books.db), costCategories(books.db)]).then(([c, k]) => {
      setCentres(c);
      setCats(k);
    });
  }, [books, version]);
  const sign = amount < 0 ? -1 : 1;
  const total = Math.abs(amount);
  const multi = useMemo(() => new Set((centres ?? []).map((c) => c.category_id)).size > 1, [centres]);

  const rows = useMemo<GridRow[]>(() => {
    if (!centres) return [];
    return initial.map((l) => {
      const c = centres.find((x) => x.id === l.cost_centre_id);
      return gridRow({ category: c?.category ?? '', centre: c?.name ?? '', amount: fmtAmount(Math.abs(l.amount)) }, { category: c?.category_id ?? null, centre: l.cost_centre_id });
    });
  }, [centres, initial]);

  if (!centres) return null;

  const catOpts: Opt[] = cats.filter((k) => centres.some((c) => c.category_id === k.id)).map((k) => ({ id: k.id, label: k.name }));
  const centreOpts = (r: GridRow): Opt[] => {
    const cat = r.id.category;
    return centres.filter((c) => !cat || c.category_id === cat).map((c) => ({ id: c.id, label: c.name, sub: multi && !cat ? c.category : undefined }));
  };
  const cols: GridCol[] = [
    ...(multi ? ([{ key: 'category', label: 'Cost Category', kind: 'picker', title: 'Cost Categories', options: catOpts, width: 170 }] as GridCol[]) : []),
    { key: 'centre', label: 'Name of Cost Centre', kind: 'picker', title: 'Cost Centres', options: centreOpts },
    { key: 'amount', label: 'Amount', kind: 'amount', align: 'right', width: 130 },
  ];

  const sums = (rs: GridRow[]) => {
    const m = new Map<number, number>();
    for (const r of rs) {
      const c = centres.find((x) => x.id === r.id.centre);
      if (c) m.set(c.category_id, (m.get(c.category_id) ?? 0) + (parseAmount(r.text.amount ?? '') ?? 0));
    }
    return m;
  };

  const derive = (rs: GridRow[], i: number, key: string): GridRow[] => {
    if (key !== 'centre') return rs;
    const r = rs[i];
    const c = centres.find((x) => x.id === r.id.centre);
    if (!c) return rs;
    const others = sums(rs.filter((_, j) => j !== i));
    const rest = Math.max(0, total - (others.get(c.category_id) ?? 0));
    const patch: GridRow = {
      text: { ...r.text, category: c.category, amount: r.text.amount?.trim() ? r.text.amount : rest ? fmtAmount(rest) : '' },
      id: { ...r.id, category: c.category_id },
    };
    return rs.map((x, j) => (j === i ? patch : x));
  };

  const validate = (rs: GridRow[]): string | null => {
    for (const r of rs) {
      if (!r.id.centre) return 'Choose the Cost Centre from the list';
      if (!(parseAmount(r.text.amount ?? '') ?? 0)) return 'Enter the allocation amount';
    }
    for (const [cat, sum] of sums(rs)) {
      if (sum !== total) return `Cost Break-up Total does not match for ledger (under Category ${cats.find((k) => k.id === cat)?.name ?? ''})`;
    }
    return null;
  };

  const accept = (rs: GridRow[]) =>
    onDone(rs.map((r) => ({ cost_centre_id: Number(r.id.centre), amount: sign * (parseAmount(r.text.amount ?? '') ?? 0) })));

  return (
    <EntryGrid
      title="Cost Centre Allocations"
      placement="right"
      width={multi ? 520 : 420}
      heading={
        <>
          <div>
            Cost Allocations for : <b>{ledger}</b>
          </div>
          <div>
            Up to: <b>{'₹'} {fmtAmount(total)} {sign > 0 ? 'Dr' : 'Cr'}</b>
          </div>
        </>
      }
      cols={cols}
      initial={rows}
      derive={derive}
      validate={validate}
      footer={(rs) => {
        const left = total - [...sums(rs).values()].reduce((a, b) => Math.max(a, b), 0);
        return <div className={`text-right text-xs ${left ? 'text-tb-danger' : ''}`}>Unallocated: {fmtAmount(left, false)}</div>;
      }}
      onAccept={accept}
      onCancel={() => onDone(null)}
    />
  );
}
