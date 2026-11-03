import { auditLog, backupNeedsPassword, createBackup, createVaultBackup, restoreBackup, fmtDate, type AuditRow } from '@tallybook/core';
import { MenuCard, useMenu, type MenuItem } from '../ui/Menu.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { pickJsonFile, saveTextFile } from '../files.ts';
import { Frame, th, useLoad, useSel } from './Reports.tsx';
import { useFilter } from './reportConfig.tsx';
import { useMemo, useState } from 'react';
import { vault } from '../db/index.ts';
import { VaultPasswordPanel } from './Login.tsx';
import { SplitMenu } from './SplitCompany.tsx';
import { isGroupCompanyOpen } from '../db/companies.ts';
import { GROUP_READ_ONLY } from '@tallybook/core';

export function EditLogReport() {
  const { books } = useStore();
  const flt = useFilter();
  const data = useLoad<AuditRow[]>(() => auditLog(books.db), []);
  const rows = useMemo(() => (data ?? []).filter((r) => flt.match(r.name, r.action, r.object)), [data, flt]);
  const { sel, setSel, keys } = useSel(rows.length);
  useScreen({ title: 'Edit Log', keys: { ...keys, ...flt.key }, buttons: [flt.button] });
  if (!data) return null;
  return (
    <Frame title="Edit Log" subtitle="Changes made to masters and vouchers, latest first">
      {flt.bar}
      <table className="w-full">
        <thead>
          <tr className="text-left">
            <th className={th}>Date and time</th>
            <th className={th}>Action</th>
            <th className={th}>Type</th>
            <th className={th}>Particulars</th>
            <th className={th}>User</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={i === sel ? 'bg-tb-sel' : ''} onMouseEnter={() => setSel(i)}>
              <td className="px-2">{fmtDate(r.at.slice(0, 10))} {r.at.slice(11, 16)}</td>
              <td className="px-2">{r.action}</td>
              <td className="px-2">{r.object}</td>
              <td className="px-2 font-bold">{r.name}</td>
              <td className="px-2">{r.username}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <div className="py-3 text-tb-muted">No changes recorded yet.</div>}
    </Frame>
  );
}

interface Ask {
  title: string;
  message: string;
  submit: (password: string) => Promise<void>;
}

export function DataMenu() {
  const { books, company, reloadCompany, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const [ask, setAsk] = useState<Ask | null>(null);

  const save = async (text: string) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const ok = await saveTextFile(`${company?.name ?? 'company'} ${stamp}.tbbackup.json`, text, 'application/json');
    if (ok) toast('Backup saved', 'ok');
  };
  const backup = async () => {
    if (isGroupCompanyOpen()) return toast('Backup a Group Company by taking the backup of each member company', 'err');
    try {
      if (!vault().encrypted()) return await save(JSON.stringify(await createBackup(books.db)));
      setAsk({
        title: 'Backup',
        message: 'This company is protected by TallyVault. The backup will be encrypted with the TallyVault password.',
        submit: async (pw) => {
          if (!(await vault().verify(pw))) throw new Error('Incorrect TallyVault password');
          const file = await createVaultBackup(books.db, pw);
          setAsk(null);
          await save(JSON.stringify(file)).catch((e: Error) => toast(e.message, 'err'));
        },
      });
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const apply = async (data: unknown, password?: string) => {
    const r = await restoreBackup(books.db, data, password);
    await reloadCompany();
    bump();
    toast(`Restored ${r.rows} records`, 'ok');
    nav.pop();
  };
  const restore = async () => {
    if (isGroupCompanyOpen()) return toast(GROUP_READ_ONLY, 'err');
    const f = await pickJsonFile();
    if (!f) return;
    let data: unknown;
    try {
      data = JSON.parse(f.text);
    } catch {
      return toast('This is not a TallyBook backup file', 'err');
    }
    if (!(await dialogs.confirm('Restoring replaces ALL data in this company with the backup. Continue?', { title: 'Restore', def: false }))) return;
    if (backupNeedsPassword(data)) {
      setAsk({
        title: 'Restore',
        message: 'This backup is encrypted with TallyVault. Enter the TallyVault password of the company it was taken from.',
        submit: async (pw) => {
          await apply(data, pw);
          setAsk(null);
        },
      });
      return;
    }
    try {
      await apply(data);
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const items: MenuItem[] = [
    { label: 'Data Management', heading: true },
    { label: 'Backup', run: () => void backup(), hotkey: 'B' },
    { label: 'Restore', run: () => void restore(), hotkey: 'R' },
    { label: 'Split', run: () => nav.push(<SplitMenu />), hotkey: 'S', hint: '>' },
    { label: 'Audit', heading: true },
    { label: 'Edit Log', run: () => nav.push(<EditLogReport />), hotkey: 'E' },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Data', noPeriod: true, keys, buttons: [] });
  return (
    <>
      <MenuCard title="Data" items={items} sel={sel} setSel={setSel} />
      {ask && <VaultPasswordPanel title={ask.title} message={ask.message} submit={ask.submit} onCancel={() => setAsk(null)} />}
    </>
  );
}
