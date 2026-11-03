import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { voucherForex, saveVoucherForex, type EntryForexInput, isMfgJournal, mfgVoucherTypes, type VoucherClass, voucherAllocations, type AllocationRow, batchAllocations, saveBatchAllocations, clearTracking, trackAgainst, canCurrent, ensureDutyLedger, recordDeduction, saveEntryAllocations, type AllocationInput, type TdsPlan, bankAlloc, bankConfig, ensureBanking, saveBankAlloc, tdsCompany, STOCK_VOUCHER_TYPES, fmtDate, parseDate, weekday, todayIso, type BatchAllocInput, type BillInput, type Group, type Ledger, type VoucherRow, type VoucherType } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { registerUnsaved } from '../unsaved.ts';
import { ManufacturingJournalScreen, ChangeVoucherMode } from './Manufacturing.tsx';
import { VoucherClassPicker, useVoucherClasses } from './VoucherClass.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { BillDialog } from '../ui/BillDialog.tsx';
import { ItemInvoiceBody } from './itemInvoice.tsx';
import { StockBody } from './stockVoucher.tsx';
import { BankAllocationScreen, type BankAllocValues } from './BankingCheques.tsx';
import { CostAllocationDialog } from './CostAllocationDialog.tsx';
import { TdsDetailsScreen } from './Tds.tsx';
import { EWayBillDetailsForm, IrnDetailsForm } from './EInvoice.tsx';
import { AccountingBody, InvoiceBody, type BodyHandle, type InitialData } from './voucherParts.tsx';
import { INPUT_SUPPLY, OUTPUT_SUPPLY, ancestry, isUnder } from '../lib.ts';
import { LedgerForm } from './MasterForms.tsx';

const INVOICE_TYPES = ['Sales', 'Purchase', 'Credit Note', 'Debit Note'];
const facilityOf = (parent: string) => ((STOCK_VOUCHER_TYPES as readonly string[]).includes(parent) ? 'Inventory Vouchers' : parent === 'Payroll' || parent === 'Attendance' ? 'Payroll Masters' : 'Accounting Vouchers');
const VOUCHER_BG: Record<string, string> = {
  Payment: '#fffaf4',
  Receipt: '#f2fafd',
  Contra: '#f9f9f8',
  Journal: '#faf7fe',
  Sales: '#f3ffe9',
  Purchase: '#fff4fc',
  'Credit Note': '#fef4f5',
  'Debit Note': '#fff4fc',
  'Sales Order': '#faf7fe',
  'Purchase Order': '#faf7fe',
  'Delivery Note': '#f3ffe9',
  'Receipt Note': '#fff4fc',
  'Rejection In': '#f3ffe9',
  'Rejection Out': '#fff4fc',
  'Stock Journal': '#faf7fe',
  'Physical Stock': '#faf7fe',
  Payroll: '#fef4f5',
};
const BANK_GROUPS = ['Bank Accounts', 'Bank OD A/c'];
const BANK_VOUCHERS = ['Payment', 'Receipt', 'Contra'];
let lastDate = '';

function toInitial(v: VoucherRow, ledgers: Ledger[], groups: Group[], invoice: boolean, batchMap: Map<number, BatchAllocInput[]>, forexMap: Map<number, EntryForexInput> = new Map()): InitialData {
  if (v.stock?.length) {
    return {
      party_id: v.party_id,
      place_of_supply: v.place_of_supply,
      items: v.stock.map((m) => ({ item_id: m.item_id, godown_id: m.godown_id ?? null, ledgerId: m.ledger_id ?? null, qty: m.qty, rate: m.rate, tracked: m.tracked, batches: batchMap.get(m.id) })),
    };
  }
  if (!invoice) {
    return { rows: v.entries.map((e) => ({ side: e.amount > 0 ? 'Dr' : 'Cr', ledgerId: e.ledger_id, amount: e.amount, bills: e.bills, forex: forexMap.get(e.id) })) };
  }
  const output = v.parent === 'Sales' || v.parent === 'Credit Note';
  const lines = v.entries
    .map((e) => ({ e, l: ledgers.find((x) => x.id === e.ledger_id)! }))
    .filter(({ l }) => isUnder(groups, l, output ? OUTPUT_SUPPLY : INPUT_SUPPLY))
    .map(({ e, l }) => ({ ledgerId: l.id, taxable: Math.abs(e.amount), rate_bp: l.rate_bp }));
  return { party_id: v.party_id, place_of_supply: v.place_of_supply, reverse_charge: !!v.reverse_charge, lines };
}

function looksLikeInvoice(v: VoucherRow, ledgers: Ledger[], groups: Group[]): boolean {
  if (!INVOICE_TYPES.includes(v.parent) || !v.party_id) return false;
  const output = v.parent === 'Sales' || v.parent === 'Credit Note';
  let supply = 0;
  for (const e of v.entries) {
    const l = ledgers.find((x) => x.id === e.ledger_id);
    if (!l) return false;
    if (l.id === v.party_id || l.duty_type === 'GST') continue;
    if (isUnder(groups, l, output ? OUTPUT_SUPPLY : INPUT_SUPPLY)) supply += 1;
    else return false;
  }
  return supply > 0;
}

export function VoucherScreen({ typeName, voucherId, duplicateFrom }: { typeName?: string; voucherId?: number; duplicateFrom?: number }) {
  const { books, company, version, bump, toast } = useStore();
  const [types, setTypes] = useState<VoucherType[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [source, setSource] = useState<VoucherRow | null | undefined>(voucherId || duplicateFrom ? undefined : null);
  const [batchMap, setBatchMap] = useState(() => new Map<number, BatchAllocInput[]>());
  const [forexMap, setForexMap] = useState(() => new Map<number, EntryForexInput>());
  const [mfg, setMfg] = useState<{ voucher: boolean; types: Set<number> } | null>(null);
  useEffect(() => {
    void (async () => {
      const voucher = voucherId ? await isMfgJournal(books.db, voucherId).catch(() => false) : false;
      const types = new Set(await mfgVoucherTypes(books.db).then((t) => t.map((x) => x.id)).catch(() => [] as number[]));
      setMfg({ voucher, types });
    })();
  }, [books, voucherId, version]);

  useEffect(() => {
    void Promise.all([books.voucherTypes(), books.ledgers(), books.groups()]).then(([t, l, g]) => {
      setTypes(t);
      setLedgers(l);
      setGroups(g);
    });
  }, [books, version]);

  useEffect(() => {
    const id = voucherId ?? duplicateFrom;
    if (!id) return;
    void books.voucher(id).then(async (v) => {
      const map = new Map<number, BatchAllocInput[]>();
      if (v && voucherId) for (const m of v.stock) {
        const a = await batchAllocations(books.db, m.id);
        if (a.length) map.set(m.id, a.map((x) => ({ batch: x.batch, mfg_date: x.mfg_date, expiry_date: x.expiry_date, qty: Math.abs(x.qty) })));
      }
      setBatchMap(map);
      if (v) {
        const fx = await voucherForex(books.db, v.id).catch(() => []);
        setForexMap(new Map(fx.map((f) => [f.entry_id, { currency_id: f.currency_id, foreign_amount: f.foreign_amount, rate_e4: f.rate_e4, rate_kind: f.rate_kind }])));
      }
      setSource(v);
    });
  }, [books, voucherId, duplicateFrom]);

  if (!types.length || !company || source === undefined || !mfg) return null;
  const type = types.find((t) => t.name === (source?.type ?? typeName)) ?? types.find((t) => t.name === 'Payment')!;
  if (mfg.voucher && voucherId) return <ManufacturingJournalScreen voucherId={voucherId} />;
  if (!voucherId && !duplicateFrom && mfg.types.has(type.id)) return <ManufacturingJournalScreen typeId={type.id} />;
  return <Editor key={`${type.id}-${voucherId ?? 'new'}`} type={type} ledgers={ledgers} groups={groups} source={source} batchMap={batchMap} forexMap={forexMap} editing={!!voucherId} />;
}

function Editor({ type, ledgers, groups, source, batchMap, forexMap, editing }: { type: VoucherType; ledgers: Ledger[]; groups: Group[]; source: VoucherRow | null; batchMap: Map<number, BatchAllocInput[]>; forexMap: Map<number, EntryForexInput>; editing: boolean }) {
  const { books, company, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const gst = !!company?.gst_enabled && INVOICE_TYPES.includes(type.parent);
  const itemMode = !!company?.inventory_enabled && INVOICE_TYPES.includes(type.parent) && (source ? source.stock.length > 0 : true);
  const startInvoice = gst && (source ? looksLikeInvoice(source, ledgers, groups) : true);
  const [invoice, setInvoice] = useState(startInvoice);
  const [resetKey, setResetKey] = useState(0);
  const initial = useMemo(() => (source ? toInitial(source, ledgers, groups, invoice, batchMap, forexMap) : undefined), [source, ledgers, groups, invoice, batchMap, forexMap]);

  const defaultDate = () => {
    if (source) return source.date;
    const t = todayIso();
    const base = lastDate || (company && t >= company.books_from && t <= company.fy_end ? t : company!.books_from);
    return base;
  };
  const [dateText, setDateText] = useState(() => fmtDate(defaultDate()));
  const [dateIso, setDateIso] = useState(defaultDate());
  const [number, setNumber] = useState(source && editing ? source.number : '');
  const [reference, setReference] = useState(source?.reference ?? '');
  const [narration, setNarration] = useState(source?.narration ?? '');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => registerUnsaved(() => dirtyRef.current || !!body.current?.isDirty()), []);
  const [billReq, setBillReq] = useState<{ ledger: Ledger; amount: number; resolve: (b: BillInput[] | null) => void } | null>(null);
  const [postDated, setPostDated] = useState(false);
  const [flags, setFlags] = useState({ einvoice: false, ewb: false, tds: false });
  const classes = useVoucherClasses(type.id);
  const [vclass, setVclass] = useState<VoucherClass | null>(null);
  const askedClass = useRef(false);
  useEffect(() => {
    if (editing || askedClass.current || !classes.length) return;
    askedClass.current = true;
    nav.push(<VoucherClassPicker typeId={type.id} title="Voucher Class List" onPick={(c) => { setVclass(c); setResetKey((k) => k + 1); }} />);
  }, [classes, editing, nav, type.id]);
  const [costReq, setCostReq] = useState<{ ledger: string; amount: number; initial?: AllocationInput[]; resolve: (l: AllocationInput[] | null) => void } | null>(null);
  const body = useRef<BodyHandle>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const narrRef = useRef<HTMLInputElement>(null);
  const saving = useRef(false);

  useEffect(() => {
    void tdsCompany(books.db).then((c) => setFlags({ einvoice: !!c.einvoice_enabled, ewb: !!c.ewb_enabled, tds: !!c.tds_enabled })).catch(() => undefined);
  }, [books]);
  useEffect(() => {
    if (!editing || !source) return;
    const bank = source.entries.find((e) => BANK_GROUPS.includes(ledgers.find((l) => l.id === e.ledger_id)?.group_name ?? ''));
    if (!bank) return;
    void ensureBanking(books.db).then(() => bankAlloc(books.db, source.id, bank.ledger_id)).then((a) => setPostDated(!!a?.post_dated)).catch(() => undefined);
  }, [books, editing, source, ledgers]);

  const askTds = (partyId: number, amount: number) =>
    new Promise<{ plan: TdsPlan } | null>((resolve) => {
      let done = false;
      nav.push(
        <TdsDetailsScreen
          partyId={partyId}
          amount={amount}
          date={dateIso}
          onDone={(plan) => {
            done = true;
            resolve({ plan });
          }}
        />
      );
      window.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape' && !done) {
          done = true;
          resolve(null);
          window.removeEventListener('keydown', esc);
        }
      });
    });
  const askCost = (ledger: string, amount: number, initial?: AllocationInput[]) => new Promise<AllocationInput[] | null>((resolve) => setCostReq({ ledger, amount, initial, resolve }));

  const askBankAlloc = (ledgerId: number, amount: number, existing: BankAllocValues | null) =>
    new Promise<BankAllocValues | null>((resolve) => {
      let done = false;
      nav.push(
        <BankAllocationScreen
          ledgerId={ledgerId}
          amount={amount}
          date={dateIso}
          postDated={postDated}
          initial={existing ?? undefined}
          onDone={(v) => {
            done = true;
            resolve(v);
          }}
        />
      );
      const watch = setInterval(() => {
        if (done) clearInterval(watch);
      }, 200);
      window.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape' && !done) {
          done = true;
          resolve(null);
          window.removeEventListener('keydown', esc);
        }
      });
    });

  const numberEditable = type.numbering === 'manual' || type.numbering === 'auto_override';

  const loadNumber = useCallback(async () => {
    if (editing) return;
    const n = await books.nextNumber(type.id);
    setNumber(n.number);
  }, [books, editing, type.id]);
  useEffect(() => void loadNumber(), [loadNumber]);

  const askBills = useCallback(
    (ledger: Ledger, amount: number) => new Promise<BillInput[] | null>((resolve) => setBillReq({ ledger, amount, resolve })),
    []
  );

  useEffect(() => {
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ text: string }>).detail;
      nav.push(<LedgerForm presetName={d.text} onSaved={() => bump()} />);
    };
    window.addEventListener('tb:create-ledger', h);
    return () => window.removeEventListener('tb:create-ledger', h);
  }, [nav, bump]);

  const commitDate = (): string | null => {
    const iso = parseDate(dateText, company?.fy_start, dateIso);
    if (!iso) {
      toast('Invalid date', 'err');
      return null;
    }
    if (company && (iso < company.books_from || iso > company.fy_end)) {
      toast(`Date must be between ${fmtDate(company.books_from)} and ${fmtDate(company.fy_end)}`, 'err');
      return null;
    }
    setDateIso(iso);
    setDateText(fmtDate(iso));
    return iso;
  };

  const saveAlloc = async (voucherId: number, bank: { ledger_id: number; values: BankAllocValues }) => {
    try {
      await saveBankAlloc(books.db, { voucher_id: voucherId, ledger_id: bank.ledger_id, ...bank.values, post_dated: postDated });
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const save = async () => {
    if (saving.current) return;
    if (!canCurrent(`${facilityOf(type.parent)}.${editing ? 'alter' : 'create'}`)) return toast('You do not have access to this action', 'err');
    const iso = commitDate();
    if (!iso) return dateRef.current?.focus();
    const built = await body.current?.build();
    if (!built) return;
    saving.current = true;
    try {
      const entries = built.entries;
      let tdsPlan: { plan: TdsPlan; partyId: number } | null = null;
      const priorTds = flags.tds && editing && source ? await books.db.select<{ party_id: number; duty_ledger_id: number; total: number }>('SELECT party_id, duty_ledger_id, total FROM tds_deductions WHERE voucher_id = ?', [source.id]).catch(() => []) : [];
      if (flags.tds && ['Payment', 'Purchase', 'Journal'].includes(type.parent)) {
        for (const e of entries) {
          const l = ledgers.find((x) => x.id === e.ledger_id);
          const payingParty = type.parent === 'Payment' ? e.amount > 0 : e.amount < 0;
          if (l && payingParty && l.tds_deductible) {
            const got = await askTds(l.id, Math.abs(e.amount));
            if (!got) return;
            for (const old of priorTds.filter((p) => p.party_id === l.id)) {
              const di = entries.findIndex((x) => x.ledger_id === old.duty_ledger_id && x.amount === -old.total);
              const back = entries.find((x) => x.amount < 0 && x.ledger_id !== old.duty_ledger_id);
              if (di >= 0 && back) {
                entries.splice(di, 1);
                back.amount -= old.total;
              }
            }
            if (got.plan.tax > 0) {
              const duty = got.plan.duty_ledger_id ?? (await ensureDutyLedger(books, got.plan.nature_id));
              const target = entries.find((x) => x.amount < 0 && x.ledger_id !== duty);
              if (target) {
                target.amount += got.plan.total;
                entries.push({ ledger_id: duty, amount: -got.plan.total });
                tdsPlan = { plan: got.plan, partyId: l.id };
              }
            }
            break;
          }
        }
      }
      const costLines = new Map<number, AllocationInput[]>();
      if (company?.cost_centres_enabled) {
        const prior = new Map<number, AllocationInput[]>();
        if (editing && source) {
          const byEntry = await voucherAllocations(books.db, source.id).catch(() => new Map<number, AllocationRow[]>());
          for (const e of source.entries) {
            const rows = byEntry.get(e.id);
            if (rows?.length && !prior.has(e.ledger_id)) prior.set(e.ledger_id, rows.map((r) => ({ cost_centre_id: r.cost_centre_id, amount: r.amount })));
          }
        }
        for (let i = 0; i < entries.length; i += 1) {
          const l = ledgers.find((x) => x.id === entries[i].ledger_id);
          if (l?.cost_centres) {
            const lines = await askCost(l.name, entries[i].amount, prior.get(l.id));
            if (lines === null) return;
            if (lines.length) costLines.set(i, lines);
          }
        }
      }
      if (company?.bill_wise) {
        for (const e of entries) {
          const l = ledgers.find((x) => x.id === e.ledger_id);
          if (l?.bill_by_bill && !e.bills?.length && l.id === built.party_id) {
            const bills = await askBills(l, e.amount);
            if (!bills) return;
            e.bills = bills;
          }
        }
      }
      let bank: { ledger_id: number; values: BankAllocValues } | null = null;
      if (BANK_VOUCHERS.includes(type.parent)) {
        const be = entries.find((e) => BANK_GROUPS.includes(ledgers.find((l) => l.id === e.ledger_id)?.group_name ?? ''));
        if (be) {
          await ensureBanking(books.db);
          const cfg = await bankConfig(books.db, be.ledger_id);
          if (postDated || cfg.cheque_printing) {
            const prior = editing && source ? await bankAlloc(books.db, source.id, be.ledger_id) : null;
            const existing = prior ? { inst_no: prior.inst_no, inst_date: prior.inst_date, favouring: prior.favouring } : null;
            const values = await askBankAlloc(be.ledger_id, be.amount, existing as BankAllocValues | null);
            if (!values) return;
            bank = { ledger_id: be.ledger_id, values };
          }
        }
      }
      const payload = {
        type_id: type.id,
        number: numberEditable ? number : undefined,
        date: iso,
        reference,
        narration,
        party_id: built.party_id ?? null,
        place_of_supply: built.place_of_supply,
        reverse_charge: built.reverse_charge,
        stock: built.stock,
        entries,
      };
      if (editing && source) {
        const oldIds = source.stock.map((m) => m.id);
        const oldTrack = oldIds.length ? await books.db.select<{ movement_id: number; against_id: number; qty: number }>(`SELECT movement_id, against_id, qty FROM stockx_track WHERE movement_id IN (${oldIds.map(() => '?').join(', ')})`, oldIds) : [];
        for (const id of oldIds) await clearTracking(books.db, id);
        await books.updateVoucher(source.id, payload);
        const fresh = await books.voucher(source.id);
        const links = built.track?.length ? built.track : oldTrack.map((t) => ({ index: oldIds.indexOf(t.movement_id), against: t.against_id, qty: t.qty }));
        for (const t of links) if (fresh?.stock[t.index]) await trackAgainst(books.db, fresh.stock[t.index].id, t.against, t.qty);
        for (const b of built.batches ?? []) if (fresh?.stock[b.index]) await saveBatchAllocations(books.db, fresh.stock[b.index].id, b.allocs);
        if (fresh && built.forex?.length) await saveVoucherForex(books.db, fresh, built.forex.map((f) => ({ entry_index: f.index, forex: f.forex })));
        if (tdsPlan) await recordDeduction(books.db, source.id, tdsPlan.partyId, iso, tdsPlan.plan);
        else if (priorTds.length) await books.db.batch([{ sql: 'DELETE FROM tds_deductions WHERE voucher_id = ?', params: [source.id] }]);
        for (const [idx, lines] of costLines) {
          const row = fresh?.entries[idx];
          if (row) await saveEntryAllocations(books.db, row.id, lines);
        }
        if (bank) await saveAlloc(source.id, bank);
        lastDate = iso;
        bump();
        toast(`${type.name} voucher altered`, 'ok');
        nav.pop();
      } else {
        const v = await books.createVoucher(payload);
        for (const t of built.track ?? []) if (v.stock[t.index]) await trackAgainst(books.db, v.stock[t.index].id, t.against, t.qty);
        for (const b of built.batches ?? []) if (v.stock[b.index]) await saveBatchAllocations(books.db, v.stock[b.index].id, b.allocs);
        if (built.forex?.length) await saveVoucherForex(books.db, v, built.forex.map((f) => ({ entry_index: f.index, forex: f.forex })));
        if (tdsPlan) await recordDeduction(books.db, v.id, tdsPlan.partyId, iso, tdsPlan.plan);
        for (const [idx, lines] of costLines) {
          const row = v.entries[idx];
          if (row) await saveEntryAllocations(books.db, row.id, lines);
        }
        if (bank) await saveAlloc(v.id, bank);
        lastDate = iso;
        bump();
        toast(`${type.name} voucher No. ${v.number} saved`, 'ok');
        setNarration('');
        setReference('');
        setDirty(false);
        body.current?.reset();
        setResetKey((k) => k + 1);
        void loadNumber();
        dateRef.current?.blur();
      }
    } catch (e) {
      toast((e as Error).message, 'err');
    } finally {
      saving.current = false;
    }
  };

  const leave = async () => {
    if (billReq) return;
    if (dirty || body.current?.isDirty()) {
      const yes = await dialogs.confirm('Quit ?', { title: 'Quit', def: false });
      if (!yes) return;
    }
    nav.pop();
  };

  const remove = async () => {
    if (!editing || !source) return;
    if (!canCurrent(`${facilityOf(type.parent)}.delete`)) return toast('You do not have access to this action', 'err');
    if (!(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    await books.deleteVoucher(source.id);
    bump();
    toast('Voucher deleted', 'ok');
    nav.pop();
  };

  const cancelVoucher = async () => {
    if (!editing || !source) return;
    if (!canCurrent(`${facilityOf(type.parent)}.delete`)) return toast('You do not have access to this action', 'err');
    if (!(await dialogs.confirm('Cancel Voucher ?', { title: 'Cancel voucher', def: false }))) return;
    await books.cancelVoucher(source.id);
    bump();
    toast('Voucher cancelled', 'ok');
    nav.pop();
  };

  const duplicate = () => {
    if (!editing || !source) return;
    nav.replace(<VoucherScreen duplicateFrom={source.id} />);
  };

  useScreen({
    title: `${editing ? 'Voucher Alteration' : (STOCK_VOUCHER_TYPES as readonly string[]).includes(type.parent) ? 'Inventory Voucher Creation' : 'Accounting Voucher Creation'}`,
    kind: 'voucher',
    keys: {
      'Ctrl+A': () => void save(),
      Escape: () => void leave(),
      F2: () => {
        dateRef.current?.focus();
        dateRef.current?.select();
      },
      'Alt+N': () => (editing && source && INVOICE_TYPES.includes(type.parent) && flags.einvoice ? nav.push(<IrnDetailsForm voucherId={source.id} />) : false),
      'Alt+W': () => (editing && source && INVOICE_TYPES.includes(type.parent) && flags.ewb ? nav.push(<EWayBillDetailsForm voucherId={source.id} />) : false),
      'Ctrl+T': () => (BANK_VOUCHERS.includes(type.parent) ? setPostDated((p) => !p) : false),
      'Alt+D': () => (editing ? void remove() : false),
      'Alt+X': () => (editing ? void cancelVoucher() : false),
      'Alt+2': () => (editing ? duplicate() : false),
      'Alt+R': () => body.current?.removeLine(),
      'Ctrl+H': () => {
        if (type.parent === 'Stock Journal' && !editing) return void nav.push(<ChangeVoucherMode current="Use for Stock Journal" onPick={(m) => m === 'Use for Manufacturing Journal' && nav.replace(<ManufacturingJournalScreen />)} />);
        if (!gst || editing || itemMode || stockMode) return false;
        if (body.current?.isDirty()) return toast('Clear the entries before changing the view', 'err');
        setInvoice((v) => !v);
        setResetKey((k) => k + 1);
      },
    },
    buttons: [
      { key: 'F2', label: 'Date', run: () => dateRef.current?.focus() },
      ...(type.parent === 'Stock Journal' && !editing ? [{ key: 'Ctrl+H', label: 'Change Mode', run: () => undefined }] : gst && !editing ? [{ key: 'Ctrl+H', label: invoice ? 'As Voucher' : 'Invoice View', run: () => undefined }] : []),
      { key: 'Alt+R', label: 'Remove Line', run: () => body.current?.removeLine() },
      ...(editing
        ? [
            { key: 'Alt+2', label: 'Duplicate Vch', run: duplicate },
            { key: 'Alt+X', label: 'Cancel Vch', run: () => void cancelVoucher() },
            { key: 'Alt+D', label: 'Delete', run: () => void remove() },
          ]
        : []),
      ...(BANK_VOUCHERS.includes(type.parent) ? [{ key: 'Ctrl+T', label: 'Post-Dated', run: () => setPostDated((p) => !p) }] : []),
      ...(editing && source && INVOICE_TYPES.includes(type.parent) && flags.einvoice ? [{ key: 'Alt+N', label: 'e-Invoice Details', run: () => nav.push(<IrnDetailsForm voucherId={source.id} />) }] : []),
      ...(editing && source && INVOICE_TYPES.includes(type.parent) && flags.ewb ? [{ key: 'Alt+W', label: 'e-Way Bill Details', run: () => nav.push(<EWayBillDetailsForm voucherId={source.id} />) }] : []),
      { key: 'Ctrl+A', label: 'Accept', run: () => void save() },
    ],
  });

  const stockMode = (STOCK_VOUCHER_TYPES as readonly string[]).includes(type.parent);
  const Body = stockMode ? StockBody : itemMode ? ItemInvoiceBody : invoice ? InvoiceBody : AccountingBody;
  const chain = ancestry(groups, undefined);
  void chain;

  return (
    <div className="-m-4 flex min-h-[calc(100vh-90px)] flex-col px-2 pb-2" style={{ backgroundColor: VOUCHER_BG[type.parent] ?? '#fffaf4' }}>
      <div className="flex items-start justify-between pt-1">
        <div className="flex items-center gap-2">
          <span className="w-[120px] bg-tb-top py-px text-center font-bold text-white">{type.name}</span>
          <span className="flex items-center gap-1">
            No.
            {numberEditable ? (
              <input className="tb-input w-28 font-bold" value={number} onChange={(e) => setNumber(e.target.value)} />
            ) : (
              <b>{number}</b>
            )}
          </span>
          {vclass && <span className="ml-4 italic">Class : <b className="not-italic">{vclass.name}</b></span>}
          <span className="ml-6 flex items-center gap-1">
            Ref:
            <input className="tb-input w-32" value={reference} onChange={(e) => { setReference(e.target.value); setDirty(true); }} />
          </span>
        </div>
        <div className="text-right">
          <input
            ref={dateRef}
            className="tb-input w-28 text-right font-bold"
            value={dateText}
            onChange={(e) => {
              setDateText(e.target.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                if (commitDate()) body.current?.focusFirst();
              }
            }}
            onBlur={() => {
              const iso = parseDate(dateText, company?.fy_start, dateIso);
              if (iso) setDateText(fmtDate(iso));
            }}
          />
          <div className="pr-1">{weekday(dateIso)}</div>
          {postDated && <div className="pr-1 italic text-[#7a7a7a]">Status : Post-Dated</div>}
        </div>
      </div>

      <Body
        key={`${invoice}-${resetKey}`}
        ref={body}
        type={type}
        ledgers={ledgers}
        groups={groups}
        date={dateIso}
        askBills={askBills}
        onFinish={() => narrRef.current?.focus()}
        onDirty={() => setDirty(true)}
        initial={initial}
        vclass={vclass}
      />

      <div className="mt-3 flex items-center gap-2">
        <label>Narration:</label>
        <input
          ref={narrRef}
          className="tb-input flex-1"
          value={narration}
          onChange={(e) => {
            setNarration(e.target.value);
            setDirty(true);
          }}
          onKeyDown={async (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              if (await dialogs.confirm('Accept ?', { title: 'Accept', yes: 'Yes', no: 'No', corner: true })) void save();
            } else if (e.key === 'Backspace' && narration === '') {
              e.preventDefault();
              body.current?.focusFirst();
            }
          }}
        />
      </div>

      {costReq && (
        <CostAllocationDialog
          ledger={costReq.ledger}
          amount={costReq.amount}
          initial={costReq.initial}
          onDone={(l) => {
            costReq.resolve(l);
            setCostReq(null);
          }}
        />
      )}
      {billReq && (
        <BillDialog
          ledger={billReq.ledger}
          amount={billReq.amount}
          creditor={ancestry(groups, billReq.ledger.group_id).includes('Sundry Creditors')}
          asOf={dateIso}
          voucherDate={dateIso}
          initial={[]}
          onDone={(b) => {
            billReq.resolve(b);
            setBillReq(null);
          }}
        />
      )}
    </div>
  );
}
