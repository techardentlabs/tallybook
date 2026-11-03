const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function groupIndian(intStr: string): string {
  if (intStr.length <= 3) return intStr;
  const last3 = intStr.slice(-3);
  const rest = intStr.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

export function fmtAmount(paise: number, blankZero = true): string {
  if (!paise && blankZero) return '';
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${paise < 0 ? '-' : ''}${groupIndian(String(whole))}.${frac}`;
}

export function fmtDrCr(paise: number): string {
  if (!paise) return '';
  return `${fmtAmount(Math.abs(paise))} ${paise > 0 ? 'Dr' : 'Cr'}`;
}

export function parseAmount(text: string): number | null {
  const t = String(text).replace(/[,\s]/g, '');
  if (t === '') return 0;
  if (!/^\d*\.?\d{0,2}$/.test(t) || t === '.') return null;
  const [w, f = ''] = t.split('.');
  return parseInt(w || '0', 10) * 100 + parseInt(f.padEnd(2, '0') || '0', 10);
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function fmtDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const mon = MONTHS[m - 1];
  return `${d}-${mon[0].toUpperCase()}${mon.slice(1)}-${y}`;
}

export function weekday(iso: string): string {
  return DAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()];
}

export function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fyEnd(start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function parseDate(text: string, fyStart?: string, baseIso?: string | null): string | null {
  const parts = String(text).trim().toLowerCase().split(/[-/.\s]+/).filter(Boolean);
  if (!parts.length || parts.length > 3) return null;
  const base = baseIso || fyStart || todayIso();
  const [by, bm] = base.split('-').map(Number);
  const day = Number(parts[0]);
  if (!Number.isInteger(day)) return null;
  let month = bm;
  if (parts[1] !== undefined) {
    const idx = MONTHS.indexOf(parts[1].slice(0, 3));
    month = idx >= 0 ? idx + 1 : Number(parts[1]);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  let year: number;
  if (parts[2] !== undefined) {
    year = Number(parts[2]);
    if (!Number.isInteger(year)) return null;
    if (year < 100) year += 2000;
  } else if (fyStart) {
    const [fy, fm] = fyStart.split('-').map(Number);
    year = month >= fm ? fy : fy + 1;
  } else {
    year = by;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return dt.toISOString().slice(0, 10);
}

export function newGuid(): string {
  return globalThis.crypto.randomUUID();
}

export function clean(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
