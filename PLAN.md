# TallyBook: Plan (for review, no code yet)

Status: draft. Name TallyBook is provisional; trademark risk accepted by the owner. Goal: functional and visual parity with TallyPrime, differing only in name and logo, with XML import/export for easy switching.

## 1. Principles

1. Parity is measured, not claimed. Every module is checked against a real TallyPrime install and real company data.
2. Switching comes first. XML import and export are built before most modules, because no one moves without their data.
3. Original artwork. Logo, icons and fonts are redrawn. Layout, colours, behaviour and shortcuts follow TallyPrime.
4. Money is integer paise. Dates are ISO in storage, Tally formats in the UI.
5. Small steps, reviewed: field lists, then schema, then code.

## 2. Stack

- Desktop shell: Tauri 2 (Rust). Local-first.
- UI: React, Vite, TypeScript, Tailwind. A keyboard-first screen engine renders the Tally look.
- Data: SQLite on the Rust side behind a small DB interface (select, atomic batch).
- Core: `@tallybook/core`, a pure TypeScript package holding accounting logic, reports and the XML codec. It is tested in Node and reused later by SaaS and mobile through different DB adapters.
- XML: a streaming parser for large exports and a writer that mirrors Tally's envelope structure.

## 3. XML import/export (the switching feature)

- Import: TallyPrime exports to XML (and its HTTP/XML interface returns envelopes with `TALLYMESSAGE` blocks). We import masters (groups, ledgers, voucher types, units, stock items, godowns, cost centres), then vouchers with entries, bill allocations and inventory allocations.
- Export: write the same structure back so a company can round-trip into Tally.
- Compatibility server (later): expose Tally's XML-over-HTTP interface on port 9000 so existing third-party tools keep working.
- Method: the owner supplies real exports from TallyPrime (several companies, different versions). The mapping and tag names are taken from those files, never guessed.
- Validation: import a company, then compare Trial Balance, P&L, Balance Sheet, ledger balances, stock summary and GST reports to Tally's own, to the paisa.
- Not planned: reading Tally's native data files directly (proprietary). XML is the supported path.

## 4. Phases

| Phase | Scope | Exit check |
|---|---|---|
| 0 Reference | Collect TallyPrime screenshots (every screen), real XML exports, sample companies, and a licensed or educational TallyPrime for comparison. | Reference pack in repo. |
| 1 Foundation | Workspace, DB layer, screen engine (Gateway, menus, forms, pickers, drill-down), keyboard map, Tally look. | Gateway and navigation match screenshots. |
| 2 Accounting core | Company, groups, ledgers, voucher types, 8 accounting vouchers, bill-by-bill, cost centres, Day Book, Trial Balance, P&L, Balance Sheet, ledger reports. | Imported company reports match Tally. |
| 3 XML switch | Masters and vouchers import, export, round-trip tests. | Round-trip equals source; reports match. |
| 4 Inventory | Stock items, units, godowns, batches, inventory vouchers, costing methods, stock reports. | Stock Summary matches. |
| 5 GST | GST masters, invoices, GSTR-1, 3B, e-invoice, e-way bill. | Returns match Tally. |
| 6 Banking, TDS, payroll | Reconciliation, TDS/TCS returns, payroll and statutory forms. | Per-module comparisons. |
| 7 Platform | Multi-user, TDL-like extensibility, audit trail, security, XML server on 9000, then SaaS and mobile. | Per goal. |

Phases 0 to 3 are the first release candidate. GST (phase 5) is required before charging small traders.

## 5. Review checkpoints

1. This plan.
2. Reference pack and per-screen layout specs.
3. Field lists for masters and vouchers.
4. Database schema.
5. XML mapping tables (from real exports).
6. Code, phase by phase.

## 6. Open items

- Target user: small traders first (recommended) or CA firms.
- Sell or internal: affects how early GST must be correct.
- Source for TallyPrime reference: licence or educational copy, screenshots, sample XML.
- Name and legal: TallyBook trademark check by an Indian IP lawyer before launch.
- Version baseline: which TallyPrime release to match (latest, plus the previous one for imports).
