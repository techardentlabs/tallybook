export type TaxRegime = 'new' | 'old';

export const TAX_REGIMES: { id: TaxRegime; label: string }[] = [
  { id: 'new', label: 'Tax Regime U/s 202 (New)' },
  { id: 'old', label: 'Regular Tax Regime (Old)' },
];

export const regimeLabel = (r: string) => TAX_REGIMES.find((t) => t.id === r)?.label ?? r;

export interface TaxSlab {
  from: number;
  rate_bp: number;
}

export interface SurchargeBand {
  above: number;
  rate_bp: number;
}

export interface TaxRules {
  fy_start: string;
  regime: TaxRegime;
  act: string;
  slabs: TaxSlab[];
  senior_slabs: TaxSlab[];
  super_senior_slabs: TaxSlab[];
  standard_deduction: number;
  rebate_limit: number;
  rebate_max: number;
  rebate_marginal: boolean;
  surcharge: SurchargeBand[];
  cess_bp: number;
  limit_80c: number;
  limit_80ccd1b: number;
  limit_home_loan: number;
}

const R = 100;
const LAKH = 100000 * R;

const NEW_SLABS: TaxSlab[] = [
  { from: 0, rate_bp: 0 },
  { from: 4 * LAKH, rate_bp: 500 },
  { from: 8 * LAKH, rate_bp: 1000 },
  { from: 12 * LAKH, rate_bp: 1500 },
  { from: 16 * LAKH, rate_bp: 2000 },
  { from: 20 * LAKH, rate_bp: 2500 },
  { from: 24 * LAKH, rate_bp: 3000 },
];

const OLD_SLABS: TaxSlab[] = [
  { from: 0, rate_bp: 0 },
  { from: 2.5 * LAKH, rate_bp: 500 },
  { from: 5 * LAKH, rate_bp: 2000 },
  { from: 10 * LAKH, rate_bp: 3000 },
];

const OLD_SENIOR: TaxSlab[] = [
  { from: 0, rate_bp: 0 },
  { from: 3 * LAKH, rate_bp: 500 },
  { from: 5 * LAKH, rate_bp: 2000 },
  { from: 10 * LAKH, rate_bp: 3000 },
];

const OLD_SUPER: TaxSlab[] = [
  { from: 0, rate_bp: 0 },
  { from: 5 * LAKH, rate_bp: 2000 },
  { from: 10 * LAKH, rate_bp: 3000 },
];

const newRules = (fy_start: string, act: string): TaxRules => ({
  fy_start,
  regime: 'new',
  act,
  slabs: NEW_SLABS,
  senior_slabs: [],
  super_senior_slabs: [],
  standard_deduction: 75000 * R,
  rebate_limit: 12 * LAKH,
  rebate_max: 60000 * R,
  rebate_marginal: true,
  surcharge: [
    { above: 50 * LAKH, rate_bp: 1000 },
    { above: 100 * LAKH, rate_bp: 1500 },
    { above: 200 * LAKH, rate_bp: 2500 },
  ],
  cess_bp: 400,
  limit_80c: 0,
  limit_80ccd1b: 0,
  limit_home_loan: 0,
});

const oldRules = (fy_start: string, act: string): TaxRules => ({
  fy_start,
  regime: 'old',
  act,
  slabs: OLD_SLABS,
  senior_slabs: OLD_SENIOR,
  super_senior_slabs: OLD_SUPER,
  standard_deduction: 50000 * R,
  rebate_limit: 5 * LAKH,
  rebate_max: 12500 * R,
  rebate_marginal: false,
  surcharge: [
    { above: 50 * LAKH, rate_bp: 1000 },
    { above: 100 * LAKH, rate_bp: 1500 },
    { above: 200 * LAKH, rate_bp: 2500 },
    { above: 500 * LAKH, rate_bp: 3700 },
  ],
  cess_bp: 400,
  limit_80c: 1.5 * LAKH,
  limit_80ccd1b: 50000 * R,
  limit_home_loan: 2 * LAKH,
});

export const DEFAULT_TAX_RULES: TaxRules[] = [
  newRules('2025-04-01', '1961'),
  oldRules('2025-04-01', '1961'),
  newRules('2026-04-01', '2025'),
  oldRules('2026-04-01', '2025'),
];

export function defaultTaxRules(fyStart: string, regime: TaxRegime): TaxRules {
  const list = DEFAULT_TAX_RULES.filter((r) => r.regime === regime).sort((a, b) => a.fy_start.localeCompare(b.fy_start));
  const hit = [...list].reverse().find((r) => r.fy_start <= fyStart) ?? list[0];
  return { ...hit, fy_start: fyStart, act: fyStart >= '2026-04-01' ? '2025' : '1961' };
}

export function slabTax(income: number, slabs: TaxSlab[]): number {
  const s = [...slabs].sort((a, b) => a.from - b.from);
  let tax = 0;
  for (let i = 0; i < s.length; i++) {
    const lo = s[i].from;
    const hi = i + 1 < s.length ? s[i + 1].from : Infinity;
    if (income <= lo) break;
    tax += ((Math.min(income, hi) - lo) * s[i].rate_bp) / 10000;
  }
  return Math.round(tax);
}

export function slabsFor(rules: TaxRules, age: number): TaxSlab[] {
  if (age >= 80 && rules.super_senior_slabs.length) return rules.super_senior_slabs;
  if (age >= 60 && rules.senior_slabs.length) return rules.senior_slabs;
  return rules.slabs;
}

export interface TaxOnIncome {
  income: number;
  slab_tax: number;
  rebate: number;
  after_rebate: number;
  surcharge: number;
  cess: number;
  total: number;
}

export function taxOnIncome(income: number, rules: TaxRules, age = 0): TaxOnIncome {
  const slabs = slabsFor(rules, age);
  const base = slabTax(income, slabs);
  let rebate = 0;
  if (income <= rules.rebate_limit) rebate = Math.min(base, rules.rebate_max);
  else if (rules.rebate_marginal && base > income - rules.rebate_limit) rebate = base - (income - rules.rebate_limit);
  const after = base - rebate;
  const bands = [...rules.surcharge].sort((a, b) => a.above - b.above);
  let sur = 0;
  let idx = -1;
  bands.forEach((b, i) => {
    if (income > b.above) idx = i;
  });
  if (idx >= 0) {
    const band = bands[idx];
    sur = Math.round((after * band.rate_bp) / 10000);
    const atThreshold = slabTax(band.above, slabs);
    const prevRate = idx > 0 ? bands[idx - 1].rate_bp : 0;
    const cap = atThreshold + Math.round((atThreshold * prevRate) / 10000) + (income - band.above);
    if (after + sur > cap) sur = Math.max(0, cap - after);
  }
  const cess = Math.round(((after + sur) * rules.cess_bp) / 10000);
  const total = Math.round((after + sur + cess) / 1000) * 1000;
  return { income, slab_tax: base, rebate, after_rebate: after, surcharge: sur, cess, total };
}

export const roundToTen = (paise: number) => Math.round(paise / 1000) * 1000;

export function ageOn(dob: string, on: string): number {
  if (!dob) return 0;
  const [y, m, d] = dob.split('-').map(Number);
  const [oy, om, od] = on.split('-').map(Number);
  return oy - y - (om < m || (om === m && od < d) ? 1 : 0);
}

export const GRATUITY_CEILINGS: { from: string; amount: number }[] = [{ from: '2018-03-29', amount: 20 * LAKH }];
export const GRATUITY_DAYS = 15;
export const GRATUITY_MONTH_DAYS = 26;
export const GRATUITY_MIN_YEARS = 5;
export const FIXED_TERM_MIN_YEARS = 1;
export const SOCIAL_SECURITY_CODE_FROM = '2025-11-21';

export function gratuityCeiling(on: string): number {
  const list = [...GRATUITY_CEILINGS].sort((a, b) => a.from.localeCompare(b.from));
  return ([...list].reverse().find((c) => c.from <= on) ?? list[0]).amount;
}

function addDays(iso: string, n: number): string {
  const t = Date.parse(iso + 'T00:00:00Z') + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${ny}-${p(nm)}-${p(Math.min(d, last))}`;
}

export interface ServiceSpan {
  years: number;
  months: number;
  days: number;
  total_months: number;
}

export function serviceSpan(joining: string, asOn: string): ServiceSpan {
  const end = addDays(asOn, 1);
  if (!joining || joining >= end) return { years: 0, months: 0, days: 0, total_months: 0 };
  let m = Math.max(0, (Number(end.slice(0, 4)) - Number(joining.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(joining.slice(5, 7)) - 1);
  while (addMonthsIso(joining, m + 1) <= end) m++;
  while (m > 0 && addMonthsIso(joining, m) > end) m--;
  const days = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(addMonthsIso(joining, m) + 'T00:00:00Z')) / 86400000);
  return { years: Math.floor(m / 12), months: m % 12, days, total_months: m };
}

export function gratuityYears(s: ServiceSpan): number {
  return s.years + (s.months > 6 || (s.months === 6 && s.days > 0) ? 1 : 0);
}

export type SeparationReason = 'separation' | 'death' | 'disablement';

export interface GratuityInput {
  wages: number;
  joining: string;
  as_on: string;
  fixed_term?: boolean;
  reason?: SeparationReason;
  ceiling?: number;
}

export interface GratuityResult {
  span: ServiceSpan;
  years: number;
  min_years: number;
  eligible: boolean;
  ceiling: number;
  capped: boolean;
  amount: number;
  accrued: number;
}

export function computeGratuity(i: GratuityInput): GratuityResult {
  const span = serviceSpan(i.joining, i.as_on);
  const years = gratuityYears(span);
  const min = i.fixed_term && i.as_on >= SOCIAL_SECURITY_CODE_FROM ? FIXED_TERM_MIN_YEARS : GRATUITY_MIN_YEARS;
  const eligible = i.reason === 'death' || i.reason === 'disablement' ? span.total_months > 0 || span.days > 0 : span.years >= min;
  const ceiling = i.ceiling ?? gratuityCeiling(i.as_on);
  const raw = Math.round((i.wages * GRATUITY_DAYS * years) / GRATUITY_MONTH_DAYS);
  const accruedRaw = Math.round((i.wages * GRATUITY_DAYS * span.total_months) / (GRATUITY_MONTH_DAYS * 12));
  return {
    span,
    years,
    min_years: min,
    eligible,
    ceiling,
    capped: eligible && raw > ceiling,
    amount: eligible ? Math.min(raw, ceiling) : 0,
    accrued: Math.min(accruedRaw, ceiling),
  };
}
