# TallyBook: Field Lists (checkpoint 3, for review)

Scope: Phase 2 (accounting core). Written from memory of TallyPrime; labels, order and defaults must be verified against the reference pack. `[v1]` ships in phase 2, `[later]` is recorded so the schema leaves room.

Conventions: amounts are integer paise; dates ISO in storage; every master has a stable id plus a name and optional alias. Names are unique case-insensitively across masters of the same kind.

## 1. Company

| Field | Notes | |
|---|---|---|
| Name | required | v1 |
| Mailing name | defaults to Name | v1 |
| Address | multi-line | v1 |
| State | India state list, drives GST place of supply | v1 |
| Country | default India | v1 |
| Pincode | | v1 |
| Telephone / Mobile | | v1 |
| E-mail / Website | | v1 |
| Financial year beginning from | date, default 1 April | v1 |
| Books beginning from | date, defaults to FY start | v1 |
| Data location | folder chosen at creation | v1 |
| Base currency symbol | default ₹ | v1 |
| Formal currency name | default INR | v1 |
| Decimal places | default 2 | v1 |
| Word for amount after decimal | default paise | v1 |
| Show amounts in millions | default No | later |
| Password / security control | | later |
| PAN / CIN | | later |
| GST registration details | | later (phase 5) |

Features screen (F11), phase 2 toggles: Maintain accounts only vs accounts with inventory, bill-by-bill, cost centres, multiple currencies, interest calculation. Only accounts-only, bill-by-bill and cost centres are active in v1.

## 2. Group

| Field | Notes | |
|---|---|---|
| Name | required | v1 |
| Alias | | v1 |
| Under | parent group; Primary allowed | v1 |
| Group behaves like a sub-group | yes or no, hides nature | v1 |
| Nature of group | shown only for Primary: Assets, Liabilities, Income, Expense | v1 |
| Net debit/credit balances for reporting | applies to sub-group behaviour | v1 |
| Used for calculation | purchase invoice allocation | later |

28 predefined groups, not deletable.

## 3. Ledger

| Field | Notes | |
|---|---|---|
| Name | required | v1 |
| Alias | | v1 |
| Under | group, required | v1 |
| Maintain balances bill-by-bill | shown for debtor, creditor and similar groups | v1 |
| Default credit period | days | v1 |
| Check for credit days during voucher entry | | v1 |
| Inventory values are affected | for ledgers under purchase/sales | later |
| Cost centres are applicable | | v1 |
| Interest calculation | | later |
| Mailing: name, address, state, country, pincode | | v1 |
| Banking: account holder, account no, IFSC, SWIFT, bank, branch | | v1 |
| Tax: PAN/IT number, registration type, GSTIN/UIN | | v1 |
| Contact: phone, mobile, e-mail, contact person | | v1 |
| Opening balance | amount plus Dr/Cr | v1 |
| Bill allocations at opening | name, date, due date, amount, Dr/Cr | v1 |
| TDS details | | later |

System ledgers: Cash, Profit & Loss A/c.

## 4. Voucher type

| Field | Notes | |
|---|---|---|
| Name | required | v1 |
| Alias / abbreviation | | v1 |
| Type of voucher | base type from the predefined list | v1 |
| Activate this voucher type | | v1 |
| Method of voucher numbering | Automatic, Automatic (manual override), Manual, None | v1 |
| Use advanced conditions | prefix, suffix, restart numbering, start number | v1 |
| Prevent duplicates | | v1 |
| Use effective dates | | later |
| Allow zero-valued transactions | | later |
| Make this voucher optional by default | | later |
| Provide narration for each entry | | v1 |
| Provide narration for voucher | default yes | v1 |
| Print voucher after saving | | v1 |
| Voucher class | named defaults (e.g. auto ledgers) | later |

Predefined: Contra, Payment, Receipt, Journal, Sales, Purchase, Credit Note, Debit Note, plus inventory types (later).

## 5. Accounting vouchers (shared header and body)

Header:

| Field | Notes | |
|---|---|---|
| Voucher type | | v1 |
| Voucher number | automatic or manual per type | v1 |
| Date | F2, within books range | v1 |
| Reference no. and date | on Payment/Receipt/Journal | later |
| Effective date | | later |

Body, one row per entry:

| Field | Notes | |
|---|---|---|
| Dr/Cr | first row default depends on type | v1 |
| Particulars (ledger) | picker with Alt+C to create | v1 |
| Current balance | shown in the picker, informational | v1 |
| Amount | | v1 |
| Bill allocation | New Ref, Against Ref, Advance, On Account | v1 |
| Cost centre allocation | when the ledger enables it | v1 |
| Bank allocation | instrument no, date, transaction type | later |
| Narration (per entry) | if enabled | v1 |

Footer: narration, total, difference. Accept requires balance and at least two entries.

Per-type behaviour, v1:

| Type | First row | Rule |
|---|---|---|
| Payment | Cr (Cash or Bank) | account ledger first, then Dr rows |
| Receipt | Dr (Cash or Bank) | account ledger first, then Cr rows |
| Contra | Cr | only Cash and Bank ledgers |
| Journal | Dr | any ledgers except Cash and Bank directly (Tally warns, not blocks) |
| Sales | Dr party | accounting-invoice mode; item mode in phase 4 |
| Purchase | Cr party | accounting-invoice mode; item mode in phase 4 |
| Credit Note | Cr party | reverses Sales |
| Debit Note | Dr party | reverses Purchase |

Operations: create, alter, delete, duplicate, cancel (marks cancelled, keeps number), insert voucher, optional vouchers (later), edit log (phase 7).

## 6. Reports needed in phase 2 (field-level specs follow after review)

Day Book, Trial Balance, Profit & Loss, Balance Sheet, Group Summary, Ledger Vouchers, Cash/Bank Book, Sales and Purchase Registers, Journal Register, Outstanding Receivables and Payables, Bill Ageing, Cost Centre reports.

## 7. Decisions I made myself (tell me if you disagree)

1. A single company per data folder; multiple companies are folders, as in Tally.
2. Numbering restarts per financial year when a voucher type enables it.
3. Deleting a ledger or group with transactions is blocked.
4. Amounts show with Indian digit grouping everywhere.

## 8. Needs verification against reference

- Exact field labels, order and default values on every form.
- Which fields appear conditionally (e.g. bill-by-bill only for certain groups).
- Names and order of the 28 predefined groups and the predefined ledgers.
- Voucher numbering options in the latest release.

## 9. Verified against Tally's public help (help.tallysolutions.com)

Confirmed:
- 28 predefined groups: 15 primary (Branch / Divisions, Capital Account, Current Assets, Current Liabilities, Direct Expenses, Direct Incomes, Fixed Assets, Indirect Expenses, Indirect Incomes, Investments, Loans (Liability), Misc. Expenses (ASSET), Purchase Accounts, Sales Accounts, Suspense A/c) and 13 sub-groups. Our seed list in section 3 matches.
- Primary groups cannot be deleted but can be renamed.
- Reserves & Surplus is a sub-group of Capital Account.
- "Maintain balances bill-by-bill" appears only when bill-wise entry is enabled in Features (F11) and the matching F12 setting is on. Enabling it later shows earlier bills as On Account.
- Default credit period is in days; suffix w, m or y for weeks, months, years. Available only with bill-wise tracking.
- With bill-wise on, Opening Balance opens a Bill-wise Breakup screen; if the bills sum to the opening balance, On Account is nil.

XML interface (needs confirmation from real exports; the help pages are over a year old):
- Envelope with header and body; imports name the operation and report (All Masters, Vouchers); records sit in TALLYMESSAGE blocks.
- Dates are YYYYMMDD. Masters must exist before vouchers that use them. Debits must equal credits.
- Voucher ACTION values: Create, Alter, Cancel, Delete. Alter needs a voucher identifier and date.
- Re-importing an export into the same company with overwrite off creates duplicates unless REMOTEID and VCHKEY GUIDs are set.
- Import statistics are logged to Tally.imp.
- Tally's own advice: create a sample in TallyPrime and export it to see the exact tag hierarchy.

## 10. Switching experience (design requirements)

1. Import wizard with a dry run: parse the file, show counts of groups, ledgers, vouchers and any errors before writing anything.
2. Idempotent: preserve Tally's GUIDs so importing the same file twice never duplicates.
3. Preserve voucher numbers, dates, narrations and bill allocations exactly.
4. After import, show a reconciliation screen comparing totals with the source (trial balance, ledger count, voucher count).
5. Export produces files Tally can import back.
6. Keep Tally's keyboard shortcuts and terminology so no retraining is needed.
