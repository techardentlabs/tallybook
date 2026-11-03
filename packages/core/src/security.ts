import { CoreError, one, type Db, type Stmt } from './db.ts';
import { fmtDate, todayIso } from './util.ts';
import { SECURITY_FACILITIES, baseFacilityOf, facilityChain, facilityKind, voucherFacilities, type ScreenRight } from './facilities.ts';

export const SECURITY_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS security_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS security_levels (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    basis TEXT NOT NULL,
    days_back INTEGER NOT NULL DEFAULT 0,
    cutoff_date TEXT,
    save_views INTEGER NOT NULL DEFAULT 1,
    delete_views INTEGER NOT NULL DEFAULT 1,
    print_rules INTEGER NOT NULL DEFAULT 0,
    override_tax INTEGER NOT NULL DEFAULT 0,
    exclude_on_account INTEGER NOT NULL DEFAULT 0,
    exclude_new_number INTEGER NOT NULL DEFAULT 0,
    allow_connect INTEGER NOT NULL DEFAULT 1,
    tallynet_auth INTEGER NOT NULL DEFAULT 0,
    disallow TEXT NOT NULL DEFAULT '[]',
    allow TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE IF NOT EXISTS security_users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL,
    level_id INTEGER NOT NULL REFERENCES security_levels(id),
    password_hash TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    browser_access INTEGER NOT NULL DEFAULT 0,
    remote_access INTEGER NOT NULL DEFAULT 0,
    local_tdl INTEGER NOT NULL DEFAULT 0,
    policy_applies INTEGER NOT NULL DEFAULT 1,
    must_change INTEGER NOT NULL DEFAULT 0,
    password_changed_at TEXT,
    old_hashes TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE IF NOT EXISTS security_edit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    username TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    detail TEXT NOT NULL DEFAULT ''
  )`,
];

const LEVEL_MIGRATIONS: [string, string][] = [
  ['shut_on_idle', 'ALTER TABLE security_levels ADD COLUMN shut_on_idle INTEGER NOT NULL DEFAULT 0'],
  ['idle_minutes', 'ALTER TABLE security_levels ADD COLUMN idle_minutes INTEGER NOT NULL DEFAULT 0'],
  ['whatsapp_nos', 'ALTER TABLE security_levels ADD COLUMN whatsapp_nos INTEGER NOT NULL DEFAULT 1'],
];

export async function ensureSecurity(db: Db): Promise<void> {
  await db.batch(SECURITY_SCHEMA.map((sql) => ({ sql })));
  const have = new Set((await db.select<{ name: string }>("SELECT name FROM pragma_table_info('security_levels')")).map((r) => r.name));
  const todo = LEVEL_MIGRATIONS.filter(([c]) => !have.has(c));
  if (todo.length) await db.batch(todo.map(([, sql]) => ({ sql })));
}

export const SECURITY_ROLES = ['Owner', 'Data Entry', 'Tally.NET Auditor', 'Tally.NET Owner', 'Tally.NET User'] as const;
export type SecurityRole = (typeof SECURITY_ROLES)[number];

export type Facility = string;

export const ACCESS_DENIED = 'No Access Allowed!';

export type AccessName = 'Full Access' | 'Create/Alter' | 'Create' | 'Alter' | 'Display/Print' | 'Print' | 'Display' | 'Preview' | 'None';
export type Right = ScreenRight;

export const ACCESS_NAMES: AccessName[] = ['Full Access', 'Create', 'Alter', 'Create/Alter', 'Display', 'Print', 'Display/Print', 'Preview'];

const ACCESS_RIGHTS: Record<AccessName, Right[]> = {
  'Full Access': ['display', 'preview', 'print', 'create', 'alter', 'delete'],
  'Create/Alter': ['display', 'preview', 'print', 'create', 'alter'],
  Create: ['display', 'preview', 'print', 'create'],
  Alter: ['display', 'preview', 'print', 'alter'],
  'Display/Print': ['display', 'preview', 'print'],
  Print: ['display', 'preview', 'print'],
  Display: ['display'],
  Preview: ['display', 'preview'],
  None: [],
};

const DISALLOW_RIGHTS: Record<AccessName, Right[]> = {
  'Full Access': ['display', 'preview', 'print', 'create', 'alter', 'delete'],
  'Create/Alter': ['create', 'alter', 'delete'],
  Create: ['create'],
  Alter: ['alter', 'delete'],
  'Display/Print': ['display', 'preview', 'print', 'create', 'alter', 'delete'],
  Print: ['print'],
  Display: ['display', 'preview', 'print', 'create', 'alter', 'delete'],
  Preview: ['preview', 'print'],
  None: [],
};

export function accessRights(a: AccessName): Right[] {
  return [...(ACCESS_RIGHTS[a] ?? [])];
}

export function accessNamesFor(facility: Facility): AccessName[] {
  const k = facilityKind(facility);
  if (k === 'Masters' || k === 'Vouchers' || k === 'Voucher Types' || k === null) return ACCESS_NAMES;
  if (k === 'Utilities' || k === 'Company') return ['Full Access', 'Display'];
  return ['Full Access', 'Display', 'Print', 'Display/Print', 'Preview'];
}

const DATA_ENTRY_VIEW = new Set<string>([
  'Day Book',
  'Cash/Bank Books',
  'Ledger',
  'Sales Register',
  'Purchase Register',
  'Journal Register',
  'Payment Register',
  'Receipt Register',
  'Contra Register',
  'Credit Note Register',
  'Debit Note Register',
  'Alter Voucher Bank Allocations',
  'Bank Reconciliation',
  'Cheque Printing',
  'Cheque Register',
  'Deposit Slip',
  'Payment Advice',
  'Post-Dated Summary',
  'Stock Query',
  'Order Outstandings',
  'Bills Pending',
  'Configuration',
  'Print',
  'E-Mail',
  'WhatsApp',
]);

const OWNER_RESERVED = new Set<string>(['Audit Listings', 'Company Alteration']);
const AUDITOR_NONE = new Set<string>(['Company Features', 'Company Alteration', 'Security Control', 'Backup', 'Restore', 'Import', 'Split Company Data', 'Repair', 'Data Synchronisation']);

export function baseAccess(role: SecurityRole | string, facility: Facility): AccessName {
  const f = baseFacilityOf(facility);
  if (role === 'Owner' || role === 'Tally.NET Owner') return OWNER_RESERVED.has(f) ? 'None' : 'Full Access';
  if (role === 'Tally.NET Auditor') {
    if (f === 'Audit Listings') return 'Full Access';
    return AUDITOR_NONE.has(f) ? 'None' : 'Display/Print';
  }
  const k = facilityKind(f);
  if (k === null) return 'Display/Print';
  if (k === 'Vouchers') return f === 'Back Dated Vouchers' ? 'None' : 'Create/Alter';
  return DATA_ENTRY_VIEW.has(f) ? 'Display/Print' : 'None';
}

export interface SecurityLevel {
  id: number;
  name: string;
  basis: SecurityRole;
  days_back: number;
  cutoff_date: string | null;
  save_views: boolean;
  delete_views: boolean;
  whatsapp_nos: boolean;
  print_rules: boolean;
  override_tax: boolean;
  exclude_on_account: boolean;
  exclude_new_number: boolean;
  allow_connect: boolean;
  tallynet_auth: boolean;
  shut_on_idle: boolean;
  idle_minutes: number;
  disallow: Record<Facility, AccessName>;
  allow: Record<Facility, AccessName>;
}

function normDisallow(d: Facility[] | Record<Facility, AccessName> | undefined): Record<Facility, AccessName> {
  if (!d) return {};
  if (Array.isArray(d)) return Object.fromEntries(d.map((f) => [f, 'Full Access' as AccessName]));
  return { ...d };
}

interface LevelRow {
  id: number;
  name: string;
  basis: string;
  days_back: number;
  cutoff_date: string | null;
  save_views: number;
  delete_views: number;
  whatsapp_nos: number;
  print_rules: number;
  override_tax: number;
  exclude_on_account: number;
  exclude_new_number: number;
  allow_connect: number;
  tallynet_auth: number;
  shut_on_idle: number;
  idle_minutes: number;
  disallow: string;
  allow: string;
}

function toLevel(r: LevelRow): SecurityLevel {
  return {
    id: r.id,
    name: r.name,
    basis: r.basis as SecurityRole,
    days_back: r.days_back,
    cutoff_date: r.cutoff_date,
    save_views: !!r.save_views,
    delete_views: !!r.delete_views,
    whatsapp_nos: !!(r.whatsapp_nos ?? 1),
    print_rules: !!r.print_rules,
    override_tax: !!r.override_tax,
    exclude_on_account: !!r.exclude_on_account,
    exclude_new_number: !!r.exclude_new_number,
    allow_connect: !!r.allow_connect,
    tallynet_auth: !!r.tallynet_auth,
    shut_on_idle: !!r.shut_on_idle,
    idle_minutes: r.idle_minutes ?? 0,
    disallow: normDisallow(JSON.parse(r.disallow) as Facility[] | Record<Facility, AccessName>),
    allow: JSON.parse(r.allow) as Record<Facility, AccessName>,
  };
}

export interface SecurityUser {
  id: number;
  username: string;
  role: SecurityRole;
  level: SecurityLevel;
  administrator: boolean;
  active: boolean;
  browser_access: boolean;
  remote_access: boolean;
  local_tdl: boolean;
  policy_applies: boolean;
  must_change: boolean;
  has_password: boolean;
  password_changed_at: string | null;
}

interface UserRow {
  id: number;
  username: string;
  role: string;
  level_id: number;
  password_hash: string | null;
  active: number;
  browser_access: number;
  remote_access: number;
  local_tdl: number;
  policy_applies: number;
  must_change: number;
  password_changed_at: string | null;
}

function toUser(r: UserRow, level: SecurityLevel, admin: string | null): SecurityUser {
  return {
    id: r.id,
    username: r.username,
    role: r.role as SecurityRole,
    level,
    administrator: admin !== null && admin.toLowerCase() === r.username.toLowerCase(),
    active: !!r.active,
    browser_access: !!r.browser_access,
    remote_access: !!r.remote_access,
    local_tdl: !!r.local_tdl,
    policy_applies: !!r.policy_applies,
    must_change: !!r.must_change,
    has_password: !!r.password_hash,
    password_changed_at: r.password_changed_at,
  };
}

const PBKDF2_ITERATIONS = 150000;

function toB64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await globalThis.crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !iter || !salt || !hash) return false;
  const expected = fromB64(hash);
  const actual = await derive(password, fromB64(salt), Number(iter));
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  return diff === 0;
}

export interface PasswordPolicy {
  active: boolean;
  min_length: number;
  advanced: boolean;
  min_alpha: number;
  min_numeric: number;
  min_special: number;
  expires_days: number;
  notify_expiry: boolean;
  restrict_old: boolean;
  change_on_first_login: boolean;
  allow_change: boolean;
}

export const DEFAULT_POLICY: PasswordPolicy = {
  active: false,
  min_length: 8,
  advanced: false,
  min_alpha: 0,
  min_numeric: 0,
  min_special: 0,
  expires_days: 90,
  notify_expiry: false,
  restrict_old: false,
  change_on_first_login: false,
  allow_change: true,
};

async function setting(db: Db, key: string): Promise<string | null> {
  return (await one<{ value: string }>(db, 'SELECT value FROM security_settings WHERE key = ?', [key]))?.value ?? null;
}

function putSetting(key: string, value: string): Stmt {
  return { sql: 'INSERT INTO security_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', params: [key, value] };
}

export async function passwordPolicy(db: Db): Promise<PasswordPolicy> {
  const raw = await setting(db, 'policy');
  return raw ? { ...DEFAULT_POLICY, ...(JSON.parse(raw) as Partial<PasswordPolicy>) } : { ...DEFAULT_POLICY };
}

export async function savePasswordPolicy(db: Db, policy: PasswordPolicy): Promise<PasswordPolicy> {
  if (!Number.isInteger(policy.min_length) || policy.min_length < 1) throw new CoreError('invalid', 'Minimum password length must be at least 1');
  if (policy.advanced && policy.min_alpha + policy.min_numeric + policy.min_special > policy.min_length) {
    throw new CoreError('invalid', 'Total of alphabetic, numeric and special characters cannot exceed the password length');
  }
  if (!Number.isInteger(policy.expires_days) || policy.expires_days < 0) throw new CoreError('invalid', 'Password expiry days cannot be negative');
  await db.batch([putSetting('policy', JSON.stringify(policy))]);
  return policy;
}

export function checkPasswordPolicy(policy: PasswordPolicy, password: string): string | null {
  if (!policy.active) return null;
  if (password.length < policy.min_length) return `Password must be at least ${policy.min_length} characters`;
  if (policy.advanced) {
    const alpha = (password.match(/[A-Za-z]/g) ?? []).length;
    const num = (password.match(/[0-9]/g) ?? []).length;
    const special = password.length - alpha - num;
    if (alpha < policy.min_alpha) return `Password needs at least ${policy.min_alpha} alphabetic characters`;
    if (num < policy.min_numeric) return `Password needs at least ${policy.min_numeric} numeric characters`;
    if (special < policy.min_special) return `Password needs at least ${policy.min_special} special characters`;
  }
  return null;
}

export async function securityEnabled(db: Db): Promise<boolean> {
  return (await setting(db, 'enabled')) === '1';
}

async function nextId(db: Db, table: string): Promise<number> {
  const r = await one<{ m: number | null }>(db, `SELECT MAX(id) AS m FROM ${table}`);
  return (r?.m ?? 0) + 1;
}

export const SECURITY_ATTRIBUTE_DEFAULTS = {
  days_back: 0,
  cutoff_date: null as string | null,
  save_views: true,
  delete_views: true,
  whatsapp_nos: true,
  print_rules: false,
  override_tax: false,
  exclude_on_account: false,
  exclude_new_number: false,
  allow_connect: true,
  tallynet_auth: false,
  shut_on_idle: false,
  idle_minutes: 0,
};

export interface LevelInput {
  name: string;
  basis: SecurityRole;
  days_back?: number;
  cutoff_date?: string | null;
  save_views?: boolean;
  delete_views?: boolean;
  whatsapp_nos?: boolean;
  print_rules?: boolean;
  override_tax?: boolean;
  exclude_on_account?: boolean;
  exclude_new_number?: boolean;
  allow_connect?: boolean;
  tallynet_auth?: boolean;
  shut_on_idle?: boolean;
  idle_minutes?: number;
  disallow?: Facility[] | Record<Facility, AccessName>;
  allow?: Record<Facility, AccessName>;
}

const LEVEL_FIELDS = [
  'basis',
  'days_back',
  'cutoff_date',
  'save_views',
  'delete_views',
  'whatsapp_nos',
  'print_rules',
  'override_tax',
  'exclude_on_account',
  'exclude_new_number',
  'allow_connect',
  'tallynet_auth',
  'shut_on_idle',
  'idle_minutes',
  'disallow',
  'allow',
] as const;

function levelParams(i: LevelInput): (string | number | null)[] {
  const d = SECURITY_ATTRIBUTE_DEFAULTS;
  const b = (v: boolean | undefined, def: boolean) => ((v ?? def) ? 1 : 0);
  return [
    i.basis,
    i.days_back ?? d.days_back,
    i.cutoff_date ?? null,
    b(i.save_views, d.save_views),
    b(i.save_views ?? d.save_views ? i.delete_views : false, d.delete_views),
    b(i.whatsapp_nos, d.whatsapp_nos),
    b(i.print_rules, d.print_rules),
    b(i.override_tax, d.override_tax),
    b(i.exclude_on_account, d.exclude_on_account),
    b(i.exclude_new_number, d.exclude_new_number),
    b(i.allow_connect, d.allow_connect),
    b(i.tallynet_auth, d.tallynet_auth),
    b(i.shut_on_idle, d.shut_on_idle),
    i.shut_on_idle ? i.idle_minutes ?? d.idle_minutes : 0,
    JSON.stringify(normDisallow(i.disallow)),
    JSON.stringify(i.allow ?? {}),
  ];
}

function validateLevel(i: LevelInput): void {
  if (!i.name.trim()) throw new CoreError('invalid', 'Name of security level is required');
  if (!SECURITY_ROLES.includes(i.basis)) throw new CoreError('invalid', `Unknown user role ${i.basis}`);
  if (i.days_back !== undefined && (!Number.isInteger(i.days_back) || i.days_back < 0)) throw new CoreError('invalid', 'Days allowed for back dated vouchers must be 0 or more');
  if (i.cutoff_date && !/^\d{4}-\d{2}-\d{2}$/.test(i.cutoff_date)) throw new CoreError('invalid', 'Cut-off date must be an ISO date');
  if (i.idle_minutes !== undefined && (!Number.isInteger(i.idle_minutes) || i.idle_minutes < 0)) throw new CoreError('invalid', 'Time for auto lock must be 0 or more minutes');
  if (i.shut_on_idle && !(i.idle_minutes && i.idle_minutes > 0)) throw new CoreError('invalid', 'Set Time (in mins) for auto lock must be more than 0');
  const all = [...Object.values(normDisallow(i.disallow)), ...Object.values(i.allow ?? {})];
  for (const a of all) if (!(a in ACCESS_RIGHTS) || a === 'None') throw new CoreError('invalid', `Unknown Type of Access ${a}`);
}

export async function securityLevels(db: Db): Promise<SecurityLevel[]> {
  return (await db.select<LevelRow>('SELECT * FROM security_levels ORDER BY id')).map(toLevel);
}

export async function securityLevel(db: Db, name: string): Promise<SecurityLevel | undefined> {
  const r = await one<LevelRow>(db, 'SELECT * FROM security_levels WHERE name = ?', [name.trim()]);
  return r ? toLevel(r) : undefined;
}

export async function saveSecurityLevel(db: Db, input: LevelInput): Promise<SecurityLevel> {
  validateLevel(input);
  const name = input.name.trim();
  const existing = await securityLevel(db, name);
  const params = levelParams({ ...input, name });
  if (existing) {
    await db.batch([
      { sql: `UPDATE security_levels SET ${LEVEL_FIELDS.map((f) => `${f}=?`).join(', ')} WHERE id = ?`, params: [...params, existing.id] },
      { sql: 'UPDATE security_users SET role = ? WHERE level_id = ?', params: [input.basis, existing.id] },
    ]);
  } else {
    const id = await nextId(db, 'security_levels');
    await db.batch([{ sql: `INSERT INTO security_levels (id, name, ${LEVEL_FIELDS.join(', ')}) VALUES (?, ?${', ?'.repeat(LEVEL_FIELDS.length)})`, params: [id, name, ...params] }]);
  }
  return (await securityLevel(db, name))!;
}

function applyLevel(level: SecurityLevel, facility: Facility, rights: Set<Right>): Set<Right> {
  const denied = level.disallow[facility];
  let out = rights;
  if (denied) {
    out = new Set(rights);
    for (const r of DISALLOW_RIGHTS[denied] ?? []) out.delete(r);
    if (!out.has('display')) out = new Set();
  }
  const allowed = level.allow[facility];
  if (allowed) {
    out = new Set(out);
    for (const r of ACCESS_RIGHTS[allowed] ?? []) out.add(r);
  }
  return out;
}

export function effectiveAccess(level: SecurityLevel, facility: Facility, chain: string[] = facilityChain(facility)): Set<Right> {
  const k = facilityKind(facility);
  const baseOf = chain.length > 1 && (k === null || k === 'Voucher Types') ? chain[chain.length - 2] : facility;
  let rights = new Set<Right>(ACCESS_RIGHTS[baseAccess(level.basis, baseOf)]);
  for (const f of chain) rights = applyLevel(level, f, rights);
  return rights;
}

export function accessName(rights: Set<Right>): AccessName {
  if (rights.size === 0) return 'None';
  const has = (r: Right) => rights.has(r);
  if (has('delete')) return 'Full Access';
  if (has('create') && has('alter')) return 'Create/Alter';
  if (has('create')) return 'Create';
  if (has('alter')) return 'Alter';
  if (has('print')) return 'Display/Print';
  if (has('preview')) return 'Preview';
  return 'Display';
}

export interface SecurityControlRow {
  facility: Facility;
  access: Record<string, AccessName>;
}

export function securityControl(levels: SecurityLevel[], facilities: readonly Facility[] = SECURITY_FACILITIES): SecurityControlRow[] {
  return facilities.map((facility) => ({
    facility,
    access: Object.fromEntries(levels.map((l) => [l.name, accessName(effectiveAccess(l, facility))])),
  }));
}

export function builtinLevels(): SecurityLevel[] {
  return SECURITY_ROLES.map((role, i) => ({
    id: -(i + 1),
    name: role,
    basis: role,
    ...SECURITY_ATTRIBUTE_DEFAULTS,
    tallynet_auth: role.startsWith('Tally.NET'),
    disallow: {},
    allow: {},
  }));
}

export type Action = `${string}.${Right}` | { facility: Facility; right: Right };

function parseAction(a: Action): { facility: Facility; right: Right } {
  if (typeof a !== 'string') return a;
  const i = a.lastIndexOf('.');
  return { facility: a.slice(0, i), right: a.slice(i + 1) as Right };
}

export function can(user: SecurityUser | null, action: Action): boolean {
  if (!user) return true;
  if (!user.active) return false;
  if (user.administrator) return true;
  const { facility, right } = parseAction(action);
  return effectiveAccess(user.level, facility).has(right);
}

export function canVoucher(user: SecurityUser | null, typeName: string, parent: string | undefined, right: Right): boolean {
  if (!user) return true;
  if (!user.active) return false;
  if (user.administrator) return true;
  const chain = voucherFacilities(typeName, parent);
  return effectiveAccess(user.level, typeName, chain).has(right);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function backDatedLimit(user: SecurityUser | null, today: string, lastEntry?: string | null, right: Right = 'create'): string | null | false {
  if (!user || user.administrator) return null;
  if (can(user, { facility: 'Back Dated Vouchers', right })) return null;
  const base = lastEntry || today;
  const days = user.level.days_back;
  const cut = user.level.cutoff_date;
  const fromDays = days > 0 ? addDays(base, -days) : null;
  if (!fromDays && !cut) return false;
  if (!fromDays) return cut!;
  if (!cut) return fromDays;
  return fromDays > cut ? fromDays : cut;
}

export function canEnterOn(user: SecurityUser | null, date: string, today: string, lastEntry?: string | null, right: Right = 'create'): boolean {
  if (!user) return true;
  const base = lastEntry || today;
  if (date >= base) return true;
  const limit = backDatedLimit(user, today, lastEntry, right);
  if (limit === null) return true;
  if (limit === false) return false;
  return date >= limit;
}

export function backDatedMessage(user: SecurityUser | null, date: string, today: string, lastEntry?: string | null, right: Right = 'create'): string | null {
  if (canEnterOn(user, date, today, lastEntry, right)) return null;
  const limit = backDatedLimit(user, today, lastEntry, right);
  return limit ? `${ACCESS_DENIED} Back dated vouchers before ${fmtDate(limit)} are not allowed` : `${ACCESS_DENIED} Back dated vouchers are not allowed`;
}

export function idleLockMinutes(user: SecurityUser | null): number | null {
  if (!user || !user.level.shut_on_idle || user.level.idle_minutes <= 0) return null;
  return user.level.idle_minutes;
}

let current: SecurityUser | null = null;
const watchers = new Set<() => void>();

export function currentUser(): SecurityUser | null {
  return current;
}

export function setCurrentUser(user: SecurityUser | null): void {
  current = user;
  for (const w of watchers) w();
}

export function onUserChange(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

export function canCurrent(action: Action): boolean {
  return can(current, action);
}

export function canAllCurrent(actions: readonly Action[] | null | undefined): boolean {
  return !actions || actions.every((a) => can(current, a));
}

type Guardable = { db: Db } & Record<string, unknown>;
const GUARDED = new WeakSet<object>();

const MASTER_METHODS: Record<string, Right> = {
  createLedger: 'create',
  updateLedger: 'alter',
  deleteLedger: 'delete',
  createGroup: 'create',
  updateGroup: 'alter',
  deleteGroup: 'delete',
  createVoucherType: 'create',
  updateVoucherType: 'alter',
};

async function voucherTypeOf(db: Db, typeId: unknown): Promise<{ name: string; parent: string } | undefined> {
  return one<{ name: string; parent: string }>(db, 'SELECT name, parent FROM voucher_types WHERE id = ?', [Number(typeId)]);
}

async function voucherOf(db: Db, id: unknown): Promise<{ date: string; name: string; parent: string } | undefined> {
  return one<{ date: string; name: string; parent: string }>(db, 'SELECT v.date, t.name, t.parent FROM vouchers v JOIN voucher_types t ON t.id = v.type_id WHERE v.id = ?', [Number(id)]);
}

async function lastEntryDate(db: Db): Promise<string | null> {
  return (await one<{ d: string | null }>(db, 'SELECT MAX(date) AS d FROM vouchers'))?.d ?? null;
}

export async function voucherDenial(
  db: Db,
  user: SecurityUser | null,
  op: { right: Right; type?: { name: string; parent: string }; dates: string[]; today?: string }
): Promise<string | null> {
  if (!user) return null;
  if (op.type && !canVoucher(user, op.type.name, op.type.parent, op.right)) return ACCESS_DENIED;
  const today = op.today ?? todayIso();
  const last = await lastEntryDate(db);
  for (const d of op.dates) {
    const m = d ? backDatedMessage(user, d, today, last, op.right) : null;
    if (m) return m;
  }
  return null;
}

export function guardBooks(books: object, user: () => SecurityUser | null = currentUser): void {
  if (GUARDED.has(books)) return;
  GUARDED.add(books);
  const b = books as Guardable;
  const wrap = (method: string, check: (args: unknown[]) => Promise<string | null>) => {
    const orig = b[method];
    if (typeof orig !== 'function') return;
    b[method] = async (...args: unknown[]) => {
      const denial = await check(args);
      if (denial) throw new CoreError('invalid', denial);
      return (orig as (...a: unknown[]) => unknown).apply(books, args);
    };
  };
  for (const [method, right] of Object.entries(MASTER_METHODS)) wrap(method, async () => (can(user(), { facility: 'Accounts Masters', right }) ? null : ACCESS_DENIED));
  wrap('createVoucher', async ([input]) => {
    const u = user();
    if (!u) return null;
    const i = input as { type_id?: number; date?: string };
    return voucherDenial(b.db, u, { right: 'create', type: await voucherTypeOf(b.db, i.type_id), dates: [i.date ?? ''] });
  });
  wrap('updateVoucher', async ([id, input]) => {
    const u = user();
    if (!u) return null;
    const cur = await voucherOf(b.db, id);
    return voucherDenial(b.db, u, { right: 'alter', type: cur, dates: [cur?.date ?? '', (input as { date?: string })?.date ?? ''] });
  });
  for (const [method, right] of [['deleteVoucher', 'delete'], ['cancelVoucher', 'alter']] as const) {
    wrap(method, async ([id]) => {
      const u = user();
      if (!u) return null;
      const cur = await voucherOf(b.db, id);
      return voucherDenial(b.db, u, { right, type: cur, dates: [cur?.date ?? ''] });
    });
  }
}

export async function administrator(db: Db): Promise<string | null> {
  const set = await setting(db, 'admin');
  if (set) return set;
  return (await one<{ username: string }>(db, "SELECT username FROM security_users WHERE role = 'Owner' ORDER BY id LIMIT 1"))?.username ?? null;
}

async function loadUser(db: Db, where: string, params: (string | number)[]): Promise<SecurityUser | undefined> {
  const r = await one<UserRow>(db, `SELECT * FROM security_users WHERE ${where}`, params);
  if (!r) return undefined;
  const level = toLevel((await one<LevelRow>(db, 'SELECT * FROM security_levels WHERE id = ?', [r.level_id]))!);
  return toUser(r, level, await administrator(db));
}

export async function securityUsers(db: Db): Promise<SecurityUser[]> {
  const rows = await db.select<UserRow>('SELECT * FROM security_users ORDER BY id');
  const levels = new Map((await securityLevels(db)).map((l) => [l.id, l]));
  const admin = await administrator(db);
  return rows.map((r) => toUser(r, levels.get(r.level_id)!, admin));
}

export interface UserInput {
  username: string;
  role: SecurityRole;
  password?: string;
  active?: boolean;
  browser_access?: boolean;
  remote_access?: boolean;
  local_tdl?: boolean;
  policy_applies?: boolean;
  level?: Omit<LevelInput, 'name' | 'basis'>;
  today?: string;
}

export async function saveUser(db: Db, input: UserInput): Promise<SecurityUser> {
  const username = input.username.trim();
  if (!username) throw new CoreError('invalid', 'Username is required');
  if (!SECURITY_ROLES.includes(input.role)) throw new CoreError('invalid', `Unknown user role ${input.role}`);
  const existing = await loadUser(db, 'username = ?', [username]);
  const policy = await passwordPolicy(db);
  const applies = input.policy_applies ?? existing?.policy_applies ?? true;
  if (input.password) {
    const bad = applies ? checkPasswordPolicy(policy, input.password) : null;
    if (bad) throw new CoreError('invalid', bad);
  }
  const level = await saveSecurityLevel(db, { ...(existing?.level ?? {}), ...(input.level ?? {}), name: username, basis: input.role });
  const hash = input.password ? await hashPassword(input.password) : (existing ? await one<{ h: string | null }>(db, 'SELECT password_hash AS h FROM security_users WHERE id = ?', [existing.id]).then((r) => r?.h ?? null) : null);
  const bit = (v: boolean | undefined, d: boolean) => ((v ?? d) ? 1 : 0);
  const stamp = input.password ? input.today ?? new Date().toISOString().slice(0, 10) : existing?.password_changed_at ?? null;
  const mustChange = input.password ? (policy.active && policy.change_on_first_login && applies ? 1 : 0) : existing?.must_change ? 1 : 0;
  if (existing) {
    const oldHashes = input.password ? await oldPasswordList(db, existing.id, true) : await oldPasswordList(db, existing.id, false);
    await db.batch([
      {
        sql: 'UPDATE security_users SET role=?, level_id=?, password_hash=?, active=?, browser_access=?, remote_access=?, local_tdl=?, policy_applies=?, must_change=?, password_changed_at=?, old_hashes=? WHERE id = ?',
        params: [
          input.role,
          level.id,
          hash,
          bit(input.active, existing.active),
          bit(input.browser_access, existing.browser_access),
          bit(input.remote_access, existing.remote_access),
          bit(input.local_tdl, existing.local_tdl),
          bit(input.policy_applies, existing.policy_applies),
          mustChange,
          stamp,
          oldHashes,
          existing.id,
        ],
      },
    ]);
  } else {
    const id = await nextId(db, 'security_users');
    await db.batch([
      {
        sql: 'INSERT INTO security_users (id, username, role, level_id, password_hash, active, browser_access, remote_access, local_tdl, policy_applies, must_change, password_changed_at, old_hashes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        params: [id, username, input.role, level.id, hash, bit(input.active, true), bit(input.browser_access, false), bit(input.remote_access, false), bit(input.local_tdl, false), bit(input.policy_applies, true), mustChange, stamp, '[]'],
      },
    ]);
  }
  return (await loadUser(db, 'username = ?', [username]))!;
}

async function oldPasswordList(db: Db, userId: number, push: boolean): Promise<string> {
  const r = await one<{ old_hashes: string; password_hash: string | null }>(db, 'SELECT old_hashes, password_hash FROM security_users WHERE id = ?', [userId]);
  const list = JSON.parse(r?.old_hashes ?? '[]') as string[];
  if (push && r?.password_hash) list.push(r.password_hash);
  return JSON.stringify(list.slice(-10));
}

export async function removeUser(db: Db, username: string): Promise<void> {
  const u = await loadUser(db, 'username = ?', [username.trim()]);
  if (!u) throw new CoreError('not_found', 'User not found');
  const owners = (await securityUsers(db)).filter((x) => x.role === 'Owner' && x.username !== u.username);
  if (u.role === 'Owner' && owners.length === 0) throw new CoreError('conflict', 'The last Owner cannot be removed');
  if (u.administrator) throw new CoreError('conflict', 'The Administrator cannot be removed');
  await db.batch([
    { sql: 'DELETE FROM security_users WHERE id = ?', params: [u.id] },
    { sql: 'DELETE FROM security_levels WHERE id = ?', params: [u.level.id] },
  ]);
}

export async function enableSecurity(db: Db, admin: { username: string; password: string; today?: string }): Promise<SecurityUser> {
  if (await securityEnabled(db)) throw new CoreError('conflict', 'Security is already enabled for this company');
  if (!admin.username.trim()) throw new CoreError('invalid', 'Administrator username is required');
  if (!admin.password) throw new CoreError('invalid', 'Administrator password is required');
  await saveUser(db, { username: admin.username, role: 'Owner', password: admin.password, policy_applies: false, today: admin.today });
  await db.batch([putSetting('enabled', '1'), putSetting('admin', admin.username.trim())]);
  return (await loadUser(db, 'username = ?', [admin.username.trim()]))!;
}

export async function disableSecurity(db: Db, actor: SecurityUser | null): Promise<void> {
  if (actor && actor.role !== 'Owner') throw new CoreError('invalid', 'Only an Owner can disable security');
  await db.batch([
    { sql: 'DELETE FROM security_users' },
    { sql: 'DELETE FROM security_levels' },
    { sql: "DELETE FROM security_settings WHERE key IN ('enabled', 'admin')" },
  ]);
}

export interface LoginResult {
  user: SecurityUser;
  must_change: boolean;
  expired: boolean;
  expires_in_days: number | null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export async function login(db: Db, username: string, password: string, today: string = new Date().toISOString().slice(0, 10)): Promise<LoginResult> {
  const row = await one<UserRow>(db, 'SELECT * FROM security_users WHERE username = ?', [username.trim()]);
  const stored = row?.password_hash ?? null;
  if (!row) {
    await verifyPassword(password, null);
    throw new CoreError('invalid', 'Incorrect user id/User does not exists');
  }
  if (stored ? !(await verifyPassword(password, stored)) : password !== '') throw new CoreError('invalid', 'Incorrect password');
  if (!row.active) throw new CoreError('invalid', 'User is inactive');
  const user = (await loadUser(db, 'id = ?', [row.id]))!;
  const policy = await passwordPolicy(db);
  let expired = false;
  let left: number | null = null;
  if (policy.active && user.policy_applies && policy.expires_days > 0 && user.password_changed_at) {
    left = policy.expires_days - daysBetween(user.password_changed_at, today);
    expired = left <= 0;
    if (!policy.notify_expiry && !expired) left = null;
  }
  return { user, must_change: user.must_change || expired, expired, expires_in_days: left };
}

export async function changePassword(
  db: Db,
  username: string,
  oldPassword: string,
  newPassword: string,
  opts: { today?: string; actor?: SecurityUser | null } = {}
): Promise<SecurityUser> {
  const row = await one<UserRow & { old_hashes: string }>(db, 'SELECT * FROM security_users WHERE username = ?', [username.trim()]);
  if (!row) throw new CoreError('not_found', 'User not found');
  if (row.password_hash && !(await verifyPassword(oldPassword, row.password_hash))) throw new CoreError('invalid', 'Incorrect old password');
  const policy = await passwordPolicy(db);
  const user = (await loadUser(db, 'id = ?', [row.id]))!;
  if (policy.active && user.policy_applies && !policy.allow_change && !user.must_change && opts.actor?.role !== 'Owner') {
    throw new CoreError('invalid', 'Password change is not allowed by the password policy');
  }
  const bad = user.policy_applies ? checkPasswordPolicy(policy, newPassword) : null;
  if (bad) throw new CoreError('invalid', bad);
  if (!newPassword) throw new CoreError('invalid', 'New password is required');
  if (policy.active && policy.restrict_old && user.policy_applies) {
    const history = [...(JSON.parse(row.old_hashes) as string[]), ...(row.password_hash ? [row.password_hash] : [])];
    for (const h of history) if (await verifyPassword(newPassword, h)) throw new CoreError('invalid', 'This password was used earlier. Enter a new password');
  }
  const hash = await hashPassword(newPassword);
  await db.batch([
    {
      sql: 'UPDATE security_users SET password_hash = ?, must_change = 0, password_changed_at = ?, old_hashes = ? WHERE id = ?',
      params: [hash, opts.today ?? new Date().toISOString().slice(0, 10), await oldPasswordList(db, row.id, true), row.id],
    },
  ]);
  return (await loadUser(db, 'id = ?', [row.id]))!;
}

export async function vaultEnabled(db: Db): Promise<boolean> {
  return (await setting(db, 'vault')) !== null;
}

export async function unlockVault(db: Db, password: string): Promise<boolean> {
  const stored = await setting(db, 'vault');
  return stored === null ? true : verifyPassword(password, stored);
}

export async function clearLegacyVault(db: Db): Promise<void> {
  await db.batch([{ sql: "DELETE FROM security_settings WHERE key = 'vault'" }]);
}

export interface EditLogEntry {
  id: number;
  at: string;
  username: string;
  action: string;
  entity: string;
  entity_id: number | null;
  detail: string;
}

export interface EditLogInput {
  action: 'create' | 'alter' | 'delete' | string;
  entity: string;
  entity_id?: number | null;
  detail?: string;
  at?: string;
}

export function editLogStmt(id: number, user: SecurityUser | null, e: EditLogInput): Stmt {
  return {
    sql: 'INSERT INTO security_edit_log (id, at, username, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?,?)',
    params: [id, e.at ?? new Date().toISOString(), user?.username ?? '', e.action, e.entity, e.entity_id ?? null, e.detail ?? ''],
  };
}

export async function logEdit(db: Db, user: SecurityUser | null, e: EditLogInput): Promise<EditLogEntry> {
  const id = await nextId(db, 'security_edit_log');
  await db.batch([editLogStmt(id, user, e)]);
  return (await one<EditLogEntry>(db, 'SELECT * FROM security_edit_log WHERE id = ?', [id]))!;
}

export async function editLog(db: Db, filter: { username?: string; entity?: string; entity_id?: number; from?: string; to?: string } = {}): Promise<EditLogEntry[]> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.username !== undefined) (where.push('username = ?'), params.push(filter.username));
  if (filter.entity !== undefined) (where.push('entity = ?'), params.push(filter.entity));
  if (filter.entity_id !== undefined) (where.push('entity_id = ?'), params.push(filter.entity_id));
  if (filter.from) (where.push('substr(at, 1, 10) >= ?'), params.push(filter.from));
  if (filter.to) (where.push('substr(at, 1, 10) <= ?'), params.push(filter.to));
  return db.select<EditLogEntry>(`SELECT * FROM security_edit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`, params);
}

export interface EditLogUserSummary {
  username: string;
  count: number;
  last_at: string;
}

export async function editLogByUser(db: Db): Promise<EditLogUserSummary[]> {
  return db.select<EditLogUserSummary>('SELECT username, COUNT(*) AS count, MAX(at) AS last_at FROM security_edit_log GROUP BY username ORDER BY username');
}

export interface CompanyRef {
  id: string;
  name: string;
  path: string;
  last_opened?: string;
}

export interface CompanyList {
  companies: CompanyRef[];
  selected: string | null;
}

export function emptyCompanyList(): CompanyList {
  return { companies: [], selected: null };
}

export function addCompanyRef(list: CompanyList, ref: CompanyRef): CompanyList {
  if (!ref.name.trim()) throw new CoreError('invalid', 'Company name is required');
  if (list.companies.some((c) => c.id === ref.id)) throw new CoreError('conflict', 'Company is already in the list');
  return { ...list, companies: [...list.companies, ref] };
}

export function removeCompanyRef(list: CompanyList, id: string): CompanyList {
  return { companies: list.companies.filter((c) => c.id !== id), selected: list.selected === id ? null : list.selected };
}

export function selectCompanyRef(list: CompanyList, id: string, now: string = new Date().toISOString()): CompanyList {
  if (!list.companies.some((c) => c.id === id)) throw new CoreError('not_found', 'Company not in list');
  return { companies: list.companies.map((c) => (c.id === id ? { ...c, last_opened: now } : c)), selected: id };
}

export function sortedCompanyRefs(list: CompanyList): CompanyRef[] {
  return [...list.companies].sort((a, b) => a.name.localeCompare(b.name));
}

export * from './companies.ts';
export * from './facilities.ts';
