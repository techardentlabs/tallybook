import { STOCK_VOUCHER_TYPES, VOUCHER_TYPES } from './schema.ts';

export type FacilityKind = 'Masters' | 'Vouchers' | 'Reports' | 'Banking' | 'Statutory' | 'Utilities' | 'Company';

export interface FacilityDef {
  name: string;
  kind: FacilityKind;
}

const def = (kind: FacilityKind, names: string[]): FacilityDef[] => names.map((name) => ({ name, kind }));

export const FACILITY_DEFS: FacilityDef[] = [
  ...def('Masters', ['Accounts Masters', 'Inventory Masters', 'Payroll Masters', 'Statutory Masters', 'Budgets', 'Price List', 'Override Invoice Defaults', 'Alter Voucher Bank Allocations']),
  ...def('Vouchers', ['Vouchers', 'Accounting Vouchers', 'Inventory Vouchers', 'Order Vouchers', 'Payroll Vouchers', 'Attendance Vouchers', 'Back Dated Vouchers', 'Optional Vouchers', 'Post-Dated Vouchers']),
  ...def('Reports', [
    'Balance Sheet',
    'Profit & Loss A/c',
    'Trial Balance',
    'Day Book',
    'Cash/Bank Books',
    'Ledger',
    'Group Summary',
    'Group Monthly Summary',
    'Sales Register',
    'Purchase Register',
    'Journal Register',
    'Payment Register',
    'Receipt Register',
    'Contra Register',
    'Credit Note Register',
    'Debit Note Register',
    'Outstandings',
    'Interest Calculations',
    'Cost Centre Details',
    'Cash Flow',
    'Funds Flow',
    'Ratio Analysis',
    'Statistics',
    'Forex Gain/Loss',
    'Exception Reports',
    'Data Analysis',
    'Voucher Verification',
    'Vouching Done',
    'Audit Listings',
    'Edit Log',
    'Dashboard',
    'Stock Summary',
    'Stock Category Summary',
    'Location-Wise Summary',
    'Stock Query',
    'Movement Analysis',
    'Stock Ageing Analysis',
    'Reorder Status',
    'Batch Summary',
    'Order Outstandings',
    'Bills Pending',
    'Cost Estimation',
    'Job Costing',
    'Material Requirement',
  ]),
  ...def('Statutory', ['GST Reports', 'TDS Reports', 'TCS Reports', 'Payroll Reports']),
  ...def('Banking', ['Bank Reconciliation', 'Cheque Printing', 'Cheque Register', 'Deposit Slip', 'Payment Advice', 'Post-Dated Summary', 'e-Payments']),
  ...def('Utilities', ['Backup', 'Restore', 'Import', 'Export', 'Split Company Data', 'Repair', 'Data Synchronisation', 'E-Mail', 'WhatsApp', 'Upload', 'Print']),
  ...def('Company', ['Company Alteration', 'Company Features', 'Configuration', 'Security Control']),
];

export const SECURITY_FACILITIES: readonly string[] = [...FACILITY_DEFS.map((f) => f.name)].sort((a, b) => a.localeCompare(b));

export const PREDEFINED_VOUCHER_TYPES: readonly string[] = [
  ...VOUCHER_TYPES.map(([n]) => n),
  'Memorandum',
  'Reversing Journal',
  ...STOCK_VOUCHER_TYPES,
  'Payroll',
  'Attendance',
];

const KIND = new Map(FACILITY_DEFS.map((f) => [f.name, f.kind]));

export function facilityKind(name: string): FacilityKind | 'Voucher Types' | null {
  return KIND.get(name) ?? (PREDEFINED_VOUCHER_TYPES.includes(name) ? 'Voucher Types' : null);
}

const ORDER_TYPES = new Set<string>(['Sales Order', 'Purchase Order', 'Job Work Out Order', 'Job Work In Order']);
const INVENTORY_TYPES = new Set<string>((STOCK_VOUCHER_TYPES as readonly string[]).filter((t) => !ORDER_TYPES.has(t)));

export function voucherGroupOf(parent: string): string {
  if (ORDER_TYPES.has(parent)) return 'Order Vouchers';
  if (INVENTORY_TYPES.has(parent)) return 'Inventory Vouchers';
  if (parent === 'Attendance') return 'Attendance Vouchers';
  if (parent === 'Payroll') return 'Payroll Vouchers';
  return 'Accounting Vouchers';
}

const GROUP_PARENT: Record<string, string> = {
  'Accounting Vouchers': 'Vouchers',
  'Inventory Vouchers': 'Vouchers',
  'Order Vouchers': 'Vouchers',
  'Payroll Vouchers': 'Vouchers',
  'Attendance Vouchers': 'Payroll Vouchers',
};

function groupChain(group: string): string[] {
  const out = [group];
  let g = group;
  while (GROUP_PARENT[g]) {
    g = GROUP_PARENT[g];
    out.unshift(g);
  }
  return out;
}

export function voucherFacilities(typeName: string, parent?: string): string[] {
  const p = parent ?? (PREDEFINED_VOUCHER_TYPES.includes(typeName) ? typeName : undefined);
  const chain = groupChain(voucherGroupOf(p ?? typeName));
  if (p && p !== typeName && !chain.includes(p)) chain.push(p);
  if (!chain.includes(typeName)) chain.push(typeName);
  return chain;
}

export function facilityChain(facility: string): string[] {
  if (GROUP_PARENT[facility] || facility === 'Vouchers') return groupChain(facility);
  if (PREDEFINED_VOUCHER_TYPES.includes(facility)) return voucherFacilities(facility);
  return [facility];
}

export function baseFacilityOf(facility: string): string {
  const chain = facilityChain(facility);
  return chain.length > 1 && !KIND.has(facility) ? chain[chain.length - 2] : facility;
}

export type ScreenRight = 'display' | 'preview' | 'print' | 'create' | 'alter' | 'delete';
export type ScreenAction = `${string}.${ScreenRight}`;

const REPORT_TITLES: Record<string, string> = {
  'Balance Sheet': 'Balance Sheet',
  'Profit & Loss A/c': 'Profit & Loss A/c',
  'Trial Balance': 'Trial Balance',
  'Day Book': 'Day Book',
  'Cash/Bank Book': 'Cash/Bank Books',
  'Cash/Bank Books': 'Cash/Bank Books',
  Ledger: 'Ledger',
  'Ledger Vouchers': 'Ledger',
  'Group Summary': 'Group Summary',
  'Group Vouchers': 'Group Summary',
  'Group Monthly Summary': 'Group Monthly Summary',
  'Ledger Monthly Summary': 'Group Monthly Summary',
  'Ledger Outstandings: Receivables': 'Outstandings',
  'Ledger Outstandings: Payables': 'Outstandings',
  'Bills Receivable': 'Outstandings',
  'Bills Payable': 'Outstandings',
  'Receivables Outstandings': 'Outstandings',
  'Payables Outstandings': 'Outstandings',
  Outstandings: 'Outstandings',
  'Group Interest Calculations': 'Interest Calculations',
  'Group Interest Calculation': 'Interest Calculations',
  'Ledger Interest Calculation': 'Interest Calculations',
  'Ledger Interest Calculations': 'Interest Calculations',
  'Budget Variance': 'Budgets',
  'Cost Centre Budget Variance': 'Budgets',
  'Cost Centre Summary': 'Cost Centre Details',
  'Cost Category Summary': 'Cost Centre Details',
  'Cost Centre Monthly Summary': 'Cost Centre Details',
  'Cost Centre Vouchers': 'Cost Centre Details',
  'Cost Centre Breakup': 'Cost Centre Details',
  'Cash Flow': 'Cash Flow',
  'Funds Flow': 'Funds Flow',
  'Ratio Analysis': 'Ratio Analysis',
  Statistics: 'Statistics',
  'Forex Gain/Loss': 'Forex Gain/Loss',
  'Exception Reports': 'Exception Reports',
  'Negative Stock': 'Exception Reports',
  'Negative Ledgers': 'Exception Reports',
  'Memorandum Register': 'Exception Reports',
  'Reversing Journals': 'Exception Reports',
  'Optional Vouchers': 'Optional Vouchers',
  'Top Buyers / Sellers': 'Data Analysis',
  'Edit Log': 'Edit Log',
  'Audit Listings': 'Audit Listings',
  Dashboard: 'Dashboard',
  'Stock Summary': 'Stock Summary',
  'Stock Item Vouchers': 'Stock Summary',
  'Stock Item Monthly Summary': 'Stock Summary',
  'Stock Group Summary': 'Stock Summary',
  'Stock Category Summary': 'Stock Category Summary',
  'Godown Summary': 'Location-Wise Summary',
  'Godown Monthly Summary': 'Location-Wise Summary',
  'Godown Vouchers': 'Location-Wise Summary',
  'Godown Transfers': 'Location-Wise Summary',
  'Stock Query': 'Stock Query',
  'Item Movement Analysis': 'Movement Analysis',
  'Item Voucher Analysis': 'Movement Analysis',
  'Item Inwards Details': 'Movement Analysis',
  'Stock Group Movement Analysis': 'Movement Analysis',
  'Stock Category Movement Analysis': 'Movement Analysis',
  'Group Analysis': 'Movement Analysis',
  'Ledger Analysis': 'Movement Analysis',
  'Stock Transfer Analysis': 'Movement Analysis',
  'Movement Analysis': 'Movement Analysis',
  'Stock Ageing Analysis': 'Stock Ageing Analysis',
  'Reorder Status': 'Reorder Status',
  'Stock Group Reorder Status': 'Reorder Status',
  'Batch Summary': 'Batch Summary',
  'Order Details': 'Order Outstandings',
  'Sales Orders (Due Only)': 'Order Outstandings',
  'Purchase Orders (Due Only)': 'Order Outstandings',
  'Sales Bills Pending': 'Bills Pending',
  'Purchase Bills Pending': 'Bills Pending',
  'Price List': 'Price List',
  'Price List (Stock Group)': 'Price List',
  'Price List (Stock Category)': 'Price List',
  'Cost Estimation': 'Cost Estimation',
  'Item Estimates': 'Cost Estimation',
  'Job Costing': 'Job Costing',
  'Material Requirement': 'Material Requirement',
  'GSTR-1': 'GST Reports',
  'GSTR-1 Summary': 'GST Reports',
  'GSTR-3B': 'GST Reports',
  'GSTR-2B Reconciliation': 'GST Reports',
  'HSN/SAC Summary': 'GST Reports',
  'Tax Analysis': 'GST Reports',
  'e-Invoice': 'GST Reports',
  'e-Invoice - Voucher Register': 'GST Reports',
  'e-Way Bill': 'GST Reports',
  'TDS Outstandings': 'TDS Reports',
  'TDS Challan Reconciliation': 'TDS Reports',
  'Challan Reconciliation': 'TDS Reports',
  'Form 26Q': 'TDS Reports',
  'Form 140': 'TDS Reports',
  'TDS Payment': 'TDS Reports',
  'TCS Outstandings': 'TCS Reports',
  'Pay Slip': 'Payroll Reports',
  'Payroll Statement': 'Payroll Reports',
  'Attendance Sheet': 'Payroll Reports',
  'Employee Vouchers': 'Payroll Reports',
  'Income Tax Computation': 'Payroll Reports',
  'Gratuity Report': 'Payroll Reports',
  'Bank Reconciliation': 'Bank Reconciliation',
  'Bank Reconciliation - Reconciled': 'Bank Reconciliation',
  'Bank Reconciliation (Manual)': 'Bank Reconciliation',
  'Bank Reconciliation Summary': 'Bank Reconciliation',
  'Reconciled Transactions - Monthly Summary': 'Bank Reconciliation',
  'Opening BRS': 'Bank Reconciliation',
  'Import Bank Statement': 'Bank Reconciliation',
  'Imported Bank Data': 'Bank Reconciliation',
  'Banking Activities': 'Bank Reconciliation',
  'Cheque Printing': 'Cheque Printing',
  'Sample Cheque Printing': 'Cheque Printing',
  'Cheque Printing Print': 'Cheque Printing',
  'Cheque Register': 'Cheque Register',
  'Cheque Range Register': 'Cheque Register',
  'Deposit Slip': 'Deposit Slip',
  'Payment Advice': 'Payment Advice',
  'Post-Dated Transactions': 'Post-Dated Summary',
  'Post-Dated Transactions Monthly Summary': 'Post-Dated Summary',
  'Post-Dated Summary': 'Post-Dated Summary',
  'e-Payments': 'e-Payments',
};

const EXACT: Record<string, ScreenAction> = {
  'Accounting Voucher Creation': 'Accounting Vouchers.create',
  'Inventory Voucher Creation': 'Inventory Vouchers.create',
  'Order Voucher Creation': 'Order Vouchers.create',
  'Payroll Voucher Creation': 'Payroll Vouchers.create',
  'Payroll Voucher Alteration': 'Payroll Vouchers.alter',
  'Attendance Voucher Creation': 'Attendance Vouchers.create',
  'Voucher Alteration': 'Vouchers.alter',
  'Chart of Accounts': 'Accounts Masters.display',
  'List of Currencies': 'Accounts Masters.display',
  'Multi-Currency Alteration': 'Accounts Masters.alter',
  'Forex Rate of Exchange': 'Accounts Masters.alter',
  'Rate of Exchange': 'Accounts Masters.alter',
  'Voucher Type Class': 'Accounts Masters.alter',
  'Interest Parameters': 'Accounts Masters.alter',
  'Revise Price': 'Inventory Masters.alter',
  'Revise Price Types': 'Inventory Masters.alter',
  'Stock Item Components (BOM)': 'Inventory Masters.alter',
  'Stock Item Multi Components (M BOM)': 'Inventory Masters.alter',
  'Bill of Materials': 'Inventory Masters.alter',
  'Stock Ageing Alteration': 'Stock Ageing Analysis.display',
  'Cheque Printing Configuration': 'Cheque Printing.alter',
  'Cheque Book Management': 'Cheque Register.alter',
  'Bank Configuration': 'Accounts Masters.alter',
  'Salary Details Alteration': 'Payroll Masters.alter',
  'Salary Details': 'Payroll Masters.alter',
  'Income Tax Declarations': 'Payroll Masters.alter',
  'Income Tax Slabs': 'Payroll Masters.alter',
  'TDS Nature of Payments': 'Statutory Masters.alter',
  'TCS Nature of Goods': 'Statutory Masters.alter',
  'Nature of Payment': 'Statutory Masters.alter',
  'Company Alteration': 'Company Alteration.alter',
  'Company Info.': 'Company Alteration.display',
  TallyVault: 'Company Alteration.alter',
  'Change TallyVault': 'Company Alteration.alter',
  'TDS Deductor Details': 'Company Alteration.alter',
  'Company Features': 'Company Features.alter',
  'Company Security': 'Security Control.alter',
  'Users and Passwords': 'Security Control.alter',
  'List of Users for Company': 'Security Control.alter',
  'User Roles': 'Security Control.alter',
  'Security Levels': 'Security Control.alter',
  'List of Security Levels': 'Security Control.alter',
  'Password Policy': 'Security Control.alter',
  'Security Control': 'Security Control.display',
  Backup: 'Backup.create',
  Restore: 'Restore.create',
  Import: 'Import.create',
  'Import Data': 'Import.create',
  'Import Exceptions': 'Import.create',
  'Sample Excel File': 'Import.create',
  'List of Mapping Templates': 'Import.create',
  'Export Data': 'Export.create',
  Export: 'Export.create',
  'Export Configuration': 'Export.create',
  Split: 'Split Company Data.create',
  'Split Company Data': 'Split Company Data.create',
  Repair: 'Repair.create',
  'Data Synchronisation': 'Data Synchronisation.create',
};

const PRINT_LIKE: Record<string, { right: ScreenRight; utility?: string }> = {
  Print: { right: 'print', utility: 'Print' },
  'Printer Settings': { right: 'print', utility: 'Print' },
  Preview: { right: 'preview' },
  Share: { right: 'print' },
  'E-mail': { right: 'print', utility: 'E-Mail' },
  'E-Mail': { right: 'print', utility: 'E-Mail' },
  WhatsApp: { right: 'print', utility: 'WhatsApp' },
  Upload: { right: 'print', utility: 'Upload' },
};

export function isPrintLikeTitle(title: string): boolean {
  return title in PRINT_LIKE;
}

const INVENTORY_OBJECTS = ['Stock Item', 'Stock Group', 'Stock Category', 'Unit', 'Godown', 'Location', 'Price Level', 'Batch', 'Bill of Materials', 'Stock Items', 'Stock Groups', 'Stock Categories', 'Units', 'Godowns'];
const PAYROLL_OBJECTS = ['Employee', 'Employee Group', 'Employee Category', 'Attendance/Production Type', 'Attendance Type', 'Pay Head', 'Salary Details', 'Income Tax Declarations', 'Income Tax Slabs', 'Employees', 'Employee Groups', 'Employee Categories', 'Pay Heads'];
const STATUTORY_OBJECTS = ['TDS Nature of Payments', 'TCS Nature of Goods', 'Nature of Payment', 'GST Classification', 'TDS Details'];

function masterFacility(object: string): string {
  if (object === 'Budget' || object === 'Budgets') return 'Budgets';
  if (object === 'Company') return 'Company Alteration';
  if (INVENTORY_OBJECTS.includes(object)) return 'Inventory Masters';
  if (PAYROLL_OBJECTS.includes(object)) return 'Payroll Masters';
  if (STATUTORY_OBJECTS.includes(object)) return 'Statutory Masters';
  return 'Accounts Masters';
}

function baseAction(title: string): ScreenAction | null {
  const t = title.trim();
  if (!t) return null;
  if (EXACT[t]) return EXACT[t];
  if (REPORT_TITLES[t]) return `${REPORT_TITLES[t]}.display`;
  const reg = /^(.+) Register$/.exec(t);
  if (reg && KIND.has(t)) return `${t}.display`;
  if (/^Cheque Register/.test(t)) return 'Cheque Register.display';
  if (/^Bank Reconciliation/.test(t)) return 'Bank Reconciliation.display';
  if (/^List of Unreconciled/.test(t)) return 'Bank Reconciliation.display';
  if (/^GSTR/.test(t)) return 'GST Reports.display';
  if (/^Company Creation$/.test(t)) return null;
  const cr = /^(.+) Creation$/.exec(t);
  if (cr) return `${masterFacility(cr[1])}.create`;
  const al = /^(.+) Alteration$/.exec(t);
  if (al) return `${masterFacility(al[1])}.alter`;
  if (/ Configuration$/.test(t)) return 'Configuration.display';
  if (KIND.has(t) && KIND.get(t) !== 'Vouchers' && KIND.get(t) !== 'Masters') return `${t}.display`;
  return null;
}

export function screenActions(title: string, below: string[] = []): ScreenAction[] | null {
  const p = PRINT_LIKE[title.trim()];
  if (p) {
    const out: ScreenAction[] = p.utility ? [`${p.utility}.display`] : [];
    for (const b of below) {
      if (PRINT_LIKE[b.trim()]) continue;
      const a = baseAction(b);
      if (a) out.push(`${a.slice(0, a.lastIndexOf('.'))}.${p.right}`);
      break;
    }
    return out.length ? out : null;
  }
  const a = baseAction(title);
  return a ? [a] : null;
}

export function menuActions(menuTitle: string, label: string): ScreenAction[] | null {
  const l = label.trim();
  if (!l) return null;
  if (menuTitle === 'Create' && l !== 'Company') return [`${masterFacility(l)}.create`];
  if (menuTitle === 'Alter' && l !== 'Company') {
    const exact = EXACT[l];
    return [exact ?? `${masterFacility(l)}.alter`];
  }
  if (menuTitle === 'Company') {
    if (l === 'Alter') return ['Company Alteration.alter'];
    if (l === 'Change TallyVault' || l === 'TDS Deductor Details') return ['Company Alteration.alter'];
  }
  if (/ Register$/.test(l) && KIND.has(l)) return [`${l}.display`];
  const a = baseAction(l);
  if (a) return [a];
  if (KIND.get(l) === 'Masters') return [`${l}.display`];
  return null;
}
