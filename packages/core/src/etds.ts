import { one, type Db } from './db.ts';
import { actOn, isCompanyType, quarterOf, tdsCompany, type TaxKind } from './tds.ts';
import { statementFilings } from './tdsreturn.ts';

export const ETDS_STATE_CODES: Record<string, string> = {
  'andaman & nicobar islands': '01', 'andaman & nicobar': '01', 'andhra pradesh': '02', 'arunachal pradesh': '03', assam: '04', bihar: '05', chandigarh: '06',
  'dadra & nagar haveli and daman & diu': '07', 'dadra & nagar haveli': '07', 'daman & diu': '07', delhi: '09', goa: '10', gujarat: '11', haryana: '12',
  'himachal pradesh': '13', 'jammu & kashmir': '14', karnataka: '15', kerala: '16', lakshadweep: '17', 'madhya pradesh': '18', maharashtra: '19',
  manipur: '20', meghalaya: '21', mizoram: '22', nagaland: '23', odisha: '24', puducherry: '25', pondicherry: '25', punjab: '26', rajasthan: '27',
  sikkim: '28', 'tamil nadu': '29', tripura: '30', 'uttar pradesh': '31', 'west bengal': '32', chhattisgarh: '33', uttarakhand: '34', jharkhand: '35',
  telangana: '36', ladakh: '37',
};

export function etdsStateCode(name: string): string {
  return ETDS_STATE_CODES[name.trim().toLowerCase().replace(/\s+and\s+/g, ' & ')] ?? '';
}

export const DEDUCTOR_CATEGORIES: { code: string; label: string }[] = [
  { code: 'A', label: 'Central Government' },
  { code: 'S', label: 'State Government' },
  { code: 'D', label: 'Statutory body (Central Govt.)' },
  { code: 'E', label: 'Statutory body (State Govt.)' },
  { code: 'G', label: 'Autonomous body (Central Govt.)' },
  { code: 'H', label: 'Autonomous body (State Govt.)' },
  { code: 'L', label: 'Local Authority (Central Govt.)' },
  { code: 'N', label: 'Local Authority (State Govt.)' },
  { code: 'K', label: 'Company' },
  { code: 'M', label: 'Branch / Division of Company' },
  { code: 'P', label: 'Association of Person (AOP)' },
  { code: 'T', label: 'Association of Person (Trust)' },
  { code: 'J', label: 'Artificial Juridical Person' },
  { code: 'B', label: 'Body of Individuals' },
  { code: 'Q', label: 'Individual/HUF' },
  { code: 'F', label: 'Firm' },
];

export function deductorCategory(type: string): string {
  const t = type.trim().toLowerCase();
  const exact = DEDUCTOR_CATEGORIES.find((c) => c.label.toLowerCase() === t || c.code.toLowerCase() === t);
  if (exact) return exact.code;
  if (t.includes('branch')) return 'M';
  if (t.includes('company')) return 'K';
  if (t.includes('trust')) return 'T';
  if (t.includes('association') || t.includes('aop')) return 'P';
  if (t.includes('juridical')) return 'J';
  if (t.includes('body of individuals')) return 'B';
  if (t.includes('individual') || t.includes('huf')) return 'Q';
  if (t.includes('firm') || t.includes('partnership')) return 'F';
  if (t.includes('central')) return 'A';
  if (t.includes('state')) return 'S';
  return '';
}

export const SECTION_CODES_26Q = [
  '193', '194', '94A', '94B', '4BP', '4BB', '94C', '94D', '4EE', '94F', '94G', '94H', '4IA', '4IB', '94L', '4DA', '4BA', '2AA', 'LBB', '9IA', 'LBC', '4IC', '94N',
  '94K', '4JA', '4JB', 'BA1', 'BA2', '4NF', '94O', '94Q', '94R', '4RP', '94S', '4SP', '9BA', '4AP', '4NC', '9FT', '94T',
];
export const COLLECTION_CODES_27EQ = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'T', 'MA', 'MB', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MI', 'MJ'];
export const SECTION_CODES_140 = [
  '1004', '1005', '1006', '1008', '1009', '1011', '1012', '1013', '1014', '1015', '1016', '1017', '1018', '1019', '1020', '1021', '1022', '1023', '1024', '1026', '1027',
  '1028', '1029', '1030', '1031', '1033', '1034', '1035', '1037', '1038', '1058', '1059', '1060', '1061', '1062', '1063', '1064', '1065', '1066', '1067',
];
export const COLLECTION_CODES_143 = Array.from({ length: 25 }, (_, i) => String(1068 + i));

const SECTION_26Q_BY_1961: Record<string, string> = {
  '193': '193', '194': '194', '194A': '94A', '194B': '94B', '194BB': '4BB', '194C': '94C', '194D': '94D', '194DA': '4DA', '194EE': '4EE', '194G': '94G', '194H': '94H',
  '194IA': '9IA', '194IC': '4IC', '194K': '94K', '194LA': '94L', '194LBA': '4BA', '194LBB': 'LBB', '194LBC': 'LBC', '194N': '94N', '194O': '94O', '194Q': '94Q',
  '194R': '94R', '194S': '94S', '194T': '94T', '192A': '2AA', '194BA': '9BA',
};

const NAME_CODES_140: [RegExp, string][] = [
  [/insurance commission/i, '1005'],
  [/commission|brokerage/i, '1006'],
  [/plant|machinery|equipment/i, '1008'],
  [/rent/i, '1009'],
  [/technical|royalty|call cent/i, '1026'],
  [/director/i, '1028'],
  [/professional/i, '1027'],
  [/interest on securities/i, '1019'],
  [/interest/i, '1022'],
  [/dividend/i, '1029'],
  [/purchase of goods/i, '1031'],
  [/e-?commerce/i, '1035'],
  [/lotter|winning/i, '1058'],
  [/partner/i, '1067'],
];

const NAME_CODES_TCS: [RegExp, string, string][] = [
  [/liquor/i, 'A', '1068'],
  [/tendu/i, 'I', '1069'],
  [/timber.*forest lease|forest lease/i, 'B', '1070'],
  [/timber/i, 'C', '1071'],
  [/forest produce/i, 'D', '1072'],
  [/scrap/i, 'E', '1073'],
  [/coal|lignite|iron ore|mineral/i, 'J', '1074'],
  [/motor vehicle/i, 'L', '1075'],
  [/wrist ?watch/i, 'MA', '1076'],
  [/art/i, 'MB', '1077'],
  [/collectible/i, 'MC', '1078'],
  [/yacht|helicopter|boat/i, 'MD', '1079'],
  [/sunglass/i, 'ME', '1080'],
  [/bag/i, 'MF', '1081'],
  [/shoe/i, 'MG', '1082'],
  [/sportswear/i, 'MH', '1083'],
  [/home theatre/i, 'MI', '1084'],
  [/horse/i, 'MJ', '1085'],
  [/parking/i, 'F', '1090'],
  [/toll/i, 'G', '1091'],
  [/min(e|ing)|quarr/i, 'H', '1092'],
];

export interface CodeInput {
  nature: string;
  section_1961: string;
  payment_code_1961: string;
  payment_code_2025: string;
  rate_bp: number;
  deductee_type: string;
}

export function returnSectionCode(form: string, n: CodeInput): string {
  const p61 = n.payment_code_1961.trim().toUpperCase();
  const p25 = n.payment_code_2025.trim();
  if (form === '26Q') {
    if (SECTION_CODES_26Q.includes(p61)) return p61;
    const sec = n.section_1961.trim().toUpperCase().replace(/\s+/g, '');
    if (sec.startsWith('194J') || p61 === '94J') return /technical|royalty|call cent/i.test(n.nature) || n.rate_bp === 200 ? '4JA' : '4JB';
    if (sec === '194I' || p61 === '94I') return /plant|machinery|equipment/i.test(n.nature) ? '4IA' : '4IB';
    return SECTION_26Q_BY_1961[sec] ?? '';
  }
  if (form === '140') {
    if (SECTION_CODES_140.includes(p25)) return p25;
    if (/contract/i.test(n.nature)) return n.deductee_type.startsWith('Individual/HUF') ? '1023' : '1024';
    return NAME_CODES_140.find(([re]) => re.test(n.nature))?.[1] ?? '';
  }
  if (form === '27EQ') {
    if (COLLECTION_CODES_27EQ.includes(p61)) return p61;
    return NAME_CODES_TCS.find(([re]) => re.test(n.nature))?.[1] ?? '';
  }
  if (COLLECTION_CODES_143.includes(p25)) return p25;
  return NAME_CODES_TCS.find(([re]) => re.test(n.nature))?.[2] ?? '';
}

export function collecteeCode(deducteeType: string, pan: string): string {
  if (deducteeType.startsWith('Company')) return '1';
  if (deducteeType.startsWith('Individual/HUF')) return pan.charAt(3) === 'H' ? '3' : '2';
  if (deducteeType.startsWith('Association')) return '4';
  if (deducteeType.startsWith('Co-Operative')) return '6';
  if (deducteeType.startsWith('Partnership')) return '7';
  if (deducteeType.startsWith('Body of Individuals')) return '8';
  if (deducteeType.startsWith('Artificial')) return '9';
  return '10';
}

export const money = (paise: number) => `${Math.floor(Math.max(0, paise) / 100)}.${String(Math.max(0, paise) % 100).padStart(2, '0')}`;
export const ddmmyyyy = (iso: string) => (iso ? `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}` : '');
const rate4 = (bp: number) => `${String(Math.floor(bp / 100)).padStart(2, '0')}.${String(bp % 100).padStart(2, '0')}00`;
const text = (s: string, max: number) => s.replace(/[\^\r\n]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);
const digits = (s: string) => s.replace(/\D/g, '');

function addressLines(addr: string): string[] {
  const parts = addr.split(/[\n,]+/).map((x) => text(x, 200)).filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    let rest = p;
    while (rest) {
      if (out.length === 5) break;
      if (rest.length <= 25) {
        out.push(rest);
        break;
      }
      const cut = rest.lastIndexOf(' ', 25) > 0 ? rest.lastIndexOf(' ', 25) : 25;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
  }
  while (out.length < 5) out.push('');
  return out;
}

export interface EtdsDeductee {
  challan: number;
  party: string;
  pan: string;
  deductee_type: string;
  section_code: string;
  date: string;
  gross: number;
  tax: number;
  surcharge: number;
  cess: number;
  total: number;
  deposited: number;
  rate_bp: number;
  remark: string;
  certificate: string;
  resident: string;
}

export interface EtdsChallan {
  id: number;
  bsr_code: string;
  challan_no: string;
  challan_date: string;
  tax: number;
  interest: number;
  fee: number;
  others: number;
  total: number;
  deductees: EtdsDeductee[];
}

export interface EtdsStatement {
  form: string;
  kind: TaxKind;
  act: string;
  quarter: number;
  from: string;
  to: string;
  layout: string;
  fvu: string;
  file_name: string;
  text: string;
  challans: EtdsChallan[];
  errors: string[];
  warnings: string[];
}

export const ETDS_LAYOUTS: Record<string, { layout: string; fvu: string }> = {
  '26Q': { layout: 'Form 26Q regular file format version 7.8 (Protean, 27 May 2025)', fvu: '9.5' },
  '27EQ': { layout: 'Form 27EQ regular file format version 6.9 (Protean, 27 May 2025)', fvu: '9.5' },
  '140': { layout: 'Form 140 (26Q) file format, Q1 to Q4, tax year 2026-27 onwards (Protean, 22 July 2026)', fvu: '1.2' },
  '143': { layout: 'Form 143 (27EQ) file format, Q1 to Q4, tax year 2026-27 onwards (Protean, 22 July 2026)', fvu: '1.2' },
};

export function etdsForm(kind: TaxKind, quarterFrom: string, legacy = false): string {
  const newAct = actOn(quarterFrom) === '2025' && !legacy;
  return kind === 'TCS' ? (newAct ? '143' : '27EQ') : newAct ? '140' : '26Q';
}

async function loadChallans(db: Db, kind: TaxKind, from: string, to: string): Promise<{ challans: EtdsChallan[]; undeposited: number }> {
  const chs = await db.select<{ id: number; bsr_code: string; challan_no: string; challan_date: string; date: string; amount: number; interest: number; fee: number; others: number }>(
    `SELECT c.id, c.bsr_code, c.challan_no, c.challan_date, c.date, c.amount, c.interest, c.fee, c.others FROM tds_challans c
     WHERE c.kind = ? AND (c.quarter_from = ? OR EXISTS (SELECT 1 FROM tds_challan_lines cl JOIN tds_deductions d ON d.id = cl.deduction_id WHERE cl.challan_id = c.id AND d.date >= ? AND d.date <= ?))
     ORDER BY COALESCE(NULLIF(c.challan_date, ''), c.date), c.id`,
    [kind, from, from, to]
  );
  const lines = await db.select<{
    challan_id: number; amount: number; party: string; pan: string; deductee_type: string; resident: string; date: string; gross: number; tax: number; surcharge: number; cess: number;
    total: number; rate_bp: number; nature: string; section: string; payment_code: string; nature_id: number; party_id: number; voucher_id: number;
  }>(
    `SELECT cl.challan_id, cl.amount, p.name AS party, d.pan, d.deductee_type, d.resident, d.date, d.gross, d.tax, d.surcharge, d.cess, d.total, d.rate_bp,
            n.name AS nature, n.section, n.payment_code, d.nature_id, d.party_id, d.voucher_id
     FROM tds_challan_lines cl JOIN tds_deductions d ON d.id = cl.deduction_id JOIN ledgers p ON p.id = d.party_id JOIN tds_nature n ON n.id = d.nature_id
     JOIN vouchers v ON v.id = d.voucher_id AND v.cancelled = 0
     WHERE d.kind = ? AND d.date >= ? AND d.date <= ? ORDER BY d.date, d.id`,
    [kind, from, to]
  );
  const versions = await db.select<{ nature_id: number; effective_from: string; payment_code: string }>('SELECT nature_id, effective_from, payment_code FROM tds_nature_versions ORDER BY effective_from');
  const parties = new Map((await db.select<{ ledger_id: number; deduct_lower: number; lower_rate_bp: number; lower_certificate: string }>('SELECT ledger_id, deduct_lower, lower_rate_bp, lower_certificate FROM tds_party')).map((p) => [p.ledger_id, p]));
  const undeposited = (await one<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM tds_deductions d JOIN vouchers v ON v.id = d.voucher_id AND v.cancelled = 0
     WHERE d.kind = ? AND d.date >= ? AND d.date <= ? AND d.total > COALESCE((SELECT SUM(cl.amount) FROM tds_challan_lines cl WHERE cl.deduction_id = d.id), 0)`,
    [kind, from, to]
  ))!.c;
  const form = etdsForm(kind, from);
  const out = chs.map((c) => ({
    id: c.id, bsr_code: c.bsr_code, challan_no: c.challan_no, challan_date: c.challan_date || c.date, tax: c.amount, interest: c.interest, fee: c.fee, others: c.others,
    total: c.amount + c.interest + c.fee + c.others, deductees: [] as EtdsDeductee[],
  }));
  const byId = new Map(out.map((c) => [c.id, c]));
  for (const l of lines) {
    const ch = byId.get(l.challan_id);
    if (!ch) continue;
    const f = l.total ? l.amount / l.total : 1;
    const part = (v: number) => (f === 1 ? v : Math.round(v * f));
    const sur = part(l.surcharge);
    const cess = part(l.cess);
    const ver = versions.filter((v) => v.nature_id === l.nature_id && v.effective_from <= l.date).pop();
    const pan = /^[A-Z]{5}\d{4}[A-Z]$/.test(l.pan) ? l.pan : '';
    const tp = parties.get(l.party_id);
    const lower = !!tp?.deduct_lower && !!tp.lower_certificate && tp.lower_rate_bp === l.rate_bp && !!pan;
    ch.deductees.push({
      challan: ch.id,
      party: l.party,
      pan,
      deductee_type: l.deductee_type,
      section_code: returnSectionCode(form, { nature: l.nature, section_1961: l.section, payment_code_1961: l.payment_code, payment_code_2025: ver?.payment_code ?? '', rate_bp: l.rate_bp, deductee_type: l.deductee_type }),
      date: l.date,
      gross: part(l.gross),
      tax: l.amount - sur - cess,
      surcharge: sur,
      cess,
      total: l.amount,
      deposited: l.amount,
      rate_bp: l.rate_bp,
      remark: lower ? 'A' : pan ? '' : 'C',
      certificate: lower ? tp!.lower_certificate : '',
      resident: l.resident,
    });
  }
  return { challans: out, undeposited };
}

export async function etdsStatement(db: Db, kind: TaxKind, quarterDate: string, opts: { legacy?: boolean; created?: string } = {}): Promise<EtdsStatement> {
  const q = quarterOf(quarterDate);
  const form = etdsForm(kind, q.from, opts.legacy);
  const isNew = form === '140' || form === '143';
  const tds = form === '26Q' || form === '140';
  const co = await tdsCompany(db);
  const company = (await one<{ name: string; address: string; state: string; pincode: string; phone: string; email: string; pan: string; gstin: string }>(db, 'SELECT name, address, state, pincode, phone, email, pan, gstin FROM company WHERE id = 1')) ?? {
    name: '', address: '', state: '', pincode: '', phone: '', email: '', pan: '', gstin: '',
  };
  const { challans, undeposited } = await loadChallans(db, kind, q.from, q.to);
  const errors: string[] = [];
  const warnings: string[] = [];
  const fyStart = Number(q.from.slice(0, 4)) - (q.q === 4 ? 1 : 0);
  const fyCode = `${fyStart}${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const ayCode = `${fyStart + 1}${String((fyStart + 2) % 100).padStart(2, '0')}`;
  const tan = co.tan.toUpperCase();
  const dPan = (co.deductor_pan || company.pan).toUpperCase();
  const cat = deductorCategory(co.deductor_type);
  const dState = etdsStateCode(company.state);
  const rState = etdsStateCode(co.person_state || company.state);
  const dPin = digits(company.pincode);
  const rPin = digits(co.person_pincode || company.pincode);
  const dAddr = addressLines(company.address);
  const rAddr = addressLines(co.person_address || company.address);
  const dPhone = digits(company.phone).slice(-10);
  const rMobile = digits(co.person_mobile).slice(-10);
  const dEmail = company.email.trim().toUpperCase();
  const rEmail = (co.person_email || company.email).trim().toUpperCase();
  const rPan = co.person_pan.toUpperCase();
  if (!/^[A-Z]{4}\d{5}[A-Z]$/.test(tan)) errors.push('TAN is not specified or invalid (Company TDS Deductor Details)');
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(dPan) && dPan !== 'PANNOTREQD') errors.push('PAN of the deductor is not specified (Company PAN or Deductor PAN)');
  if (!cat) errors.push(`Deductor type "${co.deductor_type}" cannot be mapped to a deductor category`);
  if (!text(company.name, 75)) errors.push('Name of the deductor is missing');
  if (!dAddr[0]) errors.push('Deductor address is missing');
  if (!dState) errors.push(`State "${company.state}" has no e-TDS state code`);
  if (!/^\d{6}$/.test(dPin)) errors.push('Deductor PIN code must be 6 digits');
  if (!dEmail && !rEmail) errors.push('E-mail of the deductor or the person responsible is required');
  if (!text(co.person_name, 75)) errors.push('Name of the person responsible is missing');
  if (!text(co.person_designation, 20)) errors.push('Designation of the person responsible is missing');
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(rPan)) errors.push('PAN of the person responsible is missing or invalid');
  if (!/^\d{10}$/.test(rMobile)) errors.push('Mobile number of the person responsible must be 10 digits');
  if (isNew && !/^\d{6,10}$/.test(dPhone || rMobile)) errors.push('Contact number of the deductor is required');
  if (!rState) errors.push('State of the person responsible has no e-TDS state code');
  if (!/^\d{6}$/.test(rPin)) errors.push('PIN code of the person responsible must be 6 digits');
  for (const c of challans) {
    if (!/^\d{7}$/.test(c.bsr_code)) errors.push(`Challan dated ${c.challan_date}: BSR code must be 7 digits (reconcile the challan)`);
    if (!/^\d{1,5}$/.test(c.challan_no)) errors.push(`Challan dated ${c.challan_date}: challan serial number must be up to 5 digits (reconcile the challan)`);
    for (const d of c.deductees) if (!d.section_code) errors.push(`${d.party}: no ${form} section code for the nature of payment`);
  }
  if (!challans.some((c) => c.deductees.length)) errors.push(`No deposited ${kind} for the quarter. A regular statement needs at least one deductee record`);
  if (undeposited) warnings.push(`${undeposited} deduction(s) in the quarter are not yet deposited and are not included`);

  const earlier = (await statementFilings(db, kind)).filter((f) => f.quarter_from < q.from && f.token_no && f.form === form).pop();
  const lines: string[][] = [];
  const fh = ['FH', tds ? 'NS1' : 'TC1', 'R', ddmmyyyy(opts.created ?? new Date().toISOString().slice(0, 10)), '1', 'D', tan, '1', 'TallyBook', '', '', '', '', '', '', '', ''];
  lines.push(fh);
  const batchTotal = challans.reduce((s, c) => s + c.total, 0);
  const bh: string[] = new Array(71).fill('');
  const set = (n: number, v: string) => (bh[n - 2] = v);
  set(2, 'BH');
  set(3, '1');
  set(4, String(challans.length));
  set(5, form);
  set(9, earlier ? earlier.token_no : '');
  set(13, tan);
  set(15, dPan || 'PANNOTREQD');
  set(16, ayCode);
  set(17, fyCode);
  set(18, `Q${q.q}`);
  set(19, text(company.name, 75));
  if (isNew) {
    set(20, 'INDIA');
    dAddr.forEach((a, i) => set(21 + i, a.slice(0, 25)));
  } else {
    set(20, text(co.deductor_branch, 75) || 'NA');
    dAddr.forEach((a, i) => set(21 + i, a.slice(0, 25)));
  }
  set(26, dState);
  set(27, dPin);
  set(28, dEmail);
  if (isNew) {
    set(29, '91');
    set(30, dPhone || rMobile);
  } else {
    set(31, 'N');
  }
  set(32, cat);
  set(33, text(co.person_name, 75));
  set(34, text(co.person_designation, 20));
  rAddr.forEach((a, i) => set(35 + i, a.slice(0, 25)));
  set(40, rState);
  set(41, rPin);
  set(42, rEmail);
  if (isNew) {
    set(43, 'INDIA');
    set(44, '91');
    set(45, rMobile);
  } else {
    set(43, rMobile);
    set(46, 'N');
  }
  set(47, money(batchTotal));
  if (!isNew) set(51, 'N');
  set(52, earlier ? 'Y' : 'N');
  if (['S', 'E', 'H', 'N'].includes(cat)) set(54, co.gov_state || dState);
  if (!isNew && ['A', 'S', 'D', 'E', 'G', 'H', 'L', 'N'].includes(cat)) {
    set(55, text(co.pao_code, 20));
    set(56, text(co.ddo_code, 20));
  }
  if (['A', 'D', 'G', 'E', 'H', 'L', 'N'].includes(cat)) set(57, text(co.gov_ministry, 3));
  set(59, rPan);
  if (['A', 'S'].includes(cat)) set(68, text(co.ain, 7));
  if (/^[0-9A-Z]{15}$/.test(company.gstin ?? '')) set(69, company.gstin);
  lines.push(bh);

  challans.forEach((c, ci) => {
    const cdNo = String(ci + 1);
    const nil = c.tax + c.interest + c.fee + c.others === 0;
    const sum = (k: 'tax' | 'surcharge' | 'cess' | 'total' | 'deposited') => c.deductees.reduce((s, d) => s + d[k], 0);
    if (isNew) {
      lines.push([
        'CD', '1', cdNo, String(c.deductees.length), nil ? 'Y' : 'N', '', money(c.tax), money(c.interest), money(c.fee), money(c.others), money(c.total), nil ? '' : 'C', '',
        nil ? '' : c.bsr_code, '', nil ? '' : c.challan_no.padStart(5, '0'), '', ddmmyyyy(nil ? q.to : c.challan_date), '', money(sum('deposited')), money(sum('total')), nil ? '' : '200',
        money(c.interest), money(c.others), '', '', '', '', '',
      ]);
    } else {
      const sur = sum('surcharge');
      const cess = sum('cess');
      const it = Math.max(0, c.tax - sur - cess);
      lines.push([
        'CD', '1', cdNo, String(c.deductees.length), nil ? 'Y' : 'N', '', '', '', '', '', nil ? '' : c.challan_no.padStart(5, '0'), '', '', '', nil ? '' : c.bsr_code, '',
        ddmmyyyy(nil ? q.to : c.challan_date), '', '', '', money(it), money(sur), money(cess), money(c.interest), money(c.others), money(c.total), '', money(sum('deposited')),
        money(sum('tax')), money(sur), money(cess), money(sum('total')), money(c.interest), money(c.others), '', nil ? '' : 'N', '', money(c.fee), nil ? '' : '200', '',
      ]);
    }
    c.deductees.forEach((d, di) => {
      const pan = d.pan || 'PANNOTAVBL';
      const name = text(d.party, 75);
      const nr = d.resident === 'NonResident';
      if (form === '26Q') {
        const r = new Array(53).fill('');
        const s = (n: number, v: string) => (r[n - 2] = v);
        s(2, 'DD'); s(3, '1'); s(4, cdNo); s(5, String(di + 1)); s(6, 'O'); s(8, isCompanyType(d.deductee_type) ? '1' : '2'); s(10, pan); s(13, name);
        s(14, money(d.tax)); s(15, money(d.surcharge)); s(16, money(d.cess)); s(17, money(d.total)); s(19, money(d.deposited)); s(22, money(d.gross)); s(23, ddmmyyyy(d.date));
        s(24, ddmmyyyy(d.date)); s(26, rate4(d.rate_bp)); s(30, d.remark); s(33, d.section_code); s(34, d.certificate);
        lines.push(r);
      } else if (form === '27EQ') {
        const r = new Array(53).fill('');
        const s = (n: number, v: string) => (r[n - 2] = v);
        s(2, 'DD'); s(3, '1'); s(4, cdNo); s(5, String(di + 1)); s(6, 'O'); s(8, collecteeCode(d.deductee_type, pan)); s(10, pan); s(13, name);
        s(14, money(d.tax)); s(15, money(d.surcharge)); s(16, money(d.cess)); s(17, money(d.total)); s(19, money(d.deposited)); s(21, money(d.gross)); s(22, money(d.gross));
        s(23, ddmmyyyy(d.date)); s(24, ddmmyyyy(d.date)); s(26, rate4(d.rate_bp)); s(30, d.remark); s(31, nr ? 'Y' : 'N'); s(32, nr ? 'N' : ''); s(33, d.section_code); s(34, d.certificate);
        s(49, 'N');
        lines.push(r);
      } else if (form === '140') {
        const r = new Array(44).fill('');
        const s = (n: number, v: string) => (r[n - 2] = v);
        s(2, 'DD'); s(3, '1'); s(4, String(di + 1)); s(5, cdNo); s(6, 'O'); s(8, pan); s(9, name); s(15, d.section_code); s(18, 'Y'); s(19, ddmmyyyy(d.date));
        s(20, money(d.gross)); s(24, money(d.total)); s(25, money(d.deposited)); s(27, ddmmyyyy(d.date)); s(28, rate4(d.rate_bp)); s(32, d.remark); s(33, d.certificate);
        lines.push(r);
      } else {
        const r = new Array(44).fill('');
        const s = (n: number, v: string) => (r[n - 2] = v);
        s(2, 'DD'); s(3, '1'); s(4, String(di + 1)); s(5, cdNo); s(6, 'O'); s(8, pan); s(9, name); s(11, nr ? 'Y' : 'N'); s(12, collecteeCode(d.deductee_type, pan));
        s(13, nr ? 'N' : ''); s(14, 'N'); s(15, d.section_code); s(18, 'Y'); s(19, ddmmyyyy(d.date)); s(20, money(d.gross)); s(24, money(d.total)); s(25, money(d.deposited));
        s(27, ddmmyyyy(d.date)); s(28, rate4(d.rate_bp)); s(32, d.remark); s(33, d.certificate);
        lines.push(r);
      }
    });
  });
  const body = lines.map((l, i) => [String(i + 1), ...l].join('^')).join('\r\n') + '\r\n';
  const meta = ETDS_LAYOUTS[form];
  return {
    form, kind, act: actOn(q.from), quarter: q.q, from: q.from, to: q.to, layout: meta.layout, fvu: meta.fvu,
    file_name: `${tan || 'TAN'}_${form}_Q${q.q}_${fyCode}.txt`, text: body, challans, errors, warnings,
  };
}
