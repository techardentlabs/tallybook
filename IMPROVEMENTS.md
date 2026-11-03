# Improvements over Tally (invisible or additive; the core UI and keyboard flow stay identical)

Evidence is thin: vendor comparison pages and a few Capterra reviews (accountune.com, techjockey, capterra.in, g2). No forum threads were reachable. Treat as directional and validate with real users.

## Complaints found, and the response

| Complaint | Source type | Response | Phase |
|---|---|---|---|
| Desktop only, no cloud, weak mobile | Capterra India review, comparison sites | Local-first now, sync/SaaS/mobile later through the same core | 7 |
| Single user on lower edition, multi-user costs more | Comparison sites | Multi-user in the free tier once sync exists | 7 |
| Backups are the user's responsibility | Vendor pages | Automatic rolling snapshots on every N saves and on close, one-key restore | 2 |
| Dated interface | Capterra review | Keep layout identical (owner's requirement); offer an optional dark theme and font scaling that default to off | 2 |
| Few third-party integrations | Capterra review | XML interface kept for compatibility; add a documented local REST/JSON API and CSV/Excel import/export | 7 |
| Learning curve for advanced modules | Capterra review | Same shortcuts; add inline hints in the status bar, no layout change | 2 |
| Multi-GSTIN setup is awkward (opening balances on tax ledgers) | Capterra review | Support opening balances on duty ledgers and multiple GSTINs from the start | 5 |
| Limited flexibility for larger businesses | Capterra review | Indexed SQLite, streaming XML import, paginated reports | 2 |

## Standing quality goals (from what accountants expect)

1. Integrity check on open and a repair tool (Tally has Check/Repair; ours must never lose a voucher).
2. Every edit and delete recorded in an edit log, non-removable.
3. Imports are dry-run first, idempotent by GUID, and end with a reconciliation screen.
4. Reports open fast on 100k+ vouchers.
5. Auto-match bank statements and GSTR-2B to vouchers (assistive; accountant confirms).
