import type { Stmt } from './db.ts';

export const SCHEMA_VERSION = 1;

export const LEDGER_EXTRA_TEXT = [
  'mobile', 'fax', 'cc_email', 'website', 'bank_branch', 'bank_swift', 'tan', 'supply_type', 'ledger_type', 'rounding_method',
  'appropriate_to', 'calc_method', 'transporter_id', 'notes', 'price_level', 'nature_of_transaction',
] as const;

export const LEDGER_INT_FIELDS = [
  'inventory_affected', 'check_credit_days', 'credit_limit', 'cost_centres', 'interest_active', 'tds_deductible', 'tcs_applicable',
  'is_ecommerce', 'rounding_limit', 'auto_reconcile',
] as const;

export const STOCK_ITEM_TEXT = ['part_no', 'costing_method', 'market_method', 'description', 'notes'] as const;
export const STOCK_ITEM_INT = ['maintain_batches', 'track_expiry', 'min_order_qty', 'alt_unit_id', 'alt_conversion', 'enable_cost_tracking'] as const;

export const MIGRATIONS: { table: string; column: string; ddl: string }[] = [
  { table: 'stock_movements', column: 'tracked', ddl: 'ALTER TABLE stock_movements ADD COLUMN tracked INTEGER NOT NULL DEFAULT 0' },
  { table: 'audit_log', column: 'username', ddl: "ALTER TABLE audit_log ADD COLUMN username TEXT NOT NULL DEFAULT ''" },
  { table: 'company', column: 'cost_centres_enabled', ddl: 'ALTER TABLE company ADD COLUMN cost_centres_enabled INTEGER NOT NULL DEFAULT 0' },
  { table: 'company', column: 'payroll_enabled', ddl: 'ALTER TABLE company ADD COLUMN payroll_enabled INTEGER NOT NULL DEFAULT 0' },
  { table: 'groups', column: 'net_balance_reporting', ddl: 'ALTER TABLE groups ADD COLUMN net_balance_reporting INTEGER NOT NULL DEFAULT 0' },
  { table: 'groups', column: 'used_for_calc', ddl: 'ALTER TABLE groups ADD COLUMN used_for_calc INTEGER NOT NULL DEFAULT 0' },
  { table: 'groups', column: 'sub_group_like', ddl: 'ALTER TABLE groups ADD COLUMN sub_group_like INTEGER NOT NULL DEFAULT 0' },
  { table: 'groups', column: 'alloc_method', ddl: "ALTER TABLE groups ADD COLUMN alloc_method TEXT NOT NULL DEFAULT ''" },
  ...STOCK_ITEM_TEXT.map((c) => ({ table: 'stock_items', column: c, ddl: `ALTER TABLE stock_items ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''` })),
  ...STOCK_ITEM_INT.map((c) => ({ table: 'stock_items', column: c, ddl: `ALTER TABLE stock_items ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0` })),
  ...LEDGER_EXTRA_TEXT.map((c) => ({ table: 'ledgers', column: c, ddl: `ALTER TABLE ledgers ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''` })),
  ...LEDGER_INT_FIELDS.map((c) => ({ table: 'ledgers', column: c, ddl: `ALTER TABLE ledgers ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0` })),
];

export const STOCK_VOUCHER_TYPES = ['Delivery Note', 'Receipt Note', 'Stock Journal', 'Physical Stock', 'Sales Order', 'Purchase Order', 'Rejection In', 'Rejection Out'] as const;
export const ORDER_VOUCHER_TYPES = ['Sales Order', 'Purchase Order'] as const;

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS company (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    mailing_name TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'India',
    pincode TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    pan TEXT NOT NULL DEFAULT '',
    fy_start TEXT NOT NULL,
    books_from TEXT NOT NULL,
    currency_symbol TEXT NOT NULL DEFAULT '₹',
    currency_name TEXT NOT NULL DEFAULT 'INR',
    decimals INTEGER NOT NULL DEFAULT 2,
    gst_enabled INTEGER NOT NULL DEFAULT 0,
    gstin TEXT NOT NULL DEFAULT '',
    gst_reg_type TEXT NOT NULL DEFAULT 'Regular',
    bill_wise INTEGER NOT NULL DEFAULT 1,
    inventory_enabled INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    parent_id INTEGER REFERENCES groups(id),
    nature TEXT NOT NULL CHECK (nature IN ('Assets','Liabilities','Income','Expense')),
    affects_gross INTEGER NOT NULL DEFAULT 0,
    is_system INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS ledgers (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    group_id INTEGER NOT NULL REFERENCES groups(id),
    opening INTEGER NOT NULL DEFAULT 0,
    bill_by_bill INTEGER NOT NULL DEFAULT 0,
    credit_days INTEGER NOT NULL DEFAULT 0,
    mailing_name TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT 'India',
    pincode TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    pan TEXT NOT NULL DEFAULT '',
    reg_type TEXT NOT NULL DEFAULT '',
    gstin TEXT NOT NULL DEFAULT '',
    bank_holder TEXT NOT NULL DEFAULT '',
    bank_name TEXT NOT NULL DEFAULT '',
    bank_account TEXT NOT NULL DEFAULT '',
    bank_ifsc TEXT NOT NULL DEFAULT '',
    duty_type TEXT NOT NULL DEFAULT '',
    tax_head TEXT NOT NULL DEFAULT '',
    rate_bp INTEGER NOT NULL DEFAULT 0,
    hsn_sac TEXT NOT NULL DEFAULT '',
    taxability TEXT NOT NULL DEFAULT '',
    is_system INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS voucher_types (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent TEXT NOT NULL,
    abbrev TEXT NOT NULL DEFAULT '',
    numbering TEXT NOT NULL DEFAULT 'auto' CHECK (numbering IN ('auto','auto_override','manual','none')),
    prefix TEXT NOT NULL DEFAULT '',
    suffix TEXT NOT NULL DEFAULT '',
    prevent_duplicates INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_system INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    type_id INTEGER NOT NULL REFERENCES voucher_types(id),
    number TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    narration TEXT NOT NULL DEFAULT '',
    party_id INTEGER REFERENCES ledgers(id),
    place_of_supply TEXT NOT NULL DEFAULT '',
    reverse_charge INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (type_id, number)
  )`,
  `CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    amount INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    narration TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS bills (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER REFERENCES entries(id) ON DELETE CASCADE,
    ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
    kind TEXT NOT NULL CHECK (kind IN ('new','agst','adv','onacc','opening')),
    name TEXT NOT NULL,
    amount INTEGER NOT NULL,
    bill_date TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL UNIQUE COLLATE NOCASE,
    formal_name TEXT NOT NULL DEFAULT '',
    decimals INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS stock_groups (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    parent_id INTEGER REFERENCES stock_groups(id)
  )`,
  `CREATE TABLE IF NOT EXISTS stock_categories (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_id INTEGER REFERENCES stock_categories(id)
  )`,
  `CREATE TABLE IF NOT EXISTS godowns (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_id INTEGER REFERENCES godowns(id)
  )`,
  `CREATE TABLE IF NOT EXISTS stock_items (
    id INTEGER PRIMARY KEY,
    guid TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    alias TEXT NOT NULL DEFAULT '',
    group_id INTEGER REFERENCES stock_groups(id),
    category_id INTEGER REFERENCES stock_categories(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    hsn_sac TEXT NOT NULL DEFAULT '',
    rate_bp INTEGER NOT NULL DEFAULT 0,
    taxability TEXT NOT NULL DEFAULT 'Taxable',
    opening_qty INTEGER NOT NULL DEFAULT 0,
    opening_rate INTEGER NOT NULL DEFAULT 0,
    opening_value INTEGER NOT NULL DEFAULT 0,
    reorder_qty INTEGER NOT NULL DEFAULT 0,
    standard_cost INTEGER NOT NULL DEFAULT 0,
    standard_price INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY,
    voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
    item_id INTEGER NOT NULL REFERENCES stock_items(id),
    godown_id INTEGER REFERENCES godowns(id),
    ledger_id INTEGER REFERENCES ledgers(id),
    qty INTEGER NOT NULL,
    rate INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    discount_bp INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    action TEXT NOT NULL,
    object TEXT NOT NULL,
    object_id INTEGER,
    name TEXT NOT NULL DEFAULT ''
  )`,
  'CREATE INDEX IF NOT EXISTS idx_moves_item ON stock_movements(item_id)',
  'CREATE INDEX IF NOT EXISTS idx_moves_voucher ON stock_movements(voucher_id)',
  'CREATE INDEX IF NOT EXISTS idx_entries_ledger ON entries(ledger_id)',
  'CREATE INDEX IF NOT EXISTS idx_entries_voucher ON entries(voucher_id)',
  'CREATE INDEX IF NOT EXISTS idx_vouchers_date ON vouchers(date)',
  'CREATE INDEX IF NOT EXISTS idx_bills_ledger ON bills(ledger_id)',
  'CREATE INDEX IF NOT EXISTS idx_bills_entry ON bills(entry_id)',
];

type Nature = 'Assets' | 'Liabilities' | 'Income' | 'Expense';

export const GROUPS: [string, string | null, Nature, number][] = [
  ['Branch / Divisions', null, 'Liabilities', 0],
  ['Capital Account', null, 'Liabilities', 0],
  ['Reserves & Surplus', 'Capital Account', 'Liabilities', 0],
  ['Current Assets', null, 'Assets', 0],
  ['Bank Accounts', 'Current Assets', 'Assets', 0],
  ['Cash-in-Hand', 'Current Assets', 'Assets', 0],
  ['Deposits (Asset)', 'Current Assets', 'Assets', 0],
  ['Loans & Advances (Asset)', 'Current Assets', 'Assets', 0],
  ['Stock-in-Hand', 'Current Assets', 'Assets', 0],
  ['Sundry Debtors', 'Current Assets', 'Assets', 0],
  ['Current Liabilities', null, 'Liabilities', 0],
  ['Duties & Taxes', 'Current Liabilities', 'Liabilities', 0],
  ['Provisions', 'Current Liabilities', 'Liabilities', 0],
  ['Sundry Creditors', 'Current Liabilities', 'Liabilities', 0],
  ['Direct Expenses', null, 'Expense', 1],
  ['Direct Incomes', null, 'Income', 1],
  ['Fixed Assets', null, 'Assets', 0],
  ['Indirect Expenses', null, 'Expense', 0],
  ['Indirect Incomes', null, 'Income', 0],
  ['Investments', null, 'Assets', 0],
  ['Loans (Liability)', null, 'Liabilities', 0],
  ['Bank OD A/c', 'Loans (Liability)', 'Liabilities', 0],
  ['Secured Loans', 'Loans (Liability)', 'Liabilities', 0],
  ['Unsecured Loans', 'Loans (Liability)', 'Liabilities', 0],
  ['Misc. Expenses (ASSET)', null, 'Assets', 0],
  ['Purchase Accounts', null, 'Expense', 1],
  ['Sales Accounts', null, 'Income', 1],
  ['Suspense A/c', null, 'Liabilities', 0],
];

export const VOUCHER_TYPES: [string, string][] = [
  ['Contra', 'Contra'],
  ['Payment', 'Payment'],
  ['Receipt', 'Receipt'],
  ['Journal', 'Journal'],
  ['Sales', 'Sales'],
  ['Purchase', 'Purchase'],
  ['Credit Note', 'Credit Note'],
  ['Debit Note', 'Debit Note'],
];

export function seedStatements(guid: () => string): Stmt[] {
  const ids = new Map(GROUPS.map(([name], i) => [name, i + 1]));
  const out: Stmt[] = [];
  for (const [name, parent, nature, gross] of GROUPS) {
    out.push({
      sql: 'INSERT INTO groups (id, guid, name, parent_id, nature, affects_gross, is_system) VALUES (?, ?, ?, ?, ?, ?, 1)',
      params: [ids.get(name)!, guid(), name, parent ? ids.get(parent)! : null, nature, gross],
    });
  }
  VOUCHER_TYPES.forEach(([name, parent], i) => {
    out.push({
      sql: 'INSERT INTO voucher_types (id, guid, name, parent, is_system) VALUES (?, ?, ?, ?, 1)',
      params: [i + 1, guid(), name, parent],
    });
  });
  out.push({
    sql: 'INSERT INTO ledgers (guid, name, group_id, is_system) VALUES (?, ?, ?, 1)',
    params: [guid(), 'Cash', ids.get('Cash-in-Hand')!],
  });
  out.push({
    sql: 'INSERT INTO ledgers (guid, name, group_id, is_system) VALUES (?, ?, ?, 1)',
    params: [guid(), 'Profit & Loss A/c', ids.get('Reserves & Surplus')!],
  });
  return out;
}
