import { KeyButton } from '../ui/KeyButton.tsx';
import { useRef, useState, type ReactNode } from 'react';
import { toCsv, type Company } from '@tallybook/core';
import { topEntry, useScreen, type KeyHandler } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { saveTextFile } from '../files.ts';
import { Form, type FieldDef, type FormHandle } from '../ui/Form.tsx';
import { MenuCard, useMenu, type MenuItem } from '../ui/Menu.tsx';

export interface ShareDoc {
  kind: 'voucher' | 'report';
  title: string;
  company: string;
  gstin: string;
  period: string;
  lines: string[][];
  fileName: string;
  email?: string;
  phone?: string;
}

export interface ShareConfig {
  showCompany: boolean;
  showGstin: boolean;
  attachCsv: boolean;
}

export const DEFAULT_SHARE_CONFIG: ShareConfig = { showCompany: true, showGstin: false, attachCsv: true };

export const MULTI_ACCOUNT_REPORTS = ['Cash Book', 'Bank Book', 'All Ledger Accounts', 'One Ledger Account', 'Group of Accounts'];

const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;

export function letterKey(run: () => void): KeyHandler {
  return (e) => {
    if (typing(e)) return false;
    run();
  };
}

export function docFromScreen(company: Company | null, period: { from: string; to: string }, fmt: (iso: string) => string): ShareDoc | null {
  const slots = [...document.querySelectorAll<HTMLElement>('main > div')].filter((d) => d.style.display !== 'none');
  const root = slots[slots.length - 1];
  if (!root) return null;
  const top = topEntry();
  const tables = [...root.querySelectorAll('table')].filter((t) => t.offsetParent !== null);
  const clean = (t: string | null) => (t ?? '').replace(/\s+/g, ' ').trim();
  let lines: string[][] = [];
  if (tables.length) {
    tables.forEach((t, i) => {
      if (i) lines.push([]);
      for (const r of t.querySelectorAll('tr')) lines.push([...r.children].map((c) => clean(c.textContent)));
    });
  } else {
    lines = (root.innerText || '').split('\n').map((l) => [clean(l)]).filter((l) => l[0]);
  }
  if (!lines.some((l) => l.some(Boolean))) return null;
  const title = top?.title || clean(root.querySelector('.font-semibold')?.textContent ?? '') || 'Report';
  const base = title.replace(/[^\w.-]+/g, '_');
  return {
    kind: top?.kind === 'voucher' ? 'voucher' : 'report',
    title,
    company: company?.name ?? '',
    gstin: company?.gstin ?? '',
    period: `${fmt(period.from)} to ${fmt(period.to)}`,
    lines,
    fileName: `${base}.csv`,
    email: company?.email ?? '',
    phone: company?.phone ?? '',
  };
}

export function docCsv(doc: ShareDoc): string {
  return toCsv(doc.lines);
}

export function docText(doc: ShareDoc, cfg: ShareConfig, limit = 1800): { text: string; truncated: boolean } {
  const head: string[] = [];
  if (cfg.showCompany && doc.company) head.push(doc.company);
  if (cfg.showGstin && doc.gstin) head.push(`GSTIN/UIN: ${doc.gstin}`);
  head.push(doc.title);
  if (doc.kind === 'report') head.push(doc.period);
  const cols = Math.max(0, ...doc.lines.map((l) => l.length));
  const widths = Array.from({ length: cols }, (_, i) => Math.min(32, Math.max(0, ...doc.lines.map((l) => (l[i] ?? '').length))));
  const body = doc.lines.map((l) => l.map((c, i) => (i < l.length - 1 ? c.slice(0, widths[i]).padEnd(widths[i]) : c)).join('  ').trimEnd());
  const out: string[] = [...head, '', ...body];
  let text = out.join('\n');
  let truncated = false;
  if (text.length > limit) {
    text = `${text.slice(0, limit).replace(/\n[^\n]*$/, '')}\n...`;
    truncated = true;
  }
  return { text, truncated };
}

export function mailtoUrl(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to).replace(/%2C/g, ',').replace(/%40/g, '@')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function whatsappNumber(raw: string): string {
  const digits = raw.replace(/[^\d]/g, '');
  return digits.length === 10 ? `91${digits}` : digits.replace(/^0+/, '');
}

export function whatsappUrl(phone: string, text: string): string {
  return `https://wa.me/${whatsappNumber(phone)}?text=${encodeURIComponent(text)}`;
}

export function openLink(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface EmailProfile {
  senderName: string;
  email: string;
  username: string;
  server: string;
  address: string;
  port: string;
  ssl: boolean;
  sslStd: boolean;
}

const PROFILE_KEY = 'tallybook.email.profiles';

export function loadProfiles(): EmailProfile[] {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    return raw ? (JSON.parse(raw) as EmailProfile[]) : [];
  } catch {
    return [];
  }
}

function saveProfile(p: EmailProfile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify([...loadProfiles().filter((x) => x.email !== p.email), p]));
  } catch {
    return;
  }
}

function Dialog({ title, width = 560, children }: { title: string; width?: number; children: ReactNode }) {
  return (
    <div className="border border-tb-line bg-tb-paper px-4 pb-4 pt-3" style={{ width, maxWidth: '100%' }}>
      <h3 className="mb-4 text-center text-[15px] font-semibold"><span className="border-b border-tb-line px-1">{title}</span></h3>
      {children}
    </div>
  );
}

function Buttons({ items }: { items: { k: string; label: string; run: () => void; primary?: boolean }[] }) {
  return (
    <div className="mt-6 flex justify-center gap-5">
      {items.map((b) => (
        <KeyButton key={b.k} k={b.k} label={b.label} run={b.run} primary={b.primary} />
      ))}
    </div>
  );
}

export function CreateEmailProfile({ onSaved }: { onSaved: (p: EmailProfile) => void }) {
  const { company, toast } = useStore();
  const form = useRef<FormHandle>(null);
  const servers = ['Gmail', 'Yahoo Mail', 'Outlook/Hotmail', 'User Defined'];
  const fields: FieldDef[] = [
    { key: 'senderName', label: 'E-mail sender name', kind: 'text', initial: company?.name ?? '', required: true },
    { key: 'email', label: 'E-mail from', kind: 'text', required: true, validate: (v) => (/^\S+@\S+\.\S+$/.test(v.email) ? null : 'Enter a valid e-mail address') },
    { key: 'more', label: 'Show additional options', kind: 'toggle', initial: false },
    { key: 'username', label: 'Username(for authentication)', kind: 'text', visible: (v) => v.more },
    { key: 'server', label: 'E-mail Server', kind: 'picker', title: 'List of E-mail Servers', options: servers.map((s) => ({ id: s, label: s })), initial: { id: 'User Defined', label: 'User Defined' }, visible: (v) => v.more },
    { key: 'address', label: 'Server address', kind: 'text', visible: (v) => v.more },
    { key: 'port', label: 'Port Number', kind: 'text', initial: '587', visible: (v) => v.more },
    { key: 'ssl', label: 'Use SSL', kind: 'toggle', initial: true, note: "(Select 'Yes' if you are using Secured SMTP server)", visible: (v) => v.more },
    { key: 'sslStd', label: '    Use SSL/TLS on standard port', kind: 'toggle', initial: true, note: "(Select 'Yes' if you are using SSL on default/Standard SMTP port)", visible: (v) => v.more && v.ssl },
  ];
  const save = () => {
    const v = form.current?.submit();
    if (!v) return;
    const p: EmailProfile = { senderName: v.senderName, email: v.email, username: v.username || v.email, server: v.server ?? 'User Defined', address: v.address, port: v.port, ssl: !!v.ssl, sslStd: !!v.sslStd };
    saveProfile(p);
    toast('E-mail profile saved', 'ok');
    onSaved(p);
  };
  useScreen({ title: 'Create E-mail Profile', noPeriod: true, keys: { 'Ctrl+A': () => save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: save }] });
  return (
    <Dialog title="Create E-mail Profile" width={620}>
      <Form ref={form} fields={fields} onDone={save} labelWidth={260} />
    </Dialog>
  );
}

export function ShareConfigScreen({ value, onSave, title }: { value: ShareConfig; onSave: (c: ShareConfig) => void; title: string }) {
  const form = useRef<FormHandle>(null);
  const fields: FieldDef[] = [
    { key: 'showCompany', label: 'Show Company Name', kind: 'toggle', initial: value.showCompany },
    { key: 'showGstin', label: 'Show GSTIN/UIN', kind: 'toggle', initial: value.showGstin },
    { key: 'attachCsv', label: 'Attach report as CSV file', kind: 'toggle', initial: value.attachCsv },
  ];
  const save = () => {
    const v = form.current?.submit();
    if (v) onSave({ showCompany: !!v.showCompany, showGstin: !!v.showGstin, attachCsv: !!v.attachCsv });
  };
  useScreen({ title, noPeriod: true, keys: { 'Ctrl+A': () => save() }, buttons: [{ key: 'Ctrl+A', label: 'Accept', run: save }] });
  return (
    <Dialog title={title} width={520}>
      <Form ref={form} fields={fields} onDone={save} labelWidth={300} />
    </Dialog>
  );
}

export function PreviewScreen({ text, title }: { text: string; title: string }) {
  useScreen({ title: 'Preview', noPeriod: true, buttons: [] });
  return (
    <div className="max-w-3xl border border-tb-line bg-tb-paper p-4">
      <h3 className="mb-2 border-b border-tb-line pb-1 text-[15px] font-semibold">{title}</h3>
      <pre className="m-0 whitespace-pre-wrap font-mono text-[13px]">{text}</pre>
    </div>
  );
}

export function EmailScreen({ doc }: { doc: ShareDoc }) {
  const { toast } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const [cfg, setCfg] = useState<ShareConfig>(DEFAULT_SHARE_CONFIG);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const profiles = loadProfiles();
  const first = profiles[0]?.email ?? doc.email ?? '';
  const fields: FieldDef[] = [
    {
      key: 'from',
      label: 'E-mail from',
      kind: 'picker',
      title: 'List of Profiles',
      options: profiles.map((p) => ({ id: p.email, label: p.email, sub: p.senderName })),
      initial: first ? { id: first, label: first } : undefined,
      create: (_t, done) => nav.push(<CreateEmailProfile onSaved={(p) => { nav.pop(); done({ id: p.email, label: p.email }); }} />),
    },
    { key: 'to', label: 'E-mail to', kind: 'text', required: true, validate: (v) => (v.to.split(/[,;]/).every((a: string) => /^\S+@\S+\.\S+$/.test(a.trim())) ? null : 'Enter valid e-mail address(es), separated by commas') },
    { key: 'subject', label: 'Subject', kind: 'text', initial: doc.title },
    { key: 'message', label: 'E-mail message (if any)', kind: 'text' },
  ];

  const send = async () => {
    const v = form.current?.submit();
    if (!v) return;
    const c = cfgRef.current;
    const { text, truncated } = docText(doc, c, 1500);
    let body = v.message ? `${v.message}\n\n${text}` : text;
    if (c.attachCsv) {
      const saved = await saveTextFile(doc.fileName, docCsv(doc), 'text/csv');
      body += `\n\nAttachment: ${doc.fileName}${saved ? ' (saved to your computer, please attach it to this e-mail)' : ''}`;
    } else if (truncated) body += '\n(Summary shortened)';
    openLink(mailtoUrl(v.to.replace(/;/g, ','), v.subject, body));
    toast('E-mail opened in your mail application', 'ok');
    nav.pop();
  };
  const configure = () => nav.push(<ShareConfigScreen title="E-mail Configuration" value={cfgRef.current} onSave={(x) => { setCfg(x); nav.pop(); }} />);
  const template = () => toast('No predefined message templates have been created', 'err');

  useScreen({
    title: 'E-mail',
    noPeriod: true,
    keys: { C: letterKey(configure), M: letterKey(() => void send()), 'Alt+S': () => template() },
    buttons: [{ key: 'C', label: 'Configure', run: configure }, { key: 'M', label: 'E-mail', run: () => void send() }],
  });

  return (
    <Dialog title="E-mail" width={560}>
      <Form ref={form} fields={fields} onDone={() => void send()} labelWidth={200} />
      <p className="mt-10 text-[15px] text-blue-700">(Press Alt+S to select a predefined message template)</p>
      <Buttons items={[{ k: 'C', label: 'Configure', run: configure }, { k: 'M', label: 'E-mail', run: () => void send(), primary: true }]} />
    </Dialog>
  );
}

export function WhatsAppScreen({ doc }: { doc: ShareDoc }) {
  const { toast, company } = useStore();
  const nav = useNav();
  const form = useRef<FormHandle>(null);
  const [cfg, setCfg] = useState<ShareConfig>({ ...DEFAULT_SHARE_CONFIG, attachCsv: false });
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const templateName = doc.kind === 'voucher' ? 'Common Template for Vouchers' : 'Common Template for Reports';
  const formats = ['Text (Summary message)', 'CSV (Comma Separated Values)'];
  const fields: FieldDef[] = [
    { key: 'from', label: 'WhatsApp from', kind: 'text', initial: company?.phone ?? '' },
    { key: 'to', label: 'WhatsApp to', kind: 'text', initial: doc.phone && doc.phone !== company?.phone ? doc.phone : '', required: true, validate: (v) => (v.to.split(/[,;]/).every((n: string) => whatsappNumber(n).length >= 10) ? null : 'Enter valid mobile number(s) with country code, separated by commas') },
    { key: 'format', label: 'File Format', kind: 'picker', title: 'List of File Formats', options: formats.map((f) => ({ id: f, label: f })), initial: { id: formats[0], label: formats[0] }, required: true },
    { key: 'template', label: '    WhatsApp template', kind: 'picker', title: 'List of WhatsApp Templates', options: [{ id: templateName, label: templateName }], initial: { id: templateName, label: templateName }, required: true },
    { key: 'file', label: 'File Name', kind: 'text', initial: doc.fileName, visible: (v) => v.format === formats[1] },
  ];

  const message = () => docText(doc, cfgRef.current, 1500);
  const send = async () => {
    const v = form.current?.submit();
    if (!v) return;
    let { text } = message();
    if (v.format === formats[1]) {
      const saved = await saveTextFile(v.file || doc.fileName, docCsv(doc), 'text/csv');
      text += `\n\nFile: ${v.file || doc.fileName}${saved ? ' (saved on this computer, attach it in the chat)' : ''}`;
    }
    for (const n of v.to.split(/[,;]/)) openLink(whatsappUrl(n, text));
    toast('WhatsApp opened with the message', 'ok');
    nav.pop();
  };
  const preview = () => nav.push(<PreviewScreen title={doc.title} text={message().text} />);
  const configure = () => nav.push(<ShareConfigScreen title="WhatsApp Configuration" value={cfgRef.current} onSave={(x) => { setCfg(x); nav.pop(); }} />);

  useScreen({
    title: 'WhatsApp',
    noPeriod: true,
    keys: { C: letterKey(configure), I: letterKey(preview), W: letterKey(() => void send()) },
    buttons: [{ key: 'C', label: 'Configure', run: configure }, { key: 'I', label: 'Preview', run: preview }, { key: 'W', label: 'WhatsApp', run: () => void send() }],
  });

  return (
    <Dialog title="WhatsApp" width={720}>
      <div className="mb-3 flex items-center">
        <span className="w-[200px]">Title</span>
        <span className="font-bold">: {doc.title.toUpperCase()}</span>
      </div>
      <Form ref={form} fields={fields} onDone={() => void send()} labelWidth={200} />
      <Buttons items={[{ k: 'C', label: 'Configure', run: configure }, { k: 'I', label: 'Preview', run: preview }, { k: 'W', label: 'WhatsApp', run: () => void send(), primary: true }]} />
    </Dialog>
  );
}

export function MultiAccountScreen({ verb }: { verb: string }) {
  const { toast } = useStore();
  const items: MenuItem[] = MULTI_ACCOUNT_REPORTS.map((r) => ({ label: r, run: () => toast(`${verb} of ${r} is not available yet`, 'err') }));
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'List of Multi Account Reports', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="List of Multi Account Reports" items={items} sel={sel} setSel={setSel} width={332} />;
}

function EmailConfigurationScreen() {
  const nav = useNav();
  const profiles = loadProfiles();
  const items: MenuItem[] = [
    { label: 'Create', run: () => nav.push(<CreateEmailProfile onSaved={() => nav.pop()} />) },
    ...profiles.map((p) => ({ label: p.email, hint: p.senderName })),
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'List of Profiles', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="List of Profiles" items={items} sel={sel} setSel={setSel} width={420} />;
}

export function ShareMenu({ doc }: { doc: ShareDoc | null }) {
  const { toast } = useStore();
  const nav = useNav();
  const need = (run: (d: ShareDoc) => void) => () => (doc ? run(doc) : toast('Open a report or voucher to share it', 'err'));
  const unavailable = (n: string) => () => toast(`${n} needs a WhatsApp Business account and is not available`, 'err');
  const items: MenuItem[] = [
    { label: 'E-MAIL', heading: true },
    { label: 'Current', hotkey: 'R', hint: 'Ctrl+M', run: need((d) => nav.replace(<EmailScreen doc={d} />)) },
    { label: 'Others', hotkey: 'O', run: () => nav.replace(<MultiAccountScreen verb="E-mail" />) },
    { label: '' },
    { label: 'Configuration', hotkey: 'N', run: () => nav.replace(<EmailConfigurationScreen />) },
    { label: 'WHATSAPP', heading: true },
    { label: 'Current', hotkey: 'C', hint: 'Ctrl+Alt+W', run: need((d) => nav.replace(<WhatsAppScreen doc={d} />)) },
    { label: 'Others', hotkey: 'T', run: () => nav.replace(<MultiAccountScreen verb="WhatsApp" />) },
    { label: '' },
    { label: 'Manage', hotkey: 'M', hint: '>', run: unavailable('Manage templates') },
    { label: 'Inbox', hotkey: 'I', run: unavailable('Inbox') },
    { label: 'Configuration', hotkey: 'F', run: unavailable('WhatsApp configuration') },
  ];
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title: 'Share', noPeriod: true, keys, buttons: [] });
  return <MenuCard title="Share" items={items} sel={sel} setSel={setSel} width={332} />;
}

export function useShareKeys(fmt: (iso: string) => string): Record<string, KeyHandler> {
  const { company, period, toast } = useStore();
  const nav = useNav();
  const grab = () => {
    const d = docFromScreen(company, period, fmt);
    if (!d) toast('Open a report or voucher to share it', 'err');
    return d;
  };
  return {
    'Alt+M': () => nav.push(<ShareMenu doc={docFromScreen(company, period, fmt)} />),
    'Ctrl+M': () => {
      const d = grab();
      if (d) nav.push(<EmailScreen doc={d} />);
    },
    'Ctrl+Alt+W': () => {
      const d = grab();
      if (d) nav.push(<WhatsAppScreen doc={d} />);
    },
  };
}
