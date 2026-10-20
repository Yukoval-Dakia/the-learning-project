# Architecture anti-regression ratchets — delivery (YUK-1579)

Implementation of `docs/planning/2026-10-20-architecture-no-regression-proposal.md`
on branch `arch/regression-ratchets`, merged through `origin/main` `048dfc9b9`
(which contains the recorded-baseline mechanism from #1830 / `58289c05` and
the post-#1880 debt state `420/0/42`, `>1500`=15).
Everything reuses the existing `audit:capability-boundaries` and
`audit:architecture-deepening` commands, `CAPABILITY_BASE_SHA`/`--base`,
append-only `changes`, and `--tighten`. No new audit command, CI job, package,
or test was added; `scripts/audit-capability-boundaries.test.ts` is unchanged
byte-for-byte.

## Files

| File | Change |
|---|---|
| `scripts/lib/git-base-scan.ts` | NEW — immutable base-tree plumbing: `ls-tree`/`cat-file --batch`/`ls-files`/`diff -M` rename map/`merge-base`+env base resolution/set-based specifier resolution/`wc -l` line counting |
| `scripts/lib/dependency-ratchet.ts` | NEW — pure verdicts: base→head added-edge diff (rename-normalized, kind-aware — a type→value upgrade counts as new), `edgeRecords` coverage, kernel reverse-edge gate, kernel-facade consumption check, SCC subset/total-member/max-member comparison |
| `scripts/lib/pass-through-sites.ts` | NEW — Babel AST pass-through site scan (module/function/alias/site kinds), canonical body hashing, base↔head diff, consumer-reference extraction, `compatShims` validation |
| `scripts/lib/source-size.ts` | NEW — frozen `src/`+`server/`+`web/` `.ts/.tsx` (minus test/spec/generated) size metric, `sourceSizeRecords` reconciliation, `compatShim`/`edgeRecord`/`sourceSizeRecord` zod schemas |
| `scripts/audit-capability-boundaries.ts` | Extended — schema gains `edgeRecords`/`sourceSizeRecords`/`compatShims` + `owner_approval` justification; symbol-level dependency facts; repo-relative `locateModulePath`; shared `collectDependencies` used for both worktree and immutable-base scans; kernel reverse-edge collectors; main() wires the new ratchets |
| `scripts/audit-architecture-deepening.ts` | Extended — `--base`/`CAPABILITY_BASE_SHA` resolution; pass-through site scan at head and base plus `compatShims` validation; results folded into the existing single report |
| `scripts/capability-boundary-baseline.json` | Adds `"edgeRecords": []`, `"sourceSizeRecords": []`, `"compatShims": []` (empty ledgers) |
| `AGENTS.md` | Adds the six-item "Architecture no-regression checklist" |

## Before / after semantics

| Gate | Before | After |
|---|---|---|
| `capabilityToServer`, `crossCapabilityValue` totals | May not grow unless a `changes` increase is recorded (offset or `recorded_ruling`) | Same — plus `recorded_ruling` can no longer raise either total; only `owner_approval` with a traceable `approval` URL and verbatim `quote` can. Every **new audited edge** (cap→server value+type, cross-cap value, cap→kernel value) must also be covered in `edgeRecords` — every new edge requires a matching record and every new record must correspond to a real new edge — with the real consumed `symbols`, `issue`, and `owns` |
| SCCs | Head component must be subset of a baseline component; shrink requires `--tighten` | Unchanged vs baseline — plus measured vs **base commit**: every new component ⊆ a base component, total nontrivial members non-increasing, max member count non-increasing. Component **count** is report-only — a large cycle splitting into smaller ones is an improvement, not a violation |
| `>1500`-line files | None | Count must not grow vs base; no new `>1500` path (a `git -M` rename keeps its base identity — demonstrated below) |
| `>1000`-line files | None | Growth/crossing/new requires a `sourceSizeRecords` entry `{path, baseBlob, from, to, issue, responsibilityReason}` reconciled against real blobs |
| kernel/core → capability/server | Not audited | Existing edges grandfathered by base set; **new value edges fail — including a stock `import type` upgraded to a value import** (kind-aware base index); new type edges are counted. A new cap→kernel edge whose target itself reverse-imports capability/server is flagged as a suspected facade |
| New pass-through shells | None | AST (not regex/path) detects pure re-export modules, `return [await] imported(…)` forwards whose body only forwards its parameters verbatim — same order, a full permutation of distinct params, or a single rest parameter spread — `export const X = imported`, and value re-exports inside runtime modules. New sites fail unless covered by a `compatShims` entry |
| `compatShims` | None | New entries require real consumer `file:line` (re-parsed at head), `exitCondition`, `YUK-nn` issue, traceable `approval`, `deadline ≤ date+14d`; an expired live shim hard-fails. Base sites need no record (grandfathered) |

## Preserved gates (unchanged behavior)

- `compareCounts` exact-match per-pair and totals; `compareSccs` vs baseline file;
  `compareBaselineChanges` append-only + replay + offset-requires-real-decrease
  (the `'offset requires'` stderr contract the unchanged test asserts);
  `tightenBaseline`; `--print-dependency-baseline`; `--json`; all seam rules
  (deep imports, ui-public scoping, task-catalog/index.ts composition
  exceptions); all 11 architecture-deepening check families incl. `server ->
  capability-deep = 0` and the public-read catalog.
- The append-only rule now also covers `edgeRecords`/`sourceSizeRecords`/`compatShims`.
- `serverToCapabilityDeep` stays an unforgiving zero; `serverToCapabilityPublic`
  stays report-only; cross-capability type-only edges stay report-only.

## Verification (ran)

- `pnpm typecheck` — clean.
- `pnpm exec biome check <6 changed files>` — clean; `pnpm lint` — 0 errors
  (178 pre-existing repo warnings, none in changed files).
- `pnpm build` — clean (web + server/worker/migrate esbuild).
- `pnpm audit:capability-boundaries` (merge-base `048dfc9b9`) — PASS:
  `debt ratchets exact (capability->server=420, server->capability-deep=0, cross-capability-value=42);
  new dependency edges=0; nontrivial SCCs=1 (base 1); >1500-line files=15 (base 15)`.
  (Earlier PASS at merge-base `46663192d`: `429/0/42`, `17 (base 17)` — the 17
  matches the independently measured Flash facts at `4fd1798`; upstream #1880
  lowered server debt to 420 and >1500 to 15.)
- `pnpm audit:architecture-deepening` — PASS:
  `pass-through sites 592 (+0 new)`, all 11 existing families green.
  The +5 sites vs the earlier `587` are five real pass-throughs upstream
  (#1880/#1888) added between `46663192d` and `048dfc9b9` — running
  `--base 46663192d` enumerates them as violations; vs the actual merge-base
  they are grandfathered (`+0 new`).

## Negative evidence (real git history, no fixtures)

`--base 24add632b` (baseline-introduction commit) reproduces every new gate
against real growth (801 violations at the post-merge head — 796 at `875faac0c`,
+5 from upstream commits; full logs archived externally):

- `edgeRecords`: 658 real base→head audited edges enumerated per
  `file -> module` (266 capabilityToServer + 27 crossCapabilityValue +
  365 capabilityToKernel; 574 at `875faac0c`), each carrying its measured
  `kind`/`symbols`.
- Kernel reverse gate: 16 real new value edges — exactly the real stock
  (`src/kernel/placement-persistence.ts` → `src/capabilities/{agency,knowledge}/public.ts`,
  `src/kernel/supply-dispatch-web-search.ts` → `src/server/ai/mcp/exa.ts`, …);
  type-kind reverse edges are report-only, never hard-failed.
- Facade check: 32 cases where a new cap→kernel edge targets a kernel module
  that itself reverse-imports (`…/research_meeting_nightly.ts` → `src/kernel/judge.ts`).
- Size gate: 11 new `>1500` paths (1 is a true `git -M` rename —
  `src/capabilities/practice/jobs/quiz_verify.ts` keeps base identity
  `src/server/boss/handlers/quiz_verify.ts` 1107→1528; the rest are real
  new-or-grown files at that base); 55 `>1000` crossings/growths listed with
  measured `from -> to`.
- SCC: no violation — the 5-member SCC already existed at the old base
  (subset / total-member / max-member all held).
- Pass-through gate (`audit:architecture-deepening --base 24add632b`):
  438 real new sites at the post-merge head (433 at `875faac0c`, +5 from
  upstream), incl. `module` re-export shells
  (`src/capabilities/agency/public.ts`), `site` re-exports, `alias`
  (`DURABLE_BUDGET -> …/copilot-execution.ts`), and `function` forwards.
  On the real merge-base all of these are grandfathered: `+0 new`.

`--base 4fd179818` (pre-#1830) was additionally PASS at `875faac0c` — between
`4fd1798` and `46663192d` no audited edge was added, no `>1500` file appeared,
SCCs unchanged. (At the post-merge head the same base now spans the upstream
growth and correctly fails — the PASS claim is scoped to `875faac0c`.)

## R1 fixes (second pass)

Independent review R1 (`review-r1-glm.md`, external evidence dir): 0 P0 /
2 P1 / 9 P2. Both P1s fixed; direct text errors corrected; remaining P2s
recorded for the coordinator.

- **P1-1 — F1 forward shapes widened to the approved set.** `forwardArgsShape`
  now accepts three decidable shapes — same-order params (`direct`), a full
  permutation of distinct params (`reordered`), and a single rest param spread
  verbatim (`spread`), each incl. `return await`; everything else still fails
  F1 (defaults/patterns/transforms/dropped params never match). The shape is
  recorded in the site `detail` (`forward:<imported>;<shape>[+await];<hash>`).
- **P1-2 — kind-aware base index.** `addedEdges` and `auditKernelReverseEdges`
  share `baseKindIndex`/`isNewEdge`: base pairs are indexed by `file→module`
  with value-wins kind; a head edge is new iff the pair was absent **or** the
  pair existed type-only and is upgraded to value. value→type downgrades are
  never "new". This closes the bypass where a stock `import type` flipped to
  `import` skipped both the kernel reverse hard gate and `edgeRecords`
  registration (`src/kernel/read-models/cause-policy.ts` was R1's concrete
  exploit premise — base `46663192d` has two `import type` edges into
  `{knowledge,practice}/public.ts`).
- Text fixes: SCC bullets now read *non-increasing* (implementation always was);
  `edgeRecords` "1:1" claim corrected to two-way coverage (duplicate-record
  inflation is tolerated, per R1 P2-9); AGENTS.md keeps the original six
  checklist items plus the proposal-§3 lead-in "independent review cites
  per-item source evidence or NOT_APPLICABLE".

### R1-fix negative-evidence status (honest)

- `reordered`/`spread` F1 shapes: **NOT_RUN on real history** — no real file
  at current head exercises either shape (0 occurrences in the `--base`
  violation details at `24add632b`/`46663192d`; `rg` over `src/|server/|web/`
  finds no top-level `(...args) => fn(...args)` or permuted exports —
  `workbench-client.tsx`'s `(...args) => fn(...args)` are object properties,
  correctly out of scope; `src/ui/lib/utils.ts` `cn(...args)` composes
  `twMerge(clsx(…))`, correctly not a forward). Code path verified by
  inspection; the new branches only *add* detections (fail-closed direction).
- type→value upgrade: **NOT_RUN on real history** — git archaeology over the
  flagged kernel/capability files (`cause-policy.ts`, `assessment-issuance.ts`,
  `judge.ts`, `scheduling.ts`, `placement-persistence.ts`,
  `supply-dispatch-web-search.ts`) shows every historical churn is type→type
  retargeting; no real pair ever flipped type→value. The `--base cc1167518`
  run (519 violations) covers the same code paths via absent-pair edges; the
  upgrade branch is one boolean condition left to the independent R2 review.
- `--base 46663192d` (pre-merge base): FAIL with exactly the 5 real upstream
  pass-through sites — confirms the gate fires on real base↔head deltas.

## Machine-verification limits (stated honestly)

- `owner_approval.approval` and `compatShims.approval` are validated for
  shape only (https URL, non-empty quote). The audit cannot prove a URL names
  the right owner or that the quote is verbatim from them — that check belongs
  to the required independent review round.
- `edgeRecords.owns` is author-declared prose; the audit enforces presence and
  that the record's edge/symbols/kind match real source, not that the prose is
  an accurate ownership claim.
- AST site detection proves *shape* (identity forward / pure re-export). It
  cannot prove a module is shallow overall, that an exception is still needed,
  or that a consumer still calls the shim at runtime — the 14-day deadline and
  exit condition exist for that.
- Rename detection relies on `git diff -M` heuristics; a delete+recreate that
  scores below the similarity threshold correctly fails as "new path" (fail
  closed), but could also flag a legitimately rewritten file — resolvable via
  review, never silently waived.

## NOT_RUN

- `scripts/audit-capability-boundaries.test.ts` (and all of `pnpm test`,
  vitest, DB/migration/integration suites) — forbidden locally by owner rule
  and this task; the test is byte-identical and its asserted behavior was
  verified by code-path walkthrough: an increase change with
  `justification.kind='offset'` still fails the offset check whenever the
  measured total exceeds the base total, emitting `'offset requires'`.
  **CI will run it on the exact head.**
- `audit:capability-boundaries --tighten` — not exercised (no decreases to
  record in this diff); code path unchanged except it now serializes the three
  new (empty) ledger keys.
- Live `compatShims`/`edgeRecords`/`sourceSizeRecords` entries — none exist in
  this diff; tail-entry validation logic is exercised only by the old-base
  negative run for coverage failures. The consumer-evidence re-parse path has
  no real-world positive example yet.
- Docker, DB, provider/paid calls, and any synthetic fixture validation — out
  of scope per instructions.

## Evidence

External run logs: `tlp-audit-artifacts/architecture-deepening/YUK-1579/<head>/`
(filled at commit time with the exact head SHA, `SHA256SUMS` alongside).

## Follow-ups for the coordinator

- Parent opens the PR and arranges the independent initial review + the
  verification review (both required); the approval-link authenticity check
  above is an explicit review item.
- After merge, notify main/UI/migration lines that new audited dependency
  edges now require `edgeRecords`, `>1000` growth requires `sourceSizeRecords`,
  and new pass-through shells require `compatShims` (14-day cap).
