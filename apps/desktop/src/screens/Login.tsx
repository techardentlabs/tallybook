import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  can as canDo,
  changePassword,
  clearLegacyVault,
  currentUser,
  login,
  onUserChange,
  securityEnabled,
  setCurrentUser,
  unlockVault,
  vaultEnabled,
  type Action,
  type SecurityUser,
} from '@tallybook/core';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { vault } from '../db/index.ts';

export type MiniKind = 'text' | 'password' | 'yesno' | 'number' | 'date' | 'choice' | 'static';

export interface MiniRow {
  key: string;
  label: string;
  kind: MiniKind;
  options?: string[];
  note?: string;
  heading?: string;
  hidden?: boolean;
  indent?: boolean;
  bold?: boolean;
}

export type MiniValues = Record<string, string>;

export function MiniForm({
  rows,
  values,
  onChange,
  onDone,
  labelWidth = 330,
  autoFocus = true,
}: {
  rows: MiniRow[];
  values: MiniValues;
  onChange: (key: string, value: string) => void;
  onDone: () => void;
  labelWidth?: number;
  autoFocus?: boolean;
}) {
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const active = useCallback(() => rows.filter((r) => !r.hidden && r.kind !== 'static').map((r) => r.key), [rows]);
  const focus = (key: string | undefined) => key && setTimeout(() => refs.current[key]?.focus(), 0);
  const step = (key: string, d: 1 | -1) => {
    const keys = active();
    focus(keys[keys.indexOf(key) + d]);
  };
  useEffect(() => {
    if (autoFocus) focus(active()[0]);
  }, []);
  const cycle = (row: MiniRow, dir: 1 | -1) => {
    const opts = row.kind === 'yesno' ? ['Yes', 'No'] : row.options ?? [];
    if (!opts.length) return;
    const i = opts.indexOf(values[row.key]);
    onChange(row.key, opts[(i + dir + opts.length) % opts.length]);
  };
  const onKey = (row: MiniRow) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const pick = row.kind === 'yesno' || row.kind === 'choice';
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const keys = active();
      if (keys[keys.length - 1] === row.key) onDone();
      else step(row.key, 1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (pick && e.shiftKey) cycle(row, e.key === 'ArrowDown' ? 1 : -1);
      else step(row.key, e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'Backspace' && (pick || e.currentTarget.value === '')) {
      e.preventDefault();
      e.stopPropagation();
      step(row.key, -1);
    } else if (pick) {
      if (row.kind === 'yesno' && /^[yYnN]$/.test(e.key)) {
        e.preventDefault();
        onChange(row.key, /^[yY]$/.test(e.key) ? 'Yes' : 'No');
      } else if (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        cycle(row, e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key.length === 1) e.preventDefault();
    }
  };
  return (
    <div>
      {rows.map((r) =>
        r.hidden ? null : (
          <div key={r.key}>
            {r.heading ? <div className="mb-0.5 mt-3 font-bold">{r.heading}</div> : null}
            <div className="flex items-center leading-[22px]">
              <label className={`shrink-0 ${r.indent ? 'pl-3' : ''}`} style={{ width: labelWidth }}>
                {r.label}
              </label>
              <span className="mr-1">:</span>
              {r.kind === 'static' ? (
                <span className="font-bold">{values[r.key]}</span>
              ) : (
                <input
                  ref={(el) => {
                    refs.current[r.key] = el;
                  }}
                  type={r.kind === 'password' ? 'password' : 'text'}
                  className={`tb-input w-[260px] ${r.kind === 'number' ? 'tb-num' : ''} ${r.bold !== false ? 'font-bold' : ''}`}
                  value={values[r.key] ?? ''}
                  readOnly={r.kind === 'yesno' || r.kind === 'choice'}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => onChange(r.key, e.target.value)}
                  onKeyDown={onKey(r)}
                />
              )}
              {r.note ? <span className="ml-3 text-xs italic text-tb-muted">{r.note}</span> : null}
            </div>
          </div>
        )
      )}
    </div>
  );
}

interface Security {
  enabled: boolean;
  user: SecurityUser | null;
  can: (action: Action) => boolean;
  setUser: (u: SecurityUser | null) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<Security | null>(null);

export function SecurityProvider({ children }: { children: ReactNode }) {
  const { books, version } = useStore();
  const [enabled, setEnabled] = useState(false);
  const [user, setUserState] = useState<SecurityUser | null>(currentUser());
  const refresh = useCallback(async () => {
    setEnabled(await securityEnabled(books.db).catch(() => false));
  }, [books]);
  useEffect(() => {
    void refresh();
  }, [refresh, version]);
  useEffect(() => onUserChange(() => setUserState(currentUser())), []);
  const value = useMemo<Security>(
    () => ({ enabled, user, can: (a) => !enabled || canDo(user, a), setUser: setCurrentUser, refresh }),
    [enabled, user, refresh]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSecurity(): Security {
  const s = useContext(Ctx);
  if (!s) throw new Error('SecurityProvider missing');
  return s;
}

export function LoginGate({ children }: { children: ReactNode }) {
  const { books, company } = useStore();
  const { enabled, user, setUser } = useSecurity();
  const [vaultOk, setVaultOk] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const legacy = await vaultEnabled(books.db).catch(() => false);
      if (legacy && vault().encrypted()) {
        await clearLegacyVault(books.db).catch(() => undefined);
        if (live) setVaultOk(true);
        return;
      }
      if (live) setVaultOk(!legacy);
    })();
    return () => {
      live = false;
    };
  }, [books, company?.name]);
  if (vaultOk === null) return null;
  if (!vaultOk) return <LegacyVaultPrompt onOpen={() => setVaultOk(true)} />;
  if (enabled && !user) return <LoginScreen onLogin={setUser} />;
  return <>{children}</>;
}

function Panel({ title, children, width = 440 }: { title: string; children: ReactNode; width?: number }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-tb-wash pt-[16vh]">
      <div className="border border-tb-line bg-tb-paper shadow-md" style={{ width }}>
        <div className="bg-tb-top px-2 py-1 text-center text-[15px] text-white">{title}</div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong');

function VaultPasswordForm({ message, submit, busyText = 'Checking password...' }: { message?: ReactNode; submit: (password: string) => Promise<void>; busyText?: string }) {
  const [v, setV] = useState<MiniValues>({ pw: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    if (!v.pw) return setErr('Enter the TallyVault password');
    setBusy(true);
    setErr('');
    try {
      await submit(v.pw);
    } catch (e) {
      setErr(errText(e));
      setV({ pw: '' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {message && <div className="mb-3">{message}</div>}
      <MiniForm
        labelWidth={140}
        rows={[{ key: 'pw', label: 'Password', kind: 'password' }]}
        values={v}
        onChange={(k, x) => {
          setErr('');
          setV((s) => ({ ...s, [k]: x }));
        }}
        onDone={() => void go()}
      />
      {busy && <div className="mt-3 text-tb-muted">{busyText}</div>}
      {err && <div className="mt-3 text-tb-danger">{err}</div>}
    </>
  );
}

export function VaultUnlock({ unlock, company, onCancel }: { unlock: (password: string) => Promise<void>; company?: string; onCancel?: () => void }) {
  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <Panel title="TallyVault Password" width={460}>
      <VaultPasswordForm
        message={
          company ? (
            <>
              <b>{company}</b> is encrypted with TallyVault. Enter the TallyVault password to open it.
            </>
          ) : (
            'This company is encrypted with TallyVault. Enter the TallyVault password to open it.'
          )
        }
        submit={unlock}
        busyText="Opening company..."
      />
      {onCancel && <div className="mt-3 text-xs italic text-tb-muted">Press Esc to go back to the list of companies</div>}
    </Panel>
  );
}

export function VaultPasswordPanel({ title, message, submit, onCancel }: { title: string; message?: ReactNode; submit: (password: string) => Promise<void>; onCancel: () => void }) {
  useScreen({ title, noPeriod: true, kind: 'modal', keys: { Escape: () => onCancel() }, buttons: [] });
  return (
    <Panel title={title} width={460}>
      <VaultPasswordForm message={message} submit={submit} />
      <div className="mt-3 text-xs italic text-tb-muted">Press Esc to cancel</div>
    </Panel>
  );
}

function LegacyVaultPrompt({ onOpen }: { onOpen: () => void }) {
  const { books, toast } = useStore();
  const submit = async (pw: string) => {
    if (!(await unlockVault(books.db, pw))) {
      toast('Incorrect TallyVault password', 'err');
      throw new Error('Incorrect TallyVault password');
    }
    try {
      await vault().change('', pw);
      await clearLegacyVault(books.db);
      toast('Company data is now encrypted with TallyVault', 'ok');
    } catch (e) {
      toast(`Could not encrypt the company data: ${errText(e)}`, 'err');
    }
    onOpen();
  };
  useScreen({ title: 'TallyVault', noPeriod: true, kind: 'modal', keys: {}, buttons: [] });
  return (
    <Panel title="TallyVault Password" width={460}>
      <VaultPasswordForm message="Enter the TallyVault password. The company data will be encrypted with it." submit={submit} />
    </Panel>
  );
}

export function LoginScreen({ onLogin }: { onLogin: (u: SecurityUser) => void }) {
  const { books, company } = useStore();
  const [v, setV] = useState<MiniValues>({ company: company?.name ?? '', username: '', password: '' });
  const [err, setErr] = useState('');
  const [pending, setPending] = useState<SecurityUser | null>(null);
  const submit = async () => {
    try {
      const r = await login(books.db, v.username, v.password);
      if (r.must_change) setPending(r.user);
      else onLogin(r.user);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useScreen({ title: 'Login', noPeriod: true, swallow: true, kind: 'modal', keys: {}, buttons: [] });
  if (pending) return <ForcedChange user={pending} oldPassword={v.password} onDone={onLogin} />;
  return (
    <Panel title="Company Login">
      <MiniForm
        labelWidth={130}
        rows={[
          { key: 'company', label: 'Select Company', kind: 'static' },
          { key: 'username', label: 'Username', kind: 'text' },
          { key: 'password', label: 'Password', kind: 'password' },
        ]}
        values={v}
        onChange={(k, x) => {
          setErr('');
          setV((s) => ({ ...s, [k]: x }));
        }}
        onDone={() => void submit()}
      />
      {err && <div className="mt-3 text-tb-danger">{err}</div>}
    </Panel>
  );
}

function ForcedChange({ user, oldPassword, onDone }: { user: SecurityUser; oldPassword: string; onDone: (u: SecurityUser) => void }) {
  const { books } = useStore();
  const [v, setV] = useState<MiniValues>({ username: user.username, new: '', confirm: '' });
  const [err, setErr] = useState('');
  const submit = async () => {
    if (v.new !== v.confirm) return setErr('Passwords do not match');
    try {
      onDone(await changePassword(books.db, user.username, oldPassword, v.new));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useScreen({ title: 'Change Password', noPeriod: true, swallow: true, kind: 'modal', keys: {}, buttons: [] });
  return (
    <Panel title="Change Password">
      <MiniForm
        labelWidth={160}
        rows={[
          { key: 'username', label: 'Username', kind: 'static' },
          { key: 'new', label: 'New Password', kind: 'password' },
          { key: 'confirm', label: 'Re-enter Password', kind: 'password' },
        ]}
        values={v}
        onChange={(k, x) => {
          setErr('');
          setV((s) => ({ ...s, [k]: x }));
        }}
        onDone={() => void submit()}
      />
      {err && <div className="mt-3 text-tb-danger">{err}</div>}
    </Panel>
  );
}

export function ChangeUserScreen() {
  const { books, company, toast } = useStore();
  const nav = useNav();
  const { user, setUser } = useSecurity();
  const [v, setV] = useState<MiniValues>({ company: company?.name ?? '', username: '', password: '' });
  const submit = async () => {
    try {
      const r = await login(books.db, v.username, v.password);
      setUser(r.user);
      toast(`Logged in as ${r.user.username}`, 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title: 'Change User', noPeriod: true, keys: { 'Ctrl+A': () => void submit() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void submit() }] });
  return (
    <div className="flex">
      <div className="w-[520px] border border-tb-line bg-tb-paper px-6 py-4">
        <div className="mb-4 text-center font-bold underline">Change User</div>
        <MiniForm
          labelWidth={150}
          rows={[
            { key: 'company', label: 'Select Company', kind: 'static' },
            { key: 'username', label: 'Username', kind: 'text' },
            { key: 'password', label: 'Password', kind: 'password' },
          ]}
          values={v}
          onChange={(k, x) => setV((s) => ({ ...s, [k]: x }))}
          onDone={() => void submit()}
        />
      </div>
      <div className="ml-4 w-[220px] self-start border border-tb-line bg-tb-menu">
        <div className="bg-tb-top px-2 py-1 text-white">Logged in Users</div>
        <div className="bg-tb-sel px-2 py-px text-center">Change Username</div>
        {user && <div className="px-2 py-px">{user.username}</div>}
      </div>
    </div>
  );
}

export function ChangePasswordScreen() {
  const { books, toast } = useStore();
  const nav = useNav();
  const { user, setUser } = useSecurity();
  const [v, setV] = useState<MiniValues>({ old: '', new: '', confirm: '' });
  const submit = async () => {
    if (!user) return toast('No user is logged in', 'err');
    if (v.new !== v.confirm) return toast('Passwords do not match', 'err');
    try {
      setUser(await changePassword(books.db, user.username, v.old, v.new, { actor: user }));
      toast('Password changed', 'ok');
      nav.pop();
    } catch (e) {
      toast((e as Error).message, 'err');
    }
  };
  useScreen({ title: 'Change Password', noPeriod: true, keys: { 'Ctrl+A': () => void submit() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: () => void submit() }] });
  return (
    <div className="w-[520px] border border-tb-line bg-tb-paper px-6 py-4">
      <div className="mb-4 text-center font-bold underline">Change Password</div>
      <MiniForm
        labelWidth={180}
        rows={[
          { key: 'old', label: 'Old Password', kind: 'password' },
          { key: 'new', label: 'New Password', kind: 'password' },
          { key: 'confirm', label: 'Re-enter New Password', kind: 'password' },
        ]}
        values={v}
        onChange={(k, x) => setV((s) => ({ ...s, [k]: x }))}
        onDone={() => void submit()}
      />
    </div>
  );
}
