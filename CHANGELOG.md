# Changelog

All notable changes to TallyBook are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.5] - 2026-11-03

### Added
- TallyVault now encrypts company data at rest (SQLCipher in the desktop app, AES-GCM in the browser) and encrypts backups. Set, change or remove it under Company (Alt+K) → Company Security. A lost password cannot be recovered.
- Sales and Purchase invoices ask for a Tracking No. when the party has pending Delivery/Receipt Notes or Orders, fill in the pending items, and link them. Delivery and Receipt Notes ask for an Order No.
- Balance Sheet and Profit & Loss A/c: Alt+F1 detailed view, F12 options (vertical layout, percentages, working capital, gross profit section, hide zero balances) and Ctrl+F filter.
- Bills Receivable and Payable: ageing columns (0–30, 30–60, 60–90, over 90 days) via F12.

### Fixed
- An invoice raised against a Delivery Note or Receipt Note no longer changes stock a second time.
- Report screens no longer crash when rows change (the company header and pinned Grand Total are drawn without altering the table).

## [0.1.4] - 2026-11-03

### Added
- 40% GST rate (applies from 22 September 2025). 12% and 28% stay available for earlier invoices.

### Fixed
- Trial Balance includes Opening Stock under Stock-in-Hand, so it no longer shows a false opening difference when stock items have opening balances.

## [0.1.3] - 2026-11-03

### Fixed
- GSTR-1: invoices to unregistered buyers in other states go to B2C (Large) above ₹1 lakh from 1 August 2024 (previously ₹2.5 lakh), as notified by CBIC.
- Alt+N (e-Invoice Details) and Alt+W (e-Way Bill Details) now work from the keyboard in an altered invoice.
- TDS Deductor Details (TAN, deductor type, responsible person) is reachable from the Company menu (Alt+K), so Form 26Q has the company TAN.
- The TallyVault field no longer claims to encrypt data; it is a password asked before the company opens.
- Company Features (F11) groups TDS, TCS, e-invoicing and e-way bill under Statutory & Taxation and drops an outdated note.

## [0.1.2] - 2026-11-03

### Fixed
- GSTR-1 HSN/SAC summary now uses the HSN code and GST rate of each stock item on item invoices, instead of showing "(not set)" when the sales ledger has no HSN.

## [0.1.1] - 2026-11-03

### Fixed
- Company Features (F11) showed a blank screen on a fresh install; statutory, banking and payroll tables are now created at start-up.
- Backups now include every table (payroll, TDS, banking, cost centres, budgets, price lists, batches, currencies, users). Previously only core accounting and inventory data was saved.

## [0.1.0] - 2026-11-02

First public preview.

### Added
- Gateway of Tally style home, keyboard-first navigation, Go To (Alt+G), F11 features, F12 report configuration.
- Accounting vouchers (F4–F9, Alt+F5, Alt+F6) with bill-wise details, post-dated vouchers, bank allocations.
- GST invoices, GSTR-1, GSTR-3B, GSTR-2B reconciliation, HSN summary, tax analysis, e-invoice and e-way bill JSON.
- Inventory: stock items, groups, categories, units, godowns, batches, price levels and lists, stock vouchers, FIFO/LIFO/average/last-purchase/standard costing, stock reports.
- Reports: Balance Sheet, P&L, Trial Balance, Day Book, ledgers, registers, Cash/Bank Book, Cash Flow, Funds Flow, ratios, statistics, outstandings.
- Payroll, cost centres, budgets, interest calculation, TDS/TCS, banking and cheque management, multi-currency.
- Security: users, roles, password policy, TallyVault password, edit log.
- Data: backup and restore, Tally XML import/export, Excel/CSV import, print, e-mail and WhatsApp share.
- Automatic updates on macOS, Windows and Linux.

### Known limitations
- Builds are not code-signed or notarised yet.
- Some voucher-entry hooks (foreign currency popup, voucher classes, batch allocation, price-list rates, order tracking) are not connected; see GAPS.md.
