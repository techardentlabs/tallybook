export const LAST_ID = '$lastInsertId';

export type SqlValue = string | number | null;

export interface Stmt {
  sql: string;
  params?: SqlValue[];
}

export interface Db {
  select<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  batch(stmts: Stmt[]): Promise<void>;
}

export type ErrorCode = 'invalid' | 'conflict' | 'not_found';

export class CoreError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export async function one<T>(db: Db, sql: string, params: SqlValue[] = []): Promise<T | undefined> {
  const rows = await db.select<T>(sql, params);
  return rows[0];
}
