import { isGroupCompanyOpen } from './db/companies.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Ledger } from '@tallybook/core';
import { keyName, VOUCHER_HOTKEYS } from './keys.ts';
import { screenDenial, showAccessDenied, topEntry, useTop } from './registry.ts';
import { useStore } from './store.tsx';
import { useNav } from './nav.tsx';
import { Gateway, useGo } from './screens/Gateway.tsx';
import { SelectList, type ListItem } from './screens/SelectList.tsx';
import { FeaturesScreen, CompanyAlter } from './screens/Features.tsx';
import { HelpScreen, useUpdateCheck } from './screens/Help.tsx';
import { LedgerReport } from './screens/Reports.tsx';
import { VoucherScreen } from './screens/Voucher.tsx';
import { canCurrent, ensureJobWork, ensureMfg, ensureStockVoucherTypes, fmtDate, GROUP_READ_ONLY } from '@tallybook/core';
import { saveTextFile } from './files.ts';
import { PayrollVoucherScreen, AttendanceVoucherScreen } from './screens/PayrollVoucher.tsx';
import { useShareKeys } from './screens/Share.tsx';
import { usePrintKeys } from './screens/PrintMenu.tsx';
import { CompanyMenu } from './screens/CompanyMenu.tsx';
import { DataMenu } from './screens/DataMenu.tsx';
import { useCompanyKeys } from './screens/Companies.tsx';

function exportVisibleTable(toast: (m: string, k?: 'ok' | 'err') => void) {
  const tables = [...document.querySelectorAll('main table')];
  if (!tables.length) return toast('Nothing on this screen to export', 'err');
  const q = (t: string) => `"${t.replace(/\s+/g, ' ').trim().replace(/"/g, '""')}"`;
  const csv = tables.map((t) => [...t.querySelectorAll('tr')].map((r) => [...r.children].map((c) => q(c.textContent ?? '')).join(',')).join('\r\n')).join('\r\n\r\n');
  const title = document.querySelector('main .font-semibold')?.textContent?.trim() || 'report';
  void saveTextFile(`${title}.csv`, csv, 'text/csv').then(() => toast('Report exported', 'ok'));
}

function GoTo() {
  const go = useGo();
  const { books, company } = useStore();
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  useEffect(() => void books.ledgers().then(setLedgers), [books]);
  const actions: { item: ListItem; run: () => void }[] = [
    { item: { id: 'bs', label: 'Balance Sheet', sub: 'Common Reports' }, run: go.balanceSheet },
    { item: { id: 'pl', label: 'Profit & Loss A/c', sub: 'Common Reports' }, run: go.profitLoss },
    { item: { id: 'tb', label: 'Trial Balance', sub: 'Common Reports' }, run: go.trialBalance },
    { item: { id: 'db', label: 'Day Book', sub: 'Common Reports' }, run: go.dayBook },
    { item: { id: 'rc', label: 'Bills Receivable', sub: 'Common Reports' }, run: go.receivables },
    { item: { id: 'py', label: 'Bills Payable', sub: 'Common Reports' }, run: go.payables },
    { item: { id: 'g1', label: 'GSTR-1', sub: 'GST Reports' }, run: go.gstr1 },
    { item: { id: 'g3', label: 'GSTR-3B', sub: 'GST Reports' }, run: go.gstr3b },
    { item: { id: 'coa', label: 'Chart of Accounts', sub: 'Create / Alter' }, run: go.chart },
    { item: { id: 'cl', label: 'Create Ledger', sub: 'Create / Alter' }, run: go.createLedger },
    { item: { id: 'cg', label: 'Create Group', sub: 'Create / Alter' }, run: go.createGroup },
    ...(company?.payroll_enabled ? [{ item: { id: 'att', label: 'Attendance Voucher', sub: 'Vouchers' }, run: () => go.nav.push(<AttendanceVoucherScreen />) }] : []),
    { item: { id: 'imp', label: 'Import Data', sub: 'Import / Export' }, run: go.importData },
    { item: { id: 'exp', label: 'Export Data', sub: 'Import / Export' }, run: go.exportData },
    ...ledgers.map((l) => ({ item: { id: `l${l.id}`, label: `Ledger: ${l.name}`, sub: l.group_name }, run: () => go.nav.push(<LedgerReport ledgerId={l.id} />) })),
  ];
  return <SelectList title="Go To" heading="List of Reports" grouped popOnSelect items={actions.map((a) => a.item)} onSelect={(i) => actions.find((a) => a.item.id === i.id)?.run()} />;
}

export function Shell({ children }: { children: ReactNode }) {
  const { company, period, status, toast } = useStore();
  const nav = useNav();
  const go = useGo();
  const top = useTop();
  const updateCheck = useUpdateCheck();
  useEffect(() => {
    const t = setTimeout(() => void updateCheck(true), 4000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const shareKeys = useShareKeys(fmtDate);
  const printKeys = usePrintKeys(fmtDate);
  const companyKeys = useCompanyKeys();
  const extraKeys = useRef<Record<string, (e: KeyboardEvent) => void | boolean>>({});
  extraKeys.current = { ...shareKeys, ...printKeys, ...companyKeys.keys } as never;
  const { books, bump } = useStore();
  useEffect(() => {
    if (company?.inventory_enabled) void ensureStockVoucherTypes(books.db).then(async (added) => { const before = (await books.voucherTypes()).length; await ensureMfg(books.db); await ensureJobWork(books.db); if (added || (await books.voucherTypes()).length !== before) bump(); });
  }, [company?.inventory_enabled, company?.job_work_enabled, books, bump]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyName(e);
      const t = topEntry();
      const handler = t?.keys?.[k];
      if (handler && k === 'F12' && t?.kind !== 'modal' && !canCurrent('Configuration.display')) {
        e.preventDefault();
        return showAccessDenied();
      }
      if (handler) {
        if (handler(e) !== false) e.preventDefault();
        return;
      }
      if (t?.swallow) {
        const el = e.target as HTMLElement | null;
        const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !e.ctrlKey && !e.altKey && !e.metaKey && !/^F\d+$/.test(e.key);
        if (!typing && !['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) e.preventDefault();
        return;
      }
      if (t?.kind === 'modal') return;
      if (!company) return;
      const voucher = VOUCHER_HOTKEYS[k];
      if (voucher && ['Stock Journal', 'Physical Stock', 'Delivery Note', 'Receipt Note', 'Sales Order', 'Purchase Order', 'Rejection In', 'Rejection Out'].includes(voucher) && !company.inventory_enabled) {
        e.preventDefault();
        return toast('Enable inventory in F11 (Features) to use this voucher', 'err');
      }
      const global: Record<string, () => void> = {
        'Alt+G': () => nav.push(<GoTo />),
        'Alt+K': () => nav.push(<CompanyMenu />),
        'Alt+Y': () => nav.push(<DataMenu />),
        'Alt+Z': () => toast('Exchange is not available yet', 'err'),
        'Alt+O': go.importData,
        'Alt+E': go.exportData,
        F1: () => nav.push(<HelpScreen />),
        F11: () => nav.push(<FeaturesScreen />),
        'Ctrl+Q': () => void go.quit(),
        'Ctrl+F4': () => (company.payroll_enabled ? nav.push(<PayrollVoucherScreen />) : toast('Enable payroll in F11 (Features) to use this voucher', 'err')),
        'Ctrl+E': () => (screenDenial('Share') ? showAccessDenied() : exportVisibleTable(toast)),
      };
      if (voucher && isGroupCompanyOpen()) {
        e.preventDefault();
        return toast(GROUP_READ_ONLY, 'err');
      }
      if (voucher) {
        e.preventDefault();
        if (t?.kind === 'voucher') nav.replace(<VoucherScreen typeName={voucher} />);
        else nav.push(<VoucherScreen typeName={voucher} />);
        return;
      }
      const g = extraKeys.current[k] ? () => extraKeys.current[k](e) : global[k];
      if (g) {
        e.preventDefault();
        g();
        return;
      }
      if (k === 'Escape' && nav.depth > 1) {
        e.preventDefault();
        nav.pop();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [company, nav, go, toast]);

  const soon = (n: string) => () => toast(`${n} is not available yet`, 'err');
  const manage: [string, string, () => void][] = [
    ['K', 'Company', () => nav.push(<CompanyMenu />)],
    ['Y', 'Data', () => nav.push(<DataMenu />)],
    ['Z', 'Exchange', soon('Exchange')],
  ];
  const actions: [string, string, () => void][] = [
    ['O', 'Import', go.importData],
    ['E', 'Export', go.exportData],
    ['M', 'E-mail', () => extraKeys.current['Alt+M']?.(new KeyboardEvent('keydown'))],
    ['P', 'Print', () => extraKeys.current['Alt+P']?.(new KeyboardEvent('keydown'))],
  ];
  const link = (k: string, label: string, run: () => void) => (
    <button key={k} onClick={run} className="cursor-pointer border-0 bg-transparent px-2 text-[15px] text-white hover:bg-white/15">
      <u>{k}</u>: {label}
    </button>
  );

  return (
    <div className="flex h-full flex-col">
      <header className="bg-tb-top pb-1 pl-3 text-white">
        <div className="flex h-9 items-start">
          <div className="pt-1 text-[17px] leading-none">
            <span className="opacity-80">Tally</span>
            <span className="font-bold opacity-80">Book</span>
          </div>
        </div>
        {company && (
          <div className="flex items-end">
            <div className="ml-24 mr-6 border-t border-white/40 pt-0.5">
              <div className="pl-2 text-[11px] font-bold uppercase tracking-wide text-tb-strip">Manage</div>
              <div className="flex gap-8">{manage.map(([k, l, r]) => link(k, l, r))}</div>
            </div>
            <button onClick={() => nav.push(<GoTo />)} className="cursor-pointer border-0 bg-tb-menu px-8 py-0.5 text-[15px] text-black">
              <u>G</u>: Go To
            </button>
            <div className="flex-1" />
            <div className="flex gap-6 pr-6">{actions.map(([k, l, r]) => link(k, l, r))}{link('F1', 'Help', () => nav.push(<HelpScreen />))}</div>
          </div>
        )}
      </header>
      <div className="tb-chrome relative flex items-center justify-between bg-tb-strip px-2 text-[12px] font-bold leading-5 text-black">
        <span>{top?.title ?? ''}</span>
        <span className="absolute left-1/2 -translate-x-1/2">{company && nav.depth > 1 && !top?.noPeriod ? company.name : ''}</span>
        <span className="flex gap-4">
          <span>{company && !top?.noPeriod && nav.depth > 1 ? `${fmtDate(period.from)} to ${fmtDate(period.to)}` : ''}</span>
          <span className="cursor-pointer" onClick={() => nav.depth > 1 && nav.pop()}>✕</span>
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto bg-white p-4">{children}</main>
        <aside className="tb-chrome flex w-[155px] shrink-0 flex-col bg-tb-panel pt-1">
          {(() => {
            const btns = top?.buttons ?? [];
            const norm = (k: string) => (k === 'Alt+F2' ? 'F2' : k);
            const find = (k: string) => btns.find((b) => norm(b.key) === k);
            const used = new Set<string>();
            const slot = (k: string) => {
              const given = find(k);
              const b = k === 'F3' && company && !given?.run && top?.kind !== 'modal' ? companyKeys.button : given;
              if (given) used.add(given.key);
              const label = b?.label ?? '';
              const disabled = !b || !!b.disabled;
              return (
                <div key={k} className={`mb-[2px] flex h-[28px] items-stretch ${disabled ? 'text-[#a7b0b8]' : ''}`}>
                  <button
                    disabled={disabled}
                    tabIndex={-1}
                    onClick={b?.run}
                    className={`flex flex-1 cursor-pointer items-center gap-1 border-0 bg-white px-2 text-left text-[14px] leading-[15px] ${disabled ? '' : 'hover:bg-tb-sel'}`}
                  >
                    <span className={disabled ? '' : 'text-tb-top'}>{k}:</span>
                    <span>{label}</span>
                  </button>
                  <span className="flex w-3 items-center justify-center bg-white text-[11px] text-tb-line">‹</span>
                </div>
              );
            };
            const rest = btns.filter((b) => !used.has(b.key) && !['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F12', 'Alt+F2'].includes(b.key));
            const rest2 = (() => {
              ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F12'].forEach((k) => find(k) && used.add(find(k)!.key));
              return btns.filter((b) => !used.has(b.key) && !['Alt+F2'].includes(b.key));
            })();
            const letter = (k: string) => (k.includes('+') ? k.split('+').pop()! : k);
            const isF = (k: string) => /^F\d+$/.test(letter(k));
            void rest;
            return (
              <>
                {['F2', 'F3', 'F4'].map(slot)}
                <div className="h-6" />
                {['F5', 'F6', 'F7', 'F8', 'F9', 'F10'].map(slot)}
                <div className="h-6" />
                {rest2.map((b) => (
                  <div key={b.key + b.label} className={`mb-[2px] flex min-h-[28px] items-stretch ${b.disabled ? 'text-[#a7b0b8]' : ''}`}>
                    <button disabled={b.disabled} tabIndex={-1} onClick={b.run} className="flex flex-1 cursor-pointer items-center gap-1 border-0 bg-white px-2 py-1 text-left text-[14px] leading-[15px] hover:bg-tb-sel">
                      <span className="text-tb-top">
                        {isF(b.key) ? `${b.key}:` : <><u>{letter(b.key)}</u>:</>}
                      </span>
                      <span>{b.label}</span>
                    </button>
                    <span className="flex w-3 items-center justify-center bg-white text-[11px] text-tb-line">‹</span>
                  </div>
                ))}
                <div className="flex-1" />
                {slot('F12')}
              </>
            );
          })()}
        </aside>
      </div>
      <footer className="flex min-h-6 items-center justify-between bg-tb-strip px-3 text-[12px] text-black">
        <span className={status.kind === 'err' ? 'font-bold text-tb-danger' : ''}>{status.msg}</span>
        <span className="cursor-pointer" onClick={() => nav.depth > 1 ? nav.pop() : void go.quit()}>
          <b className="text-tb-top">Ctrl+Q:</b> Quit
        </span>
      </footer>
    </div>
  );
}

export { Gateway };
