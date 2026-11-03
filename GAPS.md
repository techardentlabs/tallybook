# TallyBook gap list vs TallyPrime

Source: https://help.tallysolutions.com/tallyprime-get-started/ ("TallyPrime Features & Capabilities", updated 25 Mar 2026) and the Accounting, Inventory, Sales Process and Connected Services index pages it links to. The Purchase Process and Payroll index URLs returned 404, so those two areas are listed from the main page only.

Status: done = built and exercised in the preview, partial = built but incomplete, missing = not built.

## Accounting

| Feature | Status |
|---|---|
| Ledgers and groups (28 predefined) | partial: no Create/Alter Multiple masters, no Chart of Accounts drill-down parity |
| Voucher types (8 accounting) | partial: no custom classes, no Memorandum, Reversing Journal, Optional, Post-dated |
| Payment, Receipt, Contra, Journal, Sales, Purchase, Credit/Debit Note | done (accounting-invoice mode only) |
| Bill-wise, Receivables, Payables, Outstandings, Settle bills | partial: no ageing columns config, no reminders, no Settle-from-report |
| Trial Balance / Group Summary, Day Book, Ledger Vouchers | done: F12 configuration, Alt+F1 detailed/condensed (TB), Ctrl+F filter, CSV/print; no Ctrl+H views, Ctrl+B basis, Alt+C columnar |
| P&L, Balance Sheet, registers, outstandings, stock reports | partial: no F12, filter or detailed view yet |
| Cash/Bank Book, Statistics, Ratio Analysis | done (basic) |
| Cash Flow, Funds Flow | done (indirect method, reconciles to cash/bank movement) |
| Sales/Purchase/Payment/Receipt/Journal/Contra/CN/DN Registers | done (monthly, drill to vouchers); no Alt+F1 detail, no columnar |
| Cost Centres, Cost Categories | missing |
| Interest calculation | missing |
| Budgets, Scenarios | missing |
| Multi-currency | missing |
| Mark changed vouchers, Edit Log (Alt+Q) | missing |
| Bank reconciliation, cheque printing and register, banking utilities | missing |
| Voucher numbering methods | partial: no Unused Voucher No. (Ctrl+Alt+U) |

## Inventory and sales/purchase process
Done: units, stock groups, godowns, stock items (opening balance, HSN, GST rate, standard price), item invoices for Sales/Purchase/Credit/Debit Note with GST, weighted-average stock valuation, Stock Summary, stock item vouchers, closing stock in P&L and Balance Sheet, F11 'Maintain inventory'. Still missing:
Stock items, units and compound units, stock groups and categories, godowns, inventory vouchers (Stock Journal, Physical Stock, Delivery Note, Receipt Note, Rejection In/Out), Sales and Purchase Orders, item invoices with quantity and rate, stock summary and query, batches, price lists and levels, standard prices, reorder levels, valuation methods, POS, consignments, job work, job costing, manufacturing (BOM, manufacturing journal), salesperson commission.

## Tax and compliance
| Feature | Status |
|---|---|
| GST ledgers, CGST/SGST/IGST invoice, GSTR-1 and 3B summaries | partial: invoice mode is ledger-level, not item-level HSN |
| GSTR-2A/2B/IMS reconciliation, GST challan, filing status, GSTIN validation online | missing |
| e-Invoice (IRN, QR), e-Way Bill | missing |
| TDS/TCS | missing |
| Payroll: employees, pay heads, pay slips, attendance, PF, ESI | missing |
| MSME, Edit Log audit, Data analysis | missing |
| KSA, Kenya, GCC VAT | out of scope for the India launch |

## Ease of use and data
| Feature | Status |
|---|---|
| Keyboard shortcuts | partial: voucher keys fixed to TallyPrime (Alt+F5 Debit, Alt+F6 Credit); Alt+Y/Z/M/P stubs |
| Go To (Alt+G) | partial: no Create Voucher, Alter Master, Expand All, Show More |
| F11 features, F12 configure | partial: F11 only |
| Print (Ctrl+P / Alt+P, PDF via print dialog), CSV extract of any report (Ctrl+E) | done; native Excel, E-mail, WhatsApp, digital signature missing |
| Backup, Restore, auto-backup, Repair, Migrate | missing |
| Import/Export XML | partial: tag names unvalidated against real exports; no Excel import |
| Save view, filter (Ctrl+F), Dashboard | missing |
| Multi-company: F3 switch, Alt+F3 open, group companies | missing |
| Security: passwords, user roles, TallyVault | missing |
| Connected: remote access, browser reports, sync, Tally Virtual User, Control Centre | missing, SaaS stage |
| Plug-ins and TDL add-ons | missing |

## Suggested order
1. Inventory and item-level GST invoices (needed by most traders), with Sales/Purchase Orders and Delivery/Receipt Notes.
2. Print/PDF, Excel export, Backup/Restore, Edit Log, F12 configuration and report views.
3. Cash/Bank Book, bank reconciliation, cost centres, interest, multi-masters.
4. e-Invoice and e-Way Bill, TDS/TCS, GSTR-2B reconciliation.
5. Payroll.
6. Security and multi-user, then cloud, mobile and sync.

## Status after the module batch
Built and reachable from menus: inventory vouchers and costing methods, payroll, cost centres/categories, budgets, interest calculation, TDS/TCS, e-Invoice and e-Way Bill data and JSON, GSTR-2B reconciliation, HSN summary, tax analysis, banking (reconciliation, imported statements, cheque register and printing, post-dated), backup/restore, edit log, Cash Flow, Funds Flow.

Engines exist but are not yet hooked into voucher entry or the ledger form: cost allocation popup, TDS deduction popup, e-Invoice/e-Way buttons, bank allocations and Ctrl+T post-dated, ledger interest parameters, TDS party and duty ledger details, company TDS details.

Still not built: F11 switches for TDS/TCS/e-invoice/e-way, Cost Centre Class, Budget Controls, voucher classes, price lists/levels, batches, POS, multi-currency, multi-company and group companies, user security and passwords, Tally XML mapping for the newer masters, native Excel import, e-mail and WhatsApp sharing, digital signature, TallyVault, remote access and sync.
