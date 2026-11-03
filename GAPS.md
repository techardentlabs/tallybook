# TallyBook gaps vs TallyPrime

Status as of 0.1.3 (3 Nov 2026). "Built" means engine, screens and tests exist; it does not mean every Tally screen is matched pixel for pixel.

## Built
- Accounting: groups, ledgers (full field set), voucher types, all accounting vouchers, bill-wise, post-dated, bank allocations, cost-centre allocation and TDS deduction during entry (new vouchers).
- Inventory: stock items, groups, categories, units, godowns, price levels and lists, stock vouchers (delivery/receipt notes, stock journal, physical stock, orders, rejections), five costing methods, stock and movement reports, batch data, order outstandings.
- GST: invoices, GSTR-1 (item-level HSN), GSTR-3B, GSTR-2B reconciliation, HSN summary, tax analysis, e-invoice and e-way bill JSON for offline upload.
- Payroll, TDS/TCS, banking (reconciliation, statement import, cheques, post-dated), cost centres, budgets, interest, multi-currency masters and forex gain/loss.
- Reports: all core statements, registers, cash/funds flow, ratios, statistics, F12 configuration, Alt+F1 detail, Ctrl+F filter, print, CSV, share.
- Data: backup/restore (all tables), edit log with user, Tally XML import/export (core and new masters), Excel/CSV import, users, roles, password policy.
- Distribution: signed auto-updates, Windows/macOS/Linux installers, tallybook.online.

## Not connected yet
- Voucher entry: foreign-currency entry popup, voucher classes, batch allocation, price-list rate defaulting, order tracking against orders/deliveries.
- TDS and cost-centre details are asked only when creating a voucher, not when altering.
- Party price level field on the ledger form; F11 switches for price levels and batches.
- Many security facilities (about 34 of Tally's ~86) and permission checks on reports other than the main statements.

## Not built
- TallyVault encryption: the TallyVault password is asked before the company opens, but data and backups are not encrypted.
- Multi-user over a network, remote access, browser reports, synchronisation.
- Direct GST filing, e-invoice IRN generation, e-way bill generation, connected banking and e-payments (TallyPrime does these with TSS).
- Manufacturing (BOM, manufacturing journal), job work, job costing, POS, consignments.
- Payroll statutory returns, income-tax and gratuity calculation; Form 26Q FVU/e-TDS file; TDS late fee and interest.
- TDS sections use Income-tax Act 1961 codes; the Income-tax Act 2025 renumbering is not reflected yet.
- Company switching (F3 / Alt+F3), group companies, split company, Exchange (Alt+Z).
- JSON (Data Exchange) import; e-mail/WhatsApp attachments (links open the mail app or WhatsApp with a message).
- Code-signed installers (Apple Developer ID, Windows certificate).
- Post-dated vouchers are not excluded from ledger balances until their date.
