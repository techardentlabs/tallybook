import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEDUCTEE_TYPES,
  DEDUCTOR_CATEGORIES,
  IT_ACT_2025_FROM,
  deductorCategory,
  etdsForm,
  etdsStatement,
  interestIfPaidOn,
  quarterOf,
  saveStatementFiling,
  statementFilings,
  tdsInterestAndFee,
  type EtdsStatement,
  type QuarterLiability,
  type TdsInterestRow,
  actName,
  deleteNature,
  deleteNatureVersion,
  natureVersions,
  naturesOn,
  saveNatureVersion,
  ensureStatutory,
  fmtAmount,
  fmtDate,
  form26Q,
  natures,
  payTds,
  planTds,
  reconcileChallan,
  saveNature,
  saveTdsCompany,
  saveTdsParty,
  setDutyLedger,
  tdsChallans,
  tdsCompany,
  tdsOutstandingByNature,
  tdsOutstandingByParty,
  tdsOutstandings,
  tdsParty,
  type ChallanRow,
  type Nature,
  type TdsOutstanding,
  type TaxKind,
  type TdsPlan,
} from '@tallybook/core';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import type { Opt } from '../ui/PickerInput.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { SelectList } from './SelectList.tsx';
import { Frame, th, rowCls, useLoad, usePeriodKey, useSel } from './Reports.tsx';
import { useFilter, useReportOptions } from './reportConfig.tsx';
import { VoucherScreen } from './Voucher.tsx';
import { saveTextFile } from '../files.ts';
import { BANK_CASH } from '../lib.ts';

export function useStatutoryReady(): boolean {
  const { books } = useStore();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void ensureStatutory(books.db).then(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [books]);
  return ready;
}

const pct = (bp: number) => (bp ? String(bp / 100) : '');
const toBp = (s: unknown) => Math.round((parseFloat(String(s ?? '').replace('%', '').trim()) || 0) * 100);
const num = 'px-2 text-right tabular-nums';
const tot = 'border-y-[3px] border-double border-tb-ink px-2 text-right tabular-nums';
const grand = 'border-y-[3px] border-double border-tb-ink px-2';

function csvEscape(s: string) {
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function FormScreen({ title, fields, onSave, onDelete, width = 'max-w-xl', labelWidth }: {
  title: string;
  fields: FieldDef[];
  onSave: (v: Record<string, any>) => Promise<string | void>;
  onDelete?: () => Promise<void>;
  width?: string;
  labelWidth?: number;
}) {
  const { bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const form = useRef<FormHandle>(null);
  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    try {
      const msg = await onSave(v);
      bump();
      toast(msg || 'Saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const remove = async () => {
    if (!onDelete || !(await dialogs.confirm('Delete ?', { title: 'Delete', def: false }))) return;
    try {
      await onDelete();
      bump();
      toast('Deleted', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title,
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), 'Alt+D': onDelete ? () => void remove() : () => false },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }, ...(onDelete ? [{ key: 'Alt+D', label: 'Delete', run: () => void remove() }] : [])],
  });
  return (
    <div className={width}>
      <Form ref={form} fields={fields} labelWidth={labelWidth} onDone={() => void save()} />
    </div>
  );
}

const CATEGORY_OPTS: Opt[] = DEDUCTOR_CATEGORIES.map((c) => ({ id: c.code, label: c.label }));
const GOVT = ['A', 'S', 'D', 'E', 'G', 'H', 'L', 'N'];

export function TdsDeductorForm() {
  const { books } = useStore();
  const ready = useStatutoryReady();
  const co = useLoad(() => (ready ? tdsCompany(books.db) : Promise.resolve(null)), [ready]);
  if (!co) return null;
  const govt = (v: Record<string, any>) => GOVT.includes(String(v.category ?? ''));
  return (
    <FormScreen
      title="Company TDS Deductor Details"
      labelWidth={340}
      fields={[
        { key: 'tan', label: 'Tax deduction and collection Account Number (TAN)', kind: 'upper', initial: co.tan, maxLength: 10 },
        { key: 'tan_circle', label: 'TAN registration number', kind: 'upper', initial: co.tan_circle },
        { key: 'deductor_pan', label: 'PAN of deductor (if different from company PAN)', kind: 'upper', initial: co.deductor_pan, maxLength: 10 },
        { key: 'category', label: 'Deductor type', kind: 'picker', title: 'Deductor Types', options: CATEGORY_OPTS, initial: CATEGORY_OPTS.find((o) => o.id === deductorCategory(co.deductor_type)) },
        { key: 'deductor_branch', label: 'Deductor branch/division', kind: 'text', initial: co.deductor_branch },
        { key: 'gov_ministry', label: 'Ministry name (code)', kind: 'text', initial: co.gov_ministry, visible: govt },
        { key: 'gov_state', label: 'State name (code)', kind: 'text', initial: co.gov_state, visible: govt },
        { key: 'pao_code', label: 'PAO code', kind: 'text', initial: co.pao_code, visible: govt },
        { key: 'ddo_code', label: 'DDO code', kind: 'text', initial: co.ddo_code, visible: govt },
        { key: 'ain', label: 'Account office identification number (AIN)', kind: 'text', initial: co.ain, visible: govt },
        { key: 'person_name', label: 'Name of person responsible', kind: 'text', initial: co.person_name, heading: 'Person Responsible Details' },
        { key: 'person_father', label: 'Son/daughter of', kind: 'text', initial: co.person_father },
        { key: 'person_designation', label: 'Designation', kind: 'text', initial: co.person_designation },
        { key: 'person_pan', label: 'PAN', kind: 'upper', initial: co.person_pan, maxLength: 10 },
        { key: 'person_address', label: 'Address (blank to use company address)', kind: 'text', initial: co.person_address },
        { key: 'person_state', label: 'State', kind: 'text', initial: co.person_state },
        { key: 'person_pincode', label: 'Pincode', kind: 'text', initial: co.person_pincode, maxLength: 6 },
        { key: 'person_mobile', label: 'Mobile number', kind: 'text', initial: co.person_mobile, maxLength: 10 },
        { key: 'person_email', label: 'E-mail', kind: 'text', initial: co.person_email },
        { key: 'allow_rate_without_pan', label: 'Ignore IT exemption limit for TDS deduction', kind: 'toggle', initial: !!co.allow_rate_without_pan, heading: 'Rate & Exemption Details' },
      ]}
      onSave={async (v) => {
        const txt = (k: string) => String(v[k] ?? '');
        await saveTdsCompany(books.db, {
          tan: v.tan, tan_circle: v.tan_circle, deductor_pan: txt('deductor_pan'), deductor_type: CATEGORY_OPTS.find((o) => o.id === v.category)?.label ?? co.deductor_type,
          deductor_branch: v.deductor_branch, gov_ministry: txt('gov_ministry'), gov_state: txt('gov_state'), pao_code: txt('pao_code'), ddo_code: txt('ddo_code'), ain: txt('ain'),
          person_name: v.person_name, person_father: v.person_father, person_designation: v.person_designation, person_pan: txt('person_pan'), person_address: txt('person_address'),
          person_state: txt('person_state'), person_pincode: txt('person_pincode'), person_mobile: txt('person_mobile'), person_email: txt('person_email'),
          allow_rate_without_pan: v.allow_rate_without_pan ? 1 : 0,
        });
        return 'Company TDS deductor details saved';
      }}
    />
  );
}

export function NatureOfPaymentForm({ id, kind = 'TDS' }: { id?: number; kind?: TaxKind }) {
  const { books } = useStore();
  const ready = useStatutoryReady();
  const data = useLoad(async () => (ready ? { list: await natures(books.db), versions: id ? await natureVersions(books.db, id) : [] } : null), [ready, id]);
  if (!data) return null;
  const cur = id ? data.list.find((n) => n.id === id) : undefined;
  const ver = data.versions.find((x) => x.effective_from === IT_ACT_2025_FROM) ?? data.versions[data.versions.length - 1];
  const has2025 = (v: Record<string, any>) => !!String(v.section_2025 ?? '').trim();
  return (
    <FormScreen
      title={`${kind} Nature of Payment ${cur ? 'Alteration' : 'Creation'}`}
      labelWidth={260}
      fields={[
        { key: 'name', label: 'Name', kind: 'text', required: true, initial: cur?.name },
        { key: 'section', label: 'Section (Income-tax Act, 1961)', kind: 'text', initial: cur?.section },
        { key: 'payment_code', label: 'Payment code', kind: 'text', initial: cur?.payment_code },
        { key: 'remittance_code', label: 'Remittance code', kind: 'text', initial: cur?.remittance_code },
        { key: 'ind_pan', label: 'With PAN', kind: 'text', initial: pct(cur?.rate_ind_pan_bp ?? 0), heading: 'Rate for individuals/HUF' },
        { key: 'ind_nopan', label: 'Without PAN', kind: 'text', initial: pct(cur?.rate_ind_nopan_bp ?? 0) },
        { key: 'oth_pan', label: 'With PAN', kind: 'text', initial: pct(cur?.rate_oth_pan_bp ?? 0), heading: 'Rate for other deductee types' },
        { key: 'oth_nopan', label: 'Without PAN', kind: 'text', initial: pct(cur?.rate_oth_nopan_bp ?? 0) },
        { key: 'threshold', label: 'Threshold/exemption limit', kind: 'amount', initial: cur?.threshold || 0 },
        { key: 'section_2025', label: 'Section (Income-tax Act, 2025)', kind: 'text', initial: ver?.section ?? '', heading: 'Income-tax Act, 2025 Details', note: 'Used for transactions dated on or after the applicable date' },
        { key: 'from_2025', label: 'Applicable from', kind: 'date', initial: ver?.effective_from ?? IT_ACT_2025_FROM, visible: has2025 },
        { key: 'code_2025', label: 'Payment code', kind: 'text', initial: ver?.payment_code ?? '', visible: has2025 },
        { key: 'ind_pan_2025', label: 'Rate for individuals/HUF with PAN', kind: 'text', initial: pct(ver?.rate_ind_pan_bp ?? cur?.rate_ind_pan_bp ?? 0), visible: has2025 },
        { key: 'ind_nopan_2025', label: 'Rate for individuals/HUF without PAN', kind: 'text', initial: pct(ver?.rate_ind_nopan_bp ?? cur?.rate_ind_nopan_bp ?? 0), visible: has2025 },
        { key: 'oth_pan_2025', label: 'Rate for other deductee types with PAN', kind: 'text', initial: pct(ver?.rate_oth_pan_bp ?? cur?.rate_oth_pan_bp ?? 0), visible: has2025 },
        { key: 'oth_nopan_2025', label: 'Rate for other deductee types without PAN', kind: 'text', initial: pct(ver?.rate_oth_nopan_bp ?? cur?.rate_oth_nopan_bp ?? 0), visible: has2025 },
        { key: 'threshold_2025', label: 'Threshold/exemption limit', kind: 'amount', initial: ver?.threshold ?? cur?.threshold ?? 0, visible: has2025 },
      ]}
      onSave={async (v) => {
        const saved = await saveNature(
          books.db,
          {
            name: String(v.name),
            kind: cur?.kind ?? kind,
            section: String(v.section),
            payment_code: String(v.payment_code),
            remittance_code: String(v.remittance_code),
            rate_ind_pan_bp: toBp(v.ind_pan),
            rate_ind_nopan_bp: toBp(v.ind_nopan),
            rate_oth_pan_bp: toBp(v.oth_pan),
            rate_oth_nopan_bp: toBp(v.oth_nopan),
            threshold: Number(v.threshold) || 0,
            single_threshold: cur?.single_threshold ?? 0,
            surcharge_bp: cur?.surcharge_bp ?? 0,
            cess_bp: cur?.cess_bp ?? 0,
          },
          cur?.id
        );
        if (has2025(v))
          await saveNatureVersion(books.db, saved.id, {
            effective_from: String(v.from_2025 || IT_ACT_2025_FROM),
            act: '2025',
            section: String(v.section_2025),
            payment_code: String(v.code_2025 ?? ''),
            rate_ind_pan_bp: toBp(v.ind_pan_2025),
            rate_ind_nopan_bp: toBp(v.ind_nopan_2025),
            rate_oth_pan_bp: toBp(v.oth_pan_2025),
            rate_oth_nopan_bp: toBp(v.oth_nopan_2025),
            threshold: Number(v.threshold_2025) || 0,
            single_threshold: ver?.single_threshold ?? cur?.single_threshold ?? 0,
          });
        else if (ver) await deleteNatureVersion(books.db, ver.id);
        return 'TDS nature of payment saved';
      }}
      onDelete={cur ? () => deleteNature(books.db, cur.id) : undefined}
    />
  );
}

export function NatureOfPaymentList({ kind = 'TDS', onPick, popOnSelect = false }: { kind?: TaxKind; onPick?: (n: Nature) => void; popOnSelect?: boolean }) {
  const { books, version } = useStore();
  const nav = useNav();
  const ready = useStatutoryReady();
  const list = useLoad(async () => {
    if (!ready) return null;
    const nats = await natures(books.db, kind);
    const later = new Map((await naturesOn(books.db, '9999-12-31', kind)).map((n) => [n.id, n.section]));
    return nats.map((n) => ({ ...n, sub: later.get(n.id) && later.get(n.id) !== n.section ? `${n.section} / ${later.get(n.id)}` : n.section }));
  }, [ready, kind, version]);
  return (
    <SelectList
      title={kind === 'TDS' ? 'TDS Nature of Payments' : 'TCS Nature of Goods'}
      heading={kind === 'TDS' ? 'List of TDS Nature of Payments' : 'List of TCS Nature of Goods'}
      popOnSelect={popOnSelect}
      items={(list ?? []).map((n) => ({ id: n.id, label: n.name, sub: n.sub }))}
      onSelect={(i) => (onPick ? onPick(list!.find((n) => n.id === i.id)!) : nav.push(<NatureOfPaymentForm id={Number(i.id)} kind={kind} />))}
      onCreate={() => nav.push(<NatureOfPaymentForm kind={kind} />)}
    />
  );
}

export function TdsPartyDetailsForm({ ledgerId }: { ledgerId: number }) {
  const { books } = useStore();
  const ready = useStatutoryReady();
  const data = useLoad(async () => {
    if (!ready) return null;
    return { p: await tdsParty(books.db, ledgerId), nats: await natures(books.db, 'TDS'), l: await books.ledger(ledgerId) };
  }, [ready, ledgerId]);
  if (!data || !data.l) return null;
  const dOpts: Opt[] = DEDUCTEE_TYPES.map((t) => ({ id: t, label: t }));
  const nOpts: Opt[] = data.nats.map((n) => ({ id: n.id, label: n.name }));
  return (
    <FormScreen
      title="Statutory Details"
      labelWidth={300}
      fields={[
        { key: 'on', label: 'Is TDS Deductable', kind: 'toggle', initial: !!data.l.tds_deductible },
        { key: 'dtype', label: 'Deductee type', kind: 'picker', title: 'Deductee Type', options: dOpts, initial: dOpts.find((o) => o.id === data.p.deductee_type), visible: (v) => !!v.on },
        { key: 'nature', label: 'Default nature of payment', kind: 'picker', title: 'TDS Nature of Payments', options: nOpts, initial: nOpts.find((o) => o.id === data.p.nature_id), visible: (v) => !!v.on },
        { key: 'lower', label: 'Deduct TDS at lower/zero rate', kind: 'toggle', initial: !!data.p.deduct_lower, visible: (v) => !!v.on },
        { key: 'lrate', label: 'Rate', kind: 'text', initial: pct(data.p.lower_rate_bp), visible: (v) => !!v.on && !!v.lower },
        { key: 'cert', label: 'Certificate number', kind: 'text', initial: data.p.lower_certificate, visible: (v) => !!v.on && !!v.lower },
      ]}
      onSave={async (v) => {
        await books.updateLedger(ledgerId, { tds_deductible: v.on ? 1 : 0 });
        if (v.on)
          await saveTdsParty(books.db, ledgerId, {
            deductee_type: String(v.dtype || data.p.deductee_type),
            nature_id: v.nature ? Number(v.nature) : null,
            deduct_lower: v.lower ? 1 : 0,
            lower_rate_bp: toBp(v.lrate),
            lower_certificate: String(v.cert ?? ''),
          });
        return 'Statutory details saved';
      }}
    />
  );
}

export function TdsDutyLedgerForm({ ledgerId }: { ledgerId: number }) {
  const { books } = useStore();
  const ready = useStatutoryReady();
  const data = useLoad(async () => {
    if (!ready) return null;
    const cur = await books.db.select<{ kind: string; nature_id: number | null }>('SELECT kind, nature_id FROM tds_duty_ledger WHERE ledger_id = ?', [ledgerId]);
    return { cur: cur[0], nats: await natures(books.db) };
  }, [ready, ledgerId]);
  if (!data) return null;
  const nOpts: Opt[] = data.nats.map((n) => ({ id: n.id, label: n.name }));
  const kOpts: Opt[] = [{ id: 'TDS', label: 'TDS' }, { id: 'TCS', label: 'TCS' }];
  return (
    <FormScreen
      title="Duty Ledger Details"
      labelWidth={260}
      fields={[
        { key: 'kind', label: 'Type of duty/tax', kind: 'picker', title: 'Type of Duty/Tax', options: kOpts, initial: kOpts.find((o) => o.id === (data.cur?.kind ?? 'TDS')), required: true },
        { key: 'nature', label: 'Nature of payment', kind: 'picker', title: 'Nature of Payments', options: nOpts, initial: nOpts.find((o) => o.id === data.cur?.nature_id) },
      ]}
      onSave={async (v) => {
        await setDutyLedger(books.db, ledgerId, v.kind === 'TCS' ? 'TCS' : 'TDS', v.nature ? Number(v.nature) : null);
        await books.updateLedger(ledgerId, { duty_type: v.kind === 'TCS' ? 'TCS' : 'TDS' });
        return 'Duty ledger details saved';
      }}
    />
  );
}

export function TdsDetailsScreen({ partyId, amount, date, excludeVoucherId, onDone }: {
  partyId: number;
  amount: number;
  date: string;
  excludeVoucherId?: number;
  onDone: (plan: TdsPlan, natureName: string) => void;
}) {
  const { books, toast } = useStore();
  const nav = useNav();
  const ready = useStatutoryReady();
  const form = useRef<FormHandle>(null);
  const data = useLoad(async () => {
    if (!ready) return null;
    const p = await tdsParty(books.db, partyId);
    return { nats: await natures(books.db, 'TDS'), def: p.nature_id };
  }, [ready, partyId]);
  const [plan, setPlan] = useState<{ plan: TdsPlan; name: string } | null>(null);
  const nOpts: Opt[] = useMemo(() => (data?.nats ?? []).map((n) => ({ id: n.id, label: n.name })), [data]);
  const compute = async (id: number) => {
    try {
      const p = await planTds(books.db, { party_id: partyId, nature_id: id, amount, date, exclude_voucher_id: excludeVoucherId });
      setPlan({ plan: p, name: nOpts.find((o) => o.id === id)?.label ?? '' });
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useEffect(() => {
    if (data?.def) void compute(data.def);
  }, [data]);
  const accept = async () => {
    const v = form.current?.submit();
    if (!v) return;
    const id = Number(v.nature);
    if (!plan || plan.plan.nature_id !== id) return compute(id);
    nav.pop();
    onDone(plan.plan, plan.name);
  };
  useScreen({ title: 'TDS Details', noPeriod: true, keys: { 'Ctrl+A': () => void accept() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void accept() }] });
  if (!data) return null;
  return (
    <div className="max-w-xl">
      <Form
        ref={form}
        labelWidth={260}
        onDone={() => void accept()}
        fields={[
          { key: 'nature', label: 'Nature of payment', kind: 'picker', title: 'TDS Nature of Payments', options: nOpts, initial: nOpts.find((o) => o.id === data.def), required: true },
        ]}
      />
      {plan && (
        <div className="mt-4 text-[15px]">
          <div className="flex justify-between border-b border-tb-line px-2"><span>Assessable value</span><span className="tabular-nums">{fmtAmount(amount)}</span></div>
          <div className="flex justify-between px-2"><span>Taxable value</span><span className="tabular-nums">{fmtAmount(plan.plan.base)}</span></div>
          <div className="flex justify-between px-2"><span>TDS rate</span><span>{plan.plan.rate_bp / 100} %</span></div>
          <div className="flex justify-between px-2"><span>Section</span><span>{plan.plan.section}</span></div>
          <div className="flex justify-between px-2"><span>Act</span><span>{actName(plan.plan.act)}</span></div>
          {plan.plan.surcharge ? <div className="flex justify-between px-2"><span>Surcharge</span><span className="tabular-nums">{fmtAmount(plan.plan.surcharge)}</span></div> : null}
          {plan.plan.cess ? <div className="flex justify-between px-2"><span>Cess</span><span className="tabular-nums">{fmtAmount(plan.plan.cess)}</span></div> : null}
          <div className="flex justify-between border-y-[3px] border-double border-tb-ink px-2 font-bold"><span>TDS amount</span><span className="tabular-nums">{fmtAmount(plan.plan.total, false)}</span></div>
          {plan.plan.below_threshold && <div className="px-2 text-xs text-tb-muted">Below the threshold/exemption limit. No TDS is deducted.</div>}
        </div>
      )}
    </div>
  );
}

const OUT_DEFS = [
  { key: 'section', label: 'Show Section Code', default: false },
  { key: 'code', label: 'Show Payment Code', default: false },
];

export function TdsOutstandingsReport({ kind = 'TDS', byParty = false }: { kind?: TaxKind; byParty?: boolean }) {
  const { books, period, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const cfg = useReportOptions('tds-outstandings', 'TDS Outstandings', OUT_DEFS);
  const flt = useFilter();
  const ready = useStatutoryReady();
  const data = useLoad(async () => {
    if (!ready) return null;
    const nats = await naturesOn(books.db, period.to);
    return byParty
      ? { nats, rows: null, parties: await tdsOutstandingByParty(books.db, period.from, period.to, kind) }
      : { nats, rows: await tdsOutstandingByNature(books.db, period.from, period.to, kind), parties: null };
  }, [period, kind, byParty, ready]);
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => flt.match(r.nature)), [data, flt]);
  const parties = useMemo(() => (data?.parties ?? []).filter((r) => flt.match(r.party, r.pan)), [data, flt]);
  const count = byParty ? parties.length : rows.length;
  const { sel, setSel, keys } = useSel(count);
  const open = (i: number) => {
    if (byParty) {
      const r = parties[i];
      if (r) nav.push(<TdsBillsReport kind={kind} partyId={r.party_id} title={r.party} />);
    } else {
      const r = rows[i];
      if (r) nav.push(<TdsBillsReport kind={kind} natureId={r.nature_id} title={r.nature} />);
    }
  };
  const exportCsv = async () => {
    const lines = byParty
      ? [['Party', 'PAN', 'Pending'], ...parties.map((r) => [r.party, r.pan, fmtAmount(r.pending)])]
      : [['Nature of Payment', 'Company', 'Non Company', 'Total Pending'], ...rows.map((r) => [r.nature, fmtAmount(r.company), fmtAmount(r.non_company), fmtAmount(r.total)])];
    if (await saveTextFile('TDS Outstandings.csv', lines.map((l) => l.map(csvEscape).join(',')).join('\n'), 'text/csv')) toast('Exported', 'ok');
  };
  useScreen({
    title: `${kind} Outstandings`,
    keys: {
      ...keys, ...p.key, ...cfg.key, ...flt.key,
      Enter: () => open(sel),
      F5: () => nav.replace(<TdsOutstandingsReport kind={kind} byParty={!byParty} />),
      'Alt+E': () => void exportCsv(),
    },
    buttons: [
      p.button,
      { key: 'F5', label: byParty ? 'Nature-wise' : 'Party-wise', run: () => nav.replace(<TdsOutstandingsReport kind={kind} byParty={!byParty} />) },
      cfg.button,
      flt.button,
      { key: 'Alt+E', label: 'Export (CSV)', run: () => void exportCsv() },
    ],
  });
  if (!data) return null;
  const sectionOf = (id: number) => data.nats.find((n) => n.id === id);
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  return (
    <Frame title={`${kind} Outstandings`} subtitle={`Details of : ${byParty ? 'Party' : 'Nature of Payment'}   ${fmtDate(period.from)} to ${fmtDate(period.to)}`}>
      {flt.bar}
      {byParty ? (
        <table className="w-full">
          <thead>
            <tr className="text-left">
              <th className={th}>Party's Name</th>
              <th className={th}>PAN/IT No.</th>
              <th className={th}>Deductee Type</th>
              <th className={`${th} text-right`}>Total Pending</th>
            </tr>
          </thead>
          <tbody>
            {parties.map((r, i) => (
              <tr key={r.party_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
                <td className="px-2">{r.party}</td>
                <td className="px-2">{r.pan}</td>
                <td className="px-2">{r.deductee_type}</td>
                <td className={num}>{fmtAmount(r.pending)}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td colSpan={3} className={grand}>Grand Total</td>
              <td className={tot}>{fmtAmount(parties.reduce((s, r) => s + r.pending, 0), false)}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="text-left">
              <th className={th}>Nature of Payment</th>
              {cfg.values.section && <th className={th}>Section</th>}
              {cfg.values.code && <th className={th}>Payment Code</th>}
              <th className={`${th} text-right`}>Company</th>
              <th className={`${th} text-right`}>Non Company</th>
              <th className={`${th} text-right`}>Total Pending</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.nature_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(i)}>
                <td className="px-2">{r.nature}</td>
                {cfg.values.section && <td className="px-2">{sectionOf(r.nature_id)?.section}</td>}
                {cfg.values.code && <td className="px-2">{sectionOf(r.nature_id)?.payment_code}</td>}
                <td className={num}>{fmtAmount(r.company)}</td>
                <td className={num}>{fmtAmount(r.non_company)}</td>
                <td className={num}>{fmtAmount(r.total)}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td colSpan={1 + Number(cfg.values.section) + Number(cfg.values.code)} className={grand}>Grand Total</td>
              <td className={tot}>{fmtAmount(sum((r) => r.company), false)}</td>
              <td className={tot}>{fmtAmount(sum((r) => r.non_company), false)}</td>
              <td className={tot}>{fmtAmount(sum((r) => r.total), false)}</td>
            </tr>
          </tbody>
        </table>
      )}
      {data && count === 0 && <div className="py-3 text-tb-muted">{flt.active ? 'No rows match the filter.' : `No ${kind} outstanding.`}</div>}
    </Frame>
  );
}

export function TdsBillsReport({ kind, natureId, partyId, title }: { kind: TaxKind; natureId?: number; partyId?: number; title: string }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const flt = useFilter();
  const data = useLoad(async () => (await tdsOutstandings(books.db, period.from, period.to, kind)).filter((r) => (natureId ? r.nature_id === natureId : r.party_id === partyId)), [period, kind, natureId, partyId]);
  const rows = useMemo(() => (data ?? []).filter((r) => flt.match(r.party, r.number)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const open = (r: TdsOutstanding | undefined) => r && nav.push(<VoucherScreen voucherId={r.voucher_id} />);
  useScreen({ title: `${kind} Outstandings`, keys: { ...keys, ...p.key, ...flt.key, Enter: () => open(rows[sel]) }, buttons: [p.button, flt.button] });
  return (
    <Frame title={`${natureId ? 'Nature of Payment' : "Party's Name"} : ${title}`}>
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Ref. No.</th>
            <th className={th}>Party's Name</th>
            <th className={`${th} text-right`}>Opening Amount</th>
            <th className={`${th} text-right`}>Pending Amount</th>
            <th className={th}>Due on</th>
            <th className={`${th} text-right`}>Overdue by days</th>
            <th className={`${th} text-right`}>Interest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.deduction_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => open(r)}>
              <td className="px-2 font-bold">{fmtDate(r.date)}</td>
              <td className="px-2">{r.type} / {r.number}</td>
              <td className="px-2">{r.party}</td>
              <td className={num}>{fmtAmount(r.amount)} Cr</td>
              <td className={`${num} font-bold`}>{fmtAmount(r.pending)}</td>
              <td className="px-2">{fmtDate(r.due_on)}</td>
              <td className={`${num} italic`}>{r.overdue_days}</td>
              <td className={num}>{fmtAmount(r.interest)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={3} className={grand} />
            <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.amount, 0), false)} Cr</td>
            <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.pending, 0), false)}</td>
            <td colSpan={2} className={grand} />
            <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.interest, 0))}</td>
          </tr>
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">Nothing pending.</div>}
    </Frame>
  );
}

export function TdsPaymentScreen({ kind = 'TDS' }: { kind?: TaxKind }) {
  const { books, period, bump, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const ready = useStatutoryReady();
  const data = useLoad(async () => (ready ? tdsOutstandings(books.db, period.from, period.to, kind) : null), [period, kind, ready]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const rows = data ?? [];
  const { sel, setSel, keys } = useSel(rows.length);
  const toggle = (i: number) => {
    const r = rows[i];
    if (!r) return;
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(r.deduction_id)) n.delete(r.deduction_id);
      else n.add(r.deduction_id);
      return n;
    });
  };
  const pay = () => {
    if (!picked.size) return toast('Select at least one pending deduction with Space', 'err');
    nav.push(<ChallanDetailsForm kind={kind} ids={[...picked]} onPaid={() => { setPicked(new Set()); bump(); }} />);
  };
  const payFee = () => nav.push(<ChallanDetailsForm kind={kind} ids={[]} quarterFrom={quarterOf(period.to).from} onPaid={bump} />);
  useScreen({
    title: `${kind} Payment`,
    keys: { ...keys, ...p.key, ' ': () => toggle(sel), Space: () => toggle(sel), Enter: () => toggle(sel), 'Ctrl+A': pay, 'Alt+L': payFee },
    buttons: [p.button, { key: 'Ctrl+A', label: 'Pay', run: pay }, { key: 'Alt+L', label: 'Interest/Late Fee only', run: payFee }],
  });
  const total = rows.filter((r) => picked.has(r.deduction_id)).reduce((s, r) => s + r.pending, 0);
  const interest = rows.filter((r) => picked.has(r.deduction_id)).reduce((s, r) => s + r.interest, 0);
  return (
    <Frame title={`${kind} Payment`}>
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th} />
            <th className={th}>Date</th>
            <th className={th}>Ref. No.</th>
            <th className={th}>Nature of Payment</th>
            <th className={th}>Party's Name</th>
            <th className={th}>Due on</th>
            <th className={`${th} text-right`}>Pending Amount</th>
            <th className={`${th} text-right`}>Interest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.deduction_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => toggle(i)}>
              <td className="px-2">{picked.has(r.deduction_id) ? '*' : ''}</td>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2">{r.type} / {r.number}</td>
              <td className="px-2">{r.nature}</td>
              <td className="px-2">{r.party}</td>
              <td className="px-2">{fmtDate(r.due_on)}</td>
              <td className={num}>{fmtAmount(r.pending)}</td>
              <td className={num}>{fmtAmount(r.interest)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={6} className={grand}>Selected Total</td>
            <td className={tot}>{fmtAmount(total, false)}</td>
            <td className={tot}>{fmtAmount(interest)}</td>
          </tr>
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">Nothing pending.</div>}
    </Frame>
  );
}

export function ChallanDetailsForm({ ids, onPaid, kind = 'TDS', quarterFrom }: { ids: number[]; onPaid: () => void; kind?: TaxKind; quarterFrom?: string }) {
  const { books } = useStore();
  const today = new Date().toISOString().slice(0, 10);
  const data = useLoad(async () => ({ ledgers: await books.ledgers(), interest: await interestIfPaidOn(books.db, ids, today) }), [ids.join(',')]);
  if (!data) return null;
  const banks: Opt[] = data.ledgers.filter((l) => BANK_CASH.includes(l.group_name)).map((l) => ({ id: l.id, label: l.name }));
  return (
    <FormScreen
      title="Challan Details"
      labelWidth={260}
      fields={[
        { key: 'date', label: 'Date', kind: 'date', required: true, initial: today },
        { key: 'bank', label: 'Bank Name', kind: 'picker', title: 'Ledger Accounts', options: banks, required: true },
        ...(quarterFrom ? [{ key: 'quarter', label: 'Quarter from', kind: 'date' as const, required: true, initial: quarterFrom }] : []),
        { key: 'interest', label: 'Interest', kind: 'amount', initial: data.interest, note: ids.length ? 'Computed for payment today; recomputed for the payment date if left unchanged' : undefined },
        { key: 'fee', label: 'Late fee', kind: 'amount', initial: 0 },
        { key: 'others', label: 'Penalty/Others', kind: 'amount', initial: 0 },
        { key: 'cheque_no', label: 'Cheque/DD No.', kind: 'text' },
        { key: 'cheque_date', label: 'Cheque/DD Date', kind: 'date' },
        { key: 'bsr', label: 'BSR Code', kind: 'text', maxLength: 7 },
        { key: 'challan_no', label: 'Challan No.', kind: 'text' },
        { key: 'challan_date', label: 'Challan Date', kind: 'date' },
        { key: 'branch', label: 'Branch Name', kind: 'text' },
      ]}
      onSave={async (v) => {
        const date = String(v.date);
        const typed = Number(v.interest) || 0;
        const interest = typed === data.interest && date !== today ? await interestIfPaidOn(books.db, ids, String(v.challan_date || date)) : typed;
        await payTds(books, {
          date,
          bank_id: Number(v.bank),
          deduction_ids: ids,
          kind,
          quarter_from: quarterFrom ? String(v.quarter || quarterFrom) : undefined,
          interest,
          late_fee: Number(v.fee) || 0,
          others: Number(v.others) || 0,
          bsr_code: String(v.bsr),
          challan_no: String(v.challan_no),
          challan_date: v.challan_date || undefined,
          cheque_no: String(v.cheque_no),
          cheque_date: v.cheque_date || undefined,
          bank_name: banks.find((b) => b.id === v.bank)?.label ?? '',
          branch: String(v.branch),
        });
        onPaid();
        return 'Payment voucher created';
      }}
    />
  );
}

export function ChallanReconcileForm({ challan }: { challan: ChallanRow }) {
  const { books } = useStore();
  return (
    <FormScreen
      title="Challan Reconciliation"
      labelWidth={260}
      fields={[
        { key: 'bsr', label: 'BSR Code', kind: 'text', initial: challan.bsr_code, maxLength: 7, required: true },
        { key: 'no', label: 'Challan No.', kind: 'text', initial: challan.challan_no, required: true },
        { key: 'date', label: 'Challan Date', kind: 'date', initial: challan.challan_date || challan.date, required: true },
      ]}
      onSave={async (v) => {
        await reconcileChallan(books.db, challan.id, { bsr_code: String(v.bsr), challan_no: String(v.no), challan_date: String(v.date) });
        return 'Challan reconciled';
      }}
    />
  );
}

export function TdsChallanReconciliationReport() {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const flt = useFilter();
  const ready = useStatutoryReady();
  const [pending, setPending] = useState(false);
  const data = useLoad(async () => (ready ? tdsChallans(books.db, period.from, period.to, pending) : null), [period, pending, ready]);
  const rows = useMemo(() => (data ?? []).filter((r) => flt.match(r.particulars, r.section, r.challan_no, r.bsr_code)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const reconcile = () => rows[sel] && nav.push(<ChallanReconcileForm challan={rows[sel]} />);
  const toggle = () => setPending((x) => !x);
  useScreen({
    title: 'TDS Challan Reconciliation',
    keys: { ...keys, ...p.key, ...flt.key, F8: toggle, 'Alt+R': reconcile, Enter: reconcile },
    buttons: [p.button, { key: 'F8', label: pending ? 'Show All' : 'Show Pending', run: toggle }, flt.button, { key: 'Alt+R', label: 'Reconcile', run: reconcile }],
  });
  const heads = ['Date', 'Particulars', 'E-TDS Quarter Period', 'Section No.', 'Deductee Type', 'Resident Type', 'Cheque/DD No.', 'Cheque/DD Date', 'BSR Code', 'Challan No.', 'Challan Date', 'Vch No.'];
  return (
    <Frame title="TDS Challan Reconciliation">
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            {heads.map((h) => (
              <th key={h} className={th}>{h}</th>
            ))}
            <th className={`${th} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <FragmentChallan key={r.id} r={r} on={i === sel} onHover={() => setSel(i)} onOpen={reconcile} />
          ))}
          <tr className="font-bold">
            <td colSpan={12} className={grand}>Grand Total</td>
            <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.amount + r.interest + r.fee + r.others, 0), false)}</td>
          </tr>
        </tbody>
      </table>
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No challans found.</div>}
    </Frame>
  );
}

function FragmentChallan({ r, on, onHover, onOpen }: { r: ChallanRow; on: boolean; onHover: () => void; onOpen: () => void }) {
  return (
    <>
      <tr className={rowCls(on)} onMouseEnter={onHover} onClick={onOpen}>
        <td className="px-2">{fmtDate(r.date)}</td>
        <td className="px-2 font-bold">{r.particulars}</td>
        <td className="px-2">{fmtDate(r.quarter_from)} {fmtDate(r.quarter_to)}</td>
        <td className="px-2">{r.section}</td>
        <td className="px-2">{r.deductee_type}</td>
        <td className="px-2">{r.resident}</td>
        <td className="px-2">{r.cheque_no}</td>
        <td className="px-2">{r.cheque_date ? fmtDate(r.cheque_date) : ''}</td>
        <td className="px-2">{r.bsr_code}</td>
        <td className="px-2">{r.challan_no}</td>
        <td className="px-2">{r.challan_date ? fmtDate(r.challan_date) : ''}</td>
        <td className="px-2">{r.vch_no}</td>
        <td className={num}>{fmtAmount(r.amount + r.interest + r.fee + r.others)}</td>
      </tr>
      <tr className={on ? 'bg-tb-sel text-tb-sel-ink' : ''}>
        <td />
        <td colSpan={12} className="px-2 text-xs italic">
          Bank Name : {r.bank_name}   Branch Name : {r.branch}
          {r.interest || r.fee || r.others ? `   Tax : ${fmtAmount(r.amount, false)}   Interest : ${fmtAmount(r.interest, false)}   Late Fee : ${fmtAmount(r.fee, false)}   Others : ${fmtAmount(r.others, false)}` : ''}
        </td>
      </tr>
    </>
  );
}

export function Form26QReport({ kind = 'TDS' }: { kind?: TaxKind } = {}) {
  const { books, period, toast } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const flt = useFilter();
  const ready = useStatutoryReady();
  const data = useLoad(async () => (ready ? form26Q(books.db, period.from, period.to, kind) : null), [period, ready, kind]);
  const formName = data?.form ?? etdsForm(kind, period.from);
  const legacy = kind === 'TCS' ? '27EQ' : '26Q';
  const eReturn = () => nav.push(<EtdsExportScreen kind={kind} quarterDate={period.from} />);
  const rows = useMemo(() => (data?.deductions ?? []).filter((r) => flt.match(r.party, r.pan, r.section)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  const exportCsv = async () => {
    if (!data) return;
    const lines = [
      ['Date', 'Deductee', 'PAN', 'Section', 'Deductee Type', 'Amount Paid', 'Rate %', 'TDS', 'Surcharge', 'Cess', 'Total Tax', 'Deposited', 'Challan No.', 'BSR Code'],
      ...rows.map((r) => [r.date, r.party, r.pan, r.section, r.deductee_type, fmtAmount(r.gross), String(r.rate_bp / 100), fmtAmount(r.tax), fmtAmount(r.surcharge), fmtAmount(r.cess), fmtAmount(r.total), fmtAmount(r.deposited), r.challan_no, r.bsr_code]),
    ];
    if (await saveTextFile(`Form${data.form}.csv`, lines.map((l) => l.map(csvEscape).join(',')).join('\n'), 'text/csv')) toast('Exported', 'ok');
  };
  useScreen({
    title: `Form ${formName}`,
    keys: { ...keys, ...p.key, ...flt.key, 'Alt+E': () => void exportCsv(), 'Ctrl+E': eReturn },
    buttons: [p.button, flt.button, { key: 'Alt+E', label: 'Export (CSV)', run: () => void exportCsv() }, { key: 'Ctrl+E', label: 'Export e-Return', run: eReturn }],
  });
  return (
    <Frame
      title={formName !== legacy ? `Form ${formName} (Earlier Form ${legacy}) - ${kind === 'TCS' ? 'Collection' : 'Deduction'} Summary` : `Form ${formName} - ${kind === 'TCS' ? 'Collection' : 'Deduction'} Summary`}
      subtitle={`TAN: ${data?.tan ?? ''}   ${actName(data?.act ?? '1961')}   ${fmtDate(period.from)} to ${fmtDate(period.to)}`}
    >
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date</th>
            <th className={th}>Deductee Name</th>
            <th className={th}>PAN</th>
            <th className={th}>Section</th>
            <th className={th}>Deductee Type</th>
            <th className={`${th} text-right`}>Amount Paid</th>
            <th className={`${th} text-right`}>Rate</th>
            <th className={`${th} text-right`}>Tax Deducted</th>
            <th className={`${th} text-right`}>Deposited</th>
            <th className={th}>Challan No.</th>
            <th className={th}>BSR Code</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.date}-${r.party}-${i}`} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className="px-2">{fmtDate(r.date)}</td>
              <td className="px-2">{r.party}</td>
              <td className="px-2">{r.pan || 'PANNOTAVBL'}</td>
              <td className="px-2">{r.section}</td>
              <td className="px-2">{r.deductee_type}</td>
              <td className={num}>{fmtAmount(r.gross)}</td>
              <td className={num}>{r.rate_bp / 100} %</td>
              <td className={num}>{fmtAmount(r.total)}</td>
              <td className={num}>{fmtAmount(r.deposited)}</td>
              <td className="px-2">{r.challan_no}</td>
              <td className="px-2">{r.bsr_code}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={5} className={grand}>Grand Total</td>
            <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.gross, 0), false)}</td>
            <td className={grand} />
            <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.total, 0), false)}</td>
            <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.deposited, 0), false)}</td>
            <td colSpan={2} className={grand} />
          </tr>
        </tbody>
      </table>
      {data && data.challans.length > 0 && (
        <>
          <div className="mb-1 mt-5 font-semibold">Challan Details</div>
          <table className="w-full">
            <thead>
              <tr className="text-left">
                <th className={th}>Date</th>
                <th className={th}>Section No.</th>
                <th className={th}>BSR Code</th>
                <th className={th}>Challan No.</th>
                <th className={th}>Challan Date</th>
                <th className={`${th} text-right`}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {data.challans.map((c) => (
                <tr key={c.id}>
                  <td className="px-2">{fmtDate(c.date)}</td>
                  <td className="px-2">{c.section}</td>
                  <td className="px-2">{c.bsr_code}</td>
                  <td className="px-2">{c.challan_no}</td>
                  <td className="px-2">{c.challan_date ? fmtDate(c.challan_date) : ''}</td>
                  <td className={num}>{fmtAmount(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {data && rows.length === 0 && <div className="py-3 text-tb-muted">No deductions in this period.</div>}
    </Frame>
  );
}

export function EtdsExportScreen({ kind, quarterDate }: { kind: TaxKind; quarterDate: string }) {
  const { books, toast } = useStore();
  const dialogs = useDialogs();
  const ready = useStatutoryReady();
  const [qDate, setQDate] = useState(quarterOf(quarterDate).from);
  const data = useLoad<EtdsStatement | null>(async () => (ready ? etdsStatement(books.db, kind, qDate) : null), [ready, kind, qDate]);
  const shift = (n: number) => {
    const [y, m] = qDate.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + n * 3, 1)).toISOString().slice(0, 10);
    setQDate(quarterOf(t).from);
  };
  const save = async () => {
    if (!data) return;
    if (data.errors.length && !(await dialogs.confirm('The statement has exceptions and will be rejected by the File Validation Utility. Export anyway ?', { title: 'Export', def: false }))) return;
    if (await saveTextFile(data.file_name, data.text, 'text/plain')) toast(`Form ${data.form} exported`, 'ok');
  };
  useScreen({
    title: 'Export e-Return',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), 'Alt+E': () => void save(), PageUp: () => shift(-1), PageDown: () => shift(1) },
    buttons: [{ key: 'Ctrl+A', label: 'Export', run: () => void save() }, { key: 'PageUp', label: 'Prev Quarter', run: () => shift(-1) }, { key: 'PageDown', label: 'Next Quarter', run: () => shift(1) }],
  });
  if (!data) return null;
  const deductees = data.challans.reduce((s, c) => s + c.deductees.length, 0);
  const kv: [string, string][] = [
    ['Form', `Form ${data.form} (${actName(data.act)})`],
    ['Quarter', `Q${data.quarter}   ${fmtDate(data.from)} to ${fmtDate(data.to)}`],
    ['File format', data.layout],
    ['Validate with', `Protean e-TDS/TCS File Validation Utility (FVU) version ${data.fvu}`],
    ['Challans', String(data.challans.length)],
    [kind === 'TCS' ? 'Collectee records' : 'Deductee records', String(deductees)],
    ['Total deposit as per challans', fmtAmount(data.challans.reduce((s, c) => s + c.total, 0), false)],
    ['File name', data.file_name],
  ];
  return (
    <Frame title="Export e-Return" subtitle={`${kind} quarterly statement`} plain>
      <div className="max-w-3xl text-[15px]">
        {kv.map(([k, v]) => (
          <div key={k} className="flex">
            <span className="w-72">{k}</span>
            <span className="mr-2">:</span>
            <span className="font-semibold">{v}</span>
          </div>
        ))}
        <div className="mt-4 font-semibold">Exceptions</div>
        {data.errors.length === 0 && <div className="text-tb-muted">None. The file is ready for validation.</div>}
        {data.errors.map((e) => (
          <div key={e} className="text-red-700">{e}</div>
        ))}
        {data.warnings.map((w) => (
          <div key={w} className="italic text-tb-muted">{w}</div>
        ))}
        <div className="mt-4 text-xs text-tb-muted">
          Statements for quarters up to FY 2025-26 use Form {kind === 'TCS' ? '27EQ' : '26Q'} (FVU 9.5); quarters of tax year 2026-27 onwards use Form {kind === 'TCS' ? '143' : '140'} under the Income-tax Act, 2025 (FVU 1.2). Import the challan status (CSI) file in the FVU to validate.
        </div>
      </div>
    </Frame>
  );
}

export function StatementFilingForm({ kind, q }: { kind: TaxKind; q: QuarterLiability }) {
  const { books } = useStore();
  const loaded = useLoad(async () => ({ f: (await statementFilings(books.db, kind)).find((f) => f.quarter_from === q.from) ?? null }), [kind, q.from]);
  if (!loaded) return null;
  const data = loaded.f;
  return (
    <FormScreen
      title={`Form ${q.form} Q${q.quarter} Filing Details`}
      labelWidth={260}
      fields={[
        { key: 'filed_on', label: 'Date of filing', kind: 'date', initial: data?.filed_on || '' },
        { key: 'token', label: 'Token/receipt number (15 digits)', kind: 'text', initial: data?.token_no ?? '', maxLength: 15 },
      ]}
      onSave={async (v) => {
        await saveStatementFiling(books.db, { kind, quarter_from: q.from, filed_on: String(v.filed_on || ''), token_no: String(v.token || '') });
        return 'Filing details saved';
      }}
    />
  );
}

const INTEREST_NOTE: Record<TaxKind, string> = {
  TDS: 'Interest on late payment: 1.5% per month or part of a month from the date of deduction to the date of payment (s.201(1A)(ii) of the Income-tax Act, 1961; s.398(3)(a)(ii) of the Income-tax Act, 2025), on the tax rounded down to a multiple of Rs. 100, counting calendar months as CPC-TDS does. Late fee: Rs. 200 per day after the due date of the statement, limited to the tax deducted (s.234E; s.427).',
  TCS: 'Interest on late payment: 1% per month or part of a month for collections up to 31-03-2026 (s.206C(7) of the Income-tax Act, 1961) and 1.5% for collections from 01-04-2026 (s.398(3)(a)(ii) of the Income-tax Act, 2025), from the date of collection to the date of payment, counting calendar months. Late fee: Rs. 200 per day after the due date of the statement, limited to the tax collected (s.234E; s.427).',
};

export function TdsInterestReport({ kind = 'TDS' }: { kind?: TaxKind }) {
  const { books, period } = useStore();
  const nav = useNav();
  const p = usePeriodKey();
  const flt = useFilter();
  const ready = useStatutoryReady();
  const [detail, setDetail] = useState(false);
  const data = useLoad(async () => (ready ? tdsInterestAndFee(books.db, period.from, period.to, kind, new Date().toISOString().slice(0, 10)) : null), [ready, period, kind]);
  const rows: TdsInterestRow[] = useMemo(() => (data?.rows ?? []).filter((r) => r.interest && flt.match(r.party, r.nature, r.section)), [data, flt]);
  const quarters = data?.quarters ?? [];
  const count = detail ? rows.length : quarters.length;
  const { sel, setSel, keys } = useSel(count);
  const open = () => {
    if (detail) return rows[sel] && nav.push(<VoucherScreen voucherId={rows[sel].voucher_id} />);
    if (quarters[sel]) nav.push(<StatementFilingForm kind={kind} q={quarters[sel]} />);
  };
  const toggle = () => setDetail((d) => !d);
  useScreen({
    title: `${kind} Interest and Late Fee`,
    keys: { ...keys, ...p.key, ...flt.key, F5: toggle, Enter: open, 'Alt+F': open },
    buttons: [p.button, { key: 'F5', label: detail ? 'Quarter-wise' : 'Deduction-wise', run: toggle }, flt.button, ...(detail ? [] : [{ key: 'Alt+F', label: 'Filing Details', run: open }])],
  });
  if (!data) return null;
  const sum = (f: (q: QuarterLiability) => number) => fmtAmount(quarters.reduce((s, q) => s + f(q), 0), false);
  return (
    <Frame title={`${kind} Interest and Late Fee`} subtitle={`${fmtDate(period.from)} to ${fmtDate(period.to)}   Interest as on ${fmtDate(new Date().toISOString().slice(0, 10))}`}>
      {flt.bar}
      {detail ? (
        <table className="w-full">
          <thead>
            <tr className="text-left">
              <th className={th}>Date</th>
              <th className={th}>Ref. No.</th>
              <th className={th}>Party's Name</th>
              <th className={th}>Section</th>
              <th className={`${th} text-right`}>{kind} Amount</th>
              <th className={th}>Due on</th>
              <th className={th}>Paid on</th>
              <th className={`${th} text-right`}>Months</th>
              <th className={th}>Interest u/s</th>
              <th className={`${th} text-right`}>Interest</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.deduction_id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => nav.push(<VoucherScreen voucherId={r.voucher_id} />)}>
                <td className="px-2">{fmtDate(r.date)}</td>
                <td className="px-2">{r.type} / {r.number}</td>
                <td className="px-2">{r.party}</td>
                <td className="px-2">{r.section}</td>
                <td className={num}>{fmtAmount(r.amount)}</td>
                <td className="px-2">{fmtDate(r.due_on)}</td>
                <td className="px-2">{r.parts.filter((x) => x.interest).map((x) => (x.date ? fmtDate(x.date) : 'Not paid')).join(', ')}</td>
                <td className={num}>{r.parts.filter((x) => x.interest).map((x) => x.months).join(', ')}</td>
                <td className="px-2">{r.interest_section} @ {r.rate_bp / 100}% p.m.</td>
                <td className={num}>{fmtAmount(r.interest)}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td colSpan={9} className={grand}>Grand Total</td>
              <td className={tot}>{fmtAmount(rows.reduce((s, r) => s + r.interest, 0), false)}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="text-left">
              <th className={th}>Quarter</th>
              <th className={th}>Form</th>
              <th className={`${th} text-right`}>{kind} Amount</th>
              <th className={`${th} text-right`}>Deposited</th>
              <th className={`${th} text-right`}>Interest</th>
              <th className={`${th} text-right`}>Interest Paid</th>
              <th className={th}>Return Due on</th>
              <th className={th}>Filed on</th>
              <th className={`${th} text-right`}>Days Late</th>
              <th className={`${th} text-right`}>Late Fee</th>
              <th className={`${th} text-right`}>Late Fee Paid</th>
            </tr>
          </thead>
          <tbody>
            {quarters.map((q, i) => (
              <tr key={q.from} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)} onClick={() => nav.push(<StatementFilingForm kind={kind} q={q} />)}>
                <td className="px-2">Q{q.quarter} ({fmtDate(q.from)} to {fmtDate(q.to)})</td>
                <td className="px-2">{q.form}</td>
                <td className={num}>{fmtAmount(q.tax)}</td>
                <td className={num}>{fmtAmount(q.deposited)}</td>
                <td className={num}>{fmtAmount(q.interest)}</td>
                <td className={num}>{fmtAmount(q.interest_paid)}</td>
                <td className="px-2">{fmtDate(q.statement_due)}</td>
                <td className="px-2">{q.filed_on ? fmtDate(q.filed_on) : 'Not filed'}</td>
                <td className={num}>{q.late_days || ''}</td>
                <td className={num}>{fmtAmount(q.late_fee)}</td>
                <td className={num}>{fmtAmount(q.fee_paid)}</td>
              </tr>
            ))}
            <tr className="font-bold">
              <td colSpan={2} className={grand}>Grand Total</td>
              <td className={tot}>{sum((q) => q.tax)}</td>
              <td className={tot}>{sum((q) => q.deposited)}</td>
              <td className={tot}>{sum((q) => q.interest)}</td>
              <td className={tot}>{sum((q) => q.interest_paid)}</td>
              <td colSpan={3} className={grand} />
              <td className={tot}>{sum((q) => q.late_fee)}</td>
              <td className={tot}>{sum((q) => q.fee_paid)}</td>
            </tr>
          </tbody>
        </table>
      )}
      <div className="mt-2 text-xs text-tb-muted">{INTEREST_NOTE[kind]}</div>
      {count === 0 && <div className="py-3 text-tb-muted">{detail ? 'No interest payable.' : `No ${kind} in this period.`}</div>}
    </Frame>
  );
}
