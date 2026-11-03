import { CoreError, one, type Db, type Stmt } from './db.ts';
import { clean } from './util.ts';
import type { EntryInput } from './books.ts';

const LINES_TABLE = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
    id INTEGER PRIMARY KEY,
    class_id INTEGER NOT NULL REFERENCES voucher_classes(id) ON DELETE CASCADE,
    section TEXT NOT NULL CHECK (section IN ('default','additional','forex')),
    seq INTEGER NOT NULL,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    side TEXT NOT NULL DEFAULT 'Dr' CHECK (side IN ('Dr','Cr')),
    calc TEXT NOT NULL DEFAULT 'percent' CHECK (calc IN ('percent','fixed','user','subtotal','qty','round')),
    value INTEGER NOT NULL DEFAULT 0,
    remove_if_zero INTEGER NOT NULL DEFAULT 0,
    rounding TEXT NOT NULL DEFAULT 'none' CHECK (rounding IN ('none','normal','upward','downward')),
    round_limit INTEGER NOT NULL DEFAULT 0
  )`;

export const VCLASS_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS voucher_classes (
    id INTEGER PRIMARY KEY,
    type_id INTEGER NOT NULL REFERENCES voucher_types(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    forex_adjust INTEGER NOT NULL DEFAULT 0,
    override_item_defaults INTEGER NOT NULL DEFAULT 0,
    pos_class INTEGER NOT NULL DEFAULT 0,
    print_title TEXT NOT NULL DEFAULT '',
    gift_ledger_id INTEGER REFERENCES ledgers(id),
    card_ledger_id INTEGER REFERENCES ledgers(id),
    cheque_ledger_id INTEGER REFERENCES ledgers(id),
    cash_ledger_id INTEGER REFERENCES ledgers(id),
    UNIQUE (type_id, name)
  )`,
  LINES_TABLE('voucher_class_lines'),
  `CREATE TABLE IF NOT EXISTS voucher_class_use (
    voucher_id INTEGER PRIMARY KEY REFERENCES vouchers(id) ON DELETE CASCADE,
    class_id INTEGER NOT NULL REFERENCES voucher_classes(id) ON DELETE CASCADE
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

const CLASS_COLUMNS: [string, string][] = [
  ['override_item_defaults', 'INTEGER NOT NULL DEFAULT 0'],
  ['pos_class', 'INTEGER NOT NULL DEFAULT 0'],
  ['print_title', "TEXT NOT NULL DEFAULT ''"],
  ['gift_ledger_id', 'INTEGER REFERENCES ledgers(id)'],
  ['card_ledger_id', 'INTEGER REFERENCES ledgers(id)'],
  ['cheque_ledger_id', 'INTEGER REFERENCES ledgers(id)'],
  ['cash_ledger_id', 'INTEGER REFERENCES ledgers(id)'],
];

export async function ensureVClass(db: Db): Promise<void> {
  await db.batch(VCLASS_SCHEMA.map((sql) => ({ sql })));
  const have = new Set((await db.select<{ name: string }>(`SELECT name FROM pragma_table_info('voucher_classes')`)).map((r) => r.name));
  const add = CLASS_COLUMNS.filter(([c]) => !have.has(c)).map(([c, ddl]) => ({ sql: `ALTER TABLE voucher_classes ADD COLUMN ${c} ${ddl}` }));
  if (add.length) await db.batch(add);
  const lines = await one<{ sql: string }>(db, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'voucher_class_lines'`);
  if (lines && !lines.sql.includes('round_limit')) {
    await db.batch([
      { sql: 'DROP TABLE IF EXISTS voucher_class_lines_v2' },
      { sql: LINES_TABLE('voucher_class_lines_v2') },
      { sql: 'INSERT INTO voucher_class_lines_v2 (id, class_id, section, seq, ledger_id, side, calc, value, remove_if_zero) SELECT id, class_id, section, seq, ledger_id, side, calc, value, remove_if_zero FROM voucher_class_lines' },
      { sql: 'DROP TABLE voucher_class_lines' },
      { sql: 'ALTER TABLE voucher_class_lines_v2 RENAME TO voucher_class_lines' },
    ]);
  }
}

export type ClassSection = 'default' | 'additional' | 'forex';
export type ClassCalc = 'percent' | 'fixed' | 'user' | 'subtotal' | 'qty' | 'round';
export type RoundMethod = 'none' | 'normal' | 'upward' | 'downward';

export const INVOICE_CLASS_TYPES: readonly string[] = ['Sales', 'Purchase', 'Credit Note', 'Debit Note'];

export const CALC_LABELS: Record<ClassCalc, string> = {
  percent: 'Percentage',
  fixed: 'Flat Rate',
  user: 'As User Defined Value',
  subtotal: 'On Current SubTotal',
  qty: 'Based on Quantity',
  round: 'As Total Amount Rounding',
};

export const ACCOUNTING_CALCS: ClassCalc[] = ['percent', 'fixed', 'user'];
export const INVOICE_CALCS: ClassCalc[] = ['round', 'user', 'qty', 'fixed', 'subtotal', 'percent'];

export function invoiceCalcLabel(calc: ClassCalc, kind: string): string {
  if (calc !== 'percent') return CALC_LABELS[calc];
  return kind === 'Purchase' || kind === 'Debit Note' ? 'On Total Purchases' : 'On Total Sales';
}

export const ROUND_LABELS: Record<RoundMethod, string> = {
  none: 'Not Applicable',
  downward: 'Downward Rounding',
  normal: 'Normal Rounding',
  upward: 'Upward Rounding',
};

export function roundTo(v: number, method: RoundMethod, limit: number): number {
  if (method === 'none' || !(limit > 0)) return v;
  const q = v / limit;
  const r = method === 'normal' ? Math.round(q) : method === 'upward' ? Math.ceil(q - 1e-9) : Math.floor(q + 1e-9);
  return r * limit;
}

export interface ClassLineInput {
  section: ClassSection;
  ledger_id: number;
  side?: 'Dr' | 'Cr';
  calc?: ClassCalc;
  value?: number;
  remove_if_zero?: boolean | number;
  rounding?: RoundMethod;
  round_limit?: number;
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
  rounding: RoundMethod;
  round_limit: number;
}

export interface VoucherClass {
  id: number;
  type_id: number;
  name: string;
  forex_adjust: number;
  override_item_defaults: number;
  pos_class: number;
  print_title: string;
  gift_ledger_id: number | null;
  card_ledger_id: number | null;
  cheque_ledger_id: number | null;
  cash_ledger_id: number | null;
  lines: ClassLine[];
}

export interface VoucherClassInput {
  type_id: number;
  name: string;
  forex_adjust?: boolean | number;
  override_item_defaults?: boolean | number;
  pos_class?: boolean | number;
  print_title?: string;
  gift_ledger_id?: number | null;
  card_ledger_id?: number | null;
  cheque_ledger_id?: number | null;
  cash_ledger_id?: number | null;
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
    `SELECT cl.id, cl.class_id, cl.section, cl.seq, cl.ledger_id, l.name AS ledger, cl.side, cl.calc, cl.value, cl.remove_if_zero, cl.rounding, cl.round_limit
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

const ROUND_KEYS = Object.keys(ROUND_LABELS) as RoundMethod[];
const CALC_KEYS = Object.keys(CALC_LABELS) as ClassCalc[];
const POS_LEDGERS = ['gift_ledger_id', 'card_ledger_id', 'cheque_ledger_id', 'cash_ledger_id'] as const;

async function validate(db: Db, input: VoucherClassInput, selfId: number | null): Promise<string> {
  const name = clean(input.name, 60);
  if (!name) throw new CoreError('invalid', 'Name of Class is required');
  const type = await one<{ parent: string }>(db, 'SELECT parent FROM voucher_types WHERE id = ?', [input.type_id]);
  if (!type) throw new CoreError('not_found', 'Voucher type not found');
  if (await one(db, 'SELECT 1 FROM voucher_classes WHERE type_id = ? AND name = ? AND id <> ?', [input.type_id, name, selfId ?? 0])) throw new CoreError('conflict', `Class '${name}' already exists for this voucher type`);
  for (const l of input.lines) {
    if (!(await one(db, 'SELECT 1 FROM ledgers WHERE id = ?', [l.ledger_id]))) throw new CoreError('not_found', 'Ledger not found');
    const calc = l.calc ?? 'percent';
    if (!CALC_KEYS.includes(calc)) throw new CoreError('invalid', 'Unknown type of calculation');
    if (l.rounding && !ROUND_KEYS.includes(l.rounding)) throw new CoreError('invalid', 'Unknown rounding method');
    const v = l.value ?? 0;
    if (!Number.isInteger(v) || v < 0) throw new CoreError('invalid', 'Value cannot be negative');
    const lim = l.round_limit ?? 0;
    if (!Number.isInteger(lim) || lim < 0) throw new CoreError('invalid', 'Rounding limit cannot be negative');
    if ((calc === 'percent' || calc === 'subtotal') && v > 100 * PERCENT_SCALE) throw new CoreError('invalid', 'Percentage is too large');
    if (calc === 'round' && (l.rounding ?? 'none') === 'none') throw new CoreError('invalid', 'Choose a rounding method for As Total Amount Rounding');
  }
  if (INVOICE_CLASS_TYPES.includes(type.parent)) {
    const defaults = input.lines.filter((l) => l.section === 'default');
    const pct = defaults.reduce((s, l) => s + (l.value ?? 0), 0);
    if (defaults.length && pct !== 100 * 100) throw new CoreError('invalid', 'Default Accounting Allocations must total 100%');
  }
  if (input.pos_class) {
    for (const k of POS_LEDGERS) {
      const id = input[k];
      if (id && !(await one(db, 'SELECT 1 FROM ledgers WHERE id = ?', [id]))) throw new CoreError('not_found', 'Ledger not found');
    }
  }
  return name;
}

function lineStmts(classId: number, lines: ClassLineInput[], firstId: number): Stmt[] {
  const seq: Record<string, number> = {};
  return lines.map((l, i) => {
    const s = l.section;
    seq[s] = (seq[s] ?? -1) + 1;
    return {
      sql: 'INSERT INTO voucher_class_lines (id, class_id, section, seq, ledger_id, side, calc, value, remove_if_zero, rounding, round_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [firstId + i, classId, s, seq[s], l.ledger_id, l.side ?? 'Dr', l.calc ?? 'percent', l.value ?? 0, l.remove_if_zero ? 1 : 0, l.rounding ?? 'none', l.round_limit ?? 0],
    };
  });
}

async function nextLineId(db: Db): Promise<number> {
  return ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM voucher_class_lines'))!.m) + 1;
}

function classParams(input: VoucherClassInput): (string | number | null)[] {
  const pos = !!input.pos_class;
  return [
    input.forex_adjust ? 1 : 0,
    input.override_item_defaults ? 1 : 0,
    pos ? 1 : 0,
    pos ? clean(input.print_title ?? '', 100) : '',
    ...POS_LEDGERS.map((k) => (pos ? input[k] || null : null)),
  ];
}

const CLASS_SET = 'forex_adjust = ?, override_item_defaults = ?, pos_class = ?, print_title = ?, gift_ledger_id = ?, card_ledger_id = ?, cheque_ledger_id = ?, cash_ledger_id = ?';

export async function createVoucherClass(db: Db, input: VoucherClassInput): Promise<VoucherClass> {
  const name = await validate(db, input, null);
  const id = ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM voucher_classes'))!.m) + 1;
  await db.batch([
    {
      sql: 'INSERT INTO voucher_classes (id, type_id, name, forex_adjust, override_item_defaults, pos_class, print_title, gift_ledger_id, card_ledger_id, cheque_ledger_id, cash_ledger_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [id, input.type_id, name, ...classParams(input)],
    },
    ...lineStmts(id, input.lines, await nextLineId(db)),
  ]);
  return (await voucherClass(db, id))!;
}

export async function updateVoucherClass(db: Db, id: number, input: VoucherClassInput): Promise<VoucherClass> {
  const cur = await voucherClass(db, id);
  if (!cur) throw new CoreError('not_found', 'Voucher class not found');
  const name = await validate(db, { ...input, type_id: cur.type_id }, id);
  await db.batch([
    { sql: `UPDATE voucher_classes SET name = ?, ${CLASS_SET} WHERE id = ?`, params: [name, ...classParams(input), id] },
    { sql: 'DELETE FROM voucher_class_lines WHERE class_id = ?', params: [id] },
    ...lineStmts(id, input.lines, await nextLineId(db)),
  ]);
  return (await voucherClass(db, id))!;
}

export async function deleteVoucherClass(db: Db, id: number): Promise<void> {
  if (!(await voucherClass(db, id))) throw new CoreError('not_found', 'Voucher class not found');
  await db.batch([
    { sql: 'DELETE FROM voucher_class_use WHERE class_id = ?', params: [id] },
    { sql: 'DELETE FROM voucher_class_lines WHERE class_id = ?', params: [id] },
    { sql: 'DELETE FROM voucher_classes WHERE id = ?', params: [id] },
  ]);
}

export async function setVoucherClassUse(db: Db, voucherId: number, classId: number | null): Promise<void> {
  await db.batch([
    { sql: 'DELETE FROM voucher_class_use WHERE voucher_id = ?', params: [voucherId] },
    ...(classId ? [{ sql: 'INSERT INTO voucher_class_use (voucher_id, class_id) VALUES (?, ?)', params: [voucherId, classId] }] : []),
  ]);
}

export async function voucherClassUse(db: Db, voucherId: number): Promise<VoucherClass | null> {
  const r = await one<{ class_id: number }>(db, 'SELECT class_id FROM voucher_class_use WHERE voucher_id = ?', [voucherId]);
  return r ? voucherClass(db, r.class_id) : null;
}

export interface ExpandedEntry extends EntryInput {
  ledger: string;
  section: ClassSection;
  editable: boolean;
}

export function expandClass(cls: VoucherClass, baseAmount: number, sections: ClassSection[] = ['default', 'additional', 'forex']): ExpandedEntry[] {
  const out: ExpandedEntry[] = [];
  let running = Math.abs(baseAmount);
  for (const l of cls.lines) {
    if (!sections.includes(l.section)) continue;
    let abs = 0;
    if (l.calc === 'percent') abs = Math.round((Math.abs(baseAmount) * l.value) / PERCENT_SCALE);
    else if (l.calc === 'subtotal') abs = Math.round((running * l.value) / PERCENT_SCALE);
    else if (l.calc === 'fixed') abs = l.value;
    abs = roundTo(abs, l.rounding ?? 'none', l.round_limit ?? 0);
    if (l.section === 'additional') running += abs;
    if (abs === 0 && l.remove_if_zero) continue;
    out.push({ ledger_id: l.ledger_id, ledger: l.ledger, amount: l.side === 'Dr' ? abs : -abs, section: l.section, editable: l.calc === 'user' || l.calc === 'qty' || l.calc === 'round' || l.section === 'forex' });
  }
  return out;
}

export async function expandVoucherClass(db: Db, classId: number, baseAmount: number): Promise<ExpandedEntry[]> {
  const cls = await voucherClass(db, classId);
  if (!cls) throw new CoreError('not_found', 'Voucher class not found');
  return expandClass(cls, baseAmount);
}

export const partyIsDebit = (kind: string): boolean => kind === 'Sales' || kind === 'Debit Note';

export function hasDefaultAllocations(cls: VoucherClass | null | undefined): boolean {
  return !!cls && cls.lines.some((l) => l.section === 'default');
}

export function splitDefault(cls: VoucherClass, amount: number): { ledger_id: number; ledger: string; amount: number }[] {
  const ds = cls.lines.filter((l) => l.section === 'default');
  let left = amount;
  return ds
    .map((l, i) => {
      const a = i === ds.length - 1 ? left : roundTo(Math.round((amount * l.value) / PERCENT_SCALE), l.rounding, l.round_limit);
      left -= a;
      return { ledger_id: l.ledger_id, ledger: l.ledger, amount: a };
    })
    .filter((x) => x.amount !== 0);
}

export interface InvoiceClassLine {
  line_id: number;
  ledger_id: number;
  ledger: string;
  calc: ClassCalc;
  value: number;
  amount: number;
  editable: boolean;
  remove_if_zero: boolean;
}

export interface InvoiceClassBase {
  sales: number;
  tax: number;
  qty: number;
  user?: Record<number, number>;
}

export function invoiceAdditional(cls: VoucherClass, kind: string, base: InvoiceClassBase): InvoiceClassLine[] {
  const charge = partyIsDebit(kind) ? 'Cr' : 'Dr';
  let running = base.sales + base.tax;
  const out: InvoiceClassLine[] = [];
  for (const l of cls.lines) {
    if (l.section !== 'additional') continue;
    let signed: number;
    if (l.calc === 'round') {
      signed = roundTo(running, l.rounding, l.round_limit || 100) - running;
    } else {
      let amt = 0;
      if (l.calc === 'percent') amt = Math.round((base.sales * l.value) / PERCENT_SCALE);
      else if (l.calc === 'subtotal') amt = Math.round((running * l.value) / PERCENT_SCALE);
      else if (l.calc === 'fixed') amt = l.value;
      else if (l.calc === 'qty') amt = Math.round((base.qty * l.value) / 1000);
      else amt = base.user?.[l.id] ?? 0;
      amt = roundTo(amt, l.rounding, l.round_limit);
      signed = l.side === charge ? amt : -amt;
    }
    running += signed;
    out.push({ line_id: l.id, ledger_id: l.ledger_id, ledger: l.ledger, calc: l.calc, value: l.value, amount: signed, editable: l.calc === 'user', remove_if_zero: !!l.remove_if_zero });
  }
  return out;
}

export interface AppliedInvoiceClass {
  entries: EntryInput[];
  additional: InvoiceClassLine[];
  total: number;
}

export function applyInvoiceClass(cls: VoucherClass, kind: string, entries: EntryInput[], supplyCount: number, opts: { qty?: number; user?: Record<number, number>; split?: boolean } = {}): AppliedInvoiceClass {
  const sign = partyIsDebit(kind) ? 1 : -1;
  const [party, ...others] = entries;
  if (!party) throw new CoreError('invalid', 'Invoice has no party entry');
  const supply = others.slice(0, supplyCount);
  const rest = others.slice(supplyCount);
  const sales = supply.reduce((s, e) => s - sign * e.amount, 0);
  const tax = rest.reduce((s, e) => s - sign * e.amount, 0);
  const split = opts.split !== false && hasDefaultAllocations(cls);
  const newSupply: EntryInput[] = split ? supply.flatMap((e) => splitDefault(cls, -sign * e.amount).map((x) => ({ ledger_id: x.ledger_id, amount: -sign * x.amount }))) : supply;
  const additional = invoiceAdditional(cls, kind, { sales, tax, qty: opts.qty ?? 0, user: opts.user });
  const addEntries: EntryInput[] = additional.filter((a) => a.amount !== 0).map((a) => ({ ledger_id: a.ledger_id, amount: -sign * a.amount }));
  const body = [...newSupply, ...rest, ...addEntries];
  const partyAmount = -body.reduce((s, e) => s + e.amount, 0);
  if (sign * partyAmount <= 0) throw new CoreError('invalid', 'Invoice value must be positive');
  return { entries: [{ ...party, amount: partyAmount }, ...body], additional, total: sign * partyAmount };
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
  if (patch.pos_invoicing && t.parent !== 'Sales') throw new CoreError('invalid', 'POS invoicing is available only for Sales voucher types');
  const cur = await voucherTypeOptions(db, typeId);
  const next: Record<string, string | number> = { ...cur };
  for (const k of OPTION_KEYS) {
    const v = patch[k];
    if (v === undefined) continue;
    next[k] = (OPTION_TEXT as readonly string[]).includes(k) ? clean(v, 200) : v ? 1 : 0;
  }
  if (!next.pos_invoicing) {
    next.pos_message1 = '';
    next.pos_message2 = '';
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

export async function posVoucherTypeIds(db: Db): Promise<number[]> {
  return (await db.select<{ type_id: number }>(`SELECT o.type_id FROM voucher_type_options o JOIN voucher_types t ON t.id = o.type_id WHERE o.pos_invoicing = 1 AND t.parent = 'Sales'`)).map((r) => r.type_id);
}

export * from './pos.ts';
