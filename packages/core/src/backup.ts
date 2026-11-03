import { CoreError, type Db, type SqlValue, type Stmt } from './db.ts';

export const BACKUP_TABLES = [
  'company',
  'groups',
  'ledgers',
  'voucher_types',
  'vouchers',
  'entries',
  'bills',
  'units',
  'stock_groups',
  'stock_categories',
  'godowns',
  'stock_items',
  'stock_movements',
  'audit_log',
] as const;

export interface BackupFile {
  format: 'tallybook-backup';
  version: 1;
  created: string;
  tables: Record<string, Record<string, SqlValue>[]>;
}

export async function createBackup(db: Db): Promise<BackupFile> {
  const tables: BackupFile['tables'] = {};
  for (const t of BACKUP_TABLES) tables[t] = await db.select<Record<string, SqlValue>>(`SELECT * FROM ${t}`);
  return { format: 'tallybook-backup', version: 1, created: new Date().toISOString(), tables };
}

export async function restoreBackup(db: Db, file: unknown): Promise<{ rows: number }> {
  const f = file as BackupFile;
  if (!f || f.format !== 'tallybook-backup' || f.version !== 1 || typeof f.tables !== 'object') throw new CoreError('invalid', 'This is not a TallyBook backup file');
  if (!f.tables.company?.length) throw new CoreError('invalid', 'The backup has no company data');
  const stmts: Stmt[] = [];
  for (const t of [...BACKUP_TABLES].reverse()) stmts.push({ sql: `DELETE FROM ${t}` });
  let rows = 0;
  for (const t of BACKUP_TABLES) {
    for (const r of f.tables[t] ?? []) {
      const cols = Object.keys(r);
      if (!cols.every((c) => /^[a-z_]+$/.test(c))) throw new CoreError('invalid', `Unexpected column in ${t}`);
      stmts.push({ sql: `INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, params: cols.map((c) => r[c]) });
      rows += 1;
    }
  }
  await db.batch(stmts);
  return { rows };
}

export interface AuditRow {
  id: number;
  at: string;
  action: string;
  object: string;
  object_id: number | null;
  name: string;
  username: string;
}

export async function auditLog(db: Db, limit = 500): Promise<AuditRow[]> {
  return db.select<AuditRow>('SELECT id, at, action, object, object_id, name, username FROM audit_log ORDER BY id DESC LIMIT ?', [limit]);
}
