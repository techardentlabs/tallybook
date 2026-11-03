import { useEffect, useState, type ReactNode } from 'react';
import type { CompanyIndex } from '@tallybook/core';
import { keyName } from '../keys.ts';
import { topEntry, useScreen, useTop, type Btn } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { MenuCard, useMenu, type MenuItem } from '../ui/Menu.tsx';
import { quitApp } from '../quit.ts';
import { hasUnsaved } from '../unsaved.ts';
import { vault } from '../db/index.ts';
import { createAnotherCompany, currentCompanyEntry, isGroupCompanyOpen, loadCompanyIndex, shutCompany, switchCompany } from '../db/companies.ts';
import { GroupCompanyAlterList, GroupCompanyForm, GroupMembersReport } from './GroupCompany.tsx';
import { CompanyAlter } from './Features.tsx';
import { MiniForm, type MiniRow, type MiniValues } from './Login.tsx';
import { SelectCompanyScreen, VAULT_WARNING } from './Security.tsx';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function BootShell({ status, children }: { status?: string; children: ReactNode }) {
  const top = useTop();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keyName(e);
      const handler = topEntry()?.keys?.[k];
      if (handler) {
        if (handler(e) !== false) e.preventDefault();
        return;
      }
      if (k === 'Ctrl+Q') {
        e.preventDefault();
        void quitApp();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const btns = top?.buttons ?? [];
  return (
    <div className="flex h-full flex-col">
      <header className="bg-tb-top pb-1 pl-3 text-white">
        <div className="flex h-9 items-start">
          <div className="pt-1 text-[17px] leading-none">
            <span className="opacity-80">Tally</span>
            <span className="font-bold opacity-80">Book</span>
          </div>
        </div>
        <div className="h-[37px]" />
      </header>
      <div className="tb-chrome relative flex items-center justify-between bg-tb-strip px-2 text-[12px] font-bold leading-5 text-black">
        <span>{top?.title ?? ''}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto bg-white p-4">{children}</main>
        <aside className="tb-chrome flex w-[155px] shrink-0 flex-col bg-tb-panel pt-1">
          {btns.map((b) => (
            <div key={b.key + b.label} className={`mb-[2px] flex min-h-[28px] items-stretch ${b.disabled ? 'text-[#a7b0b8]' : ''}`}>
              <button disabled={b.disabled} tabIndex={-1} onClick={b.run} className="flex flex-1 cursor-pointer items-center gap-1 border-0 bg-white px-2 py-1 text-left text-[14px] leading-[15px] hover:bg-tb-sel">
                <span className="text-tb-top">{b.key}:</span>
                <span>{b.label}</span>
              </button>
              <span className="flex w-3 items-center justify-center bg-white text-[11px] text-tb-line">‹</span>
            </div>
          ))}
        </aside>
      </div>
      <footer className="flex min-h-6 items-center justify-between bg-tb-strip px-3 text-[12px] text-black">
        <span className={status ? 'font-bold text-tb-danger' : ''}>{status ?? ''}</span>
        <span className="cursor-pointer" onClick={() => void quitApp()}>
          <b className="text-tb-top">Ctrl+Q:</b> Quit
        </span>
      </footer>
    </div>
  );
}

export function CompanyListScreen({ title }: { title: string }) {
  const nav = useNav();
  const { toast } = useStore();
  const [index, setIndex] = useState<CompanyIndex | null>(null);
  useEffect(() => {
    let live = true;
    loadCompanyIndex()
      .then((i) => live && setIndex(i))
      .catch((e) => toast(errText(e), 'err'));
    return () => {
      live = false;
    };
  }, [toast]);
  if (!index) return null;
  return (
    <SelectCompanyScreen
      title={title}
      index={index}
      onOpen={(c) => {
        if (c.id === currentCompanyEntry()?.id) return nav.pop();
        toast(`Opening ${c.name || c.id}...`);
        void switchCompany(c.id).catch((e) => toast(errText(e), 'err'));
      }}
      onCreate={() => void createAnotherCompany().catch((e) => toast(errText(e), 'err'))}
    />
  );
}

export function useShutCompany() {
  const { company, toast } = useStore();
  const dialogs = useDialogs();
  return async () => {
    const name = company?.name ?? currentCompanyEntry()?.name ?? '';
    if (!(await dialogs.confirm(name ? <>Shut <b>{name}</b> ?</> : 'Shut Company ?', { title: 'Shut Company' }))) return;
    await shutCompany().catch((e) => toast(errText(e), 'err'));
  };
}

export function CompanyInfoMenu() {
  const nav = useNav();
  const { company, toast } = useStore();
  const dialogs = useDialogs();
  const shut = useShutCompany();
  const items: MenuItem[] = [
    { label: 'Select Company', run: () => nav.push(<CompanyListScreen title="Select Company" />), hotkey: 'S' },
    { label: 'Shut Company', run: () => void shut(), hotkey: 'H', hotAt: 1 },
    { label: '' },
    { label: 'Create Company', run: () => void createAnotherCompany().catch((e) => toast(errText(e), 'err')), hotkey: 'C' },
    { label: 'Create Group Company', run: () => nav.push(<GroupCompanyForm />), hotkey: 'G' },
    {
      label: 'Alter',
      run: () => {
        const cur = currentCompanyEntry();
        if (cur && isGroupCompanyOpen()) return nav.push(<GroupCompanyForm alterId={cur.id} />);
        return company ? nav.push(<CompanyAlter />) : toast('No company is open', 'err');
      },
      hotkey: 'A',
    },
    { label: 'Alter Group Company', run: () => nav.push(<GroupCompanyAlterList />), hotkey: 'L' },
    ...(isGroupCompanyOpen() ? [{ label: 'Member Companies', run: () => nav.push(<GroupMembersReport />), hotkey: 'M' }] : []),
    { label: 'Change TallyVault', run: () => (company && !isGroupCompanyOpen() ? nav.push(<ChangeVaultScreen />) : toast(company ? 'TallyVault is set for each member company' : 'No company is open', 'err')), hotkey: 'V' },
    { label: '' },
    {
      label: 'Quit',
      run: async () => {
        if (await dialogs.confirm('Quit ?', { title: 'Quit' })) await quitApp();
      },
      hotkey: 'Q',
    },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Company Info.', noPeriod: true, keys, buttons: [] });
  return (
    <div className="flex justify-center pt-[70px]">
      <MenuCard title="Company Info." items={items} sel={sel} setSel={setSel} />
    </div>
  );
}

export function ChangeVaultScreen() {
  const { company, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const encrypted = vault().encrypted();
  const [v, setV] = useState<MiniValues>({ company: company?.name ?? '', old: '', next: '', repeat: '' });
  const [busy, setBusy] = useState(false);
  const rows: MiniRow[] = [
    { key: 'company', label: 'Company Name', kind: 'static' },
    { key: 'old', label: 'Existing TallyVault Password', kind: 'password', hidden: !encrypted, heading: ' ' },
    { key: 'next', label: encrypted ? 'New TallyVault Password' : 'Password', kind: 'password', heading: encrypted ? undefined : ' ' },
    { key: 'repeat', label: 'Confirm Password', kind: 'password' },
  ];
  const save = async () => {
    if (busy) return;
    try {
      if (encrypted && !v.old) throw new Error('Enter the existing TallyVault password');
      if (!encrypted && !v.next) throw new Error('Enter the TallyVault password');
      if (v.next !== v.repeat) throw new Error('TallyVault passwords do not match');
      if (encrypted && !(await vault().verify(v.old))) throw new Error('Incorrect existing TallyVault password');
      const question = !encrypted
        ? `${VAULT_WARNING} Encrypt the company data with this password?`
        : v.next
          ? 'Are you sure you want to alter the TallyVault password?'
          : 'Remove TallyVault encryption? The company data will be stored without encryption.';
      if (!(await dialogs.confirm(question, { title: 'TallyVault', def: false }))) return;
      setBusy(true);
      await vault().change(encrypted ? v.old : '', v.next);
      toast(!encrypted ? 'Company data encrypted with TallyVault' : v.next ? 'TallyVault password changed' : 'TallyVault encryption removed', 'ok');
      nav.pop();
    } catch (e) {
      toast(errText(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  useScreen({
    title: 'TallyVault',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save() },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }],
  });
  return (
    <div className="w-[620px] border border-tb-line bg-tb-paper px-6 py-4">
      <div className="mb-1 text-center font-bold underline">TallyVault</div>
      <div className="mb-4 text-center text-xs italic">
        TallyVault Password encrypts your Company Data.
        <br />
        (If you forget your TallyVault Password, you will permanently lose access to your Company Data.)
      </div>
      <MiniForm labelWidth={260} rows={rows} values={v} onChange={(k, x) => setV((s) => ({ ...s, [k]: x }))} onDone={() => void save()} />
      {encrypted && <div className="mt-3 text-xs italic text-tb-muted">Leave the new password blank to remove TallyVault encryption.</div>}
      {busy && <div className="mt-2 text-tb-muted">Working...</div>}
    </div>
  );
}

export function useCompanyKeys(): { keys: Record<string, () => void>; button: Btn } {
  const nav = useNav();
  const shut = useShutCompany();
  const dialogs = useDialogs();
  const guard = (run: () => void) => () => {
    if (!hasUnsaved()) return run();
    void dialogs.confirm('Quit without saving the voucher ?', { title: 'Quit', def: false, corner: true }).then((yes) => yes && run());
  };
  const change = guard(() => nav.push(<CompanyListScreen title="Change Company" />));
  return {
    keys: {
      F3: change,
      'Alt+F3': guard(() => nav.push(<CompanyInfoMenu />)),
      'Ctrl+F3': guard(() => void shut()),
    },
    button: { key: 'F3', label: 'Company', run: change },
  };
}
