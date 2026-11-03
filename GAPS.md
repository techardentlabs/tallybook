# TallyBook gaps vs TallyPrime

Status as of 0.3.0 (3 Nov 2026). "Built" means engine, screens and tests exist; it does not mean every Tally screen is matched pixel for pixel.

## Built
- Accounting: groups, ledgers (full field set, currency of ledger), voucher types with classes, all accounting vouchers, bill-wise with due dates and credit-day checks, post-dated vouchers (kept out of balances until their date), bank allocations, cost-centre allocation and TDS deduction on create and alter, foreign-currency entry.
- Inventory: stock items, groups, categories, units, godowns, price levels and lists (rates and discounts filled in invoices), batches in vouchers, stock vouchers, order and delivery tracking, five costing methods, stock and movement reports.
- Job work: job work orders, Material In/Out with consumption, third-party godowns and the job work reports.
- Manufacturing: bill of materials, Manufacturing Journal (components, co-products, by-products, scrap, additional costs), Cost Estimation, Job Costing, Material Requirement.
- GST: invoices, GSTR-1 (item-level HSN), GSTR-3B, GSTR-2B reconciliation, HSN summary, tax analysis, e-invoice and e-way bill JSON for offline upload.
- Income-tax Act 2025: TDS/TCS sections and rates dated from 1 April 2026 (1961 codes kept for earlier vouchers), Form 140 title for 2026-27, salary TDS by slab (both regimes), gratuity under the Labour Codes, Income Tax Computation and Gratuity reports.
- Payroll, banking (reconciliation, statement import, cheques), cost centres, budgets, interest, multi-currency and forex gain/loss.
- Companies: multiple companies, Select/Change/Shut (F3, Alt+F3, Ctrl+F3), TallyVault encryption per company, split company data, group companies.
- POS invoicing with multi-mode payment and POS Register; voucher classes in voucher and invoice mode.
- Security: TallyPrime facilities with type of access, back-dated limits, auto lock.
- Statutory returns: TDS/TCS interest and late fee, e-TDS files (26Q/27EQ, 140/143), PF ECR, Form 3A/6A, ESI monthly upload.
- Data exchange: Tally XML, Excel/CSV and TallyPrime JSON import and export.
- Reports: core statements, registers, cash/funds flow, ratios, statistics, F12 configuration, Alt+F1 detail, Ctrl+F filter, print, CSV, share.
- Data: backup/restore (all tables, encrypted with TallyVault), edit log with user, Tally XML import/export, Excel/CSV import, users, roles, password policy.
- Distribution: signed auto-updates, Windows/macOS/Linux installers, tallybook.online.

## Partly built
- Voucher classes: "Override using Item Defaults" is stored but has no effect; additional class charges are not added to the GST taxable value.
- Security: the full facility list is enforced on screens and menus; print-before-save, tax override and Tally.NET rules are stored but not enforced; stock, payroll and cost-centre masters are checked by screen only.
- Only one company is open at a time (TallyPrime can load several); group companies have no member-wise columns view.
- e-TDS, ECR and ESI files follow the official formats but have not been validated with the Protean FVU or uploaded to the portals; the ESI file is .xlsx and may need saving as .xls.

## Not built
- Multi-user over a network, remote access, browser reports, synchronisation.
- Direct GST filing, e-invoice IRN generation, e-way bill generation, connected banking and e-payments (TallyPrime does these with TSS).
- Batches and alternate units on manufacturing lines.
- TDS correction statements, Form 24Q/138 (salary) statements and nil statements.
- Exchange (Alt+Z), e-mail/WhatsApp attachments, POS print layout.
- Code-signed installers (Apple Developer ID, Windows certificate).
