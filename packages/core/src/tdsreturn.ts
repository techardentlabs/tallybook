import { CoreError, one, type Db } from './db.ts';
import { clean, isIsoDate } from './util.ts';
import { actOn, dueDate, quarterOf, sectionOn, type NatureVersion, type TaxKind } from './tds.ts';

export interface InterestRule {
  act: '1961' | '2025';
  kind: TaxKind;
  late_deduction_bp: number;
  late_payment_bp: number;
  deduction_section: string;
  payment_section: string;
  fee_section: string;
}

export const INTEREST_RULES: InterestRule[] = [
  { act: '1961', kind: 'TDS', late_deduction_bp: 100, late_payment_bp: 150, deduction_section: '201(1A)(i)', payment_section: '201(1A)(ii)', fee_section: '234E' },
  { act: '1961', kind: 'TCS', late_deduction_bp: 100, late_payment_bp: 100, deduction_section: '206C(7)', payment_section: '206C(7)', fee_section: '234E' },
  { act: '2025', kind: 'TDS', late_deduction_bp: 100, late_payment_bp: 150, deduction_section: '398(3)(a)(i)', payment_section: '398(3)(a)(ii)', fee_section: '427' },
  { act: '2025', kind: 'TCS', late_deduction_bp: 100, late_payment_bp: 150, deduction_section: '398(3)(a)(i)', payment_section: '398(3)(a)(ii)', fee_section: '427' },
];

export const LATE_FEE_PER_DAY = 200_00;

export function interestRule(kind: TaxKind, date: string): InterestRule {
  const act = actOn(date);
  return INTEREST_RULES.find((r) => r.act === act && r.kind === kind)!;
}

export function interestMonths(from: string, to: string): number {
  if (!from || !to || to < from) return 0;
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

const floorHundred = (paise: number) => Math.floor(paise / 10000) * 10000;
const roundRupee = (paise: number) => Math.round(paise / 100) * 100;

export function interestOn(amount: number, bp: number, months: number): number {
  if (amount <= 0 || months <= 0) return 0;
  return roundRupee((floorHundred(amount) * bp * months) / 10000);
}

export function statementDueDate(quarterFrom: string, kind: TaxKind): string {
  const y = Number(quarterFrom.slice(0, 4));
  const m = Number(quarterFrom.slice(5, 7));
  const day = kind === 'TCS' && actOn(quarterFrom) === '1961' ? '15' : '31';
  if (m >= 4 && m <= 6) return `${y}-07-${day}`;
  if (m >= 7 && m <= 9) return `${y}-10-${day}`;
  if (m >= 10) return `${y + 1}-01-${day}`;
  return `${y}-05-${day}`;
}

const days = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

export function lateFee(dueOn: string, filedOn: string, tax: number): { days: number; fee: number } {
  const d = Math.max(0, days(dueOn, filedOn));
  return { days: d, fee: Math.min(d * LATE_FEE_PER_DAY, Math.max(0, tax)) };
}

export interface InterestPart {
  date: string;
  amount: number;
  months: number;
  interest: number;
}

export interface TdsInterestRow {
  deduction_id: number;
  voucher_id: number;
  date: string;
  number: string;
  type: string;
  party: string;
  nature_id: number;
  nature: string;
  section: string;
  kind: TaxKind;
  act: string;
  interest_section: string;
  rate_bp: number;
  amount: number;
  paid: number;
  pending: number;
  due_on: string;
  parts: InterestPart[];
  interest: number;
}

export async function tdsInterest(db: Db, from: string, to: string, kind: TaxKind = 'TDS', asOn?: string): Promise<TdsInterestRow[]> {
  const today = asOn ?? to;
  const rows = await db.select<{ deduction_id: number; voucher_id: number; date: string; number: string; type: string; party: string; nature_id: number; nature: string; section: string; amount: number }>(
    `SELECT d.id AS deduction_id, d.voucher_id, d.date, v.number, t.name AS type, p.name AS party, d.nature_id, n.name AS nature, n.section, d.total AS amount
     FROM tds_deductions d
     JOIN vouchers v ON v.id = d.voucher_id AND v.cancelled = 0
     JOIN voucher_types t ON t.id = v.type_id
     JOIN ledgers p ON p.id = d.party_id
     JOIN tds_nature n ON n.id = d.nature_id
     WHERE d.kind = ? AND d.date >= ? AND d.date <= ? AND d.total > 0
     ORDER BY d.date, d.id`,
    [kind, from, to]
  );
  if (!rows.length) return [];
  const pays = await db.select<{ deduction_id: number; amount: number; date: string }>(
    `SELECT cl.deduction_id, cl.amount, CASE WHEN c.challan_date <> '' THEN c.challan_date ELSE c.date END AS date
     FROM tds_challan_lines cl JOIN tds_challans c ON c.id = cl.challan_id
     JOIN tds_deductions d ON d.id = cl.deduction_id WHERE d.kind = ? AND d.date >= ? AND d.date <= ?`,
    [kind, from, to]
  );
  const byDed = new Map<number, { amount: number; date: string }[]>();
  for (const p of pays) byDed.set(p.deduction_id, [...(byDed.get(p.deduction_id) ?? []), p]);
  const versions = await db.select<NatureVersion>('SELECT * FROM tds_nature_versions');
  return rows.map((r) => {
    const rule = interestRule(kind, r.date);
    const due = dueDate(r.date, kind);
    const parts: InterestPart[] = [];
    let paid = 0;
    for (const p of (byDed.get(r.deduction_id) ?? []).sort((a, b) => a.date.localeCompare(b.date))) {
      paid += p.amount;
      const months = p.date > due ? interestMonths(r.date, p.date) : 0;
      parts.push({ date: p.date, amount: p.amount, months, interest: interestOn(p.amount, rule.late_payment_bp, months) });
    }
    const pending = Math.max(0, r.amount - paid);
    if (pending > 0) {
      const months = today > due ? interestMonths(r.date, today) : 0;
      parts.push({ date: '', amount: pending, months, interest: interestOn(pending, rule.late_payment_bp, months) });
    }
    return {
      ...r,
      section: sectionOn({ id: r.nature_id, section: r.section }, versions.filter((v) => v.nature_id === r.nature_id), r.date),
      kind,
      act: actOn(r.date),
      interest_section: rule.payment_section,
      rate_bp: rule.late_payment_bp,
      paid,
      pending,
      due_on: due,
      parts,
      interest: parts.reduce((s, x) => s + x.interest, 0),
    };
  });
}

export async function interestIfPaidOn(db: Db, deductionIds: number[], payDate: string): Promise<number> {
  if (!deductionIds.length || !isIsoDate(payDate)) return 0;
  const ph = deductionIds.map(() => '?').join(',');
  const rows = await db.select<{ id: number; date: string; kind: TaxKind; total: number; paid: number }>(
    `SELECT d.id, d.date, d.kind, d.total, COALESCE((SELECT SUM(cl.amount) FROM tds_challan_lines cl WHERE cl.deduction_id = d.id), 0) AS paid
     FROM tds_deductions d WHERE d.id IN (${ph})`,
    deductionIds
  );
  let total = 0;
  for (const r of rows) {
    const due = dueDate(r.date, r.kind);
    if (payDate <= due) continue;
    total += interestOn(r.total - r.paid, interestRule(r.kind, r.date).late_payment_bp, interestMonths(r.date, payDate));
  }
  return total;
}

export interface StatementFiling {
  id: number;
  kind: TaxKind;
  quarter_from: string;
  quarter_to: string;
  form: string;
  filed_on: string;
  token_no: string;
}

export async function statementFilings(db: Db, kind?: TaxKind): Promise<StatementFiling[]> {
  return kind
    ? db.select<StatementFiling>('SELECT * FROM tds_statements WHERE kind = ? ORDER BY quarter_from', [kind])
    : db.select<StatementFiling>('SELECT * FROM tds_statements ORDER BY kind, quarter_from');
}

export function formFor(kind: TaxKind, quarterFrom: string): string {
  const act = actOn(quarterFrom);
  return kind === 'TCS' ? (act === '2025' ? '143' : '27EQ') : act === '2025' ? '140' : '26Q';
}

export async function saveStatementFiling(db: Db, input: { kind: TaxKind; quarter_from: string; filed_on: string; token_no?: string }): Promise<StatementFiling> {
  if (!isIsoDate(input.quarter_from)) throw new CoreError('invalid', 'Quarter is invalid');
  if (input.filed_on && !isIsoDate(input.filed_on)) throw new CoreError('invalid', 'Date of filing is invalid');
  const q = quarterOf(input.quarter_from);
  const token = clean(input.token_no, 20);
  if (token && !/^\d{15}$/.test(token)) throw new CoreError('invalid', 'Token number must be 15 digits');
  const cur = await one<{ id: number }>(db, 'SELECT id FROM tds_statements WHERE kind = ? AND quarter_from = ?', [input.kind, q.from]);
  const id = cur?.id ?? ((await one<{ m: number }>(db, 'SELECT COALESCE(MAX(id), 0) AS m FROM tds_statements'))!.m + 1);
  await db.batch([
    {
      sql: 'INSERT OR REPLACE INTO tds_statements (id, kind, quarter_from, quarter_to, form, filed_on, token_no) VALUES (?, ?, ?, ?, ?, ?, ?)',
      params: [id, input.kind, q.from, q.to, formFor(input.kind, q.from), input.filed_on, token],
    },
  ]);
  return (await one<StatementFiling>(db, 'SELECT * FROM tds_statements WHERE id = ?', [id]))!;
}

export interface QuarterLiability {
  kind: TaxKind;
  quarter: number;
  from: string;
  to: string;
  form: string;
  act: string;
  tax: number;
  deposited: number;
  interest: number;
  interest_paid: number;
  statement_due: string;
  filed_on: string;
  late_days: number;
  late_fee: number;
  fee_paid: number;
  fee_section: string;
}

export async function tdsInterestAndFee(db: Db, from: string, to: string, kind: TaxKind = 'TDS', asOn?: string): Promise<{ rows: TdsInterestRow[]; quarters: QuarterLiability[] }> {
  const today = asOn ?? to;
  const rows = await tdsInterest(db, from, to, kind, today);
  const filings = new Map((await statementFilings(db, kind)).map((f) => [f.quarter_from, f]));
  const paidRows = await db.select<{ quarter_from: string; interest: number; fee: number }>(
    'SELECT quarter_from, COALESCE(SUM(interest), 0) AS interest, COALESCE(SUM(fee), 0) AS fee FROM tds_challans WHERE kind = ? GROUP BY quarter_from',
    [kind]
  );
  const paid = new Map(paidRows.map((p) => [p.quarter_from, p]));
  const quarters = new Map<string, QuarterLiability>();
  for (const r of rows) {
    const q = quarterOf(r.date);
    const fee = interestRule(kind, q.from).fee_section;
    const cur = quarters.get(q.from) ?? {
      kind, quarter: q.q, from: q.from, to: q.to, form: formFor(kind, q.from), act: actOn(q.from), tax: 0, deposited: 0, interest: 0,
      interest_paid: paid.get(q.from)?.interest ?? 0, statement_due: statementDueDate(q.from, kind), filed_on: filings.get(q.from)?.filed_on ?? '',
      late_days: 0, late_fee: 0, fee_paid: paid.get(q.from)?.fee ?? 0, fee_section: fee,
    };
    cur.tax += r.amount;
    cur.deposited += r.paid;
    cur.interest += r.interest;
    quarters.set(q.from, cur);
  }
  for (const q of quarters.values()) {
    const lf = lateFee(q.statement_due, q.filed_on || today, q.tax);
    q.late_days = lf.days;
    q.late_fee = lf.fee;
  }
  return { rows, quarters: [...quarters.values()].sort((a, b) => a.from.localeCompare(b.from)) };
}
