import { CoreError, one, type Db, type Stmt } from './db.ts';
import { clean } from './util.ts';
import type { EntryInput } from './books.ts';

export const VCLASS_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS voucher_classes (
    id INTEGER PRIMARY KEY,
    type_id INTEGER NOT NULL REFERENCES voucher_types(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    forex_adjust INTEGER NOT NULL DEFAULT 0,
    UNIQUE (type_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS voucher_class_lines (
    id INTEGER PRIMARY KEY,
    class_id INTEGER NOT NULL REFERENCES voucher_classes(id) ON DELETE CASCADE,
    section TEXT NOT NULL CHECK (section IN ('default','additional','forex')),
    seq INTEGER NOT NULL,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    side TEXT NOT NULL DEFAULT 'Dr' CHECK (side IN ('Dr','Cr')),
    calc TEXT NOT NULL DEFAULT 'percent' CHECK (calc IN ('percent','fixed','user')),
    value INTEGER NOT NULL DEFAULT 0,
    remove_if_zero INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS voucher_type_options (
    type_id INTEGER PRIMARY KEY REFERENCES voucher_types(id) ON DELETE CASCADE,
    use_effective_dates INTEGER NOT NULL DEFAULT 0,
    allow_zero_valued INTEGER NOT NULL DEFAULT 0,
    optional_by_default INTEGER NOT NULL DEFAULT 0,
    allow_narration INTEGER NOT NULL DEFAULT 1,
    narration_per_ledger INTEGER NOT NULL DEFAULT 0,
    track_additional_costs INTEGER NOT NULL DEFAULT 0,
    default_accounting_allocations INTEGER NOT NULL DEFAULT 0,
    print_after_saving INTEGER NOT NULL DEFAULT 0,
    whatsapp_after_saving INTEGER NOT NULL DEFAULT 0,
    payment_qr_after_saving INTEGER NOT NULL DEFAULT 0,
    pos_invoicing INTEGER NOT NULL DEFAULT 0,
    pos_message1 TEXT NOT NULL DEFAULT '',
    pos_message2 TEXT NOT NULL DEFAULT '',
    default_template TEXT NOT NULL DEFAULT '',
    default_title TEXT NOT NULL DEFAULT '',
    default_bank TEXT NOT NULL DEFAULT '',
    default_jurisdiction TEXT NOT NULL DEFAULT '',
    set_declaration INTEGER NOT NULL DEFAULT 0,
    declaration TEXT NOT NULL DEFAULT '',
    set_terms INTEGER NOT NULL DEFAULT 0,
    default_terms TEXT NOT NULL DEFAULT ''
  )`,
];

export async function ensureVClass(db: Db): Promise<void> {
  await db.batch(VCLASS_SCHEMA.map((sql) => ({ sql })));
}

export type ClassSection = 'default' | 'additional' | 'forex';
export type ClassCalc = 'percent' | 'fixed' | 'user';

export const CALC_LABELS: Record<ClassCalc, string> = {
  percent: 'Percentage',
  fixed: 'Flat Rate',
  user: 'As User Defined Value',
};

export interface ClassLineInput {
  section: ClassSection;
  ledger_id: number;
  side?: 'Dr' | 'Cr';
  calc?: ClassCalc;
  value?: number;
  remove_if_zero?: boolean | number;
}

export interface ClassLine {
  id: number;
  class_id: number;
  section: ClassSection;
  seq: number;
  ledger_id: number;
  ledger: string;
  side: 'Dr' | 'Cr';
  calc: ClassCalc;
  value: number;
  remove_if_zero: number;
}

export interface VoucherClass {
  id: number;
  type_id: number;
  name: string;
  forex_adjust: number;
  lines: ClassLine[];
}

export interface VoucherClassInput {
  type_id: number;
  name: string;
  forex_adjust?: boolean | number;
  lines: ClassLineInput[];
}

export const PERCENT_SCALE = 10000;

export function parsePercent(text: string): number | null {
  const t = String(text).replace(/[%\s]/g, '');
  if (!/^\d*\.?\d{0,2}$/.test(t) || t === '' || t === '.') return null;
  const [w, f = ''] = t.split('.');
  return parseInt(w || '0', 10) * 100 + parseInt(f.padEnd(2, '0') || '0', 10);
}

export function fmtPercent(bp: number): string {
  const w = Math.floor(bp / 100);
  const f = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : String(w);
}

async function loadLines(db: Db, classId: number): Promise<ClassLine[]> {
  return db.select<ClassLine>(
    `SELECT cl.id, cl.class_id, cl.section, cl.seq, cl.ledger_id, l.name AS ledger, cl.side, cl.calc, cl.value, cl.remove_if_zero
     FROM voucher_class_lines cl JOIN ledgers l ON l.id = cl.ledger_id WHERE cl.class_id = ? ORDER BY CASE cl.section WHEN 'default' THEN 0 WHEN 'additional' THEN 1 ELSE 2 END, cl.seq`,
    [classId]
  );
}

export async function voucherClasses(db: Db, typeId?: number): Promise<VoucherClass[]> {
  const rows = typeId
    ? await db.select<Omit<VoucherClass, 'lines'>>('SELECT * FROM voucher_classes WHERE type_id = ? ORDER BY id', [typeId])
    : await db.select<Omit<VoucherClass, 'lines'>>('SELECT * FROM voucher_classes ORDER BY id');
  const out: VoucherClass[] = [];
  for (const r of rows) out.push({ ...r, lines: await loadLines(db, r.id) });
  return out;
}

export async function voucherClass(db: Db, id: number): Promise<VoucherClass | null> {
  const r = await one<Omit<VoucherClass, 'lines'>>(db, 'SELECT * FROM voucher_classes WHERE id = ?', [id]);
  return r ? { ...r, lines: await loadLines(db, id) } : null;
}

async function validate(db: Db, input: VoucherClassInput, selfId: number | null): Promise<string> {
  const name = clean(input.name, 60);
  if (!name) throw new CoreError('invalid', 'Name of Class is required');
  if (!(await one(db, 'SELECT 1 FROM voucher_types WHERE id = ?', [input.type_id]))) throw new CoreError('not_found', 'Voucher type not found');
  if (await one(db, 'SELECT 1 FROM voucher_classes WHERE type_id = ? AND name = ? AND id <> ?', [input.type_id, name, selfId ?? 0])) throw new CoreError('conflict', `Class '${name}' already exists for this voucher type`);
  for (const l of input.lines) {
    if (!(await one(db, 'SELECT 1 FROM ledgers WHERE id = ?', [l.ledger_id]))) throw new CoreError('not_found', 'Ledger not found');
    const calc = l.calc ?? 'percent';
    const v = l.value ?? 0;
    if (!Number.isInteger(v) || v < 0) throw new CoreError('invalid', 'Value cannot be negative');
    if (calc === 'percent' && v > 100 * PERCENT_SCALE) throw new CoreError('invalid', 'Percentage is too large');
  }
  return name;
}

function lineStmts(classId: number, lines: ClassLineInput[], firstId: number): Stmt[] {
  const seq: Record<string, number> = {};
  return lines.map((l, i) => {
    const s = l.section;
    seq[s] = (seq[s] ?? -1) + 1;
    return {
      sql: 'INSERT INTO voucher_class_lines (id, class_id, section, seq, ledger_id, side, calc, value, remove_if_zero) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [firstId + i, classId, s, seq[s], l.ledger_id, l.side ?? 'Dr', l.calc ?? 'percent', l.value ?? 0, l.remove_if_zero ? 1 : 0],
    };
  });
}

async function nextLineId(db: Db): Promise<number> {
  return ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM voucher_class_lines'))!.m) + 1;
}

export async function createVoucherClass(db: Db, input: VoucherClassInput): Promise<VoucherClass> {
  const name = await validate(db, input, null);
  const id = ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM voucher_classes'))!.m) + 1;
  await db.batch([
    { sql: 'INSERT INTO voucher_classes (id, type_id, name, forex_adjust) VALUES (?, ?, ?, ?)', params: [id, input.type_id, name, input.forex_adjust ? 1 : 0] },
    ...lineStmts(id, input.lines, await nextLineId(db)),
  ]);
  return (await voucherClass(db, id))!;
}

export async function updateVoucherClass(db: Db, id: number, input: VoucherClassInput): Promise<VoucherClass> {
  const cur = await voucherClass(db, id);
  if (!cur) throw new CoreError('not_found', 'Voucher class not found');
  const name = await validate(db, { ...input, type_id: cur.type_id }, id);
  await db.batch([
    { sql: 'UPDATE voucher_classes SET name = ?, forex_adjust = ? WHERE id = ?', params: [name, input.forex_adjust ? 1 : 0, id] },
    { sql: 'DELETE FROM voucher_class_lines WHERE class_id = ?', params: [id] },
    ...lineStmts(id, input.lines, await nextLineId(db)),
  ]);
  return (await voucherClass(db, id))!;
}

export async function deleteVoucherClass(db: Db, id: number): Promise<void> {
  if (!(await voucherClass(db, id))) throw new CoreError('not_found', 'Voucher class not found');
  await db.batch([
    { sql: 'DELETE FROM voucher_class_lines WHERE class_id = ?', params: [id] },
    { sql: 'DELETE FROM voucher_classes WHERE id = ?', params: [id] },
  ]);
}

export interface ExpandedEntry extends EntryInput {
  ledger: string;
  section: ClassSection;
  editable: boolean;
}

export function expandClass(cls: VoucherClass, baseAmount: number, sections: ClassSection[] = ['default', 'additional', 'forex']): ExpandedEntry[] {
  const out: ExpandedEntry[] = [];
  for (const l of cls.lines) {
    if (!sections.includes(l.section)) continue;
    let abs = 0;
    if (l.calc === 'percent') abs = Math.round((Math.abs(baseAmount) * l.value) / PERCENT_SCALE);
    else if (l.calc === 'fixed') abs = l.value;
    if (abs === 0 && l.remove_if_zero) continue;
    out.push({ ledger_id: l.ledger_id, ledger: l.ledger, amount: l.side === 'Dr' ? abs : -abs, section: l.section, editable: l.calc === 'user' || l.section === 'forex' });
  }
  return out;
}

export async function expandVoucherClass(db: Db, classId: number, baseAmount: number): Promise<ExpandedEntry[]> {
  const cls = await voucherClass(db, classId);
  if (!cls) throw new CoreError('not_found', 'Voucher class not found');
  return expandClass(cls, baseAmount);
}

export function forexClassLedgers(classes: VoucherClass[]): { id: number; name: string }[] {
  const seen = new Map<number, string>();
  for (const c of classes) {
    if (!c.forex_adjust) continue;
    for (const l of c.lines) if (l.section === 'forex') seen.set(l.ledger_id, l.ledger);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

export interface VoucherTypeOptions {
  type_id: number;
  use_effective_dates: number;
  allow_zero_valued: number;
  optional_by_default: number;
  allow_narration: number;
  narration_per_ledger: number;
  track_additional_costs: number;
  default_accounting_allocations: number;
  print_after_saving: number;
  whatsapp_after_saving: number;
  payment_qr_after_saving: number;
  pos_invoicing: number;
  pos_message1: string;
  pos_message2: string;
  default_template: string;
  default_title: string;
  default_bank: string;
  default_jurisdiction: string;
  set_declaration: number;
  declaration: string;
  set_terms: number;
  default_terms: string;
}

export const VOUCHER_TYPE_OPTION_DEFAULTS: Omit<VoucherTypeOptions, 'type_id'> = {
  use_effective_dates: 0,
  allow_zero_valued: 0,
  optional_by_default: 0,
  allow_narration: 1,
  narration_per_ledger: 0,
  track_additional_costs: 0,
  default_accounting_allocations: 0,
  print_after_saving: 0,
  whatsapp_after_saving: 0,
  payment_qr_after_saving: 0,
  pos_invoicing: 0,
  pos_message1: '',
  pos_message2: '',
  default_template: '',
  default_title: '',
  default_bank: '',
  default_jurisdiction: '',
  set_declaration: 0,
  declaration: '',
  set_terms: 0,
  default_terms: '',
};

const OPTION_TEXT = ['pos_message1', 'pos_message2', 'default_template', 'default_title', 'default_bank', 'default_jurisdiction', 'declaration', 'default_terms'] as const;
const OPTION_KEYS = Object.keys(VOUCHER_TYPE_OPTION_DEFAULTS) as (keyof typeof VOUCHER_TYPE_OPTION_DEFAULTS)[];

export async function voucherTypeOptions(db: Db, typeId: number): Promise<VoucherTypeOptions> {
  const r = await one<VoucherTypeOptions>(db, 'SELECT * FROM voucher_type_options WHERE type_id = ?', [typeId]);
  return r ?? { type_id: typeId, ...VOUCHER_TYPE_OPTION_DEFAULTS };
}

export async function setVoucherTypeOptions(db: Db, typeId: number, patch: Partial<Omit<VoucherTypeOptions, 'type_id'>>): Promise<VoucherTypeOptions> {
  const t = await one<{ parent: string }>(db, 'SELECT parent FROM voucher_types WHERE id = ?', [typeId]);
  if (!t) throw new CoreError('not_found', 'Voucher type not found');
  if (patch.optional_by_default && (t.parent === 'Memorandum' || t.parent === 'Reversing Journal')) throw new CoreError('invalid', "'Optional' by default is not applicable to this voucher type");
  const cur = await voucherTypeOptions(db, typeId);
  const next: Record<string, string | number> = { ...cur };
  for (const k of OPTION_KEYS) {
    const v = patch[k];
    if (v === undefined) continue;
    next[k] = (OPTION_TEXT as readonly string[]).includes(k) ? clean(v, 200) : v ? 1 : 0;
  }
  await db.batch([
    { sql: 'DELETE FROM voucher_type_options WHERE type_id = ?', params: [typeId] },
    {
      sql: `INSERT INTO voucher_type_options (type_id, ${OPTION_KEYS.join(', ')}) VALUES (?, ${OPTION_KEYS.map(() => '?').join(', ')})`,
      params: [typeId, ...OPTION_KEYS.map((k) => next[k])],
    },
  ]);
  return voucherTypeOptions(db, typeId);
}
