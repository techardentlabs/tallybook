# TallyBook

**Download:** [tallybook.online](https://tallybook.online) · [Releases](https://github.com/techardentlabs/tallybook-releases/releases/latest) (macOS, Windows, Linux)

A keyboard-first accounting application modelled on TallyPrime: Gateway menu, Tally's shortcuts, bill-wise tracking, GST, and import/export of Tally XML so existing users can switch.

Name, UI parity and trademark risk are the owner's decisions. See `PLAN.md`, `FIELDS.md`, `IMPROVEMENTS.md`.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Accounting engine in TypeScript: masters, vouchers, bill-wise, reports, GST, Tally XML import/export. Tested in Node. |
| `apps/desktop` | React + Vite + Tailwind UI. Runs in a browser for preview, or inside Tauri as a desktop app. |
| `apps/desktop/src-tauri` | Rust shell: native SQLite (`rusqlite`) exposed to the UI through two commands. |

## Run

```sh
pnpm install
pnpm test                 # core tests (accounting, XML, GST)
pnpm dev                  # browser preview at http://127.0.0.1:1420 (data kept in IndexedDB)
pnpm desktop              # Tauri desktop app (needs Rust; data in the app data folder)
```

Build an installer locally with `pnpm release:build`. Official builds come from GitHub Actions: see [RELEASING.md](RELEASING.md) for versioning, the monthly update cycle and how releases are published. Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Keyboard (same as Tally)

`F4` Contra, `F5` Payment, `F6` Receipt, `F7` Journal, `F8` Sales, `F9` Purchase, `Alt+F6` Credit Note, `Alt+F5` Debit Note, `Alt+F2` period, `Alt+G` Go To, `Alt+C` create from a list, `Ctrl+A` accept, `Esc` back, `F11` features, `Alt+O` / `Alt+E` import / export. Press `F1` in the app for the full list.

On macOS, function keys may need the `fn` key unless "Use F1, F2 etc. keys as standard function keys" is on. The desktop app receives them directly; browsers may intercept some.

## Status

Working and tested: company, groups, ledgers (with GST and bank details), voucher types and numbering, eight accounting voucher types, bill-by-bill (New Ref, Agst Ref, Advance, On Account), GST invoices (CGST/SGST/IGST), Day Book, Trial Balance, P&L, Balance Sheet, ledger vouchers, outstandings, GSTR-1 and GSTR-3B summaries (GSTR-1 JSON export), Tally XML import (dry run, idempotent) and export.

Not built yet: inventory and item invoices, e-invoice and e-way bill, TDS/TCS, payroll, bank reconciliation, multi-user, cloud, printing. The XML tag names come from Tally's public docs and memory and must be validated against real exports.

## Disclaimer

TallyBook is an independent product by Techardent Internet Pvt. Ltd. It is not affiliated with, endorsed by, or connected to Tally Solutions Pvt. Ltd. "Tally" and "TallyPrime" are trademarks of their respective owners.
