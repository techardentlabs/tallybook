import { useEffect, useState } from 'react';
import { fmtDate, todayIso, weekday } from '@tallybook/core';
import { MenuCard, useMenu, type MenuItem } from '../ui/Menu.tsx';
import { useScreen } from '../registry.ts';
import { useStore } from '../store.tsx';
import { useNav } from '../nav.tsx';
import { useDialogs } from '../ui/Dialogs.tsx';
import { GroupForm, LedgerForm, VoucherTypeForm } from './MasterForms.tsx';
import { PickGroup, PickLedger, PickVoucherType } from './Pickers.tsx';
import { ChartOfAccounts } from './Chart.tsx';
import { VoucherScreen } from './Voucher.tsx';
import { BalanceSheetReport, DayBookReport, GroupSummaryReport, LedgerReport, OutstandingsReport, ProfitLossReport } from './Reports.tsx';
import { Gstr1Report, Gstr3bReport } from './GstReports.tsx';
import { ExportScreen, ImportScreen } from './DataTransfer.tsx';
import { StockCategoryForm, GodownForm, PickStockItem, StockGroupForm, StockItemForm, StockSummaryReport, UnitForm } from './Inventory.tsx';
import { CashBankBookReport, CashFlowReport, FundsFlowReport, RatioAnalysisReport, RegisterReport, StatisticsReport } from './Reports2.tsx';
import {
  AttendanceSheetReport, AttendanceTypeAlterList, AttendanceTypeForm, EmployeeAlterList, EmployeeCategoryAlterList, EmployeeCategoryForm,
  EmployeeForm, EmployeeGroupAlterList, EmployeeGroupForm, EmployeeVouchersPicker, PayHeadAlterList, PayHeadForm, PayrollStatementReport,
  PaySlipPicker, SalaryDetailsList, IncomeTaxDeclarationList, IncomeTaxSlabsList, IncomeTaxComputationPicker, GratuityReport,
} from './PayrollImports.ts';
import { CostCategoryForm, CostCentreForm, AlterCostCentres, AlterCostCategories, CostCentreSummaryReport, CostCategorySummaryReport, CostCentreBreakupEntry, BudgetForm, AlterBudgets, BudgetVarianceEntry, GroupInterestEntry, LedgerInterestEntry } from './CostingImports.ts';
import { NatureOfPaymentList, TdsOutstandingsReport, TdsChallanReconciliationReport, Form26QReport, TdsPaymentScreen, EInvoiceReport, EWayBillReport, Gstr2bReconciliationReport, HsnSummaryReport, TaxAnalysisReport } from './StatutoryImports.ts';
import { ImportMenu } from './ImportExcel.tsx';
import { bankingMenu } from './Banking.tsx';
import { canCurrent, tdsCompany, type TdsCompany } from '@tallybook/core';
import { AlterCurrencies, CurrencyForm, ForexGainLossReport, MultiCurrencyAlteration } from './Currency.tsx';
import { StockQueryReport, GodownSummaryReport, ItemMovementReport, StockGroupMovementReport, GroupAnalysisReport, LedgerAnalysisReport, StockTransferAnalysisReport, StockAgeingReport, ReorderStatusReport, StockHierarchySummaryReport, OrderDetailsReport, OrderOutstandingsReport, BillsPendingReport, GodownTransfersReport, PriceLevelForm, PriceLevelsList, PriceListScreen, BatchSummaryReport } from './StockImports.ts';
import { quitApp } from '../quit.ts';
import { BomGateway, CostEstimationReport, JobCostingReport, MaterialRequirementReport } from './Manufacturing.tsx';

const PAYROLL_CREATE: Record<string, () => JSX.Element> = {
  'Employee Group': () => <EmployeeGroupForm />,
  'Employee Category': () => <EmployeeCategoryForm />,
  Employee: () => <EmployeeForm />,
  'Attendance/Production Type': () => <AttendanceTypeForm />,
  'Pay Head': () => <PayHeadForm />,
  'Salary Details': () => <SalaryDetailsList />,
};
const PAYROLL_ALTER: Record<string, () => JSX.Element> = {
  'Employee Group': () => <EmployeeGroupAlterList />,
  'Employee Category': () => <EmployeeCategoryAlterList />,
  Employee: () => <EmployeeAlterList />,
  'Attendance/Production Type': () => <AttendanceTypeAlterList />,
  'Pay Head': () => <PayHeadAlterList />,
  'Salary Details': () => <SalaryDetailsList />,
};
const PAYROLL_NAMES = Object.keys(PAYROLL_CREATE);

export function useGo() {
  const nav = useNav();
  const dialogs = useDialogs();
  const { toast } = useStore();
  const gated = (facility: string, fn: () => void) => () => (canCurrent(`${facility}.display`) ? fn() : toast('You do not have access to this report', 'err'));
  return {
    createLedger: () => nav.push(<LedgerForm />),
    createGroup: () => nav.push(<GroupForm />),
    createVoucherType: () => nav.push(<VoucherTypeForm />),
    alterLedger: () => nav.push(<PickLedger title="Ledger Alteration" onPick={(l) => nav.push(<LedgerForm id={l.id} />)} />),
    alterGroup: () => nav.push(<PickGroup title="Group Alteration" onPick={(g) => nav.push(<GroupForm id={g.id} />)} />),
    alterVoucherType: () => nav.push(<PickVoucherType title="Voucher Type Alteration" onPick={(t) => nav.push(<VoucherTypeForm id={t.id} />)} />),
    createStockItem: () => nav.push(<StockItemForm />),
    alterStockItem: () => nav.push(<PickStockItem title="Stock Item Alteration" onPick={(i) => nav.push(<StockItemForm id={i.id} />)} />),
    createStockGroup: () => nav.push(<StockGroupForm />),
    createStockCategory: () => nav.push(<StockCategoryForm />),
    createUnit: () => nav.push(<UnitForm />),
    createGodown: () => nav.push(<GodownForm />),
    stockSummary: gated('Stock Summary', () => nav.push(<StockSummaryReport />)),
    register: (parent: string) => nav.push(<RegisterReport parent={parent} />),
    cashBankBook: () => nav.push(<CashBankBookReport />),
    ratio: () => nav.push(<RatioAnalysisReport />),
    cashFlow: gated('Cash Flow', () => nav.push(<CashFlowReport />)),
    fundsFlow: gated('Funds Flow', () => nav.push(<FundsFlowReport />)),
    statistics: () => nav.push(<StatisticsReport />),
    payrollCreate: (k: string) => nav.push(PAYROLL_CREATE[k]()),
    payrollAlter: (k: string) => nav.push(PAYROLL_ALTER[k]()),
    paySlip: () => nav.push(<PaySlipPicker />),
    payrollStatement: () => nav.push(<PayrollStatementReport />),
    attendanceSheet: () => nav.push(<AttendanceSheetReport />),
    employeeVouchers: () => nav.push(<EmployeeVouchersPicker />),
    costCategoryNew: () => nav.push(<CostCategoryForm />),
    costCentreNew: () => nav.push(<CostCentreForm />),
    budgetNew: () => nav.push(<BudgetForm />),
    costCategoryAlter: () => nav.push(<AlterCostCategories />),
    costCentreAlter: () => nav.push(<AlterCostCentres />),
    budgetAlter: () => nav.push(<AlterBudgets />),
    costCentreSummary: () => nav.push(<CostCentreSummaryReport />),
    costCategorySummary: () => nav.push(<CostCategorySummaryReport />),
    costCentreBreakup: () => nav.push(<CostCentreBreakupEntry />),
    budgetVariance: () => nav.push(<BudgetVarianceEntry />),
    groupInterest: () => nav.push(<GroupInterestEntry />),
    ledgerInterest: () => nav.push(<LedgerInterestEntry />),
    tdsNatures: () => nav.push(<NatureOfPaymentList />),
    tcsNatures: () => nav.push(<NatureOfPaymentList kind="TCS" />),
    tdsOutstandings: () => nav.push(<TdsOutstandingsReport />),
    tcsOutstandings: () => nav.push(<TdsOutstandingsReport kind="TCS" />),
    tdsChallans: () => nav.push(<TdsChallanReconciliationReport />),
    form26q: () => nav.push(<Form26QReport />),
    tdsPayment: () => nav.push(<TdsPaymentScreen />),
    eInvoice: () => nav.push(<EInvoiceReport />),
    eWayBill: () => nav.push(<EWayBillReport />),
    gstr2b: () => nav.push(<Gstr2bReconciliationReport />),
    hsnSummary: () => nav.push(<HsnSummaryReport />),
    taxAnalysis: () => nav.push(<TaxAnalysisReport />),
    currencyNew: () => nav.push(<CurrencyForm />),
    currencyAlter: () => nav.push(<AlterCurrencies />),
    rateOfExchange: () => nav.push(<MultiCurrencyAlteration />),
    forexGainLoss: () => nav.push(<ForexGainLossReport />),
    priceLevelNew: () => nav.push(<PriceLevelForm />),
    priceLevelAlter: () => nav.push(<PriceLevelsList alter />),
    chart: () => nav.push(<ChartOfAccounts />),
    voucher: (name: string) => nav.push(<VoucherScreen typeName={name} />),
    vouchers: () => nav.push(<PickVoucherType onPick={(t) => nav.push(<VoucherScreen typeName={t.name} />)} />),
    dayBook: gated('Day Book', () => nav.push(<DayBookReport />)),
    trialBalance: gated('Trial Balance', () => nav.push(<GroupSummaryReport />)),
    balanceSheet: gated('Balance Sheet', () => nav.push(<BalanceSheetReport />)),
    profitLoss: gated('Profit & Loss A/c', () => nav.push(<ProfitLossReport />)),
    ledgerReport: () => nav.push(<PickLedger title="Ledger" onPick={(l) => nav.push(<LedgerReport ledgerId={l.id} />)} />),
    groupSummary: gated('Group Summary', () => nav.push(<PickGroup title="Group Summary" onPick={(g) => nav.push(<GroupSummaryReport groupId={g.id} />)} />)),
    receivables: () => nav.push(<OutstandingsReport side="receivable" />),
    payables: () => nav.push(<OutstandingsReport side="payable" />),
    gstr1: () => nav.push(<Gstr1Report />),
    gstr3b: () => nav.push(<Gstr3bReport />),
    importData: () => nav.push(<ImportMenu />),
    exportData: () => nav.push(<ExportScreen />),
    quit: async () => {
      if (await dialogs.confirm('Quit ?', { title: 'Quit', yes: 'Yes', no: 'No' })) await quitApp();
    },
    nav,
  };
}

function SubMenu({ title, items }: { title: string; items: MenuItem[] }) {
  const { sel, setSel, keys } = useMenu(items);
  useScreen({ title, noPeriod: true, keys, buttons: [] });
  return <MenuCard title={title} items={items} sel={sel} setSel={setSel} />;
}

export function Gateway() {
  const { company, period, books, version } = useStore();
  const nav = useNav();
  const go = useGo();
  const gst = !!company?.gst_enabled;
  const [tdsFlags, setTdsFlags] = useState<TdsCompany | null>(null);
  useEffect(() => void tdsCompany(books.db).then(setTdsFlags).catch(() => undefined), [books, version]);
  const tdsOn = !!tdsFlags?.tds_enabled;
  const tcsOn = !!tdsFlags?.tcs_enabled;
  const [last, setLast] = useState('');
  useEffect(() => {
    void books.db.select<{ d: string | null }>('SELECT MAX(date) AS d FROM vouchers').then((r) => setLast(r[0]?.d ?? ''));
  }, [books, version]);

  const inv = (m: MenuItem[]): MenuItem[] => (company?.inventory_enabled ? m : []);
  const pay = (kind: 'payrollCreate' | 'payrollAlter'): MenuItem[] =>
    company?.payroll_enabled
      ? [
          { label: 'Payroll Masters', heading: true },
          ...PAYROLL_NAMES.map((n) => ({ label: n, run: () => go[kind](n) })),
          { label: 'Income Tax Declarations', run: () => nav.push(<IncomeTaxDeclarationList />) },
          { label: 'Income Tax Slabs', run: () => nav.push(<IncomeTaxSlabsList />) },
        ]
      : [];
  const create: MenuItem[] = [
    { label: 'Accounting Masters', heading: true },
    { label: 'Group', run: go.createGroup },
    { label: 'Ledger', run: go.createLedger },
    { label: 'Voucher Type', run: go.createVoucherType },
    { label: 'Currency', run: go.currencyNew },
    ...inv([
      { label: 'Inventory Masters', heading: true },
      { label: 'Stock Group', run: go.createStockGroup },
      { label: 'Stock Category', run: go.createStockCategory },
      ...(company?.price_levels_enabled ? [{ label: 'Price Level', run: go.priceLevelNew }] : []),
      { label: 'Stock Item', run: go.createStockItem },
      { label: 'Bill of Materials', run: () => nav.push(<BomGateway />) },
      { label: 'Unit', run: go.createUnit },
      { label: 'Godown', run: go.createGodown },
    ]),
    ...(company?.cost_centres_enabled ? [{ label: 'Cost Centre Masters', heading: true } as MenuItem, { label: 'Cost Category', run: go.costCategoryNew }, { label: 'Cost Centre', run: go.costCentreNew }] : []),
    ...(tdsOn || tcsOn ? [{ label: 'Statutory Masters', heading: true } as MenuItem] : []),
    ...(tdsOn ? [{ label: 'TDS Nature of Payments', run: go.tdsNatures }] : []),
    ...(tcsOn ? [{ label: 'TCS Nature of Goods', run: go.tcsNatures }] : []),
    { label: 'Budgets', heading: true },
    { label: 'Budget', run: go.budgetNew },
    ...pay('payrollCreate'),
  ];
  const alter: MenuItem[] = [
    { label: 'Accounting Masters', heading: true },
    { label: 'Group', run: go.alterGroup },
    { label: 'Ledger', run: go.alterLedger },
    { label: 'Voucher Type', run: go.alterVoucherType },
    { label: 'Currency', run: go.currencyAlter },
    { label: 'Rate of Exchange', run: go.rateOfExchange },
    ...inv([
      { label: 'Inventory Masters', heading: true },
      { label: 'Stock Item', run: go.alterStockItem },
      { label: 'Bill of Materials', run: () => nav.push(<BomGateway />) },
      ...(company?.price_levels_enabled ? [{ label: 'Price Level', run: go.priceLevelAlter }] : []),
    ]),
    ...(company?.cost_centres_enabled ? [{ label: 'Cost Centre Masters', heading: true } as MenuItem, { label: 'Cost Category', run: go.costCategoryAlter }, { label: 'Cost Centre', run: go.costCentreAlter }] : []),
    { label: 'Budgets', heading: true },
    { label: 'Budget', run: go.budgetAlter },
    ...pay('payrollAlter'),
  ];
  const sub = (label: string, items: MenuItem[]): MenuItem => ({ label, run: () => nav.push(<SubMenu title={label} items={items} />) });
  const book = (label: string, run: () => void): MenuItem => ({ label, run });
  const statutory: MenuItem[] = [
    ...(gst
      ? ([
          { label: 'GST Reports', heading: true },
          book('GSTR-1', go.gstr1),
          book('GSTR-3B', go.gstr3b),
          book('GSTR-2B Reconciliation', go.gstr2b),
          book('HSN/SAC Summary', go.hsnSummary),
          book('Tax Analysis', go.taxAnalysis),
          ...(tdsFlags?.einvoice_enabled ? [book('e-Invoice', go.eInvoice)] : []),
          ...(tdsFlags?.ewb_enabled ? [book('e-Way Bill', go.eWayBill)] : []),
        ] as MenuItem[])
      : []),
    ...(tdsOn || tcsOn
      ? [
          { label: 'TDS Reports', heading: true } as MenuItem,
          ...(tdsOn ? [book('TDS Outstandings', go.tdsOutstandings)] : []),
          ...(tcsOn ? [book('TCS Outstandings', go.tcsOutstandings)] : []),
          book('TDS Payment', go.tdsPayment),
          book('Challan Reconciliation', go.tdsChallans),
          book('Form 26Q', go.form26q),
        ]
      : []),
  ];
  const more: MenuItem[] = [
    book('Trial Balance', go.trialBalance),
    book('Day Book', go.dayBook),
    sub('Account Books', [
      { label: 'Cash/Bank Books', heading: true },
      book('Cash/Bank Book', go.cashBankBook),
      { label: 'Ledgers', heading: true },
      book('Ledger', go.ledgerReport),
      book('Group Summary', go.groupSummary),
      { label: 'Registers', heading: true },
      ...['Sales', 'Purchase', 'Payment', 'Receipt', 'Journal', 'Contra', 'Credit Note', 'Debit Note'].map((n) => book(`${n} Register`, () => go.register(n))),
    ]),
    sub('Statements of Accounts', [
      { label: 'Outstandings', heading: true },
      { label: 'Receivables (Bills Receivable)', run: go.receivables, hotkey: 'R' },
      { label: 'Payables (Bills Payable)', run: go.payables, hotkey: 'P' },
      { label: 'Interest Calculations', heading: true },
      book('Group Interest Calculation', go.groupInterest),
      book('Ledger Interest Calculation', go.ledgerInterest),
      { label: 'Budgets', heading: true },
      book('Budget Variance', go.budgetVariance),
    ]),
    ...(company?.inventory_enabled
      ? [
          sub('Inventory Books', [
            { label: 'Stock Reports', heading: true },
            book('Stock Summary', go.stockSummary),
            { label: 'Stock Query', run: () => nav.push(<StockQueryReport />) },
            { label: 'Godown Summary', run: () => nav.push(<GodownSummaryReport />) },
            { label: 'Stock Group Summary', run: () => nav.push(<StockHierarchySummaryReport by="group" />) },
            { label: 'Stock Category Summary', run: () => nav.push(<StockHierarchySummaryReport by="category" />) },
            { label: 'Reorder Status', run: () => nav.push(<ReorderStatusReport />) },
            { label: 'Stock Ageing Analysis', run: () => nav.push(<StockAgeingReport />) },
            { label: 'Batch Summary', run: () => nav.push(<BatchSummaryReport />) },
            { label: 'Movement Analysis', heading: true },
            { label: 'Stock Item Movement Analysis', run: () => nav.push(<ItemMovementReport />) },
            { label: 'Stock Group Movement Analysis', run: () => nav.push(<StockGroupMovementReport by="group" />) },
            { label: 'Stock Category Movement Analysis', run: () => nav.push(<StockGroupMovementReport by="category" />) },
            { label: 'Group Analysis', run: () => nav.push(<GroupAnalysisReport />) },
            { label: 'Ledger Analysis', run: () => nav.push(<LedgerAnalysisReport />) },
            { label: 'Stock Transfer Analysis', run: () => nav.push(<StockTransferAnalysisReport />) },
            { label: 'Godown Transfers', run: () => nav.push(<GodownTransfersReport />) },
            { label: 'Orders and Bills', heading: true },
            { label: 'Sales Orders (Due Only)', run: () => nav.push(<OrderDetailsReport kind="Sales" />) },
            { label: 'Purchase Orders (Due Only)', run: () => nav.push(<OrderDetailsReport kind="Purchase" />) },
            { label: 'Sales Order Stock Group Outstandings', run: () => nav.push(<OrderOutstandingsReport kind="Sales" mode="stockGroup" />) },
            { label: 'Sales Order Ledger Outstandings', run: () => nav.push(<OrderOutstandingsReport kind="Sales" mode="ledger" />) },
            { label: 'Purchase Order Ledger Outstandings', run: () => nav.push(<OrderOutstandingsReport kind="Purchase" mode="ledger" />) },
            { label: 'Sales Bills Pending', run: () => nav.push(<BillsPendingReport kind="Sales" />) },
            { label: 'Purchase Bills Pending', run: () => nav.push(<BillsPendingReport kind="Purchase" />) },
            { label: 'Price Lists', heading: true },
            { label: 'Price List (Stock Group)', run: () => nav.push(<PriceListScreen scope="group" />) },
            { label: 'Price List (Stock Category)', run: () => nav.push(<PriceListScreen scope="category" />) },
            { label: 'Manufacturing', heading: true },
            { label: 'Cost Estimation', run: () => nav.push(<CostEstimationReport />) },
            { label: 'Job Costing', run: () => nav.push(<JobCostingReport />) },
            { label: 'Material Requirement', run: () => nav.push(<MaterialRequirementReport />) },
          ]),
        ]
      : []),
    ...(statutory.length ? [sub('Statutory Reports', statutory)] : []),
    sub('Analysis & Verification', [book('Cash Flow', go.cashFlow), book('Funds Flow', go.fundsFlow), book('Forex Gain/Loss', go.forexGainLoss), book('Ratio Analysis', go.ratio), book('Statistics', go.statistics)]),
    ...(company?.cost_centres_enabled
      ? [sub('Cost Centres', [book('Cost Centre Summary', go.costCentreSummary), book('Cost Category Summary', go.costCategorySummary), book('Cost Centre Breakup', go.costCentreBreakup)])]
      : []),
    ...(company?.payroll_enabled
      ? [sub('Payroll Reports', [book('Pay Slip', go.paySlip), book('Payroll Statement', go.payrollStatement), book('Attendance Sheet', go.attendanceSheet), book('Employee Vouchers', go.employeeVouchers), { label: 'Income Tax Computation', run: () => nav.push(<IncomeTaxComputationPicker />) }, { label: 'Gratuity Report', run: () => nav.push(<GratuityReport />) }])]
      : []),
  ];

  const items: MenuItem[] = [
    { label: 'Masters', heading: true },
    { label: 'Create', run: () => nav.push(<SubMenu title="Create" items={create} />), hotkey: 'C' },
    { label: 'Alter', run: () => nav.push(<SubMenu title="Alter" items={alter} />), hotkey: 'L' },
    { label: 'Chart of Accounts', run: go.chart, hotkey: 'H' },
    { label: 'Transactions', heading: true },
    { label: 'Vouchers', run: go.vouchers, hotkey: 'V' },
    { label: 'Day Book', run: go.dayBook, hotkey: 'K', hotAt: 7 },
    { label: 'Utilities', heading: true },
    { label: 'Banking', run: () => nav.push(<SubMenu title="Banking" items={bankingMenu((n) => nav.push(n))} />), hotkey: 'N' },
    { label: 'Reports', heading: true },
    { label: 'Balance Sheet', run: go.balanceSheet, hotkey: 'B' },
    { label: 'Profit & Loss A/c', run: go.profitLoss, hotkey: 'P' },
    ...inv([{ label: 'Stock Summary', run: go.stockSummary, hotkey: 'S' }]),
    { label: '' },
    { label: 'Display More Reports', run: () => nav.push(<SubMenu title="Display More Reports" items={more} />), hotkey: 'D' },
    { label: '' },
    { label: 'Quit', run: () => void go.quit(), hotkey: 'Q' },
  ];
  const { sel, setSel, keys } = useMenu(items);

  useScreen({
    title: 'Gateway of Tally',
    keys,
    buttons: [
      { key: 'F2', label: 'Date' },
      { key: 'F3', label: 'Company' },
    ],
  });

  const today = todayIso();
  const cap = 'text-[11px] uppercase text-tb-muted';
  return (
    <div className="-m-4 flex h-[calc(100%+2rem)]">
      <div className="w-[610px] shrink-0 border-r border-tb-strip">
        <div className="flex justify-between px-6 pb-3 pt-9">
          <div>
            <div className={cap}>Current Period</div>
            <div className="mt-1 text-[13px] font-bold">{fmtDate(period.from)} to {fmtDate(period.to)}</div>
          </div>
          <div className="text-right">
            <div className={cap}>Current Date</div>
            <div className="mt-1 text-[13px] font-bold">{weekday(today)}, {fmtDate(today)}</div>
          </div>
        </div>
        <div className="mt-6 flex justify-between border-y border-tb-strip px-6 py-0.5">
          <span className={cap}>Name of Company</span>
          <span className={cap}>Date of Last Entry</span>
        </div>
        <div className="flex justify-between px-6 pt-4 text-[14px] font-bold">
          <span>{company?.name}</span>
          <span>{last ? fmtDate(last) : ''}</span>
        </div>
      </div>
      <div className="flex flex-1 items-start justify-center pt-[70px]">
        <MenuCard title="Gateway of Tally" items={items} sel={sel} setSel={setSel} />
      </div>
    </div>
  );
}
