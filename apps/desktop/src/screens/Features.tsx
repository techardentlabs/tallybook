import { useEffect, useRef, useState } from 'react';
import { STATES, isValidGstin, saveTdsCompany, tdsCompany, type TdsCompany } from '@tallybook/core';
import { Form, type FormHandle, type FieldDef } from '../ui/Form.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';

export function FeaturesScreen() {
  const { books, company, reloadCompany, bump, toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const [tds, setTds] = useState<TdsCompany | null>(null);
  useEffect(() => void tdsCompany(books.db).then(setTds), [books]);
  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    try {
      await books.updateCompany({ gst_enabled: v.gst ? 1 : 0, bill_wise: v.bill ? 1 : 0, inventory_enabled: v.inv ? 1 : 0, payroll_enabled: v.pay ? 1 : 0, cost_centres_enabled: v.cc ? 1 : 0, gstin: v.gst ? v.gstin : '' });
      await saveTdsCompany(books.db, { tds_enabled: v.tds ? 1 : 0, tcs_enabled: v.tcs ? 1 : 0, einvoice_enabled: v.einv ? 1 : 0, ewb_enabled: v.ewb ? 1 : 0 });
      await reloadCompany();
      bump();
      toast('Features updated', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title: 'Company Features', noPeriod: true, keys: { 'Ctrl+A': () => void save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }] });
  if (!company || !tds) return null;
  const fields: FieldDef[] = [
    { key: 'bill', label: 'Maintain bill-wise details', kind: 'toggle', initial: !!company.bill_wise, heading: 'Accounting features' },
    { key: 'inv', label: 'Maintain inventory', kind: 'toggle', initial: !!company.inventory_enabled },
    { key: 'cc', label: 'Enable cost centres', kind: 'toggle', initial: !!company.cost_centres_enabled },
    { key: 'pay', label: 'Maintain payroll', kind: 'toggle', initial: !!company.payroll_enabled },
    { key: 'tds', label: 'Enable Tax Deducted at Source (TDS)', kind: 'toggle', initial: !!tds.tds_enabled },
    { key: 'tcs', label: 'Enable Tax Collected at Source (TCS)', kind: 'toggle', initial: !!tds.tcs_enabled },
    { key: 'einv', label: 'Enable e-Invoicing', kind: 'toggle', initial: !!tds.einvoice_enabled },
    { key: 'ewb', label: 'Enable e-Way Bill', kind: 'toggle', initial: !!tds.ewb_enabled },
    { key: 'gst', label: 'Enable Goods and Services Tax (GST)', kind: 'toggle', initial: !!company.gst_enabled, heading: 'Statutory & taxation' },
    {
      key: 'gstin',
      label: 'GSTIN/UIN',
      kind: 'upper',
      initial: company.gstin,
      maxLength: 15,
      visible: (v) => v.gst,
      validate: (v) => (v.gst && v.gstin && !isValidGstin(v.gstin) ? 'GSTIN is not valid' : null),
    },
  ];
  return (
    <div className="max-w-2xl border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 text-[15px] font-semibold">Company Operations Alteration (F11)</h3>
      <Form ref={form} fields={fields} onDone={() => void save()} />
      <p className="mt-3 text-xs text-tb-muted">Inventory, payroll and order processing arrive in later releases.</p>
    </div>
  );
}

export function CompanyAlter() {
  const { books, company, reloadCompany, toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const save = async () => {
    const v = form.current?.submit();
    if (!v) return;
    try {
      await books.updateCompany({ name: v.name, mailing_name: v.mailing_name, address: v.address, state: STATES.find((s) => s.code === v.state)?.name ?? company?.state ?? '', pincode: v.pincode, phone: v.phone, email: v.email, pan: v.pan });
      await reloadCompany();
      toast('Company altered', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title: 'Company Alteration', noPeriod: true, keys: { 'Ctrl+A': () => void save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }] });
  if (!company) return null;
  const st = STATES.find((s) => s.name === company.state);
  const fields: FieldDef[] = [
    { key: 'name', label: 'Company name', kind: 'text', required: true, initial: company.name },
    { key: 'mailing_name', label: 'Mailing name', kind: 'text', initial: company.mailing_name },
    { key: 'address', label: 'Address', kind: 'text', initial: company.address },
    { key: 'state', label: 'State', kind: 'picker', title: 'States', options: STATES.map((s) => ({ id: s.code, label: s.name, sub: s.code })), initial: st ? { id: st.code, label: st.name } : undefined },
    { key: 'pincode', label: 'Pincode', kind: 'text', initial: company.pincode },
    { key: 'phone', label: 'Telephone no.', kind: 'text', initial: company.phone },
    { key: 'email', label: 'E-mail', kind: 'text', initial: company.email },
    { key: 'pan', label: 'PAN/IT No.', kind: 'upper', initial: company.pan, maxLength: 10 },
  ];
  return (
    <div className="max-w-3xl border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 text-[15px] font-semibold">Company Alteration</h3>
      <Form ref={form} fields={fields} onDone={() => void save()} />
      <p className="mt-3 text-xs text-tb-muted">Financial year and books beginning dates cannot be changed after creation.</p>
    </div>
  );
}
