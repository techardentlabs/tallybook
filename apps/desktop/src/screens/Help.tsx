import { useEffect, useState } from 'react';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { appVersion, findUpdate } from '../updater.ts';

export function useUpdateCheck() {
  const { toast } = useStore();
  const dialogs = useDialogs();
  return async (quiet: boolean) => {
    try {
      const u = await findUpdate();
      if (!u) {
        if (!quiet) toast('TallyBook is up to date', 'ok');
        return;
      }
      if (!(await dialogs.confirm(`TallyBook ${u.version} is available. Update now ?`, { title: 'Update' }))) return;
      await u.install((pct) => toast(`Downloading update ${pct}%`));
    } catch (e) {
      if (!quiet) toast(`Could not check for updates: ${(e as Error).message}`, 'err');
    }
  };
}

const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Vouchers',
    rows: [['F4', 'Contra'], ['F5', 'Payment'], ['F6', 'Receipt'], ['F7', 'Journal'], ['F8', 'Sales'], ['F9', 'Purchase'], ['Alt+F6', 'Credit Note'], ['Alt+F5', 'Debit Note']],
  },
  {
    title: 'Everywhere',
    rows: [['Enter', 'Accept field / open'], ['Esc', 'Go back'], ['Ctrl+A', 'Accept the form'], ['Alt+C', 'Create (in a list)'], ['Alt+G', 'Go To'], ['Alt+F2', 'Change period'], ['F11', 'Features'], ['Alt+K', 'Company'], ['Alt+O', 'Import'], ['Alt+E', 'Export'], ['Ctrl+Q', 'Quit']],
  },
  {
    title: 'In a voucher',
    rows: [['F2', 'Change date'], ['Alt+R', 'Remove line'], ['Alt+D', 'Delete voucher'], ['Alt+X', 'Cancel voucher'], ['Alt+2', 'Duplicate voucher'], ['Ctrl+H', 'Change view (invoice / voucher)'], ['D / C', 'Set Dr or Cr']],
  },
  {
    title: 'In reports',
    rows: [['Enter', 'Drill down'], ['Esc', 'Back'], ['Up / Down', 'Move'], ['Alt+E', 'Export']],
  },
];

export function HelpScreen() {
  const check = useUpdateCheck();
  const [version, setVersion] = useState('');
  useEffect(() => void appVersion().then(setVersion), []);
  useScreen({ title: 'Help', noPeriod: true, keys: { 'Alt+U': () => void check(false) }, buttons: [{ key: 'Alt+U', label: 'Check for Updates', run: () => void check(false) }] });
  return (
    <div className="max-w-4xl">
    <div className="mb-3">TallyBook <b>{version}</b></div>
    <div className="grid grid-cols-2 gap-x-8 gap-y-4">
      {SECTIONS.map((s) => (
        <div key={s.title}>
          <div className="mb-1 border-b border-tb-ink font-semibold">{s.title}</div>
          {s.rows.map(([k, d]) => (
            <div key={k} className="flex justify-between">
              <span className="font-bold">{k}</span>
              <span className="text-tb-muted">{d}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
    </div>
  );
}
