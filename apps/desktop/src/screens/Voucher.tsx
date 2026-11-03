import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canCurrent, ensureDutyLedger, recordDeduction, saveEntryAllocations, type AllocationInput, type TdsPlan, bankAlloc, bankConfig, ensureBanking, saveBankAlloc, tdsCompany, STOCK_VOUCHER_TYPES, fmtDate, parseDate, weekday, todayIso, type BillInput, type Group, type Ledger, type VoucherRow, type VoucherType } from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
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

function toInitial(v: VoucherRow, ledgers: Ledger[], groups: Group[], invoice: boolean): InitialData {
  if (v.stock?.length) {
    return {
      party_id: v.party_id,
      place_of_supply: v.place_of_supply,
      items: v.stock.map((m) => ({ item_id: m.item_id, godown_id: m.godown_id ?? null, ledgerId: m.ledger_id ?? null, qty: m.qty, rate: m.rate })),
    };
  }
  if (!invoice) {
    return { rows: v.entries.map((e) => ({ side: e.amount > 0 ? 'Dr' : 'Cr', ledgerId: e.ledger_id, amount: e.amount, bills: e.bills })) };
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
    void books.voucher(id).then(setSource);
  }, [books, voucherId, duplicateFrom]);

  if (!types.length || !company || source === undefined) return null;
  const type = types.find((t) => t.name === (source?.type ?? typeName)) ?? types.find((t) => t.name === 'Payment')!;
  return <Editor key={`${type.id}-${voucherId ?? 'new'}`} type={type} ledgers={ledgers} groups={groups} source={source} editing={!!voucherId} />;
}

function Editor({ type, ledgers, groups, source, editing }: { type: VoucherType; ledgers: Ledger[]; groups: Group[]; source: VoucherRow | null; editing: boolean }) {
  const { books, company, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const gst = !!company?.gst_enabled && INVOICE_TYPES.includes(type.parent);
  const itemMode = !!company?.inventory_enabled && INVOICE_TYPES.includes(type.parent) && (source ? source.stock.length > 0 : true);
  const startInvoice = gst && (source ? looksLikeInvoice(source, ledgers, groups) : true);
  const [invoice, setInvoice] = useState(startInvoice);
  const [resetKey, setResetKey] = useState(0);
  const initial = useMemo(() => (source ? toInitial(source, ledgers, groups, invoice) : undefined), [source, ledgers, groups, invoice]);

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
  const [billReq, setBillReq] = useState<{ ledger: Ledger; amount: number; resolve: (b: BillInput[] | null) => void } | null>(null);
  const [postDated, setPostDated] = useState(false);
  const [flags, setFlags] = useState({ einvoice: false, ewb: false, tds: false });
  const [costReq, setCostReq] = useState<{ ledger: string; amount: number; resolve: (l: AllocationInput[] | null) => void } | null>(null);
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
  const askCost = (ledger: string, amount: number) => new Promise<AllocationInput[] | null>((resolve) => setCostReq({ ledger, amount, resolve }));

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
      if (flags.tds && !editing && ['Payment', 'Purchase', 'Journal'].includes(type.parent)) {
        for (const e of entries) {
          const l = ledgers.find((x) => x.id === e.ledger_id);
          const payingParty = type.parent === 'Payment' ? e.amount > 0 : e.amount < 0;
          if (l && payingParty && l.tds_deductible) {
            const got = await askTds(l.id, Math.abs(e.amount));
            if (!got) return;
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
      if (company?.cost_centres_enabled && !editing) {
        for (let i = 0; i < entries.length; i += 1) {
          const l = ledgers.find((x) => x.id === entries[i].ledger_id);
          if (l?.cost_centres) {
            const lines = await askCost(l.name, entries[i].amount);
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
        await books.updateVoucher(source.id, payload);
        if (bank) await saveAlloc(source.id, bank);
        lastDate = iso;
        bump();
        toast(`${type.name} voucher altered`, 'ok');
        nav.pop();
      } else {
        const v = await books.createVoucher(payload);
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
    title: `${editing ? 'Voucher Alteration' : 'Accounting Voucher Creation'}`,
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
        if (!gst || editing || itemMode || stockMode) return false;
        if (body.current?.isDirty()) return toast('Clear the entries before changing the view', 'err');
        setInvoice((v) => !v);
        setResetKey((k) => k + 1);
      },
    },
    buttons: [
      { key: 'F2', label: 'Date', run: () => dateRef.current?.focus() },
      ...(gst && !editing ? [{ key: 'Ctrl+H', label: invoice ? 'As Voucher' : 'Invoice View', run: () => undefined }] : []),
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
