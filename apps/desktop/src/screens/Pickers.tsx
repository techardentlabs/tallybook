import { useEffect, useState } from 'react';
import type { Group, Ledger, VoucherType } from '@tallybook/core';
import { SelectList } from './SelectList.tsx';
import { useStore } from '../store.tsx';
import { HOTKEY_OF_TYPE } from '../keys.ts';

export function PickLedger({ title = 'Ledger', onPick, onCreate }: { title?: string; onPick: (l: Ledger) => void; onCreate?: () => void }) {
  const { books, version } = useStore();
  const [items, setItems] = useState<Ledger[]>([]);
  useEffect(() => void books.ledgers().then(setItems), [books, version]);
  return <SelectList title={title} heading="List of Ledgers" popOnSelect items={items.map((l) => ({ id: l.id, label: l.name, sub: l.group_name }))} onSelect={(i) => onPick(items.find((l) => l.id === i.id)!)} onCreate={onCreate} />;
}

export function PickGroup({ title = 'Group', onPick }: { title?: string; onPick: (g: Group) => void }) {
  const { books, version } = useStore();
  const [items, setItems] = useState<Group[]>([]);
  useEffect(() => void books.groups().then(setItems), [books, version]);
  return <SelectList title={title} heading="List of Groups" popOnSelect items={items.map((g) => ({ id: g.id, label: g.name, sub: g.parent ?? 'Primary' }))} onSelect={(i) => onPick(items.find((g) => g.id === i.id)!)} />;
}

export function PickVoucherType({ title = 'Voucher Type Selection', onPick }: { title?: string; onPick: (t: VoucherType) => void }) {
  const { books } = useStore();
  const [items, setItems] = useState<VoucherType[]>([]);
  useEffect(() => void books.voucherTypes().then(setItems), [books]);
  return (
    <SelectList
      title={title}
      heading="List of Voucher Types"
      popOnSelect
      items={items.filter((t) => t.is_active).map((t) => ({ id: t.id, label: t.name, sub: HOTKEY_OF_TYPE[t.name] }))}
      onSelect={(i) => onPick(items.find((t) => t.id === i.id)!)}
    />
  );
}
