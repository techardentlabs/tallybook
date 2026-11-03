import { CoreError, one, type Db, type SqlValue, type Stmt } from './db.ts';
import { ensureCosting } from './costing.ts';
import { STOCK_VOUCHER_TYPES, LEDGER_EXTRA_TEXT, LEDGER_INT_FIELDS, MIGRATIONS, SCHEMA, seedStatements } from './schema.ts';
import { clean, fyEnd, isIsoDate, newGuid } from './util.ts';

export interface Company {
  name: string;
  mailing_name: string;
  address: string;
  state: string;
  country: string;
  pincode: string;
  phone: string;
  email: string;
  website: string;
  pan: string;
  fy_start: string;
  fy_end: string;
  books_from: string;
  currency_symbol: string;
  currency_name: string;
  decimals: number;
  gst_enabled: number;
  gstin: string;
  gst_reg_type: string;
  bill_wise: number;
  inventory_enabled: number;
  payroll_enabled: number;
  cost_centres_enabled: number;
  price_levels_enabled: number;
  batches_enabled: number;
  job_work_enabled: number;
}

export interface Group {
  id: number;
  guid: string;
  name: string;
  alias: string;
  parent_id: number | null;
  parent: string | null;
  nature: 'Assets' | 'Liabilities' | 'Income' | 'Expense';
  affects_gross: number;
  is_system: number;
  net_balance_reporting: number;
  used_for_calc: number;
  sub_group_like: number;
  alloc_method: string;
}

export interface Ledger {
  id: number;
  guid: string;
  name: string;
  alias: string;
  group_id: number;
  group_name: string;
  opening: number;
  bill_by_bill: number;
  credit_days: number;
  mailing_name: string;
  address: string;
  state: string;
  country: string;
  pincode: string;
  phone: string;
  email: string;
  contact: string;
  pan: string;
  reg_type: string;
  gstin: string;
  bank_holder: string;
  bank_name: string;
  bank_account: string;
  bank_ifsc: string;
  duty_type: string;
  tax_head: string;
  rate_bp: number;
  hsn_sac: string;
  taxability: string;
  is_system: number;
  mobile: string;
  fax: string;
  cc_email: string;
  website: string;
  bank_branch: string;
  bank_swift: string;
  tan: string;
  supply_type: string;
  ledger_type: string;
  rounding_method: string;
  appropriate_to: string;
  calc_method: string;
  transporter_id: string;
  notes: string;
  price_level: string;
  nature_of_transaction: string;
  inventory_affected: number;
  check_credit_days: number;
  credit_limit: number;
  cost_centres: number;
  interest_active: number;
  tds_deductible: number;
  tcs_applicable: number;
  is_ecommerce: number;
  rounding_limit: number;
  auto_reconcile: number;
  currency_id: number;
}

export interface VoucherType {
  id: number;
  guid: string;
  name: string;
  parent: string;
  abbrev: string;
  numbering: 'auto' | 'auto_override' | 'manual' | 'none';
  prefix: string;
  suffix: string;
  prevent_duplicates: number;
  is_active: number;
  is_system: number;
}

export interface BillInput {
  kind: 'new' | 'agst' | 'adv' | 'onacc' | 'opening';
  name: string;
  amount: number;
  bill_date?: string;
  due_date?: string;
}

export interface EntryInput {
  ledger_id: number;
  amount: number;
  narration?: string;
  bills?: BillInput[];
}

export interface VoucherInput {
  type_id: number;
  number?: string;
  date: string;
  reference?: string;
  narration?: string;
  party_id?: number | null;
  place_of_supply?: string;
  reverse_charge?: boolean;
  guid?: string;
  entries: EntryInput[];
  stock?: StockLineInput[];
}

export interface StockLineInput {
  item_id: number;
  godown_id?: number | null;
  ledger_id?: number | null;
  qty: number;
  rate: number;
  amount: number;
  discount_bp?: number;
  tracked?: number;
}

export interface VoucherRow {
  id: number;
  guid: string;
  type_id: number;
  type: string;
  parent: string;
  number: string;
  seq: number;
  date: string;
  reference: string;
  narration: string;
  party_id: number | null;
  place_of_supply: string;
  reverse_charge: number;
  cancelled: number;
  entries: { id: number; ledger_id: number; ledger: string; amount: number; narration: string; bills: BillInput[] }[];
  stock: (StockLineInput & { id: number; item: string })[];
}

export const LEDGER_TEXT_FIELDS = [
  'alias', 'mailing_name', 'address', 'state', 'country', 'pincode', 'phone', 'email', 'contact', 'pan',
  'reg_type', 'gstin', 'bank_holder', 'bank_name', 'bank_account', 'bank_ifsc', 'duty_type', 'tax_head',
  'hsn_sac', 'taxability', ...LEDGER_EXTRA_TEXT,
] as const;

export { LEDGER_INT_FIELDS };

const BANK_GROUPS = ['Bank Accounts', 'Cash-in-Hand', 'Bank OD A/c'];

export class Books {
  readonly db: Db;
  private static AUDITED: { method: string; action: string; object: string; pre?: 'voucher' | 'ledger' | 'group'; name: (r: any, a: any[], pre: string) => string; id: (r: any, a: any[]) => number | null }[] = [
    { method: 'createVoucher', action: 'Create', object: 'Voucher', name: (r) => `${r.type} No. ${r.number}`, id: (r) => r.id },
    { method: 'updateVoucher', action: 'Alter', object: 'Voucher', name: (r) => `${r.type} No. ${r.number}`, id: (r) => r.id },
    { method: 'deleteVoucher', action: 'Delete', object: 'Voucher', pre: 'voucher', name: (_r, _a, pre) => pre, id: (_r, a) => a[0] },
    { method: 'cancelVoucher', action: 'Cancel', object: 'Voucher', pre: 'voucher', name: (_r, _a, pre) => pre, id: (_r, a) => a[0] },
    { method: 'createLedger', action: 'Create', object: 'Ledger', name: (r) => r.name, id: (r) => r.id },
    { method: 'updateLedger', action: 'Alter', object: 'Ledger', name: (r) => r.name, id: (r) => r.id },
    { method: 'deleteLedger', action: 'Delete', object: 'Ledger', pre: 'ledger', name: (_r, _a, pre) => pre, id: (_r, a) => a[0] },
    { method: 'createGroup', action: 'Create', object: 'Group', name: (r) => r.name, id: (r) => r.id },
    { method: 'updateGroup', action: 'Alter', object: 'Group', name: (r) => r.name, id: (r) => r.id },
    { method: 'deleteGroup', action: 'Delete', object: 'Group', pre: 'group', name: (_r, _a, pre) => pre, id: (_r, a) => a[0] },
  ];

  actor: () => string = () => '';

  constructor(db: Db) {
    this.db = db;
    for (const a of Books.AUDITED) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const self = this as any;
      const orig = self[a.method].bind(this);
      self[a.method] = async (...args: unknown[]) => {
        let pre = '';
        if (a.pre === 'voucher') {
          const v = await this.voucher(args[0] as number);
          pre = v ? `${v.type} No. ${v.number}` : '';
        } else if (a.pre === 'ledger') pre = (await this.ledger(args[0] as number))?.name ?? '';
        else if (a.pre === 'group') pre = (await this.groups()).find((g) => g.id === args[0])?.name ?? '';
        const r = await orig(...args);
        const next = ((await one<{ m: number }>(this.db, 'SELECT COALESCE(MAX(id), 0) AS m FROM audit_log'))!.m) + 1;
        await this.db.batch([
          { sql: 'INSERT INTO audit_log (id, action, object, object_id, name, username) VALUES (?, ?, ?, ?, ?, ?)', params: [next, a.action, a.object, a.id(r, args as unknown[]) ?? null, a.name(r, args as unknown[], pre), this.actor()] },
        ]);
        return r;
      };
    }
  }

  async init(): Promise<void> {
    await this.db.batch(SCHEMA.map((sql) => ({ sql })));
    for (const table of new Set(MIGRATIONS.map((m) => m.table))) {
      const have = new Set((await this.db.select<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)).map((r) => r.name));
      const todo = MIGRATIONS.filter((m) => m.table === table && !have.has(m.column));
      if (todo.length) await this.db.batch(todo.map((m) => ({ sql: m.ddl })));
    }
    await ensureCosting(this.db);
    const n = await one<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM groups');
    if (!n || n.n === 0) await this.db.batch(seedStatements(newGuid));
  }

  async company(): Promise<Company | null> {
    const c = await one<Omit<Company, 'fy_end'>>(this.db, 'SELECT * FROM company WHERE id = 1');
    return c ? { ...c, fy_end: fyEnd(c.fy_start) } : null;
  }

  async requireCompany(): Promise<Company> {
    const c = await this.company();
    if (!c) throw new CoreError('not_found', 'No company is open');
    return c;
  }

  async createCompany(input: Partial<Company> & { name: string; fy_start: string }): Promise<Company> {
    if (await this.company()) throw new CoreError('conflict', 'Company already exists');
    const name = clean(input.name);
    if (!name) throw new CoreError('invalid', 'Company name is required');
    if (!isIsoDate(input.fy_start)) throw new CoreError('invalid', 'Financial year start is required');
    const books = input.books_from && isIsoDate(input.books_from) ? input.books_from : input.fy_start;
    if (books < input.fy_start || books > fyEnd(input.fy_start)) {
      throw new CoreError('invalid', 'Books beginning date must fall inside the financial year');
    }
    await this.db.batch([
      {
        sql: `INSERT INTO company (id, name, mailing_name, address, state, country, pincode, phone, email, website, pan,
          fy_start, books_from, currency_symbol, currency_name, decimals, gst_enabled, gstin, gst_reg_type, bill_wise, inventory_enabled)
          VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          name,
          clean(input.mailing_name) || name,
          clean(input.address, 500),
          clean(input.state),
          clean(input.country) || 'India',
          clean(input.pincode, 10),
          clean(input.phone),
          clean(input.email),
          clean(input.website),
          clean(input.pan, 10).toUpperCase(),
          input.fy_start,
          books,
          clean(input.currency_symbol, 5) || '₹',
          clean(input.currency_name, 10) || 'INR',
          input.decimals ?? 2,
          input.gst_enabled ? 1 : 0,
          clean(input.gstin, 15).toUpperCase(),
          clean(input.gst_reg_type) || 'Regular',
          input.bill_wise === 0 ? 0 : 1,
          input.inventory_enabled ? 1 : 0,
        ],
      },
    ]);
    return (await this.company())!;
  }

  async updateCompany(input: Partial<Company>): Promise<Company> {
    const cur = await this.requireCompany();
    const m = { ...cur, ...input };
    const name = clean(m.name);
    if (!name) throw new CoreError('invalid', 'Company name is required');
    await this.db.batch([
      {
        sql: `UPDATE company SET name=?, mailing_name=?, address=?, state=?, country=?, pincode=?, phone=?, email=?, website=?,
          pan=?, currency_symbol=?, currency_name=?, decimals=?, gst_enabled=?, gstin=?, gst_reg_type=?, bill_wise=?, inventory_enabled=? WHERE id=1`,
        params: [
          name, clean(m.mailing_name) || name, clean(m.address, 500), clean(m.state), clean(m.country) || 'India',
          clean(m.pincode, 10), clean(m.phone), clean(m.email), clean(m.website), clean(m.pan, 10).toUpperCase(),
          clean(m.currency_symbol, 5) || '₹', clean(m.currency_name, 10) || 'INR', m.decimals ?? 2,
          m.gst_enabled ? 1 : 0, clean(m.gstin, 15).toUpperCase(), clean(m.gst_reg_type) || 'Regular',
          m.bill_wise ? 1 : 0, m.inventory_enabled ? 1 : 0,
        ],
      },
      { sql: 'UPDATE company SET payroll_enabled = ?, cost_centres_enabled = ?, price_levels_enabled = ?, batches_enabled = ?, job_work_enabled = ? WHERE id = 1', params: [m.payroll_enabled ? 1 : 0, m.cost_centres_enabled ? 1 : 0, m.price_levels_enabled ? 1 : 0, m.batches_enabled ? 1 : 0, m.job_work_enabled ? 1 : 0] },
    ]);
    return (await this.company())!;
  }

  async groups(): Promise<Group[]> {
    return this.db.select<Group>(
      `SELECT g.*, p.name AS parent FROM groups g LEFT JOIN groups p ON p.id = g.parent_id ORDER BY g.id`
    );
  }

  private async nameTaken(name: string, exceptGroup?: number, exceptLedger?: number): Promise<boolean> {
    const g = await one(this.db, 'SELECT id FROM groups WHERE name = ? COLLATE NOCASE AND id != ?', [name, exceptGroup ?? -1]);
    if (g) return true;
    const l = await one(this.db, 'SELECT id FROM ledgers WHERE name = ? COLLATE NOCASE AND id != ?', [name, exceptLedger ?? -1]);
    return !!l;
  }

  async createGroup(input: { name: string; parent_id?: number | null; alias?: string; nature?: Group['nature']; net_balance_reporting?: number; used_for_calc?: number; sub_group_like?: number; alloc_method?: string }): Promise<Group> {
    const name = clean(input.name);
    if (!name) throw new CoreError('invalid', 'Group name is required');
    if (await this.nameTaken(name)) throw new CoreError('conflict', `"${name}" already exists`);
    let nature: Group['nature'];
    let gross = 0;
    if (input.parent_id) {
      const parent = await one<Group>(this.db, 'SELECT * FROM groups WHERE id = ?', [input.parent_id]);
      if (!parent) throw new CoreError('invalid', 'Parent group not found');
      nature = parent.nature;
      gross = parent.affects_gross;
    } else {
      if (!input.nature) throw new CoreError('invalid', 'Nature of group is required for a primary group');
      nature = input.nature;
    }
    const id = ((await one<{ m: number }>(this.db, 'SELECT COALESCE(MAX(id), 0) AS m FROM groups'))!.m) + 1;
    await this.db.batch([
      {
        sql: 'INSERT INTO groups (id, guid, name, alias, parent_id, nature, affects_gross) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [id, newGuid(), name, clean(input.alias), input.parent_id ?? null, nature, gross],
      },
      {
        sql: 'UPDATE groups SET net_balance_reporting = ?, used_for_calc = ?, sub_group_like = ?, alloc_method = ? WHERE id = ?',
        params: [input.net_balance_reporting ? 1 : 0, input.used_for_calc ? 1 : 0, input.sub_group_like ? 1 : 0, clean(input.alloc_method), id],
      },
    ]);
    return (await this.groups()).find((g) => g.id === id)!;
  }

  async updateGroup(id: number, input: { name?: string; alias?: string; net_balance_reporting?: number; used_for_calc?: number; sub_group_like?: number; alloc_method?: string }): Promise<Group> {
    const cur = (await this.groups()).find((g) => g.id === id);
    if (!cur) throw new CoreError('not_found', 'Group not found');
    const name = clean(input.name ?? cur.name);
    if (!name) throw new CoreError('invalid', 'Group name is required');
    if (await this.nameTaken(name, id)) throw new CoreError('conflict', `"${name}" already exists`);
    await this.db.batch([
      {
        sql: 'UPDATE groups SET name = ?, alias = ?, net_balance_reporting = ?, used_for_calc = ?, sub_group_like = ?, alloc_method = ? WHERE id = ?',
        params: [
          name,
          clean(input.alias ?? cur.alias),
          (input.net_balance_reporting ?? cur.net_balance_reporting) ? 1 : 0,
          (input.used_for_calc ?? cur.used_for_calc) ? 1 : 0,
          (input.sub_group_like ?? cur.sub_group_like) ? 1 : 0,
          clean(input.alloc_method ?? cur.alloc_method),
          id,
        ],
      },
    ]);
    return (await this.groups()).find((g) => g.id === id)!;
  }

  async deleteGroup(id: number): Promise<void> {
    const g = (await this.groups()).find((x) => x.id === id);
    if (!g) throw new CoreError('not_found', 'Group not found');
    if (g.is_system) throw new CoreError('invalid', 'Predefined groups cannot be deleted');
    if (await one(this.db, 'SELECT 1 FROM groups WHERE parent_id = ?', [id])) throw new CoreError('conflict', 'Group has sub-groups');
    if (await one(this.db, 'SELECT 1 FROM ledgers WHERE group_id = ?', [id])) throw new CoreError('conflict', 'Group has ledgers');
    await this.db.batch([{ sql: 'DELETE FROM groups WHERE id = ?', params: [id] }]);
  }

  async ledgers(): Promise<Ledger[]> {
    return this.db.select<Ledger>(
      'SELECT l.*, g.name AS group_name FROM ledgers l JOIN groups g ON g.id = l.group_id ORDER BY l.name COLLATE NOCASE'
    );
  }

  async ledger(id: number): Promise<(Ledger & { opening_bills: BillInput[] }) | null> {
    const l = await one<Ledger>(
      this.db,
      'SELECT l.*, g.name AS group_name FROM ledgers l JOIN groups g ON g.id = l.group_id WHERE l.id = ?',
      [id]
    );
    if (!l) return null;
    const bills = await this.db.select<BillInput>(
      "SELECT kind, name, amount, bill_date, due_date FROM bills WHERE ledger_id = ? AND kind = 'opening' ORDER BY id",
      [id]
    );
    return { ...l, opening_bills: bills };
  }

  private async ledgerParams(input: Partial<Ledger> & { opening_bills?: BillInput[] }, id?: number) {
    const name = clean(input.name);
    if (!name) throw new CoreError('invalid', 'Ledger name is required');
    if (!input.group_id) throw new CoreError('invalid', 'Choose the group the ledger is under');
    if (!(await one(this.db, 'SELECT 1 FROM groups WHERE id = ?', [input.group_id]))) throw new CoreError('invalid', 'Group not found');
    if (await this.nameTaken(name, undefined, id)) throw new CoreError('conflict', `"${name}" already exists`);
    const opening = input.opening ?? 0;
    if (!Number.isInteger(opening)) throw new CoreError('invalid', 'Opening balance must be whole paise');
    const bills = input.opening_bills ?? [];
    if (bills.length) {
      const sum = bills.reduce((s, b) => s + b.amount, 0);
      if (sum !== opening) throw new CoreError('invalid', 'Opening bill allocations must add up to the opening balance');
    }
    const text = LEDGER_TEXT_FIELDS.map((f) => clean(input[f] as string | undefined, f === 'address' ? 500 : 200));
    text[LEDGER_TEXT_FIELDS.indexOf('gstin')] = text[LEDGER_TEXT_FIELDS.indexOf('gstin')].toUpperCase().slice(0, 15);
    text[LEDGER_TEXT_FIELDS.indexOf('pan')] = text[LEDGER_TEXT_FIELDS.indexOf('pan')].toUpperCase().slice(0, 10);
    if (!text[LEDGER_TEXT_FIELDS.indexOf('country')]) text[LEDGER_TEXT_FIELDS.indexOf('country')] = 'India';
    const ints = LEDGER_INT_FIELDS.map((f) => Math.max(0, Math.trunc(Number(input[f]) || 0)));
    return { name, opening, bills, text, ints };
  }

  async createLedger(input: Partial<Ledger> & { name: string; group_id: number; opening_bills?: BillInput[]; guid?: string }): Promise<Ledger> {
    const p = await this.ledgerParams(input);
    const id = ((await one<{ m: number }>(this.db, 'SELECT COALESCE(MAX(id), 0) AS m FROM ledgers'))!.m) + 1;
    const cols = ['id', 'guid', 'name', 'group_id', 'opening', 'bill_by_bill', 'credit_days', ...LEDGER_TEXT_FIELDS, 'rate_bp', ...LEDGER_INT_FIELDS];
    const stmts: Stmt[] = [
      {
        sql: `INSERT INTO ledgers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        params: [id, input.guid || newGuid(), p.name, input.group_id, p.opening, input.bill_by_bill ? 1 : 0, input.credit_days ?? 0, ...p.text, input.rate_bp ?? 0, ...p.ints],
      },
      ...this.openingBillStmts(id, p.bills),
    ];
    await this.db.batch(stmts);
    return (await this.ledger(id))!;
  }

  async updateLedger(id: number, input: Partial<Ledger> & { opening_bills?: BillInput[] }): Promise<Ledger> {
    const cur = await this.ledger(id);
    if (!cur) throw new CoreError('not_found', 'Ledger not found');
    const merged = { ...cur, ...input, opening_bills: input.opening_bills ?? cur.opening_bills };
    if (cur.is_system && merged.group_id !== cur.group_id) throw new CoreError('invalid', 'A predefined ledger cannot change group');
    const p = await this.ledgerParams(merged, id);
    const sets = ['name', 'group_id', 'opening', 'bill_by_bill', 'credit_days', ...LEDGER_TEXT_FIELDS, 'rate_bp', ...LEDGER_INT_FIELDS].map((c) => `${c} = ?`).join(', ');
    await this.db.batch([
      {
        sql: `UPDATE ledgers SET ${sets} WHERE id = ?`,
        params: [p.name, merged.group_id, p.opening, merged.bill_by_bill ? 1 : 0, merged.credit_days ?? 0, ...p.text, merged.rate_bp ?? 0, ...p.ints, id],
      },
      { sql: "DELETE FROM bills WHERE ledger_id = ? AND kind = 'opening'", params: [id] },
      ...this.openingBillStmts(id, p.bills),
    ]);
    return (await this.ledger(id))!;
  }

  private openingBillStmts(ledgerId: number, bills: BillInput[]): Stmt[] {
    return bills.map((b) => ({
      sql: "INSERT INTO bills (entry_id, ledger_id, kind, name, amount, bill_date, due_date) VALUES (NULL, ?, 'opening', ?, ?, ?, ?)",
      params: [ledgerId, clean(b.name), b.amount, b.bill_date ?? '', b.due_date ?? ''],
    }));
  }

  async deleteLedger(id: number): Promise<void> {
    const l = await this.ledger(id);
    if (!l) throw new CoreError('not_found', 'Ledger not found');
    if (l.is_system) throw new CoreError('invalid', 'Predefined ledgers cannot be deleted');
    if (await one(this.db, 'SELECT 1 FROM entries WHERE ledger_id = ?', [id])) {
      throw new CoreError('conflict', 'Ledger has transactions and cannot be deleted');
    }
    await this.db.batch([
      { sql: 'DELETE FROM bills WHERE ledger_id = ?', params: [id] },
      { sql: 'DELETE FROM ledgers WHERE id = ?', params: [id] },
    ]);
  }

  async voucherTypes(): Promise<VoucherType[]> {
    return this.db.select<VoucherType>('SELECT * FROM voucher_types ORDER BY id');
  }

  async createVoucherType(input: Partial<VoucherType> & { name: string; parent: string }): Promise<VoucherType> {
    const name = clean(input.name);
    if (!name) throw new CoreError('invalid', 'Voucher type name is required');
    const types = await this.voucherTypes();
    if (types.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new CoreError('conflict', `"${name}" already exists`);
    if (!types.some((t) => t.is_system && t.name === input.parent)) throw new CoreError('invalid', 'Choose a predefined type to base it on');
    const id = Math.max(0, ...types.map((t) => t.id)) + 1;
    await this.db.batch([
      {
        sql: 'INSERT INTO voucher_types (id, guid, name, parent, abbrev, numbering, prefix, suffix, prevent_duplicates) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [id, newGuid(), name, input.parent, clean(input.abbrev, 10), input.numbering ?? 'auto', clean(input.prefix, 20), clean(input.suffix, 20), input.prevent_duplicates === 0 ? 0 : 1],
      },
    ]);
    return (await this.voucherTypes()).find((t) => t.id === id)!;
  }

  async updateVoucherType(id: number, input: Partial<VoucherType>): Promise<VoucherType> {
    const cur = (await this.voucherTypes()).find((t) => t.id === id);
    if (!cur) throw new CoreError('not_found', 'Voucher type not found');
    const m = { ...cur, ...input };
    await this.db.batch([
      {
        sql: 'UPDATE voucher_types SET abbrev = ?, numbering = ?, prefix = ?, suffix = ?, prevent_duplicates = ?, is_active = ? WHERE id = ?',
        params: [clean(m.abbrev, 10), m.numbering, clean(m.prefix, 20), clean(m.suffix, 20), m.prevent_duplicates ? 1 : 0, m.is_active ? 1 : 0, id],
      },
    ]);
    return (await this.voucherTypes()).find((t) => t.id === id)!;
  }

  async nextNumber(typeId: number): Promise<{ number: string; seq: number }> {
    const t = (await this.voucherTypes()).find((x) => x.id === typeId);
    if (!t) throw new CoreError('not_found', 'Voucher type not found');
    const r = await one<{ m: number }>(this.db, 'SELECT COALESCE(MAX(seq), 0) AS m FROM vouchers WHERE type_id = ?', [typeId]);
    const seq = (r?.m ?? 0) + 1;
    return { number: `${t.prefix}${seq}${t.suffix}`, seq };
  }

  async voucher(id: number): Promise<VoucherRow | null> {
    const v = await one<Omit<VoucherRow, 'entries'>>(
      this.db,
      `SELECT v.*, t.name AS type, t.parent AS parent FROM vouchers v JOIN voucher_types t ON t.id = v.type_id WHERE v.id = ?`,
      [id]
    );
    if (!v) return null;
    const rows = await this.db.select<{ id: number; ledger_id: number; ledger: string; amount: number; narration: string }>(
      'SELECT e.id, e.ledger_id, l.name AS ledger, e.amount, e.narration FROM entries e JOIN ledgers l ON l.id = e.ledger_id WHERE e.voucher_id = ? ORDER BY e.seq',
      [id]
    );
    const bills = await this.db.select<BillInput & { entry_id: number }>(
      'SELECT entry_id, kind, name, amount, bill_date, due_date FROM bills WHERE entry_id IN (SELECT id FROM entries WHERE voucher_id = ?) ORDER BY id',
      [id]
    );
    const stock = await this.db.select<StockLineInput & { id: number; item: string }>(
      'SELECT m.id, m.item_id, i.name AS item, m.godown_id, m.ledger_id, m.qty, m.rate, m.amount, m.discount_bp, m.tracked FROM stock_movements m JOIN stock_items i ON i.id = m.item_id WHERE m.voucher_id = ? ORDER BY m.seq',
      [id]
    );
    return {
      ...v,
      stock,
      entries: rows.map((e) => ({
        ...e,
        bills: bills.filter((b) => b.entry_id === e.id).map(({ kind, name, amount, bill_date, due_date }) => ({ kind, name, amount, bill_date, due_date })),
      })),
    };
  }

  private async validateVoucher(input: VoucherInput, id?: number) {
    const company = await this.requireCompany();
    const type = (await this.voucherTypes()).find((t) => t.id === input.type_id);
    if (!type) throw new CoreError('invalid', 'Unknown voucher type');
    if (!isIsoDate(input.date)) throw new CoreError('invalid', 'Invalid voucher date');
    if (input.date < company.books_from || input.date > company.fy_end) {
      throw new CoreError('invalid', 'Voucher date is outside the books period');
    }
    const stockOnly = (STOCK_VOUCHER_TYPES as readonly string[]).includes(type.parent);
    const entries = input.entries ?? [];
    if (stockOnly) {
      if (entries.length) throw new CoreError('invalid', `${type.parent} vouchers do not post ledger entries`);
      if (!input.stock?.length) throw new CoreError('invalid', 'Add at least one stock item');
      for (const l of input.stock) {
        if (!Number.isInteger(l.qty) || l.qty === 0) throw new CoreError('invalid', 'Quantities must be non-zero');
        if (!(await one(this.db, 'SELECT 1 FROM stock_items WHERE id = ?', [l.item_id]))) throw new CoreError('invalid', 'Unknown stock item');
      }
    } else if (entries.length < 2) throw new CoreError('invalid', 'A voucher needs at least two ledger entries');
    const ledgers = new Map((await this.ledgers()).map((l) => [l.id, l]));
    let sum = 0;
    for (const e of entries) {
      if (!Number.isInteger(e.amount) || e.amount === 0) throw new CoreError('invalid', 'Entry amounts must be non-zero whole paise');
      const l = ledgers.get(e.ledger_id);
      if (!l) throw new CoreError('invalid', 'Unknown ledger in voucher');
      if (type.parent === 'Contra' && !BANK_GROUPS.includes(await this.rootBankGroup(l))) {
        throw new CoreError('invalid', 'Contra vouchers accept only cash and bank ledgers');
      }
      sum += e.amount;
      if (e.bills?.length) {
        const bsum = e.bills.reduce((s, b) => s + b.amount, 0);
        if (bsum !== e.amount) throw new CoreError('invalid', `Bill allocations for ${l.name} must equal the entry amount`);
        if (e.bills.some((b) => !clean(b.name) && b.kind !== 'onacc')) throw new CoreError('invalid', 'Bill reference name is required');
      }
    }
    if (!stockOnly && sum !== 0) throw new CoreError('invalid', 'Total debit must equal total credit');
    let number = clean(input.number, 50);
    let seq = 0;
    if (type.numbering === 'manual' && !number) throw new CoreError('invalid', 'Voucher number is required');
    if (!id) {
      const next = await this.nextNumber(type.id);
      seq = next.seq;
      if (!number || type.numbering === 'auto') number = next.number;
      if (type.numbering === 'none') number = String(seq);
    }
    return { company, type, number, seq, entries };
  }

  async createVoucher(input: VoucherInput): Promise<VoucherRow> {
    const v = await this.validateVoucher(input);
    const dup = await one(this.db, 'SELECT 1 FROM vouchers WHERE type_id = ? AND number = ?', [v.type.id, v.number]);
    if (dup) throw new CoreError('conflict', `Voucher number ${v.number} already exists for ${v.type.name}`);
    const vid = ((await one<{ m: number }>(this.db, 'SELECT COALESCE(MAX(id), 0) AS m FROM vouchers'))!.m) + 1;
    const stmts: Stmt[] = [
      {
        sql: `INSERT INTO vouchers (id, guid, type_id, number, seq, date, reference, narration, party_id, place_of_supply, reverse_charge)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [vid, input.guid || newGuid(), v.type.id, v.number, v.seq, input.date, clean(input.reference), clean(input.narration, 500), input.party_id ?? null, clean(input.place_of_supply), input.reverse_charge ? 1 : 0],
      },
    ];
    stmts.push(...(await this.entryStmts(vid, v.entries)));
    stmts.push(...(await this.stockStmts(vid, input.stock)));
    await this.db.batch(stmts);
    return (await this.voucher(vid))!;
  }

  private async stockStmts(voucherId: number, lines?: StockLineInput[]): Promise<Stmt[]> {
    if (!lines?.length) return [];
    let next = ((await one<{ m: number }>(this.db, 'SELECT COALESCE(MAX(id), 0) AS m FROM stock_movements'))!.m) + 1;
    return lines.map((l, i) => ({
      sql: 'INSERT INTO stock_movements (id, voucher_id, item_id, godown_id, ledger_id, qty, rate, amount, discount_bp, seq, tracked) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      params: [next++, voucherId, l.item_id, l.godown_id ?? null, l.ledger_id ?? null, l.qty, l.rate, l.amount, l.discount_bp ?? 0, i, l.tracked ? 1 : 0],
    }));
  }

  private async entryStmts(voucherId: number, entries: EntryInput[]): Promise<Stmt[]> {
    let eid = ((await one<{ m: number }>(this.db, 'SELECT COALESCE(MAX(id), 0) AS m FROM entries'))!.m) + 1;
    const out: Stmt[] = [];
    entries.forEach((e, i) => {
      out.push({
        sql: 'INSERT INTO entries (id, voucher_id, ledger_id, amount, seq, narration) VALUES (?, ?, ?, ?, ?, ?)',
        params: [eid, voucherId, e.ledger_id, e.amount, i, clean(e.narration, 500)],
      });
      for (const b of e.bills ?? []) {
        out.push({
          sql: 'INSERT INTO bills (entry_id, ledger_id, kind, name, amount, bill_date, due_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
          params: [eid, e.ledger_id, b.kind, clean(b.name), b.amount, b.bill_date ?? '', b.due_date ?? ''],
        });
      }
      eid += 1;
    });
    return out;
  }

  async updateVoucher(id: number, input: VoucherInput): Promise<VoucherRow> {
    const cur = await this.voucher(id);
    if (!cur) throw new CoreError('not_found', 'Voucher not found');
    const v = await this.validateVoucher({ ...input, type_id: cur.type_id }, id);
    let number = cur.number;
    const t = v.type;
    if ((t.numbering === 'manual' || t.numbering === 'auto_override') && v.number && v.number !== cur.number) {
      const dup = await one(this.db, 'SELECT 1 FROM vouchers WHERE type_id = ? AND number = ? AND id != ?', [t.id, v.number, id]);
      if (dup) throw new CoreError('conflict', `Voucher number ${v.number} already exists for ${t.name}`);
      number = v.number;
    }
    const stmts: Stmt[] = [
      {
        sql: 'UPDATE vouchers SET number = ?, date = ?, reference = ?, narration = ?, party_id = ?, place_of_supply = ?, reverse_charge = ? WHERE id = ?',
        params: [number, input.date, clean(input.reference), clean(input.narration, 500), input.party_id ?? null, clean(input.place_of_supply), input.reverse_charge ? 1 : 0, id],
      },
      { sql: 'DELETE FROM bills WHERE entry_id IN (SELECT id FROM entries WHERE voucher_id = ?)', params: [id] },
      { sql: 'DELETE FROM entries WHERE voucher_id = ?', params: [id] },
    ];
    stmts.push({ sql: 'DELETE FROM stock_movements WHERE voucher_id = ?', params: [id] });
    stmts.push(...(await this.entryStmts(id, v.entries)));
    stmts.push(...(await this.stockStmts(id, input.stock)));
    await this.db.batch(stmts);
    return (await this.voucher(id))!;
  }

  async deleteVoucher(id: number): Promise<void> {
    if (!(await one(this.db, 'SELECT 1 FROM vouchers WHERE id = ?', [id]))) throw new CoreError('not_found', 'Voucher not found');
    await this.db.batch([
      { sql: 'DELETE FROM stock_movements WHERE voucher_id = ?', params: [id] },
      { sql: 'DELETE FROM bills WHERE entry_id IN (SELECT id FROM entries WHERE voucher_id = ?)', params: [id] },
      { sql: 'DELETE FROM entries WHERE voucher_id = ?', params: [id] },
      { sql: 'DELETE FROM vouchers WHERE id = ?', params: [id] },
    ]);
  }

  async cancelVoucher(id: number): Promise<void> {
    if (!(await one(this.db, 'SELECT 1 FROM vouchers WHERE id = ?', [id]))) throw new CoreError('not_found', 'Voucher not found');
    await this.db.batch([
      { sql: 'DELETE FROM stock_movements WHERE voucher_id = ?', params: [id] },
      { sql: 'DELETE FROM bills WHERE entry_id IN (SELECT id FROM entries WHERE voucher_id = ?)', params: [id] },
      { sql: 'DELETE FROM entries WHERE voucher_id = ?', params: [id] },
      { sql: "UPDATE vouchers SET cancelled = 1, narration = '' WHERE id = ?", params: [id] },
    ]);
  }

  private async rootBankGroup(l: Ledger): Promise<string> {
    return l.group_name;
  }

  async count(table: 'groups' | 'ledgers' | 'vouchers'): Promise<number> {
    const r = await one<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM ${table}`);
    return r?.n ?? 0;
  }

  async params(sql: string, params: SqlValue[] = []) {
    return this.db.select(sql, params);
  }
}
