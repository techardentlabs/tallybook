import { auditLog, createBackup, restoreBackup, fmtDate, type AuditRow } from '@tallybook/core';
import { MenuCard, useMenu, type MenuItem } from '../ui/Menu.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { pickJsonFile, saveTextFile } from '../files.ts';
import { Frame, th, useLoad, useSel } from './Reports.tsx';
import { useFilter } from './reportConfig.tsx';
import { useMemo } from 'react';

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

export function DataMenu() {
  const { books, company, reloadCompany, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();

  const backup = async () => {
    const file = await createBackup(books.db);
    const stamp = new Date().toISOString().slice(0, 10);
    const ok = await saveTextFile(`${company?.name ?? 'company'} ${stamp}.tbbackup.json`, JSON.stringify(file), 'application/json');
    if (ok) toast('Backup saved', 'ok');
  };
  const restore = async () => {
    const f = await pickJsonFile();
    if (!f) return;
    if (!(await dialogs.confirm('Restoring replaces ALL data in this company with the backup. Continue?', { title: 'Restore', def: false }))) return;
    try {
      const r = await restoreBackup(books.db, JSON.parse(f.text));
      await reloadCompany();
      bump();
      toast(`Restored ${r.rows} records`, 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };

  const items: MenuItem[] = [
    { label: 'Data Management', heading: true },
    { label: 'Backup', run: () => void backup(), hotkey: 'B' },
    { label: 'Restore', run: () => void restore(), hotkey: 'R' },
    { label: 'Audit', heading: true },
    { label: 'Edit Log', run: () => nav.push(<EditLogReport />), hotkey: 'E' },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Data', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="Data" items={items} sel={sel} setSel={setSel} />;
}
