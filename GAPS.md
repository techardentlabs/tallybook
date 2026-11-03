# TallyBook gaps vs TallyPrime

Status as of 0.1.6 (3 Nov 2026). "Built" means engine, screens and tests exist; it does not mean every Tally screen is matched pixel for pixel.

## Built
- Accounting: groups, ledgers (full field set, currency of ledger), voucher types with classes, all accounting vouchers, bill-wise with due dates and credit-day checks, post-dated vouchers (kept out of balances until their date), bank allocations, cost-centre allocation and TDS deduction on create and alter, foreign-currency entry.
- Inventory: stock items, groups, categories, units, godowns, price levels and lists (rates and discounts filled in invoices), batches in vouchers, stock vouchers, order and delivery tracking, five costing methods, stock and movement reports.
- Manufacturing: bill of materials, Manufacturing Journal (components, co-products, by-products, scrap, additional costs), Cost Estimation, Job Costing, Material Requirement.
- GST: invoices, GSTR-1 (item-level HSN), GSTR-3B, GSTR-2B reconciliation, HSN summary, tax analysis, e-invoice and e-way bill JSON for offline upload.
- Income-tax Act 2025: TDS/TCS sections and rates dated from 1 April 2026 (1961 codes kept for earlier vouchers), Form 140 title for 2026-27, salary TDS by slab (both regimes), gratuity under the Labour Codes, Income Tax Computation and Gratuity reports.
- Payroll, banking (reconciliation, statement import, cheques), cost centres, budgets, interest, multi-currency and forex gain/loss.
- Companies: multiple companies, Select/Change/Shut (F3, Alt+F3, Ctrl+F3), TallyVault encryption per company.
- Reports: core statements, registers, cash/funds flow, ratios, statistics, F12 configuration, Alt+F1 detail, Ctrl+F filter, print, CSV, share.
- Data: backup/restore (all tables, encrypted with TallyVault), edit log with user, Tally XML import/export, Excel/CSV import, users, roles, password policy.
- Distribution: signed auto-updates, Windows/macOS/Linux installers, tallybook.online.

## Partly built
- Voucher classes fill lines in voucher mode; invoice-mode classes (default allocations per item) are not applied yet.
- Security: about 34 of Tally's ~86 facilities; permission checks cover vouchers and main statements only.
- Only one company is open at a time (TallyPrime can load several).
- EPF wage ceiling still uses ₹15,000; the reported revision has not been verified yet.

## Not built
- Multi-user over a network, remote access, browser reports, synchronisation.
- Direct GST filing, e-invoice IRN generation, e-way bill generation, connected banking and e-payments (TallyPrime does these with TSS).
- Job work, POS, consignments; batches and alternate units on manufacturing lines.
- Payroll statutory returns and Form 140 FVU/e-TDS file; TDS late fee and interest.
- Group companies, split company, Exchange (Alt+Z), JSON (Data Exchange) import, e-mail/WhatsApp attachments.
- Code-signed installers (Apple Developer ID, Windows certificate).
