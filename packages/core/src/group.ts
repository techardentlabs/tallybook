import { CoreError, one, type Db, type SqlValue, type Stmt } from './db.ts';
import { Books } from './books.ts';
import { ensureStockVoucherTypes } from './inventory.ts';
import { newGuid } from './util.ts';
import { columnsOf, dependencyOrder, foreignKeys, ifNotExists, insertStmts, qid, runChunked, schemaObjects, tableList, type ColumnInfo, type FkRef } from './dbtools.ts';

export const GROUP_READ_ONLY = 'This is a Group Company. Its data is read from the member companies and cannot be altered here; alter the member company instead.';

export interface GroupMemberSource {
  id: string;
  name: string;
  db: Db;
}

export interface GroupMemberSummary {
  id: string;
  name: string;
  ledgers: number;
  vouchers: number;
  stock_items: number;
}

export interface ConsolidationReport {
  name: string;
  members: GroupMemberSummary[];
  ledgers: number;
  vouchers: number;
  merged_ledgers: number;
}

const MERGE_KEYS: Record<string, string> = {
  groups: 'name',
  ledgers: 'name',
  voucher_types: 'name',
  units: 'symbol',
  stock_groups: 'name',
  stock_categories: 'name',
  godowns: 'name',
  stock_items: 'name',
};

const ADDITIVE: Record<string, string[]> = {
  ledgers: ['opening'],
  stock_items: ['opening_qty', 'opening_value'],
};

const SKIP = new Set(['company', 'audit_log', 'security_edit_log']);
const FIRST_ONLY = (t: string) => t.startsWith('security_') || t.endsWith('_config') || t.endsWith('_settings') || t === 'tds_company';

const PROTECTED = new Set([
  'company', 'groups', 'ledgers', 'voucher_types', 'vouchers', 'entries', 'bills', 'stock_items', 'stock_movements', 'stock_groups', 'stock_categories',
  'units', 'godowns', 'cost_centres', 'cost_categories', 'cost_allocations', 'stockx_batches', 'stockx_track', 'bank_allocs',
]);

const WRITE_RE = /^\s*(?:INSERT(?:\s+OR\s+(\w+))?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?(\w+)/i;

export function groupWriteTarget(sql: string): string | null {
  const m = WRITE_RE.exec(sql);
  if (!m) return null;
  if (m[1] && /^ignore$/i.test(m[1])) return null;
  return m[2].toLowerCase();
}

export function readOnlyGroupDb(db: Db): Db {
  return {
    select: (sql, params) => db.select(sql, params),
    async batch(stmts: Stmt[]) {
      for (const s of stmts) {
        const t = groupWriteTarget(s.sql);
        if (t && PROTECTED.has(t)) throw new CoreError('invalid', GROUP_READ_ONLY);
      }
      await db.batch(stmts);
    },
  };
}

function stripVoucherUnique(sql: string): string {
  return sql.replace(/,\s*UNIQUE\s*\(\s*type_id\s*,\s*number\s*\)/i, '');
}

function dropUniqueIndex(sql: string): string | null {
  return /^\s*CREATE\s+UNIQUE\s+INDEX/i.test(sql) ? null : sql;
}

interface TableMeta {
  cols: ColumnInfo[];
  intPk: boolean;
  refs: FkRef[];
  key?: string;
}

async function targetMeta(db: Db, table: string, refs: FkRef[]): Promise<TableMeta> {
  const cols = await columnsOf(db, table);
  const pk = cols.filter((c) => c.pk > 0);
  const intPk = pk.length === 1 && pk[0].name === 'id' && /int/i.test(pk[0].type);
  let key = MERGE_KEYS[table];
  if (!key && intPk) {
    const lit = `'${table.replace(/'/g, "''")}'`;
    for (const ix of await db.select<{ name: string; unique: number; origin: string }>(`SELECT name, "unique" AS "unique", origin FROM pragma_index_list(${lit})`)) {
      if (!ix.unique || ix.origin === 'pk') continue;
      const info = await db.select<{ name: string }>(`SELECT name FROM pragma_index_info('${ix.name.replace(/'/g, "''")}')`);
      if (info.length === 1 && info[0].name !== 'guid' && info[0].name !== 'id') {
        key = info[0].name;
        break;
      }
    }
  }
  return { cols, intPk, refs: refs.filter((r) => r.table === table), key };
}

async function buildSchema(target: Db, members: GroupMemberSource[]): Promise<void> {
  const made = new Set<string>();
  const stmts: Stmt[] = [];
  const idx: Stmt[] = [];
  for (const m of members) {
    for (const o of await schemaObjects(m.db)) {
      if (o.type === 'table') {
        if (made.has(o.name)) continue;
        made.add(o.name);
        stmts.push({ sql: ifNotExists(o.name === 'vouchers' ? stripVoucherUnique(o.sql) : o.sql) });
      } else if (o.type === 'index') {
        const sql = dropUniqueIndex(o.sql);
        if (sql) idx.push({ sql: ifNotExists(sql) });
      }
    }
  }
  await target.batch(stmts);
  const tables = new Set(await tableList(target));
  await target.batch(idx.filter((s) => {
    const m = /\bON\s+["`]?(\w+)/i.exec(s.sql);
    return !m || tables.has(m[1]);
  }));
}

function topoRows(rows: Record<string, SqlValue>[], selfCol: string | null): Record<string, SqlValue>[] {
  if (!selfCol) return rows;
  const done = new Set<SqlValue>();
  const ids = new Set(rows.map((r) => r.id));
  const out: Record<string, SqlValue>[] = [];
  let left = rows;
  while (left.length) {
    const next: Record<string, SqlValue>[] = [];
    for (const r of left) {
      const p = r[selfCol];
      if (p === null || p === undefined || done.has(p) || !ids.has(p)) {
        out.push(r);
        done.add(r.id);
      } else next.push(r);
    }
    if (next.length === left.length) {
      out.push(...next);
      break;
    }
    left = next;
  }
  return out;
}

export async function consolidateCompanies(target: Db, name: string, members: GroupMemberSource[]): Promise<ConsolidationReport> {
  if (members.length < 2) throw new CoreError('invalid', 'A Group Company needs at least two member companies');
  const companies: Record<string, SqlValue>[] = [];
  for (const m of members) {
    const c = await one<Record<string, SqlValue>>(m.db, 'SELECT * FROM company WHERE id = 1');
    if (!c) throw new CoreError('invalid', `${m.name} has no company data`);
    companies.push(c);
  }
  const sym = (c: Record<string, SqlValue>) => `${c.currency_symbol ?? ''}|${String(c.currency_name ?? '').toLowerCase()}`;
  if (new Set(companies.map(sym)).size > 1) throw new CoreError('invalid', 'All member companies must have the same base currency symbol and formal name');

  await buildSchema(target, members);
  const books = new Books(target);
  await books.init();
  await ensureStockVoucherTypes(target);

  const tables = await tableList(target);
  const refs = await foreignKeys(target, tables);
  const order = dependencyOrder(tables, refs).filter((t) => !SKIP.has(t));
  const meta = new Map<string, TableMeta>();
  for (const t of order) meta.set(t, await targetMeta(target, t, refs));

  const summaries: GroupMemberSummary[] = [];
  let merged = 0;
  for (const [mi, m] of members.entries()) {
    const srcTables = new Set(await tableList(m.db));
    const maps = new Map<string, Map<SqlValue, SqlValue>>();
    const mapOf = (t: string) => maps.get(t) ?? maps.set(t, new Map()).get(t)!;
    for (const t of order) {
      if (!srcTables.has(t)) continue;
      if (FIRST_ONLY(t) && mi > 0) continue;
      const tm = meta.get(t)!;
      const srcCols = new Set((await columnsOf(m.db, t)).map((c) => c.name));
      const cols = tm.cols.map((c) => c.name).filter((c) => srcCols.has(c));
      if (!cols.length) continue;
      const selfRef = tm.refs.find((r) => r.parent === t && !r.soft)?.from ?? null;
      const rows = topoRows(await m.db.select<Record<string, SqlValue>>(`SELECT ${cols.map(qid).join(', ')} FROM ${qid(t)} ORDER BY rowid`), cols.includes('id') ? selfRef : null);
      if (!rows.length) continue;
      const map = mapOf(t);
      const keyIndex = new Map<string, Record<string, SqlValue>>();
      if (tm.key) {
        const existing = await target.select<Record<string, SqlValue>>(`SELECT * FROM ${qid(t)}`);
        for (const e of existing) keyIndex.set(String(e[tm.key] ?? '').toLowerCase(), e);
      }
      let nextId = tm.intPk ? ((await one<{ m: number }>(target, `SELECT COALESCE(MAX(id), 0) AS m FROM ${qid(t)}`))?.m ?? 0) + 1 : 0;
      const inserts: SqlValue[][] = [];
      const updates: Stmt[] = [];
      for (const r of rows) {
        const out: Record<string, SqlValue> = { ...r };
        let skip = false;
        for (const ref of tm.refs) {
          if (!cols.includes(ref.from)) continue;
          const v = r[ref.from];
          if (v === null || v === undefined) continue;
          if (ref.parent === t && ref.from !== 'id') {
            out[ref.from] = map.get(v) ?? null;
            continue;
          }
          const pm = maps.get(ref.parent);
          if (!pm) continue;
          const nv = pm.get(v);
          if (nv === undefined) {
            const col = tm.cols.find((c) => c.name === ref.from)!;
            if (col.notnull) skip = true;
            else out[ref.from] = null;
          } else out[ref.from] = nv;
        }
        if (skip) continue;
        if (tm.key) {
          const k = String(r[tm.key] ?? '').toLowerCase();
          const hit = keyIndex.get(k);
          if (hit) {
            map.set(r.id, hit.id);
            merged += t === 'ledgers' ? 1 : 0;
            const add = (ADDITIVE[t] ?? []).filter((c) => cols.includes(c) && Number(r[c]));
            if (add.length) {
              for (const c of add) hit[c] = Number(hit[c] ?? 0) + Number(r[c]);
              updates.push({ sql: `UPDATE ${qid(t)} SET ${add.map((c) => `${qid(c)} = ?`).join(', ')} WHERE id = ?`, params: [...add.map((c) => hit[c]), hit.id] });
            }
            continue;
          }
        }
        if (tm.intPk) {
          out.id = nextId++;
          map.set(r.id, out.id);
        }
        if (cols.includes('guid')) out.guid = newGuid();
        if (tm.key) keyIndex.set(String(r[tm.key] ?? '').toLowerCase(), out);
        inserts.push(cols.map((c) => out[c] ?? null));
      }
      const verb = tm.key ? 'INSERT' : 'INSERT OR IGNORE';
      await runChunked(target, [...insertStmts(t, cols, inserts, verb), ...updates], 100);
    }
    const count = async (t: string) => (srcTables.has(t) ? ((await one<{ n: number }>(m.db, `SELECT COUNT(*) AS n FROM ${qid(t)}`))?.n ?? 0) : 0);
    summaries.push({ id: m.id, name: m.name, ledgers: await count('ledgers'), vouchers: await count('vouchers'), stock_items: await count('stock_items') });
  }

  const items = await target.select<{ id: number; opening_qty: number; opening_value: number }>('SELECT id, opening_qty, opening_value FROM stock_items');
  const rates = items.filter((i) => i.opening_qty).map((i) => ({ sql: 'UPDATE stock_items SET opening_rate = ? WHERE id = ?', params: [Math.round((i.opening_value * 1000) / i.opening_qty), i.id] }));
  if (rates.length) await runChunked(target, rates, 200);

  const base = { ...companies[0] };
  const fy = companies.map((c) => String(c.fy_start)).sort()[0];
  const bf = companies.map((c) => String(c.books_from)).sort()[0];
  base.name = name;
  base.mailing_name = name;
  base.fy_start = fy;
  base.books_from = bf < fy ? fy : bf;
  for (const c of companies.slice(1)) {
    for (const k of Object.keys(base)) if (/_enabled$/.test(k) && Number(c[k])) base[k] = 1;
  }
  const tcols = new Set((await columnsOf(target, 'company')).map((c) => c.name));
  const ccols = Object.keys(base).filter((k) => tcols.has(k));
  await target.batch([{ sql: 'DELETE FROM company' }, ...insertStmts('company', ccols, [ccols.map((k) => base[k] ?? null)])]);
  return {
    name,
    members: summaries,
    ledgers: (await one<{ n: number }>(target, 'SELECT COUNT(*) AS n FROM ledgers'))?.n ?? 0,
    vouchers: (await one<{ n: number }>(target, 'SELECT COUNT(*) AS n FROM vouchers'))?.n ?? 0,
    merged_ledgers: merged,
  };
}
