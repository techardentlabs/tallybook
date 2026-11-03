import { useEffect, useMemo, useRef, useState } from 'react';
import { STATES, isValidGstin, stateCode, type Group, type Ledger, type VoucherType } from '@tallybook/core';
import { canCurrent, partyPriceLevel, setPartyPriceLevel } from '@tallybook/core';
import { usePriceLevelOptions } from './PriceLists.tsx';
import { VoucherTypeOptionsScreen } from './VoucherClass.tsx';
import { InterestParametersScreen } from './Interest.tsx';
import { TdsDutyLedgerForm, TdsPartyDetailsForm } from './Tds.tsx';
import { BankConfigurationScreen } from './BankingCheques.tsx';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import type { Opt } from '../ui/PickerInput.tsx';
import { showAccessDenied, useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useCurrencies } from './Currency.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';

const BILLWISE_ROOTS = ['Sundry Debtors', 'Sundry Creditors'];
const DEBTOR_CREDITOR = new Set(['Sundry Debtors', 'Sundry Creditors']);
const SUPPLY_ROOTS = ['Sales Accounts', 'Purchase Accounts', 'Direct Incomes', 'Direct Expenses', 'Indirect Incomes', 'Indirect Expenses', 'Fixed Assets'];
const GST_RATES: Opt[] = [0, 0.25, 3, 5, 12, 18, 28].map((r) => ({ id: r * 100, label: `${r}%` }));

function useGroups() {
  const { books, version } = useStore();
  const [groups, setGroups] = useState<Group[]>([]);
  useEffect(() => {
    void books.groups().then(setGroups);
  }, [books, version]);
  return groups;
}

function ancestry(groups: Group[], id: number | null): string[] {
  const names: string[] = [];
  let g = groups.find((x) => x.id === id);
  while (g) {
    names.push(g.name);
    g = g.parent_id ? groups.find((x) => x.id === g!.parent_id) : undefined;
  }
  return names;
}

const extras = (v: Record<string, unknown>) => ({
  net_balance_reporting: v.net_balance_reporting ? 1 : 0,
  used_for_calc: v.used_for_calc ? 1 : 0,
  sub_group_like: v.sub_group_like ? 1 : 0,
  alloc_method: v.used_for_calc ? String(v.alloc_method ?? '') : '',
});

export function GroupForm({ id, onSaved }: { id?: number; onSaved?: (g: Group) => void }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const groups = useGroups();
  const form = useRef<FormHandle>(null);
  const cur = groups.find((g) => g.id === id);
  const opts = useMemo<Opt[]>(() => [{ id: 0, label: 'Primary' }, ...groups.map((g) => ({ id: g.id, label: g.name }))], [groups]);

  const save = async () => {
    if (!canCurrent(`Accounts Masters.${id ? 'alter' : 'create'}`)) return showAccessDenied();
    const v = form.current?.submit();
    if (!v) return;
    try {
      const saved = id
        ? await books.updateGroup(id, { name: v.name, alias: v.alias, ...extras(v) })
        : await books.createGroup({ name: v.name, alias: v.alias, parent_id: v.parent || null, nature: v.nature || undefined, ...extras(v) });
      bump();
      toast(id ? 'Group altered' : 'Group created', 'ok');
      onSaved?.(saved);
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const remove = async () => {
    if (!id || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await books.deleteGroup(id);
      bump();
      toast('Group deleted', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  useScreen({
    title: id ? 'Group Alteration' : 'Group Creation',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), 'Alt+D': id ? () => void remove() : () => false },
    buttons: [
      { key: 'Ctrl+A', label: 'Accept', run: () => void save() },
      ...(id ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : []),
    ],
  });
  if (id && !cur) return null;

  const fields: FieldDef[] = [
    { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name },
    { key: 'alias', label: '(alias)', kind: 'text', initial: cur?.alias },
    ...(id
      ? []
      : ([
          { key: 'parent', label: 'Under', kind: 'picker', title: 'Groups', options: opts, required: true, initial: opts[0] },
          {
            key: 'nature',
            label: 'Nature of group',
            kind: 'picker',
            title: 'Natures',
            options: ['Assets', 'Liabilities', 'Income', 'Expense'].map((n) => ({ id: n, label: n })),
            visible: (v) => !v.parent,
            required: true,
          },
        ] as FieldDef[])),
    { key: 'sub_group_like', label: 'Group behaves like a sub-group', kind: 'toggle', initial: !!cur?.sub_group_like, visible: (v) => !v.parent },
    { key: 'net_balance_reporting', label: 'Nett Debit/Credit Balances for Reporting', kind: 'toggle', initial: !!cur?.net_balance_reporting },
    { key: 'used_for_calc', label: 'Used for calculation (for example: taxes, discounts)', kind: 'toggle', initial: !!cur?.used_for_calc },
    {
      key: 'alloc_method',
      label: 'Method to allocate when used in purchase invoice',
      kind: 'picker',
      title: 'Allocation Methods',
      options: ['Not Applicable', 'Appropriate by Qty', 'Appropriate by Value'].map((n) => ({ id: n, label: n })),
      initial: { id: cur?.alloc_method || 'Not Applicable', label: cur?.alloc_method || 'Not Applicable' },
      visible: (v) => !!v.used_for_calc,
    },
  ];
  return (
    <div className="max-w-2xl border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 text-[15px] font-semibold">{id ? 'Group Alteration' : 'Group Creation'}</h3>
      <Form ref={form} fields={fields} onDone={() => void save()} />
    </div>
  );
}

interface LedgerFormProps {
  id?: number;
  presetName?: string;
  onSaved?: (l: Ledger) => void;
}

export function LedgerForm({ id, presetName, onSaved }: LedgerFormProps) {
  const { books, company, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const groups = useGroups();
  const form = useRef<FormHandle>(null);
  const [cur, setCur] = useState<Ledger | null>(null);
  const levelOpts = usePriceLevelOptions();
  const forexList = useCurrencies();
  const baseSym = company?.currency_symbol ?? '₹';
  const curOpts: Opt[] = [{ id: 0, label: baseSym, sub: company?.currency_name ?? 'INR' }, ...forexList.map((c) => ({ id: c.id, label: c.symbol, sub: c.formal_name }))];
  const [levelId, setLevelId] = useState<number | null>(null);
  useEffect(() => {
    if (id) void partyPriceLevel(books.db, id).then((l) => setLevelId(l?.id ?? null)).catch(() => undefined);
  }, [books, id]);
  const [ready, setReady] = useState(!id);
  useEffect(() => {
    if (!id) return;
    void books.ledger(id).then((l) => {
      setCur(l);
      setReady(true);
    });
  }, [books, id]);

  const groupOpts = useMemo<Opt[]>(() => groups.map((g) => ({ id: g.id, label: g.name })), [groups]);
  const stateOpts = useMemo<Opt[]>(() => STATES.map((s) => ({ id: s.name, label: s.name, sub: s.code })), []);
  const names = (gid: number | null) => ancestry(groups, gid);
  const hasRoot = (gid: number | null, roots: string[]) => names(gid).some((n) => roots.includes(n));

  const save = async () => {
    if (!canCurrent(`Accounts Masters.${id ? 'alter' : 'create'}`)) return showAccessDenied();
    const v = form.current?.submit();
    if (!v) return;
    try {
      const opening = (v.opening_dc === 'Cr' ? -1 : 1) * (v.opening || 0);
      const payload = {
        name: v.name,
        alias: v.alias,
        group_id: v.group,
        opening,
        bill_by_bill: v.bill_by_bill ? 1 : 0,
        credit_days: v.credit_days ? Number(String(v.credit_days).replace(/\D/g, '')) : 0,
        mailing_name: v.mailing_name,
        address: v.address,
        state: v.state ?? '',
        pincode: v.pincode,
        phone: v.phone,
        email: v.email,
        contact: v.contact,
        pan: v.pan,
        reg_type: v.reg_type ?? '',
        gstin: v.gstin,
        bank_holder: v.bank_holder,
        bank_name: v.bank_name,
        bank_account: v.bank_account,
        bank_ifsc: v.bank_ifsc,
        rate_bp: v.rate_bp ?? 0,
        hsn_sac: v.hsn_sac,
        taxability: v.taxability ?? '',
        duty_type: v.duty_type ? 'GST' : '',
        tax_head: v.tax_head ?? '',
        country: v.country || 'India',
        mobile: v.mobile, fax: v.fax, cc_email: v.cc_email, website: v.website,
        bank_branch: v.bank_branch, bank_swift: v.bank_swift, tan: v.tan,
        supply_type: v.supply_type ?? '', ledger_type: v.ledger_type ?? '', rounding_method: v.rounding_method ?? '',
        appropriate_to: v.appropriate_to ?? '', calc_method: v.calc_method ?? '', transporter_id: v.transporter_id,
        notes: v.notes, price_level: v.price_level, nature_of_transaction: v.nature_of_transaction ?? '',
        inventory_affected: v.inventory_affected ? 1 : 0, check_credit_days: v.check_credit_days ? 1 : 0, credit_limit: v.credit_limit || 0,
        cost_centres: v.cost_centres ? 1 : 0, interest_active: v.interest_active ? 1 : 0, tds_deductible: v.tds_deductible ? 1 : 0,
        tcs_applicable: v.tcs_applicable ? 1 : 0, is_ecommerce: v.is_ecommerce ? 1 : 0, rounding_limit: v.rounding_limit || 0,
        auto_reconcile: v.auto_reconcile ? 1 : 0, currency_id: Number(v.currency_id) || 0,
      };
      const saved = id ? await books.updateLedger(id, payload) : await books.createLedger(payload);
      if (invOn && company?.price_levels_enabled && levelOpts.length > 1 && v.price_level_id !== undefined) await setPartyPriceLevel(books.db, saved.id, Number(v.price_level_id) || null);
      bump();
      toast(id ? 'Ledger altered' : 'Ledger created', 'ok');
      onSaved?.(saved);
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const remove = async () => {
    if (!id || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await books.deleteLedger(id);
      bump();
      toast('Ledger deleted', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  useScreen({
    title: id ? 'Ledger Alteration' : 'Ledger Creation',
    noPeriod: true,
    keys: {
      'Ctrl+A': () => void save(),
      'Alt+D': id ? () => void remove() : () => false,
      F6: () => (id && cur?.interest_active ? nav.push(<InterestParametersScreen ledgerId={id} />) : false),
      F7: () => (id && cur?.tds_deductible ? nav.push(<TdsPartyDetailsForm ledgerId={id} />) : false),
      F8: () => (id && cur?.duty_type && /TDS|TCS/i.test(cur.duty_type) ? nav.push(<TdsDutyLedgerForm ledgerId={id} />) : false),
      F9: () => (id && ['Bank Accounts', 'Bank OD A/c'].includes(cur?.group_name ?? '') ? nav.push(<BankConfigurationScreen ledgerId={id} />) : false),
    },
    buttons: [
      { key: 'Ctrl+A', label: 'Accept', run: () => void save() },
      ...(id ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : []),
      ...(id && cur?.interest_active ? [{ key: 'F6', label: 'Interest Parameters', run: () => nav.push(<InterestParametersScreen ledgerId={id} />) }] : []),
      ...(id && cur?.tds_deductible ? [{ key: 'F7', label: 'TDS Statutory Details', run: () => nav.push(<TdsPartyDetailsForm ledgerId={id} />) }] : []),
      ...(id && cur?.duty_type && /TDS|TCS/i.test(cur.duty_type) ? [{ key: 'F8', label: 'TDS Duty Ledger', run: () => nav.push(<TdsDutyLedgerForm ledgerId={id} />) }] : []),
      ...(id && ['Bank Accounts', 'Bank OD A/c'].includes(cur?.group_name ?? '') ? [{ key: 'F9', label: 'Bank Configuration', run: () => nav.push(<BankConfigurationScreen ledgerId={id} />) }] : []),
    ],
  });
  if (!ready || !groups.length) return null;

  const gst = !!company?.gst_enabled;
  const billOn = !!company?.bill_wise;
  const isParty = (v: Record<string, unknown>) => hasRoot(v.group as number, BILLWISE_ROOTS);
  const isBank = (v: Record<string, unknown>) => names(v.group as number).includes('Bank Accounts');
  const isDuty = (v: Record<string, unknown>) => names(v.group as number).includes('Duties & Taxes');
  const isSupply = (v: Record<string, unknown>) => hasRoot(v.group as number, SUPPLY_ROOTS);
  const PL_ROOTS = ['Purchase Accounts', 'Sales Accounts', 'Direct Expenses', 'Direct Incomes', 'Indirect Expenses', 'Indirect Incomes'];
  const isPL = (v: Record<string, unknown>) => hasRoot(v.group as number, PL_ROOTS);
  const isIndirect = (v: Record<string, unknown>) => hasRoot(v.group as number, ['Indirect Expenses', 'Indirect Incomes']);
  const isSales = (v: Record<string, unknown>) => hasRoot(v.group as number, ['Sales Accounts']);
  const invOn = !!company?.inventory_enabled;
  const pick = (title: string, key: string, list: string[], cur: string | undefined, extra: Partial<FieldDef> = {}, label?: string): FieldDef => ({
    key, label: label ?? title, kind: 'picker', title, options: list.map((n) => ({ id: n, label: n })), initial: cur ? { id: cur, label: cur } : undefined, ...extra,
  });
  const yn = (key: string, label: string, val: number | undefined, visible: FieldDef['visible']): FieldDef => ({ key, label, kind: 'toggle', initial: !!val, visible });

  const initialGroup = cur ? groupOpts.find((o) => o.id === cur.group_id) : undefined;
  const fields: FieldDef[] = [
    { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name ?? presetName },
    { key: 'alias', label: '(alias)', kind: 'text', initial: cur?.alias },
    { key: 'group', label: 'Under', kind: 'picker', title: 'Groups', options: groupOpts, required: true, initial: initialGroup },
    yn('inventory_affected', 'Inventory values are affected', cur?.inventory_affected, (v) => invOn && isPL(v)),
    yn('cost_centres', 'Cost centres are applicable', cur?.cost_centres, (v) => isPL(v)),
    pick('Ledger Types', 'ledger_type', ['Not Applicable', 'Discount', 'Invoice Rounding'], cur?.ledger_type || 'Not Applicable', { visible: (v) => isIndirect(v) }, 'Type of ledger'),
    pick('Rounding Methods', 'rounding_method', ['Normal Rounding', 'Upward Rounding', 'Downward Rounding'], cur?.rounding_method || 'Normal Rounding', { visible: (v) => isIndirect(v) && v.ledger_type === 'Invoice Rounding' }, 'Rounding method'),
    { key: 'rounding_limit', label: 'Rounding limit', kind: 'amount', initial: cur?.rounding_limit || undefined, visible: (v) => isIndirect(v) && v.ledger_type === 'Invoice Rounding' },
    pick('Appropriate To', 'appropriate_to', ['Goods', 'Services'], cur?.appropriate_to || 'Goods', { visible: (v) => invOn && isIndirect(v) && !!v.inventory_affected }, 'Appropriate to'),
    pick('Calculation Methods', 'calc_method', ['Based on Value', 'Based on Quantity', 'As Total Amount', 'As Total Item Quantity'], cur?.calc_method || 'Based on Value', { visible: (v) => invOn && isIndirect(v) && !!v.inventory_affected }, 'Method of calculation'),
    { key: 'currency_id', label: 'Currency of Ledger', kind: 'picker', title: 'Currencies', options: curOpts, initial: curOpts.find((o) => o.id === (cur?.currency_id ?? 0)) ?? curOpts[0], visible: () => forexList.length > 0 },
    {
      key: 'bill_by_bill',
      label: 'Maintain balances bill-by-bill',
      kind: 'toggle',
      initial: !!cur?.bill_by_bill,
      visible: (v) => billOn && isParty(v),
    },
    { key: 'credit_days', label: 'Default credit period', kind: 'text', initial: cur?.credit_days ? `${cur.credit_days} Days` : '', visible: (v) => billOn && isParty(v) && !!v.bill_by_bill },
    yn('check_credit_days', 'Check for credit days during voucher entry', cur?.check_credit_days, (v) => billOn && isParty(v) && !!v.bill_by_bill),
    { key: 'credit_limit', label: 'Credit limit', kind: 'amount', initial: cur?.credit_limit || undefined, visible: (v) => isParty(v) },
    yn('interest_active', 'Activate interest calculation', cur?.interest_active, (v) => isParty(v)),
    yn('tds_deductible', 'Is TDS deductible', cur?.tds_deductible, (v) => isParty(v)),
    yn('tcs_applicable', 'Is TCS applicable', cur?.tcs_applicable, (v) => isParty(v)),
    { key: 'mailing_name', label: 'Name (mailing)', kind: 'text', initial: cur?.mailing_name, heading: 'Mailing details', visible: (v) => isParty(v) || isBank(v) },
    { key: 'address', label: 'Address', kind: 'text', initial: cur?.address, visible: (v) => isParty(v) },
    { key: 'country', label: 'Country', kind: 'text', initial: cur?.country || 'India', visible: (v) => isParty(v) },
    { key: 'state', label: 'State', kind: 'picker', title: 'States', options: stateOpts, initial: cur?.state ? { id: cur.state, label: cur.state } : undefined, visible: (v) => isParty(v) },
    { key: 'pincode', label: 'Pincode', kind: 'text', initial: cur?.pincode, maxLength: 6, visible: (v) => isParty(v) },
    { key: 'phone', label: 'Telephone no.', kind: 'text', initial: cur?.phone, visible: (v) => isParty(v) },
    { key: 'email', label: 'E-mail', kind: 'text', initial: cur?.email, visible: (v) => isParty(v) },
    { key: 'contact', label: 'Contact person', kind: 'text', initial: cur?.contact, visible: (v) => isParty(v) },
    { key: 'mobile', label: 'Mobile no.', kind: 'text', initial: cur?.mobile, visible: (v) => isParty(v) },
    { key: 'fax', label: 'Fax no.', kind: 'text', initial: cur?.fax, visible: (v) => isParty(v) },
    { key: 'cc_email', label: 'E-mail (CC)', kind: 'text', initial: cur?.cc_email, visible: (v) => isParty(v) },
    { key: 'website', label: 'Website', kind: 'text', initial: cur?.website, visible: (v) => isParty(v) },
    { key: 'price_level_id', label: 'Price level applicable', kind: 'picker', title: 'Price Levels', options: levelOpts, initial: levelOpts.find((o) => o.id === (levelId ?? 0)) ?? levelOpts[0], visible: (v) => invOn && !!company?.price_levels_enabled && isParty(v) && levelOpts.length > 1 },
    { key: 'bank_holder', label: 'A/c holder name', kind: 'text', initial: cur?.bank_holder, heading: 'Bank details', visible: (v) => isBank(v) || isParty(v) },
    { key: 'bank_name', label: 'Bank name', kind: 'text', initial: cur?.bank_name, visible: (v) => isBank(v) || isParty(v) },
    { key: 'bank_account', label: 'A/c no.', kind: 'text', initial: cur?.bank_account, visible: (v) => isBank(v) || isParty(v) },
    { key: 'bank_ifsc', label: 'IFSC code', kind: 'upper', initial: cur?.bank_ifsc, maxLength: 11, visible: (v) => isBank(v) || isParty(v) },
    { key: 'bank_branch', label: 'Branch', kind: 'text', initial: cur?.bank_branch, visible: (v) => isBank(v) || isParty(v) },
    { key: 'bank_swift', label: 'SWIFT code', kind: 'upper', initial: cur?.bank_swift, maxLength: 11, visible: (v) => isBank(v) || isParty(v) },
    yn('auto_reconcile', 'Enable auto reconciliation', cur?.auto_reconcile, (v) => isBank(v)),
    { key: 'pan', label: 'PAN/IT No.', kind: 'upper', initial: cur?.pan, maxLength: 10, heading: 'Tax registration details', visible: (v) => isParty(v) },
    { key: 'tan', label: 'TAN', kind: 'upper', initial: cur?.tan, maxLength: 10, visible: (v) => isParty(v) },
    {
      key: 'reg_type',
      label: 'Registration type',
      kind: 'picker',
      title: 'Registration Types',
      options: ['Regular', 'Composition', 'Unregistered/Consumer', 'Regular - SEZ', 'Regular - Deemed Export', 'Regular - EOU', 'Unknown'].map((n) => ({ id: n, label: n })),
      initial: cur?.reg_type ? { id: cur.reg_type, label: cur.reg_type } : undefined,
      visible: (v) => gst && isParty(v),
    },
    {
      key: 'gstin',
      label: 'GSTIN/UIN',
      kind: 'upper',
      initial: cur?.gstin,
      maxLength: 15,
      visible: (v) => gst && isParty(v) && !String(v.reg_type ?? '').startsWith('Unregistered') && v.reg_type !== 'Consumer',
      validate: (v) => (v.gstin && !isValidGstin(v.gstin) ? 'GSTIN is not valid' : v.gstin && v.state && stateCode(v.state) && v.gstin.slice(0, 2) !== stateCode(v.state) ? 'GSTIN state code does not match the State' : null),
    },
    yn('is_ecommerce', 'Is e-commerce operator', cur?.is_ecommerce, (v) => gst && isParty(v)),
    { key: 'transporter_id', label: 'Transporter ID', kind: 'text', initial: cur?.transporter_id, visible: (v) => gst && isParty(v) },
    { key: 'duty_type', label: 'Type of duty/tax is GST', kind: 'toggle', initial: cur?.duty_type === 'GST', heading: 'Statutory details', visible: (v) => gst && isDuty(v) },
    {
      key: 'tax_head',
      label: 'Tax type',
      kind: 'picker',
      title: 'Tax Types',
      options: ['Central Tax', 'State Tax', 'Integrated Tax', 'Cess'].map((n) => ({ id: n, label: n })),
      initial: cur?.tax_head ? { id: cur.tax_head, label: cur.tax_head } : undefined,
      required: true,
      visible: (v) => gst && isDuty(v) && !!v.duty_type,
    },
    {
      key: 'rate_bp',
      label: 'Percentage of calculation',
      kind: 'picker',
      title: 'GST Rates',
      options: GST_RATES,
      initial: cur && cur.rate_bp !== undefined && isDutyOrSupply(cur.group_name) ? GST_RATES.find((o) => o.id === cur.rate_bp) ?? { id: cur.rate_bp, label: `${cur.rate_bp / 100}%` } : undefined,
      visible: (v) => gst && ((isDuty(v) && !!v.duty_type) || isSupply(v)),
    },
    pick('Supply Types', 'supply_type', ['Goods', 'Services'], cur?.supply_type || 'Goods', { visible: (v) => gst && isSupply(v) }, 'Nature of supply'),
    { key: 'hsn_sac', label: 'HSN/SAC', kind: 'text', initial: cur?.hsn_sac, maxLength: 8, visible: (v) => gst && isSupply(v) },
    {
      key: 'taxability',
      label: 'Taxability',
      kind: 'picker',
      title: 'Taxability',
      options: ['Taxable', 'Exempt', 'Nil Rated', 'Zero Rated'].map((n) => ({ id: n, label: n })),
      initial: cur?.taxability ? { id: cur.taxability, label: cur.taxability } : undefined,
      visible: (v) => gst && isSupply(v),
    },
    pick('Nature of Transactions', 'nature_of_transaction', ['Sales Taxable', 'Interstate Sales Taxable', 'Sales Exempt', 'Sales Nil Rated', 'Export Sales Taxable', 'Purchase Taxable', 'Interstate Purchase Taxable', 'Purchase Exempt', 'Purchase Nil Rated', 'Import Purchase Taxable'], cur?.nature_of_transaction, { visible: (v) => gst && isSupply(v) }, 'Nature of transaction'),
    { key: 'notes', label: 'Notes', kind: 'text', initial: cur?.notes, heading: 'Other' },
    { key: 'opening', label: 'Opening Balance', kind: 'amount', initial: cur ? Math.abs(cur.opening) : 0, heading: 'Opening' },
    {
      key: 'opening_dc',
      label: 'Dr/Cr',
      kind: 'picker',
      title: 'Dr/Cr',
      options: [{ id: 'Dr', label: 'Dr' }, { id: 'Cr', label: 'Cr' }],
      initial: { id: cur && cur.opening < 0 ? 'Cr' : 'Dr', label: cur && cur.opening < 0 ? 'Cr' : 'Dr' },
      visible: (v) => !!v.opening,
    },
  ];
  void DEBTOR_CREDITOR;

  return (
    <div className="max-w-3xl p-2">
      <h3 className="mb-3 text-[15px] font-semibold">{id ? 'Ledger Alteration' : 'Ledger Creation'}</h3>
      <Form ref={form} fields={fields} onDone={() => void save()} />
      <p className="mt-4 text-xs text-tb-muted">Opening bill-wise breakup is entered through opening vouchers or imported from Tally XML.</p>
    </div>
  );
}

function isDutyOrSupply(groupName: string): boolean {
  return groupName === 'Duties & Taxes' || SUPPLY_ROOTS.includes(groupName);
}

export function VoucherTypeForm({ id, onSaved }: { id?: number; onSaved?: (t: VoucherType) => void }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const [types, setTypes] = useState<VoucherType[]>([]);
  useEffect(() => {
    void books.voucherTypes().then(setTypes);
  }, [books]);
  const cur = types.find((t) => t.id === id);

  const save = async () => {
    if (!canCurrent(`Accounts Masters.${id ? 'alter' : 'create'}`)) return showAccessDenied();
    const v = form.current?.submit();
    if (!v) return;
    try {
      const body = { abbrev: v.abbrev, numbering: v.numbering, prefix: v.prefix, suffix: v.suffix, prevent_duplicates: v.prevent ? 1 : 0 };
      const saved = id ? await books.updateVoucherType(id, body) : await books.createVoucherType({ name: v.name, parent: v.parent, ...body });
      bump();
      toast(id ? 'Voucher type altered' : 'Voucher type created', 'ok');
      onSaved?.(saved);
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  useScreen({
    title: id ? 'Voucher Type Alteration' : 'Voucher Type Creation',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), F6: () => (id ? nav.push(<VoucherTypeOptionsScreen typeId={id} />) : false) },
    buttons: [
      { key: 'Ctrl+A', label: 'Accept', run: () => void save() },
      ...(id ? [{ key: 'F6', label: 'Options and Classes', run: () => nav.push(<VoucherTypeOptionsScreen typeId={id} />) }] : []),
    ],
  });
  if (!types.length || (id && !cur)) return null;

  const numberingOpts: Opt[] = [
    { id: 'auto', label: 'Automatic' },
    { id: 'auto_override', label: 'Automatic (Manual Override)' },
    { id: 'manual', label: 'Manual' },
    { id: 'none', label: 'None' },
  ];
  const parents = types.filter((t) => t.is_system).map((t) => ({ id: t.name, label: t.name }));
  const fields: FieldDef[] = [
    { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name },
    { key: 'parent', label: 'Type of voucher', kind: 'picker', title: 'Voucher Types', options: parents, required: true, initial: cur ? { id: cur.parent, label: cur.parent } : undefined },
    { key: 'abbrev', label: 'Abbreviation', kind: 'text', initial: cur?.abbrev },
    { key: 'numbering', label: 'Method of voucher numbering', kind: 'picker', title: 'Numbering Methods', options: numberingOpts, required: true, initial: numberingOpts.find((o) => o.id === (cur?.numbering ?? 'auto')) },
    { key: 'prefix', label: 'Prefix', kind: 'text', initial: cur?.prefix, visible: (v) => v.numbering === 'auto' || v.numbering === 'auto_override' },
    { key: 'suffix', label: 'Suffix', kind: 'text', initial: cur?.suffix, visible: (v) => v.numbering === 'auto' || v.numbering === 'auto_override' },
    { key: 'prevent', label: 'Prevent duplicates (manual numbering)', kind: 'toggle', initial: cur ? !!cur.prevent_duplicates : true },
  ];
  return (
    <div className="max-w-2xl border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 text-[15px] font-semibold">{id ? 'Voucher Type Alteration' : 'Voucher Type Creation'}</h3>
      <Form ref={form} fields={id ? fields.filter((f) => f.key !== 'name' && f.key !== 'parent') : fields} onDone={() => void save()} />
    </div>
  );
}
