import { useEffect, useMemo, useState } from 'react';
import { fmtDrCr, groupSummary } from '@tallybook/core';
import type { Group, Ledger } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { GroupForm, LedgerForm } from './MasterForms.tsx';

interface Node {
  kind: 'group' | 'ledger';
  id: number;
  name: string;
  depth: number;
  closing?: number;
}

export function ChartOfAccounts() {
  const { books, period, version } = useStore();
  const nav = useNav();
  const [groups, setGroups] = useState<Group[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [closing, setClosing] = useState<Map<number, number>>(new Map());
  const [sel, setSel] = useState(0);
  useEffect(() => {
    void Promise.all([books.groups(), books.ledgers()]).then(([g, l]) => {
      setGroups(g);
      setLedgers(l);
    });
    void (async () => {
      const m = new Map<number, number>();
      const walk = async (gid: number | null) => {
        const s = await groupSummary(books.db, period.from, period.to, gid);
        for (const r of s.rows) {
          if (r.kind === 'ledger') m.set(r.id, r.closing);
          else await walk(r.id);
        }
      };
      await walk(null);
      setClosing(m);
    })();
  }, [books, period, version]);

  const nodes = useMemo(() => {
    const out: Node[] = [];
    const walk = (parent: number | null, depth: number) => {
      for (const g of groups.filter((x) => x.parent_id === parent)) {
        out.push({ kind: 'group', id: g.id, name: g.name, depth });
        walk(g.id, depth + 1);
        for (const l of ledgers.filter((x) => x.group_id === g.id)) out.push({ kind: 'ledger', id: l.id, name: l.name, depth: depth + 1, closing: closing.get(l.id) });
      }
    };
    walk(null, 0);
    return out;
  }, [groups, ledgers, closing]);

  const open = (n?: Node) => {
    if (!n) return;
    nav.push(n.kind === 'group' ? <GroupForm id={n.id} /> : <LedgerForm id={n.id} />);
  };
  useScreen({
    title: 'Chart of Accounts',
    noPeriod: true,
    keys: {
      ArrowDown: () => setSel((s) => Math.min(s + 1, nodes.length - 1)),
      ArrowUp: () => setSel((s) => Math.max(s - 1, 0)),
      PageDown: () => setSel((s) => Math.min(s + 12, nodes.length - 1)),
      PageUp: () => setSel((s) => Math.max(s - 12, 0)),
      Enter: () => open(nodes[sel]),
      'Alt+C': () => nav.push(<LedgerForm />),
    },
    buttons: [{ key: 'Alt+C', label: 'Create Ledger', run: () => nav.push(<LedgerForm />) }],
  });
  return (
    <div className="border border-tb-line bg-tb-paper px-4 py-3">
      <div className="mb-2 text-center font-semibold">Chart of Accounts</div>
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className="border-y border-tb-ink px-2 py-1">Name</th>
            <th className="border-y border-tb-ink px-2 py-1 text-right">Closing balance</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((n, i) => (
            <tr
              key={`${n.kind}-${n.id}`}
              ref={(el) => {
                if (el && i === sel) el.scrollIntoView({ block: 'nearest' });
              }}
              className={`cursor-pointer ${i === sel ? 'bg-tb-sel text-tb-sel-ink' : ''} ${n.kind === 'group' ? 'font-bold' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => open(n)}
            >
              <td className="px-2" style={{ paddingLeft: 8 + n.depth * 20 }}>{n.name}</td>
              <td className="px-2 text-right tabular-nums">{n.kind === 'ledger' ? fmtDrCr(n.closing ?? 0) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
