# Changelog

All notable changes to TallyBook are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
