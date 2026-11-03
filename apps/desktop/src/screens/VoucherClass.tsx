import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtAmount, parseAmount, type Ledger, type VoucherType } from '@tallybook/core';
import {
  CALC_LABELS,
  createVoucherClass,
  deleteVoucherClass,
  expandClass,
  fmtPercent,
  parsePercent,
  setVoucherTypeOptions,
  updateVoucherClass,
  voucherClass,
  voucherClasses,
  voucherTypeOptions,
  type ClassCalc,
  type ClassLineInput,
  type ClassSection,
  type ExpandedEntry,
  type VoucherClass,
  type VoucherTypeOptions,
} from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import type { Opt } from '../ui/PickerInput.tsx';
import { SelectList } from './SelectList.tsx';
import { EntryGrid, gridRow, type GridCol, type GridRow } from './EntryGrid.tsx';

function useLedgers(): Ledger[] {
  const { books, version } = useStore();
  const [l, setL] = useState<Ledger[]>([]);
  useEffect(() => {
    void books.ledgers().then(setL);
  }, [books, version]);
  return l;
}

const CALC_OPTS: Opt[] = (Object.keys(CALC_LABELS) as ClassCalc[]).map((k) => ({ id: k, label: CALC_LABELS[k] }));
const SIDE_OPTS: Opt[] = [
  { id: 'Dr', label: 'Dr' },
  { id: 'Cr', label: 'Cr' },
];
const YES_NO: Opt[] = [
  { id: 1, label: 'Yes' },
  { id: 0, label: 'No' },
];

function valueText(calc: ClassCalc, value: number): string {
  if (calc === 'percent') return fmtPercent(value);
  if (calc === 'fixed') return fmtAmount(value);
  return '';
}

export function VoucherClassForm({ typeId, id, initialName = '' }: { typeId: number; id?: number; initialName?: string }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const form = useRef<FormHandle>(null);
  const ledgers = useLedgers();
  const [type, setType] = useState<VoucherType | null>(null);
  const [cur, setCur] = useState<VoucherClass | null | undefined>(id ? undefined : null);
  const [head, setHead] = useState<{ name: string; forex: boolean } | null>(null);
  const [stage, setStage] = useState<ClassSection | null>(null);
  const [lines, setLines] = useState<ClassLineInput[]>([]);

  useEffect(() => {
    void books.voucherTypes().then((ts) => setType(ts.find((t) => t.id === typeId) ?? null));
    if (id) void voucherClass(books.db, id).then(setCur);
  }, [books, id, typeId]);

  const save = async (h: { name: string; forex: boolean }, ls: ClassLineInput[]) => {
    try {
      const input = { type_id: typeId, name: h.name, forex_adjust: h.forex, lines: ls };
      if (cur) await updateVoucherClass(books.db, cur.id, input);
      else await createVoucherClass(books.db, input);
      bump();
      toast('Voucher class saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
      setStage(null);
      setHead(null);
    }
  };

  const proceed = () => {
    const v = form.current?.submit();
    if (!v) return;
    const h = { name: String(v.name), forex: !!v.forex };
    setHead(h);
    setLines([]);
    setStage(h.forex ? 'forex' : 'default');
  };

  const remove = async () => {
    if (!cur || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await deleteVoucherClass(books.db, cur.id);
      bump();
      toast('Deleted', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  useScreen({
    title: 'Voucher Type Class',
    noPeriod: true,
    keys: { 'Ctrl+A': proceed, 'Alt+D': cur ? () => void remove() : () => false },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: proceed }, ...(cur ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : [])],
  });

  if (cur === undefined || !type) return null;
  const canForex = type.parent === 'Journal';
  const fields: FieldDef[] = [
    { key: 'name', label: 'Class', kind: 'text', required: true, initial: cur?.name ?? initialName, maxLength: 60 },
    ...(canForex ? ([{ key: 'forex', label: 'Use Class for Forex Gain/Loss Adjustments', kind: 'toggle', initial: !!cur?.forex_adjust }] as FieldDef[]) : []),
  ];
  const existing = (s: ClassSection) => (cur?.lines ?? []).filter((l) => l.section === s);
  const advance = (more: ClassLineInput[]) => {
    const next = [...lines, ...more];
    setLines(next);
    if (stage === 'default') setStage('additional');
    else void save(head!, next);
  };
  const cancel = () => {
    setStage(null);
    setHead(null);
  };
  const opts: Opt[] = ledgers.map((l) => ({ id: l.id, label: l.name, sub: l.group_name }));
  const heading = (
    <div className="text-center font-semibold">
      {head?.name} <span className="text-xs font-normal">({type.name})</span>
    </div>
  );

  return (
    <div className="max-w-2xl">
      <div className="mb-2 text-center">
        <span className="mr-2">Class:</span>
        <span className="font-bold">{head?.name ?? ''}</span>
      </div>
      <Form ref={form} fields={fields} labelWidth={320} onDone={proceed} />
      {stage === 'forex' && head && (
        <EntryGrid
          title="Forex Gain/Loss Ledger Account to use"
          heading={heading}
          cols={[{ key: 'ledger', label: 'Ledger Name', kind: 'picker', title: 'List of Ledger Accounts', options: opts }]}
          initial={existing('forex').map((l) => gridRow({ ledger: l.ledger }, { ledger: l.ledger_id }))}
          width={420}
          validate={(rs) => (rs.some((r) => !r.id.ledger) ? 'Ledger Name: choose from the list' : null)}
          onAccept={(rs) => advance(rs.map((r) => ({ section: 'forex' as const, ledger_id: Number(r.id.ledger) })))}
          onCancel={cancel}
        />
      )}
      {(stage === 'default' || stage === 'additional') && head && <LineGrid key={stage} section={stage} ledgers={opts} initial={existing(stage)} heading={heading} onAccept={advance} onCancel={cancel} />}
    </div>
  );
}

function LineGrid({ section, ledgers, initial, heading, onAccept, onCancel }: { section: 'default' | 'additional'; ledgers: Opt[]; initial: { ledger: string; ledger_id: number; side: 'Dr' | 'Cr'; calc: ClassCalc; value: number; remove_if_zero: number }[]; heading: React.ReactNode; onAccept: (l: ClassLineInput[]) => void; onCancel: () => void }) {
  const isDefault = section === 'default';
  const rows = initial.map((l) =>
    gridRow(
      { ledger: l.ledger, side: l.side, calc: CALC_LABELS[l.calc], value: valueText(l.calc, l.value), rz: l.remove_if_zero ? 'Yes' : 'No' },
      { ledger: l.ledger_id, side: l.side, calc: l.calc, rz: l.remove_if_zero }
    )
  );
  const cols: GridCol[] = [
    { key: 'ledger', label: 'Ledger Name', kind: 'picker', title: 'List of Ledger Accounts', options: ledgers },
    { key: 'side', label: 'Dr/Cr', kind: 'picker', title: 'Dr/Cr', options: SIDE_OPTS, width: 70 },
    { key: 'calc', label: 'Type of Calculation', kind: 'picker', title: 'Types of Calculation', options: CALC_OPTS, width: 190 },
    { key: 'value', label: 'Percentage % / Value', kind: 'text', align: 'right', width: 130, visible: (r) => r.id.calc !== 'user' },
    ...(isDefault ? [] : [{ key: 'rz', label: 'Remove if Zero ?', kind: 'picker' as const, title: 'Remove if Zero', options: YES_NO, width: 120 }]),
  ];
  const fresh = (rs: GridRow[]) => {
    const last = rs[rs.length - 1];
    return gridRow({ side: last?.text.side ?? 'Cr', calc: last?.text.calc ?? CALC_LABELS.percent, rz: 'No' }, { side: last?.id.side ?? 'Cr', calc: last?.id.calc ?? 'percent', rz: 0 });
  };
  return (
    <EntryGrid
      title={isDefault ? 'Default Accounting Entries' : 'Additional Accounting Entries (e.g. Taxes / Other charges) to be added in Invoice'}
      heading={heading}
      cols={cols}
      initial={rows}
      fresh={fresh}
      width={760}
      validate={(all) => {
        const rs = all.filter((r) => r.id.ledger || (r.text.ledger ?? '').trim());
        for (const r of rs) {
          if (!r.id.ledger) return 'Ledger Name: choose from the list';
          if (!r.id.side || !r.id.calc) return 'Choose Dr/Cr and Type of Calculation';
          if (r.id.calc === 'percent' && parsePercent(r.text.value ?? '') === null) return 'Enter a valid percentage';
          if (r.id.calc === 'fixed' && parseAmount(r.text.value ?? '') === null) return 'Enter a valid amount';
        }
        return null;
      }}
      onAccept={(all) =>
        onAccept(
          all.filter((r) => r.id.ledger).map((r) => {
            const calc = r.id.calc as ClassCalc;
            return {
              section,
              ledger_id: Number(r.id.ledger),
              side: r.id.side === 'Cr' ? ('Cr' as const) : ('Dr' as const),
              calc,
              value: calc === 'percent' ? parsePercent(r.text.value ?? '') ?? 0 : calc === 'fixed' ? parseAmount(r.text.value ?? '') ?? 0 : 0,
              remove_if_zero: !isDefault && Number(r.id.rz) === 1,
            };
          })
        )
      }
      onCancel={onCancel}
    />
  );
}

export function VoucherClassPicker({ typeId, onPick, title = 'Voucher Class' }: { typeId: number; onPick: (c: VoucherClass | null) => void; title?: string }) {
  const { books } = useStore();
  const [list, setList] = useState<VoucherClass[] | null>(null);
  useEffect(() => {
    void voucherClasses(books.db, typeId).then(setList);
  }, [books, typeId]);
  if (!list) return null;
  return (
    <SelectList
      title={title}
      heading="List of Voucher Classes"
      popOnSelect
      items={[{ id: 0, label: 'Not Applicable' }, ...list.map((c) => ({ id: c.id, label: c.name }))]}
      onSelect={(i) => onPick(list.find((c) => c.id === i.id) ?? null)}
    />
  );
}

export function useVoucherClasses(typeId: number | null | undefined): VoucherClass[] {
  const { books, version } = useStore();
  const [list, setList] = useState<VoucherClass[]>([]);
  useEffect(() => {
    if (!typeId) return setList([]);
    void voucherClasses(books.db, typeId).then(setList);
  }, [books, typeId, version]);
  return list;
}

export function classEntries(cls: VoucherClass, baseAmount: number): ExpandedEntry[] {
  return expandClass(cls, baseAmount);
}

type OptKey = keyof Omit<VoucherTypeOptions, 'type_id'>;

interface OptRow {
  key: OptKey;
  label: string;
  kind: 'toggle' | 'text';
  show?: (parent: string, o: VoucherTypeOptions) => boolean;
  indent?: boolean;
}

const STOCK_NO_NARR = ['Delivery Note', 'Receipt Note', 'Sales Order', 'Purchase Order', 'Physical Stock', 'Stock Journal', 'Rejection In', 'Rejection Out'];
const ADD_COSTS = ['Purchase', 'Journal', 'Memorandum', 'Payment', 'Physical Stock', 'Rejection Out', 'Reversing Journal'];
const QR = ['Sales', 'Debit Note', 'Delivery Note', 'Journal', 'Point of Sales', 'Sales Order'];
const TEMPLATE = ['Sales', 'Point of Sales', 'Sales Order', 'Delivery Note', 'Credit Note', 'Debit Note'];

const GENERAL: OptRow[] = [
  { key: 'use_effective_dates', label: 'Use effective dates for vouchers', kind: 'toggle' },
  { key: 'allow_zero_valued', label: 'Allow zero-valued transactions', kind: 'toggle' },
  { key: 'optional_by_default', label: "Make this voucher type as 'Optional' by default", kind: 'toggle', show: (p) => p !== 'Memorandum' && p !== 'Reversing Journal' },
  { key: 'allow_narration', label: 'Allow narration in voucher', kind: 'toggle' },
  { key: 'narration_per_ledger', label: 'Provide narrations for each ledger in voucher', kind: 'toggle', show: (p) => !STOCK_NO_NARR.includes(p) },
  { key: 'track_additional_costs', label: 'Track Additional Costs for Purchases', kind: 'toggle', show: (p) => ADD_COSTS.includes(p) },
  { key: 'default_accounting_allocations', label: 'Enable default accounting allocations', kind: 'toggle' },
  { key: 'whatsapp_after_saving', label: 'WhatsApp voucher after saving', kind: 'toggle' },
  { key: 'payment_qr_after_saving', label: 'Generate payment link/QR code after saving voucher', kind: 'toggle', show: (p) => QR.includes(p) },
];

const PRINTING: OptRow[] = [
  { key: 'print_after_saving', label: 'Print voucher after saving', kind: 'toggle' },
  { key: 'pos_invoicing', label: 'Use for POS invoicing', kind: 'toggle', show: (p) => p === 'Sales' },
  { key: 'pos_message1', label: 'Message to print (1)', kind: 'text', indent: true, show: (p, o) => p === 'Sales' && !!o.pos_invoicing },
  { key: 'pos_message2', label: 'Message to print (2)', kind: 'text', indent: true, show: (p, o) => p === 'Sales' && !!o.pos_invoicing },
  { key: 'default_template', label: 'Default template to print', kind: 'text', show: (p) => TEMPLATE.includes(p) },
  { key: 'default_title', label: 'Default title to print', kind: 'text', show: (p) => p === 'Sales' },
  { key: 'default_bank', label: 'Default bank', kind: 'text', show: (p) => p === 'Sales' },
  { key: 'default_jurisdiction', label: 'Default jurisdiction', kind: 'text', show: (p) => p === 'Sales' },
  { key: 'set_declaration', label: 'Set/alter declaration', kind: 'toggle' },
  { key: 'declaration', label: 'Declaration', kind: 'text', indent: true, show: (_p, o) => !!o.set_declaration },
  { key: 'set_terms', label: 'Set/Alter Terms and Conditions', kind: 'toggle', show: (p) => TEMPLATE.includes(p) },
  { key: 'default_terms', label: 'Default Terms and Conditions', kind: 'text', indent: true, show: (_p, o) => !!o.set_terms },
];

export function VoucherTypeOptionsScreen({ typeId }: { typeId: number }) {
  const { books, bump, toast, company } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const [type, setType] = useState<VoucherType | null>(null);
  const [opts, setOpts] = useState<VoucherTypeOptions | null>(null);
  const classes = useVoucherClasses(typeId);
  const [newName, setNewName] = useState('');
  const refs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    void books.voucherTypes().then((ts) => setType(ts.find((t) => t.id === typeId) ?? null));
    void voucherTypeOptions(books.db, typeId).then(setOpts);
  }, [books, typeId]);

  const save = useCallback(async () => {
    if (!opts) return;
    const { type_id: _t, ...patch } = opts;
    void _t;
    try {
      await setVoucherTypeOptions(books.db, typeId, patch);
      bump();
      toast('Voucher type saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  }, [books, bump, nav, opts, toast, typeId]);
  const accept = useCallback(async () => {
    if (await dialogs.confirm('Accept ?', { title: 'Accept', yes: 'Yes', no: 'No', corner: true })) void save();
  }, [dialogs, save]);

  const parent = type?.parent ?? '';
  const vis = (rows: OptRow[]) => (opts ? rows.filter((r) => !r.show || r.show(parent, opts)) : []);
  const general = vis(GENERAL);
  const printing = vis(PRINTING);
  const order = [...general.map((r) => r.key as string), ...printing.map((r) => r.key as string), 'class'];
  const go = (key: string, dir: 1 | -1) =>
    setTimeout(() => {
      const i = order.indexOf(key);
      const next = order[i + dir];
      if (next) {
        refs.current[next]?.focus();
        refs.current[next]?.select?.();
      }
    }, 0);
  useEffect(() => {
    if (opts && type) setTimeout(() => refs.current[order[0]]?.focus(), 0);
  }, [!!opts, !!type]);

  const openClass = (c?: VoucherClass, name = '') => nav.push(<VoucherClassForm typeId={typeId} id={c?.id} initialName={name} />);
  useScreen({
    title: 'Voucher Type Alteration',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void accept() },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void accept() }],
  });
  if (!opts || !type) return null;

  const set = (k: OptKey, v: number | string) => setOpts((o) => (o ? { ...o, [k]: v } : o));
  const field = (r: OptRow) => {
    const v = opts[r.key];
    const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (r.kind === 'toggle' && (/^[yYnN]$/.test(e.key) || e.key === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        set(r.key, /^[yY]$/.test(e.key) ? 1 : /^[nN]$/.test(e.key) ? 0 : v ? 0 : 1);
      } else if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        go(r.key, 1);
      } else if (e.key === 'Backspace' && (r.kind === 'toggle' || e.currentTarget.value === '')) {
        e.preventDefault();
        e.stopPropagation();
        go(r.key, -1);
      }
    };
    return (
      <div key={r.key} className={`flex items-center ${r.indent ? 'pl-4' : ''}`}>
        <label className="flex-1 pr-1">{r.label}</label>
        <span className="mr-1">:</span>
        <input
          ref={(el) => {
            refs.current[r.key] = el;
          }}
          className={`tb-input w-36 ${r.kind === 'toggle' ? 'font-bold' : ''}`}
          readOnly={r.kind === 'toggle'}
          value={r.kind === 'toggle' ? (v ? 'Yes' : 'No') : String(v)}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => set(r.key, e.target.value)}
          onKeyDown={onKey}
        />
      </div>
    );
  };
  const col = 'flex-1 border-l border-tb-line px-2 first:border-l-0';
  void company;
  return (
    <div className="border border-tb-line bg-tb-paper">
      <div className="px-3 py-2">
        <div className="flex">
          <span className="w-24">Name</span>
          <span className="mr-2">:</span>
          <span className="font-bold">{type.name}</span>
        </div>
        <div className="flex">
          <span className="w-24 italic">(alias)</span>
          <span className="mr-2">:</span>
        </div>
      </div>
      <div className="flex border-t border-tb-line">
        <div className={col}>
          <div className="py-2 text-center font-bold underline">General</div>
          <div className="flex">
            <span className="flex-1">Select type of voucher</span>
            <span className="mr-1">:</span>
            <span className="w-36 px-1 font-bold">{type.parent}</span>
          </div>
          <div className="flex">
            <span className="flex-1">Abbreviation</span>
            <span className="mr-1">:</span>
            <span className="w-36 px-1">{type.abbrev}</span>
          </div>
          <div className="flex">
            <span className="flex-1">Activate this Voucher Type</span>
            <span className="mr-1">:</span>
            <span className="w-36 px-1 font-bold">{type.is_active ? 'Yes' : 'No'}</span>
          </div>
          <div className="mt-2 border-t border-tb-line pt-2">{general.map(field)}</div>
        </div>
        <div className={col}>
          <div className="py-2 text-center font-bold underline">Printing</div>
          {printing.map(field)}
        </div>
        <div className="w-60 border-l border-tb-line px-2">
          <div className="py-2 text-center font-bold underline">Name of Class</div>
          {classes.map((c) => (
            <input
              key={c.id}
              className="tb-input mb-0.5 block w-full font-bold"
              readOnly
              value={c.name}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  openClass(c);
                } else if (e.key === 'ArrowDown') {
                  (e.currentTarget.nextElementSibling as HTMLInputElement | null)?.focus();
                } else if (e.key === 'ArrowUp') {
                  (e.currentTarget.previousElementSibling as HTMLInputElement | null)?.focus();
                } else if (e.key === 'Delete' || (e.altKey && e.key.toLowerCase() === 'd')) {
                  e.preventDefault();
                  e.stopPropagation();
                  void (async () => {
                    if (await dialogs.confirm('Delete ?', { title: 'Delete', def: false })) {
                      await deleteVoucherClass(books.db, c.id);
                      bump();
                    }
                  })();
                }
              }}
            />
          ))}
          <input
            ref={(el) => {
              refs.current.class = el;
            }}
            className="tb-input block w-full font-bold"
            value={newName}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                e.stopPropagation();
                const n = newName.trim();
                if (!n) return void accept();
                const hit = classes.find((c) => c.name.toLowerCase() === n.toLowerCase());
                setNewName('');
                openClass(hit, hit ? '' : n);
              } else if (e.key === 'Backspace' && e.currentTarget.value === '') {
                e.preventDefault();
                e.stopPropagation();
                go('class', -1);
              } else if (e.key === 'ArrowUp' && e.currentTarget.previousElementSibling) {
                (e.currentTarget.previousElementSibling as HTMLInputElement).focus();
              }
            }}
          />
        </div>
      </div>
      <div className="min-h-[160px]" />
    </div>
  );
}

export function useTypeOptions(typeId: number | null | undefined): VoucherTypeOptions | null {
  const { books, version } = useStore();
  const [o, setO] = useState<VoucherTypeOptions | null>(null);
  useEffect(() => {
    if (!typeId) return setO(null);
    void voucherTypeOptions(books.db, typeId).then(setO);
  }, [books, typeId, version]);
  return o;
}

export function useTypeById(typeId: number | null | undefined): VoucherType | null {
  const { books } = useStore();
  const [t, setT] = useState<VoucherType | null>(null);
  useEffect(() => {
    if (!typeId) return setT(null);
    void books.voucherTypes().then((ts) => setT(ts.find((x) => x.id === typeId) ?? null));
  }, [books, typeId]);
  return useMemo(() => t, [t]);
}
