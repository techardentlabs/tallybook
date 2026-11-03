import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fmtAmount, parseAmount, type Group, type Ledger, type VoucherType, jobWorkTypeOptions, saveJobWorkTypeOptions, type JobWorkTypeOptions } from '@tallybook/core';
import {
  ACCOUNTING_CALCS,
  CALC_LABELS,
  INVOICE_CALCS,
  INVOICE_CLASS_TYPES,
  POS_MODES,
  POS_MODE_GROUPS,
  ROUND_LABELS,
  createVoucherClass,
  deleteVoucherClass,
  expandClass,
  fmtPercent,
  invoiceCalcLabel,
  parsePercent,
  partyIsDebit,
  setVoucherTypeOptions,
  updateVoucherClass,
  voucherClass,
  voucherClasses,
  voucherTypeOptions,
  type ClassCalc,
  type ClassLine,
  type ClassLineInput,
  type ClassSection,
  type ExpandedEntry,
  type PosMode,
  type RoundMethod,
  type VoucherClass,
  type VoucherTypeOptions,
} from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { Form, type FieldDef, type FormHandle, type Values } from '../ui/Form.tsx';
import type { Opt } from '../ui/PickerInput.tsx';
import { SelectList } from './SelectList.tsx';
import { EntryGrid, gridRow, type GridCol, type GridRow } from './EntryGrid.tsx';
import { isUnder } from '../lib.ts';

function useLedgers(): { ledgers: Ledger[]; groups: Group[] } {
  const { books, version } = useStore();
  const [l, setL] = useState<{ ledgers: Ledger[]; groups: Group[] }>({ ledgers: [], groups: [] });
  useEffect(() => {
    void Promise.all([books.ledgers(), books.groups()]).then(([ledgers, groups]) => setL({ ledgers, groups }));
  }, [books, version]);
  return l;
}

const calcOpts = (calcs: ClassCalc[], kind: string | null): Opt[] => calcs.map((k) => ({ id: k, label: kind ? invoiceCalcLabel(k, kind) : CALC_LABELS[k] }));
const ROUND_OPTS: Opt[] = (['none', 'downward', 'normal', 'upward'] as RoundMethod[]).map((k) => ({ id: k, label: ROUND_LABELS[k] }));
const SIDE_OPTS: Opt[] = [
  { id: 'Dr', label: 'Dr' },
  { id: 'Cr', label: 'Cr' },
];
const YES_NO: Opt[] = [
  { id: 1, label: 'Yes' },
  { id: 0, label: 'No' },
];
const POS_LABELS: Record<PosMode, string> = {
  gift: 'Gift Vouchers',
  card: 'Credit / Debit Card Payment',
  cheque: 'Cheque / DD',
  cash: 'Cash',
};
const POS_KEY: Record<PosMode, 'gift_ledger_id' | 'card_ledger_id' | 'cheque_ledger_id' | 'cash_ledger_id'> = { gift: 'gift_ledger_id', card: 'card_ledger_id', cheque: 'cheque_ledger_id', cash: 'cash_ledger_id' };

function valueText(calc: ClassCalc, value: number): string {
  if (calc === 'percent' || calc === 'subtotal') return fmtPercent(value);
  if (calc === 'fixed' || calc === 'qty') return fmtAmount(value);
  return '';
}

interface Head {
  name: string;
  forex: boolean;
  print_title: string;
  pos: Partial<Record<PosMode, number | null>>;
}

export function VoucherClassForm({ typeId, id, initialName = '' }: { typeId: number; id?: number; initialName?: string }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const form = useRef<FormHandle>(null);
  const { ledgers, groups } = useLedgers();
  const topts = useTypeOptions(typeId);
  const [type, setType] = useState<VoucherType | null>(null);
  const [cur, setCur] = useState<VoucherClass | null | undefined>(id ? undefined : null);
  const [head, setHead] = useState<Head | null>(null);
  const [stage, setStage] = useState<ClassSection | null>(null);
  const [lines, setLines] = useState<ClassLineInput[]>([]);

  useEffect(() => {
    void books.voucherTypes().then((ts) => setType(ts.find((t) => t.id === typeId) ?? null));
    if (id) void voucherClass(books.db, id).then(setCur);
  }, [books, id, typeId]);

  const posType = type?.parent === 'Sales' && !!topts?.pos_invoicing;
  const invoiceType = !!type && INVOICE_CLASS_TYPES.includes(type.parent);

  const save = async (h: Head, ls: ClassLineInput[]) => {
    try {
      const input = {
        type_id: typeId,
        name: h.name,
        forex_adjust: h.forex,
        pos_class: posType,
        print_title: h.print_title,
        gift_ledger_id: h.pos.gift ?? null,
        card_ledger_id: h.pos.card ?? null,
        cheque_ledger_id: h.pos.cheque ?? null,
        cash_ledger_id: h.pos.cash ?? null,
        lines: ls,
      };
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
    const v: Values | null = form.current?.submit() ?? null;
    if (!v) return;
    const pos: Head['pos'] = {};
    if (posType) for (const m of POS_MODES) pos[m] = v[m] ? Number(v[`${m}_ledger`]) || null : null;
    const h: Head = { name: String(v.name), forex: !!v.forex, print_title: posType ? String(v.print_title ?? '') : '', pos };
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

  if (cur === undefined || !type || !topts) return null;
  const canForex = type.parent === 'Journal';
  const ledgerOpt = (lid: number | null | undefined): Opt | undefined => {
    const l = lid ? ledgers.find((x) => x.id === lid) : undefined;
    return l ? { id: l.id, label: l.name, sub: l.group_name } : undefined;
  };
  const posFields: FieldDef[] = posType
    ? [
        { key: 'print_title', label: 'Default Print Title', kind: 'text', initial: cur?.print_title ?? '', maxLength: 100 },
        ...POS_MODES.flatMap((m): FieldDef[] => [
          { key: m, label: POS_LABELS[m], kind: 'toggle', initial: !!cur?.[POS_KEY[m]] },
          {
            key: `${m}_ledger`,
            label: 'Ledger',
            kind: 'picker',
            title: 'List of Ledger Accounts',
            required: true,
            options: ledgers.filter((l) => isUnder(groups, l, POS_MODE_GROUPS[m])).map((l) => ({ id: l.id, label: l.name, sub: l.group_name })),
            initial: ledgerOpt(cur?.[POS_KEY[m]]),
            visible: (v) => !!v[m],
          },
        ]),
      ]
    : [];
  const fields: FieldDef[] = [
    { key: 'name', label: 'Class', kind: 'text', required: true, initial: cur?.name ?? initialName, maxLength: 60 },
    ...(canForex ? ([{ key: 'forex', label: 'Use Class for Forex Gain/Loss Adjustments', kind: 'toggle', initial: !!cur?.forex_adjust }] as FieldDef[]) : []),
    ...posFields,
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
  if (!ledgers.length) return null;

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
      {(stage === 'default' || stage === 'additional') && head && (
        <LineGrid key={stage} section={stage} kind={invoiceType ? type.parent : null} ledgers={opts} initial={existing(stage)} heading={heading} onAccept={advance} onCancel={cancel} />
      )}
    </div>
  );
}

function LineGrid({ section, kind, ledgers, initial, heading, onAccept, onCancel }: { section: 'default' | 'additional'; kind: string | null; ledgers: Opt[]; initial: ClassLine[]; heading: React.ReactNode; onAccept: (l: ClassLineInput[]) => void; onCancel: () => void }) {
  const isDefault = section === 'default';
  const invoice = !!kind;
  const supplySide: 'Dr' | 'Cr' = kind && partyIsDebit(kind) ? 'Cr' : 'Dr';
  const label = (c: ClassCalc) => (kind ? invoiceCalcLabel(c, kind) : CALC_LABELS[c]);
  const rows = initial.map((l) =>
    gridRow(
      { ledger: l.ledger, side: l.side, calc: label(l.calc), value: valueText(l.calc, l.value), rz: l.remove_if_zero ? 'Yes' : 'No', round: ROUND_LABELS[l.rounding ?? 'none'], limit: l.round_limit ? fmtAmount(l.round_limit) : '' },
      { ledger: l.ledger_id, side: l.side, calc: l.calc, rz: l.remove_if_zero, round: l.rounding ?? 'none' }
    )
  );
  const roundCols: GridCol[] = invoice
    ? [
        { key: 'round', label: 'Rounding Method', kind: 'picker', title: 'Rounding Methods', options: ROUND_OPTS, width: 170 },
        { key: 'limit', label: 'Rounding Limit', kind: 'text', align: 'right', width: 110, visible: (r) => !!r.id.round && r.id.round !== 'none' },
      ]
    : [];
  const cols: GridCol[] =
    invoice && isDefault
      ? [{ key: 'ledger', label: 'Ledger Name', kind: 'picker', title: 'List of Ledger Accounts', options: ledgers }, { key: 'value', label: 'Percentage', kind: 'text', align: 'right', width: 110 }, ...roundCols]
      : [
          { key: 'ledger', label: 'Ledger Name', kind: 'picker', title: 'List of Ledger Accounts', options: ledgers },
          { key: 'side', label: 'Dr/Cr', kind: 'picker', title: 'Dr/Cr', options: SIDE_OPTS, width: 70 },
          { key: 'calc', label: 'Type of Calculation', kind: 'picker', title: 'Types of Calculation', options: calcOpts(invoice ? INVOICE_CALCS : ACCOUNTING_CALCS, kind), width: 200 },
          { key: 'value', label: 'Percentage % / Value', kind: 'text', align: 'right', width: 130, visible: (r) => r.id.calc !== 'user' && r.id.calc !== 'round' },
          ...roundCols,
          ...(isDefault ? [] : [{ key: 'rz', label: 'Remove if Zero ?', kind: 'picker' as const, title: 'Remove if Zero', options: YES_NO, width: 120 }]),
        ];
  const pctOf = (rs: GridRow[]) => rs.filter((r) => r.id.ledger).reduce((s, r) => s + (parsePercent(r.text.value ?? '') ?? 0), 0);
  const fresh = (rs: GridRow[]) => {
    const last = rs[rs.length - 1];
    if (invoice && isDefault) {
      const left = 10000 - pctOf(rs);
      return gridRow({ value: left > 0 ? fmtPercent(left) : '', round: ROUND_LABELS.none }, { round: 'none' });
    }
    const side = invoice ? supplySide : last?.id.side ?? 'Cr';
    return gridRow({ side: String(side), calc: last?.text.calc ?? label('percent'), rz: 'No', round: ROUND_LABELS.none }, { side, calc: last?.id.calc ?? 'percent', rz: 0, round: 'none' });
  };
  const title = isDefault ? (invoice ? 'Default Accounting Allocations for each Item in Invoice' : 'Default Accounting Entries') : 'Additional Accounting Entries (e.g. Taxes / Other charges) to be added in Invoice';
  return (
    <EntryGrid
      title={title}
      heading={heading}
      cols={cols}
      initial={rows.length ? rows : invoice && isDefault ? [gridRow({ value: '100', round: ROUND_LABELS.none }, { round: 'none' })] : rows}
      fresh={fresh}
      width={invoice ? (isDefault ? 720 : 1040) : 760}
      validate={(all) => {
        const rs = all.filter((r) => r.id.ledger || (r.text.ledger ?? '').trim());
        for (const r of rs) {
          if (!r.id.ledger) return 'Ledger Name: choose from the list';
          if (invoice && r.id.round && r.id.round !== 'none' && !parseAmount(r.text.limit ?? '')) return 'Enter the Rounding Limit';
          if (invoice && isDefault) {
            if (parsePercent(r.text.value ?? '') === null) return 'Enter a valid percentage';
            continue;
          }
          if (!r.id.side || !r.id.calc) return 'Choose Dr/Cr and Type of Calculation';
          if ((r.id.calc === 'percent' || r.id.calc === 'subtotal') && parsePercent(r.text.value ?? '') === null) return 'Enter a valid percentage';
          if ((r.id.calc === 'fixed' || r.id.calc === 'qty') && parseAmount(r.text.value ?? '') === null) return 'Enter a valid amount';
          if (r.id.calc === 'round' && (!r.id.round || r.id.round === 'none')) return 'Choose a Rounding Method for As Total Amount Rounding';
        }
        if (invoice && isDefault && rs.length && pctOf(rs) !== 10000) return 'Percentages must total 100%';
        return null;
      }}
      onAccept={(all) =>
        onAccept(
          all.filter((r) => r.id.ledger).map((r) => {
            const calc = (invoice && isDefault ? 'percent' : r.id.calc) as ClassCalc;
            const round = (invoice ? r.id.round || 'none' : 'none') as RoundMethod;
            return {
              section,
              ledger_id: Number(r.id.ledger),
              side: invoice && isDefault ? supplySide : r.id.side === 'Cr' ? ('Cr' as const) : ('Dr' as const),
              calc,
              value: calc === 'percent' || calc === 'subtotal' ? parsePercent(r.text.value ?? '') ?? 0 : calc === 'fixed' || calc === 'qty' ? parseAmount(r.text.value ?? '') ?? 0 : 0,
              remove_if_zero: !isDefault && Number(r.id.rz) === 1,
              rounding: round,
              round_limit: round === 'none' ? 0 : parseAmount(r.text.limit ?? '') ?? 0,
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

  const [jw, setJw] = useState<JobWorkTypeOptions | null>(null);
  useEffect(() => {
    void books.voucherTypes().then((ts) => setType(ts.find((t) => t.id === typeId) ?? null));
    void voucherTypeOptions(books.db, typeId).then(setOpts);
  }, [books, typeId]);
  useEffect(() => {
    if (type && (type.parent === 'Material Out' || type.parent === 'Material In')) void jobWorkTypeOptions(books.db, typeId).then(setJw);
  }, [books, type, typeId]);

  const save = useCallback(async () => {
    if (!opts) return;
    const { type_id: _t, ...patch } = opts;
    void _t;
    try {
      await setVoucherTypeOptions(books.db, typeId, patch);
      if (jw) await saveJobWorkTypeOptions(books.db, typeId, jw);
      bump();
      toast('Voucher type saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  }, [books, bump, nav, opts, toast, typeId, jw]);
  const accept = useCallback(async () => {
    if (await dialogs.confirm('Accept ?', { title: 'Accept', yes: 'Yes', no: 'No', corner: true })) void save();
  }, [dialogs, save]);

  const parent = type?.parent ?? '';
  const vis = (rows: OptRow[]) => (opts ? rows.filter((r) => !r.show || r.show(parent, opts)) : []);
  const general = vis(GENERAL);
  const printing = vis(PRINTING);
  const jwRows = jw
    ? ([
        { key: 'use_for_job_work', label: 'Use for Job Work' },
        ...(jw.use_for_job_work ? [{ key: 'use_for_job_work_in', label: 'Use for Job Work In' }] : []),
        ...(parent === 'Material In' && !jw.use_for_job_work_in ? [{ key: 'allow_consumption', label: 'Allow consumption' }] : []),
      ] as { key: 'use_for_job_work' | 'use_for_job_work_in' | 'allow_consumption'; label: string }[])
    : [];
  const order = [...general.map((r) => r.key as string), ...jwRows.map((r) => `jw_${r.key}`), ...printing.map((r) => r.key as string), 'class'];
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
  const jwField = (r: (typeof jwRows)[number]) => (
    <div key={r.key} className="flex items-center">
      <label className="flex-1 pr-1">{r.label}</label>
      <span className="mr-1">:</span>
      <input
        ref={(el) => {
          refs.current[`jw_${r.key}`] = el;
        }}
        className="tb-input w-36 font-bold"
        readOnly
        value={jw?.[r.key] ? 'Yes' : 'No'}
        onKeyDown={(e) => {
          if (/^[yYnN]$/.test(e.key) || e.key === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            setJw((o) => (o ? { ...o, [r.key]: /^[yY]$/.test(e.key) ? 1 : /^[nN]$/.test(e.key) ? 0 : o[r.key] ? 0 : 1 } : o));
          } else if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            e.stopPropagation();
            go(`jw_${r.key}`, 1);
          } else if (e.key === 'Backspace') {
            e.preventDefault();
            e.stopPropagation();
            go(`jw_${r.key}`, -1);
          }
        }}
      />
    </div>
  );
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
          <div className="mt-2 border-t border-tb-line pt-2">{general.map(field)}{jwRows.map(jwField)}</div>
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
