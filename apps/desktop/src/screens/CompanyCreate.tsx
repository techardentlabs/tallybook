import { useEffect, useRef, useState } from 'react';
import { STATES, todayIso } from '@tallybook/core';
import { Form, type FormHandle, type FieldDef } from '../ui/Form.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { Gateway } from './Gateway.tsx';
import { isValidGstin } from '@tallybook/core';
import { currentCompanyEntry, loadCompanyIndex, noteCompanyOpened, shutCompany } from '../db/companies.ts';
import { GroupCompanyForm } from './GroupCompany.tsx';

function defaultFyStart(): string {
  const t = todayIso();
  const y = Number(t.slice(0, 4));
  return `${Number(t.slice(5, 7)) >= 4 ? y : y - 1}-04-01`;
}

export function CompanyCreate() {
  const { books, reloadCompany, toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const [others, setOthers] = useState(0);
  useEffect(() => {
    void loadCompanyIndex()
      .then((i) => setOthers(i.companies.filter((c) => c.id !== currentCompanyEntry()?.id).length))
      .catch(() => setOthers(0));
  }, []);
  const stateOpts = STATES.map((s) => ({ id: s.code, label: s.name, sub: s.code }));

  const fields: FieldDef[] = [
    { key: 'name', label: 'Company name', kind: 'text', required: true },
    { key: 'mailing_name', label: 'Mailing name', kind: 'text' },
    { key: 'address', label: 'Address', kind: 'text' },
    { key: 'state', label: 'State', kind: 'picker', options: stateOpts },
    { key: 'pincode', label: 'Pincode', kind: 'text', maxLength: 6 },
    { key: 'phone', label: 'Telephone no.', kind: 'text' },
    { key: 'email', label: 'E-mail', kind: 'text' },
    { key: 'fy_start', label: 'Financial year beginning from', kind: 'date', required: true, initial: defaultFyStart() },
    { key: 'books_from', label: 'Books beginning from', kind: 'date', required: true, initial: defaultFyStart() },
    { key: 'currency_symbol', label: 'Base currency symbol', kind: 'text', initial: '₹' },
    { key: 'gst_enabled', label: 'Enable Goods and Services Tax (GST)', kind: 'toggle', initial: true, heading: 'Statutory' },
    {
      key: 'gstin',
      label: 'GSTIN/UIN',
      kind: 'upper',
      maxLength: 15,
      visible: (v) => v.gst_enabled,
      validate: (v) => (v.gst_enabled && v.gstin && !isValidGstin(v.gstin) ? 'GSTIN is not valid (check the 15 characters and the check digit)' : null),
    },
    { key: 'pan', label: 'PAN/IT No.', kind: 'upper', maxLength: 10 },
  ];

  const create = async () => {
    const v = form.current?.submit();
    if (!v) return;
    try {
      const state = STATES.find((s) => s.code === v.state)?.name ?? '';
      await books.createCompany({
        name: v.name,
        mailing_name: v.mailing_name,
        address: v.address,
        state,
        pincode: v.pincode,
        phone: v.phone,
        email: v.email,
        fy_start: v.fy_start,
        books_from: v.books_from,
        currency_symbol: v.currency_symbol,
        gst_enabled: v.gst_enabled ? 1 : 0,
        gstin: v.gst_enabled ? v.gstin : '',
        pan: v.pan,
      });
      const created = await reloadCompany();
      await noteCompanyOpened(created).catch((e) => toast(`Company created, but the list of companies could not be updated: ${(e as Error).message}`, 'err'));
      toast('Company created', 'ok');
      nav.reset(<Gateway />);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  useScreen({
    title: 'Company Creation',
    noPeriod: true,
    keys: {
      'Ctrl+A': () => void create(),
      'Alt+R': () => nav.push(<GroupCompanyForm />),
      Escape: () => {
        if (!others || nav.depth > 1) return false;
        void shutCompany().catch((e) => toast((e as Error).message, 'err'));
      },
    },
    buttons: [
      { key: 'Alt+R', label: 'Group Company', run: () => nav.push(<GroupCompanyForm />) },
      { key: 'Ctrl+A', label: 'Accept', run: () => void create() },
    ],
  });

  return (
    <div className="max-w-3xl border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-3 text-[15px] font-semibold">Company Creation</h3>
      <Form ref={form} fields={fields} onDone={() => void create()} />
      <p className="mt-4 text-xs text-tb-muted">Enter moves to the next field. Ctrl+A accepts. Alt+R creates a Group Company from existing companies.</p>
    </div>
  );
}
