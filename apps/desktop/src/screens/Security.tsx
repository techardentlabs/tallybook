import { useEffect, useMemo, useState } from 'react';
import { fmtDate, parseDate } from '@tallybook/core';
import {
  ACCESS_NAMES,
  SECURITY_FACILITIES,
  SECURITY_ROLES,
  baseAccess,
  disableSecurity,
  editLog,
  editLogByUser,
  effectiveAccess,
  accessName,
  enableSecurity,
  passwordPolicy,
  removeUser,
  saveSecurityLevel,
  savePasswordPolicy,
  saveUser,
  securityControl,
  securityEnabled,
  securityLevel,
  securityLevels,
  securityUsers,
  setVaultPassword,
  sortedCompanyRefs,
  vaultEnabled,
  type AccessName,
  type CompanyList,
  type CompanyRef,
  type PasswordPolicy,
  type SecurityRole,
} from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { Frame, th, rowCls, useLoad, useSel } from './Reports.tsx';
import { MiniForm, useSecurity, type MiniRow, type MiniValues } from './Login.tsx';

const yn = (b: boolean) => (b ? 'Yes' : 'No');
const isYes = (s: string) => s === 'Yes';

function Titled({ title, children, width = 640 }: { title: string; children: React.ReactNode; width?: number }) {
  const { company } = useStore();
  return (
    <div className="border border-tb-line bg-tb-paper" style={{ width }}>
      <div className="bg-tb-strip px-2 py-px text-[13px] font-bold">{title}</div>
      <div className="px-6 py-4">
        {company && <div className="mb-3">Name: <b>{company.name}</b></div>}
        {children}
      </div>
    </div>
  );
}

export function CompanySecurityScreen() {
  const { books, bump, toast, company } = useStore();
  const nav = useNav();
  const sec = useSecurity();
  const dialogs = useDialogs();
  const enabled = useLoad(() => securityEnabled(books.db), []);
  const vault = useLoad(() => vaultEnabled(books.db), []);
  const [v, setV] = useState<MiniValues>({ use: 'No', admin: '', password: '', repeat: '', vault: '', vaultRepeat: '' });
  useEffect(() => {
    if (enabled !== null) setV((s) => ({ ...s, use: yn(enabled) }));
  }, [enabled]);
  const rows: MiniRow[] = [
    { key: 'use', label: 'Use Security Control', kind: 'yesno' },
    { key: 'admin', label: 'Name of Administrator', kind: 'text', hidden: !isYes(v.use) || !!enabled },
    { key: 'password', label: 'Password', kind: 'password', hidden: !isYes(v.use) || !!enabled },
    { key: 'repeat', label: 'Repeat Password', kind: 'password', hidden: !isYes(v.use) || !!enabled },
    { key: 'vault', label: 'TallyVault password (asked before this company opens)', kind: 'password', heading: 'TallyVault' },
    { key: 'vaultRepeat', label: 'Confirm Password', kind: 'password' },
  ];
  const save = async () => {
    try {
      if (isYes(v.use) && !enabled) {
        if (v.password !== v.repeat) throw new Error('Passwords do not match');
        await enableSecurity(books.db, { username: v.admin, password: v.password });
      } else if (!isYes(v.use) && enabled) {
        if (!(await dialogs.confirm('Disable security control and remove all users?', { title: 'Security', def: false }))) return;
        await disableSecurity(books.db, sec.user);
        sec.setUser(null);
      }
      if (v.vault || v.vaultRepeat) {
        if (v.vault !== v.vaultRepeat) throw new Error('TallyVault passwords do not match');
        await setVaultPassword(books.db, v.vault);
      }
      await sec.refresh();
      bump();
      toast('Security settings saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title: 'Company Security',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save() },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }],
  });
  if (enabled === null || vault === null) return null;
  return (
    <Titled title={`Company Security${company ? ' - ' + company.name : ''}`}>
      <MiniForm labelWidth={340} rows={rows} values={v} onChange={(k, x) => setV((s) => ({ ...s, [k]: x }))} onDone={() => void save()} />
      {vault && <div className="mt-3 text-xs italic text-tb-muted">A TallyVault password is already set. Leave blank to keep it.</div>}
    </Titled>
  );
}

export function UsersAndPasswordsScreen() {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const users = useLoad(() => securityUsers(books.db), []) ?? [];
  const { sel, setSel, keys } = useSel(users.length);
  const open = (name?: string) => nav.push(<UserForm username={name} />);
  const remove = async () => {
    const u = users[sel];
    if (!u || !(await dialogs.confirm(`Remove user ${u.username}?`, { title: 'Delete', def: false }))) return;
    try {
      await removeUser(books.db, u.username);
      bump();
      toast('User removed', 'ok');
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({
    title: 'List of Users for Company',
    noPeriod: true,
    keys: { ...keys, Enter: () => open(users[sel]?.username), 'Alt+C': () => open(), 'Alt+D': () => void remove() },
    buttons: [
      { key: 'Alt+C', label: 'Create', run: () => open() },
      { key: 'Enter', label: 'Alter', run: () => open(users[sel]?.username) },
      { key: 'Alt+D', label: 'Delete', run: () => void remove() },
    ],
  });
  return (
    <Frame title="List of Users for Company" subtitle="">
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>User Roles</th>
            <th className={`${th} text-left`}>Username</th>
            <th className={`${th} text-left`}>Password (if any)</th>
            <th className={`${th} text-center`}>Allow Browser Access</th>
            <th className={`${th} text-center`}>Allow Remote Access</th>
            <th className={`${th} text-center`}>Allow Local TDL Files</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u, i) => (
            <tr key={u.id} className={rowCls(i === sel, 'font-bold')} onMouseEnter={() => setSel(i)} onClick={() => open(u.username)}>
              <td className="px-2 py-0.5">{u.role}</td>
              <td className="px-2 py-0.5">{u.username}</td>
              <td className="px-2 py-0.5">{u.has_password ? '******' : ''}</td>
              <td className="px-2 py-0.5 text-center">{yn(u.browser_access)}</td>
              <td className="px-2 py-0.5 text-center">{yn(u.remote_access)}</td>
              <td className="px-2 py-0.5 text-center">{yn(u.local_tdl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {users.length === 0 && <div className="py-3 text-tb-muted">Security is not enabled or no users exist. Enable it from Company Security.</div>}
    </Frame>
  );
}

function UserForm({ username }: { username?: string }) {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const dialogs = useDialogs();
  const existing = useLoad(() => (username ? securityUsers(books.db).then((l) => l.find((u) => u.username === username) ?? null) : Promise.resolve(null)), [username]);
  const [v, setV] = useState<MiniValues>({ role: 'Data Entry', username: '', password: '', browser: 'No', remote: 'No', tdl: 'No', active: 'Yes', policy: 'Yes' });
  const [config, setConfig] = useState(false);
  useEffect(() => {
    if (existing)
      setV({
        role: existing.role,
        username: existing.username,
        password: '',
        browser: yn(existing.browser_access),
        remote: yn(existing.remote_access),
        tdl: yn(existing.local_tdl),
        active: yn(existing.active),
        policy: yn(existing.policy_applies),
      });
  }, [existing]);
  const save = async () => {
    try {
      await saveUser(books.db, {
        username: v.username,
        role: v.role as SecurityRole,
        password: v.password || undefined,
        browser_access: isYes(v.browser),
        remote_access: isYes(v.remote),
        local_tdl: isYes(v.tdl),
        active: isYes(v.active),
        policy_applies: isYes(v.policy),
      });
      bump();
      toast('User saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const confirmSave = async () => {
    if (await dialogs.confirm('Accept ?', { corner: true, title: 'Accept' })) await save();
  };
  useScreen({
    title: 'Users and Passwords',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), F12: () => setConfig((c) => !c) },
    buttons: [
      { key: 'F12', label: 'Configure', run: () => setConfig((c) => !c) },
      { key: 'Ctrl+A', label: 'Accept', run: () => void save() },
    ],
  });
  const rows: MiniRow[] = [
    { key: 'role', label: 'User Roles', kind: 'choice', options: [...SECURITY_ROLES] },
    { key: 'username', label: 'Username', kind: 'text' },
    { key: 'password', label: 'Password (if any)', kind: 'password', note: existing?.has_password ? 'Leave blank to keep the current password' : undefined },
    { key: 'browser', label: 'Allow Browser Access', kind: 'yesno' },
    { key: 'remote', label: 'Allow Remote Access', kind: 'yesno' },
    { key: 'tdl', label: 'Allow Local TDL Files', kind: 'yesno' },
    { key: 'active', label: 'Status (Active)', kind: 'yesno', hidden: !config },
    { key: 'policy', label: 'Password Policy applicable', kind: 'yesno', hidden: !config },
  ];
  if (username && existing === null) return null;
  return (
    <Titled title="List of Users for Company">
      <MiniForm labelWidth={220} rows={rows} values={v} onChange={(k, x) => setV((s) => ({ ...s, [k]: x }))} onDone={() => void confirmSave()} />
    </Titled>
  );
}

export function UserRolesScreen() {
  const { books } = useStore();
  const nav = useNav();
  const levels = useLoad(() => securityLevels(books.db), []) ?? [];
  const { sel, setSel, keys } = useSel(levels.length);
  const open = () => levels[sel] && nav.push(<SecurityLevelScreen name={levels[sel].name} />);
  useScreen({ title: 'Security Levels', noPeriod: true, keys: { ...keys, Enter: open }, buttons: [{ key: 'Enter', label: 'Alter', run: open }] });
  return (
    <Frame title="List of Security Levels" subtitle="">
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Name of Security Level</th>
            <th className={`${th} text-left`}>Use Basic Facilities of</th>
          </tr>
        </thead>
        <tbody>
          {levels.map((l, i) => (
            <tr key={l.id} className={rowCls(i === sel, 'font-bold')} onMouseEnter={() => setSel(i)} onClick={() => nav.push(<SecurityLevelScreen name={l.name} />)}>
              <td className="px-2 py-0.5">{l.name}</td>
              <td className="px-2 py-0.5">{l.basis}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {levels.length === 0 && <div className="py-3 text-tb-muted">No security levels. Create users from Users and Passwords.</div>}
    </Frame>
  );
}

export function SecurityLevelScreen({ name }: { name: string }) {
  const { books, bump, toast, company } = useStore();
  const nav = useNav();
  const level = useLoad(() => securityLevel(books.db, name), [name]);
  const [v, setV] = useState<MiniValues>({});
  const [disallow, setDisallow] = useState<string[]>([]);
  const [allow, setAllow] = useState<Record<string, AccessName>>({});
  const [inTable, setInTable] = useState(false);
  const [row, setRow] = useState(0);
  useEffect(() => {
    if (!level) return;
    setV({
      name: level.name,
      basis: level.basis,
      days: String(level.days_back),
      cutoff: level.cutoff_date ? fmtDate(level.cutoff_date) : '',
      views: yn(level.save_views),
      delviews: yn(level.delete_views),
      print: yn(level.print_rules),
      tax: yn(level.override_tax),
      onacc: yn(level.exclude_on_account),
      newno: yn(level.exclude_new_number),
      connect: yn(level.allow_connect),
      tnet: yn(level.tallynet_auth),
    });
    setDisallow(level.disallow);
    setAllow(level.allow);
  }, [level]);
  const facilities = SECURITY_FACILITIES;
  const save = async () => {
    try {
      const cutoff = v.cutoff ? parseDate(v.cutoff, company?.fy_start ?? '') : null;
      await saveSecurityLevel(books.db, {
        name: v.name,
        basis: v.basis as SecurityRole,
        days_back: Number(v.days) || 0,
        cutoff_date: cutoff || null,
        save_views: isYes(v.views),
        delete_views: isYes(v.views) && isYes(v.delviews),
        print_rules: isYes(v.print),
        override_tax: isYes(v.tax),
        exclude_on_account: isYes(v.onacc),
        exclude_new_number: isYes(v.newno),
        allow_connect: isYes(v.connect),
        tallynet_auth: isYes(v.tnet),
        disallow,
        allow,
      });
      bump();
      toast('Security level saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  const cycleAllow = (d: 1 | -1) => {
    const f = facilities[row];
    const opts: (AccessName | '')[] = ['', ...ACCESS_NAMES];
    const cur = opts.indexOf(allow[f] ?? '');
    const next = opts[(cur + d + opts.length) % opts.length];
    setAllow((a) => {
      const n = { ...a };
      if (next) n[f] = next as AccessName;
      else delete n[f];
      return n;
    });
  };
  const toggleDisallow = () => {
    const f = facilities[row];
    setDisallow((d) => (d.includes(f) ? d.filter((x) => x !== f) : [...d, f]));
  };
  const tableKeys: Record<string, () => void> = inTable
    ? {
        ArrowDown: () => setRow((r) => Math.min(r + 1, facilities.length - 1)),
        ArrowUp: () => {
          if (row > 0) return setRow(row - 1);
          setInTable(false);
          const inputs = document.querySelectorAll<HTMLInputElement>('input.tb-input');
          inputs[inputs.length - 1]?.focus();
        },
        PageDown: () => setRow((r) => Math.min(r + 10, facilities.length - 1)),
        PageUp: () => setRow((r) => Math.max(r - 10, 0)),
        Enter: toggleDisallow,
        Space: toggleDisallow,
        ArrowRight: () => cycleAllow(1),
        ArrowLeft: () => cycleAllow(-1),
      }
    : {};
  useScreen({
    title: 'Security Levels',
    noPeriod: true,
    keys: { 'Ctrl+A': () => void save(), ...tableKeys },
    buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }],
  });
  const rows: MiniRow[] = [
    { key: 'name', label: 'Name of security level', kind: 'static' },
    { key: 'basis', label: 'Use Basic Facilities of', kind: 'choice', options: [...SECURITY_ROLES] },
    { key: 'days', label: 'Days allowed for Back Dated vouchers', kind: 'number', heading: ' ' },
    { key: 'cutoff', label: 'Cut-off date for Back Dated vouchers', kind: 'date' },
    { key: 'views', label: 'Allow to save report views for This Company', kind: 'yesno', heading: ' ' },
    { key: 'delviews', label: 'Allow to delete saved views for This Company', kind: 'yesno', indent: true, hidden: !isYes(v.views ?? 'Yes') },
    { key: 'print', label: 'Set/Alter rules for Print Before Save', kind: 'yesno', note: '(also applicable for Export/E-Mail/Upload)' },
    { key: 'tax', label: 'Allow to override tax details', kind: 'yesno' },
    { key: 'onacc', label: 'Exclude On Account from Bill Allocations', kind: 'yesno' },
    { key: 'newno', label: 'Exclude New Number from Item Allocations', kind: 'yesno', note: '(for tracking/orders)' },
    { key: 'connect', label: 'Allow company to connect', kind: 'yesno' },
    { key: 'tnet', label: 'Use Tally.NET Authentication', kind: 'yesno' },
  ];
  if (!level) return null;
  const start = Math.max(0, Math.min(row - 6, facilities.length - 14));
  const window = facilities.slice(start, start + 14);
  return (
    <div className="border border-tb-line bg-tb-paper">
      <div className="flex justify-between bg-tb-strip px-2 py-px text-[13px] font-bold">
        <span>Security Levels</span>
        <span>{company?.name}</span>
      </div>
      <div className="px-5 py-3">
        <MiniForm labelWidth={380} rows={rows} values={v} onChange={(k, x) => setV((s) => ({ ...s, [k]: x }))} onDone={() => {
            (document.activeElement as HTMLElement | null)?.blur();
            setInTable(true);
          }} />
        <div className="mt-3 grid grid-cols-2 border-t border-tb-line pt-2 text-center">
          <div>
            <div className="font-bold underline">Disallow the following Facilities</div>
            <div className="text-xs italic">(others will be allowed)</div>
          </div>
          <div>
            <div className="font-bold underline">Allow the following Facilities</div>
            <div className="text-xs italic">(to re-enable disallowed facilities)</div>
          </div>
        </div>
        <div className="mt-2 border-t border-tb-line pt-2">
          {window.map((f, i) => {
            const on = inTable && start + i === row;
            return (
              <div key={f} className={`grid grid-cols-[110px_1fr_140px_1fr] leading-[20px] ${on ? 'bg-tb-sel' : ''}`} onClick={() => (setInTable(true), setRow(start + i))}>
                <b>{disallow.includes(f) ? 'Full Access' : ''}</b>
                <span>{f}</span>
                <b>{allow[f] ?? ''}</b>
                <span>{allow[f] ? f : ''}</span>
              </div>
            );
          })}
        </div>
        {inTable && <div className="mt-1 text-xs text-tb-muted">Enter or Space: disallow / allow, Left and Right: change access of allowed facility</div>}
      </div>
    </div>
  );
}

export function SecurityControlScreen() {
  const { books } = useStore();
  const data = useLoad(async () => {
    const levels = await securityLevels(books.db);
    const users = await securityUsers(books.db);
    return { levels, users };
  }, []);
  const roles = useMemo(
    () =>
      SECURITY_ROLES.map((role, i) => ({
        id: -(i + 1),
        name: role,
        basis: role as SecurityRole,
        days_back: 0,
        cutoff_date: null,
        save_views: true,
        delete_views: true,
        print_rules: false,
        override_tax: false,
        exclude_on_account: false,
        exclude_new_number: false,
        allow_connect: true,
        tallynet_auth: false,
        disallow: [],
        allow: {},
      })),
    []
  );
  const cols = data && data.levels.length ? data.levels : roles;
  const rows = securityControl(cols);
  const { sel, setSel, keys } = useSel(rows.length);
  useScreen({ title: 'Security Control', noPeriod: true, keys });
  return (
    <Frame title="Security Control" subtitle={data && data.levels.length ? 'Security Levels' : 'Default User Roles'}>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Facility</th>
            {cols.map((c) => (
              <th key={c.name} className={`${th} text-left`}>
                {c.name}
                {data && data.levels.length ? <div className="text-xs font-normal">({c.basis})</div> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.facility} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className="px-2 py-0.5">{r.facility}</td>
              {cols.map((c) => (
                <td key={c.name} className="px-2 py-0.5">
                  {r.access[c.name]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Frame>
  );
}

export function PasswordPolicyScreen() {
  const { books, bump, toast } = useStore();
  const nav = useNav();
  const policy = useLoad(() => passwordPolicy(books.db), []);
  const [v, setV] = useState<MiniValues>({});
  useEffect(() => {
    if (!policy) return;
    setV({
      active: yn(policy.active),
      len: String(policy.min_length),
      adv: yn(policy.advanced),
      alpha: String(policy.min_alpha),
      num: String(policy.min_numeric),
      spec: String(policy.min_special),
      days: String(policy.expires_days),
      notify: yn(policy.notify_expiry),
      old: yn(policy.restrict_old),
      first: yn(policy.change_on_first_login),
      allow: yn(policy.allow_change),
    });
  }, [policy]);
  const save = async () => {
    const p: PasswordPolicy = {
      active: isYes(v.active),
      min_length: Number(v.len),
      advanced: isYes(v.adv),
      min_alpha: Number(v.alpha) || 0,
      min_numeric: Number(v.num) || 0,
      min_special: Number(v.spec) || 0,
      expires_days: Number(v.days),
      notify_expiry: isYes(v.notify),
      restrict_old: isYes(v.old),
      change_on_first_login: isYes(v.first),
      allow_change: isYes(v.allow),
    };
    try {
      await savePasswordPolicy(books.db, p);
      bump();
      toast('Password policy saved', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title: 'Password Policy', noPeriod: true, keys: { 'Ctrl+A': () => void save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void save() }] });
  const on = isYes(v.active ?? 'No');
  const rows: MiniRow[] = [
    { key: 'active', label: 'Activate password policy', kind: 'yesno' },
    { key: 'len', label: 'Minimum password length', kind: 'number', heading: 'Password Strength', hidden: !on },
    { key: 'adv', label: 'Specify advanced parameters for password strength', kind: 'yesno', hidden: !on },
    { key: 'alpha', label: 'Alphabetic', kind: 'number', indent: true, hidden: !on || !isYes(v.adv ?? 'No') },
    { key: 'num', label: 'Numeric', kind: 'number', indent: true, hidden: !on || !isYes(v.adv ?? 'No') },
    { key: 'spec', label: 'Special characters', kind: 'number', indent: true, hidden: !on || !isYes(v.adv ?? 'No') },
    { key: 'days', label: 'Password expires after (days)', kind: 'number', heading: 'Password Expiry', note: "(Set '0' to disable Password Expiry)", hidden: !on },
    { key: 'notify', label: 'Notify users before password expires', kind: 'yesno', hidden: !on },
    { key: 'old', label: 'Restrict the use of old passwords', kind: 'yesno', hidden: !on },
    { key: 'first', label: 'Change password on first login', kind: 'yesno', heading: 'Other Options', hidden: !on },
    { key: 'allow', label: 'Allow users to change password', kind: 'yesno', hidden: !on },
  ];
  if (!policy) return null;
  return (
    <Titled title="Password Policy for Company" width={620}>
      <MiniForm labelWidth={360} rows={rows} values={v} onChange={(k, x) => setV((s) => ({ ...s, [k]: x }))} onDone={() => void save()} />
    </Titled>
  );
}

export function EditLogScreen() {
  const { books, period } = useStore();
  const nav = useNav();
  const [user, setUser] = useState<string | undefined>(undefined);
  const data = useLoad(async () => ({ log: await editLog(books.db, { username: user }), by: await editLogByUser(books.db) }), [user]);
  const log = data?.log ?? [];
  const { sel, setSel, keys } = useSel(log.length);
  const cycle = () => {
    const names = (data?.by ?? []).map((b) => b.username);
    if (!names.length) return;
    const i = user === undefined ? -1 : names.indexOf(user);
    setUser(i + 1 >= names.length ? undefined : names[i + 1]);
  };
  useScreen({
    title: 'Edit Log',
    noPeriod: true,
    keys: { ...keys, 'Alt+F1': cycle, Escape: () => (nav.pop(), true) },
    buttons: [{ key: 'Alt+F1', label: user ? `User: ${user}` : 'User: All', run: cycle }],
  });
  return (
    <Frame title="Edit Log" subtitle={user ? `User: ${user}` : `All Users (${fmtDate(period.from)} onwards)`}>
      <table className="w-full">
        <thead>
          <tr>
            <th className={`${th} text-left`}>Date and Time</th>
            <th className={`${th} text-left`}>User</th>
            <th className={`${th} text-left`}>Action</th>
            <th className={`${th} text-left`}>Entity</th>
            <th className={`${th} text-left`}>Detail</th>
          </tr>
        </thead>
        <tbody>
          {log.map((e, i) => (
            <tr key={e.id} className={rowCls(i === sel)} onMouseEnter={() => setSel(i)}>
              <td className="px-2 py-0.5">{fmtDate(e.at.slice(0, 10))} {e.at.slice(11, 19)}</td>
              <td className="px-2 py-0.5">{e.username}</td>
              <td className="px-2 py-0.5 capitalize">{e.action}</td>
              <td className="px-2 py-0.5">{e.entity}{e.entity_id ? ` #${e.entity_id}` : ''}</td>
              <td className="px-2 py-0.5">{e.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {log.length === 0 && <div className="py-3 text-tb-muted">No changes have been logged.</div>}
    </Frame>
  );
}

export function SelectCompanyScreen({ list, onOpen, onCreate }: { list: CompanyList; onOpen: (c: CompanyRef) => void; onCreate?: () => void }) {
  const items = sortedCompanyRefs(list);
  const { sel, setSel, keys } = useSel(items.length);
  useScreen({
    title: 'Select Company',
    noPeriod: true,
    keys: { ...keys, Enter: () => items[sel] && onOpen(items[sel]), ...(onCreate ? { 'Alt+C': onCreate } : {}) },
    buttons: [
      { key: 'Enter', label: 'Open', run: () => items[sel] && onOpen(items[sel]) },
      ...(onCreate ? [{ key: 'Alt+C', label: 'Create Company', run: onCreate }] : []),
    ],
  });
  return (
    <div className="w-[480px] border border-tb-line bg-tb-menu">
      <div className="bg-tb-top px-2 py-1 text-[15px] text-white">List of Companies</div>
      <ul>
        {items.map((c, i) => (
          <li key={c.id} className={`flex cursor-pointer justify-between px-2 py-px ${i === sel ? 'bg-tb-sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => onOpen(c)}>
            <b>{c.name}</b>
            <i className="text-xs">{c.path}</i>
          </li>
        ))}
        {items.length === 0 && <li className="px-2 py-1 text-tb-muted">No companies</li>}
      </ul>
    </div>
  );
}

export { baseAccess, effectiveAccess, accessName };
