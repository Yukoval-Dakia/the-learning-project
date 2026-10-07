# YUK-588 — fixed-window cost observation

Owner Q-588(b), `docs/triage/2026-09-25/answers-applied.md:10`, approves folding quota/cost observation into the existing overnight digest. This backend slice adds accounting evidence; it grants no budget authority and enables no night jobs or providers. The owner approved the concrete Today UI preflight on 2026-10-06 and instructed the first parallel batch to start. The issue remains open until the UI delivery gates pass.

## Window and ownership

The digest's existing window is the previous Asia/Shanghai calendar day, `[from,to)`, including foreground and background activity. It is not a count of only night-cron spending. The shared Today entrypoint composes the shell and observability public ports and injects the cost reader into shell; no new cross-capability value dependency or raised architecture baseline.

`provider-cost-projection.ts` owns one shared SQL projection for existing admin/Today cost aggregates and the new bounded reader. An authoritative provider attempt is terminal, has a reserved provider start, and either is opaque or records a positive wire count. Exact UUID-linked ledger echoes are excluded. That linkage authority is checked across all dates, then each source is filtered by its own accounting timestamp: provider `finished_at`, ledger `occurred_at`. Filtering authority itself to the requested day would double count echoes that cross midnight. Unlinked historical rows remain visible. Failed/retried provider spending is included; watchdog alert exclusions never filter spend.

## Read contract

`cost` carries `scope: all_activity`, accounting `records`, `by_currency` known subtotals and source counts, and grouped `details`:

- provider/model/lane/task plus source and reported/estimated/unknown/legacy cost provenance;
- currency and nullable amount, preserving real reported zero versus unknown cost;
- usage basis/unit/source and nullable input/output/total with missing-value record counts;
- known wire counts alongside records without a physical call count.

Ledger rows have no authoritative lane or physical wire count; both remain unknown. Ledger token columns are unclassified recorded usage, not provider-reported usage. Provider units are retained, including non-token units. Partial sums do not erase the count of missing quantities. Accounting records, physical provider requests and actual subscription deductions are different facts; no remaining-quota number is fabricated. Currency subtotals are never combined.

The existing five-source `has_overnight_activity` remains a business-output signal. Costs are independent, so cost-only evidence does not invent an overnight task or business product. Copilot's deterministic handoff can mention previous-day accounting records, explicitly including foreground/background and excluding any claim about subscription deduction. No monetary estimate is presented as a bill.

The HTTP response schema, generated client and Postman descriptions carry the same contract. Existing admin/cost schemas reuse the extracted currency breakdown fields unchanged. No DB schema, flag, provider configuration, task execution or production operation changes.

## Verification

Six feature regressions first failed on the original digest because cost evidence was absent. Real PostgreSQL tests cover empty/zero/unknown, exact BJT boundaries, UUID-linked echoes across window edges, unrelated historical records, failed/retried spending, currency and lane separation, non-token/partial usage, unfinished/no-wire exclusion, opaque unknown call counts, repeated-row aggregation and invalid windows. Existing digest, admin/Today cost and learner-state consumers are included in scoped regression verification. Local typecheck/lint/build, required audits, independent review and exact-head CI precede merge.

UI acceptance remains pending: keep the existing activity disclosure, render honest currency/basis/unknown detail, preserve loading/error/empty and independent probes, and verify desktop/mobile. Backend delivery alone does not complete the whole issue.

## CI release-blocker correction

Initial exact-head CI `37214953644` found one unrelated weekly-report fixture race at Beijing midnight: its `now - 1 second` event belonged to yesterday while the assertion required today's bucket. The production endpoint returned the correct calendar date. Freezing only `Date` at `2026-10-04T16:00:00.500Z` reproduced the original failure locally. The test now freezes before/at/just after midnight, seeds current and previous local-day events, and checks explicit dates and both unchanged count/correct contracts. Network timers remain real and `afterEach` restores the clock. No endpoint or statistics behavior changes.

The corrected weekly file plus digest DB regressions pass 28 tests; the calendar-window unit file passes 6. CI must run on the corrected head; the failed SHA is not rerun as a substitute for the fix.


## Today presentation, approved 2026-10-06

The existing handoff card now has an independent, initially collapsed “昨日 AI 用量与费用” disclosure. It shows the previous Beijing calendar-day interval, including foreground and background activity. Quiet business output does not suppress cost evidence. The existing activity disclosure, degraded flags and independently loaded probe queue retain their behavior.

Currency summaries preserve reported, estimated, historical and unknown records separately. Details retain provider/model/lane, usage units and partial/missing quantities. Accounting records are not labeled as physical requests; known physical requests have their own missing-record count. Small nonzero amounts remain visible. Estimates do not claim to be bills or subscription deductions.

The component uses existing chip, disclosure and design tokens. No API/schema/budget/permission changes. Design references are `docs/design/2026-07-19-teaching-brief-ui-design.md` §2.4 and §4.1. The user approved the file scope and inline component in the Linear preflight before implementation.

Local verification: 18 scoped unit tests, typecheck, lint with the unchanged 297-warning baseline, and the complete web/server/worker/migrate build. Eight focused Playwright cases run against the actual production build on local port 18788, using deterministic API fixtures and no provider calls. They cover existing Today cost truth plus the new disclosure at 1440 and 390 CSS pixels, keyboard and pointer toggles, and currency/usage evidence. This is browser acceptance with fixtures, not production accounting reconciliation.

Independent initial review found no P0/P1. Its fixture-consistency note was addressed before PR publication: grouped details now match the displayed counts and sources, including unknown usage units. The parent reran the 18 unit and eight browser cases. No second review round was needed because production code did not change.

A pre-existing desktop background overflow was reproduced separately: at viewport width 1440, document width is 1560 both before and after expansion; temporarily hiding `.today-page::before` restores 1440. The cost region itself fits, and the 390px page has no overflow. Follow-up YUK-1324 owns that independent visual defect.

PR/exact-head CI and merge are still pending. No deployment or paid provider evaluation was performed.
