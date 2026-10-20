# Architecture anti-regression ratchets — delivery (YUK-1579)

Implementation of `docs/planning/2026-10-20-architecture-no-regression-proposal.md`
on branch `arch/regression-ratchets`, merged through `origin/main` `c26ec39f9`
(which contains the recorded-baseline mechanism from #1830 / `58289c05` and
the post-#1882 debt state `417/0/43`, `>1500`=16).
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
- `pnpm exec biome check <changed files>` — clean; `pnpm lint` — 0 errors
  (179 pre-existing repo warnings, none in changed files).
- `pnpm build` — clean (web + server/worker/migrate esbuild).
- `pnpm audit:capability-boundaries` (merge-base `2338e0192`, current head) —
  PASS: `debt ratchets exact (capability->server=406, server->capability-deep=0,
  cross-capability-value=43); new dependency edges=0; server-entry new
  edges=0 approved/0 blocked/0 type-only; nontrivial SCCs=1 (base 1);
  >1500-line files=15 (base 15)`.
  (Previous PASS at merge-base `c26ec39f9`: `417/0/43`, `16 (base 16)`.)
  (Earlier PASS at merge-base `46663192d`: `429/0/42`, `17 (base 17)` — the 17
  matches the independently measured Flash facts at `4fd1798`.)
- `pnpm audit:architecture-deepening` — PASS:
  `pass-through sites 1167 (+0 new)`, all 11 existing families green.
  The 592→1167 growth is the per-symbol re-export granularity fix (each
  exported name in an export-from is now its own site); base and head use the
  identical representation, so `+0 new` still holds.
- Upstream merge honesty note: `origin/main` grew `crossCapabilityValue`
  42→43 via a `recorded_ruling` `changes` entry (#1872 / YUK-1622,
  agency→practice 4→5) and added one `>1500` file plus five real pass-through
  sites. All of it sits **inside** the merge-base commit `671e08044`, so it is
  base stock and grandfathered — the audit replays only post-base `changes`
  tails, and `recorded_ruling` increases on the two protected debts remain
  hard-fail for anything appended after the base.

## Negative evidence (real git history, no fixtures)

`--base 24add632b` (baseline-introduction commit) reproduces every new gate
against real growth (801 violations at the post-merge head — 796 at `875faac0c`,
+5 from upstream commits; full logs archived externally):

- `edgeRecords`: 582 real base→head audited edges enumerated per
  `file -> module` (204 capabilityToServer + 13 crossCapabilityValue +
  365 capabilityToKernel; 574 at `875faac0c`), each carrying its measured
  `kind`/`symbols`.
- Kernel reverse gate: 16 real new value edges — exactly the real stock
  (`src/kernel/placement-persistence.ts` → `src/capabilities/{agency,knowledge}/public.ts`,
  `src/kernel/supply-dispatch-web-search.ts` → `src/server/ai/mcp/exa.ts`, …);
  type-kind reverse edges are report-only, never hard-failed.
- Facade check: 32 cases where a new cap→kernel edge targets a kernel module
  that itself reverse-imports (`…/research_meeting_nightly.ts` → `src/kernel/judge.ts`).
- Size gate: 10 new `>1500` paths (1 is a true `git -M` rename —
  `src/capabilities/practice/jobs/quiz_verify.ts` keeps base identity
  `src/server/boss/handlers/quiz_verify.ts` 1107→1528; the rest are real
  new-or-grown files at that base); 55 `>1000` crossings/growths listed with
  measured `from -> to`.
- SCC: no violation — the 5-member SCC already existed at the old base
  (subset / total-member / max-member all held).
- Pass-through gate (`audit:architecture-deepening --base 24add632b`):
  928 real new sites after the per-symbol granularity fix (438 in the sealed
  module-level scan: 200 `module` shells, 210 `site` re-exports, 17 `alias`,
  11 `function`). Sites now enumerate real exported names — e.g.
  `src/capabilities/agency/public.ts: module acceptLearningIntent ->
  …/learning-intent.ts`. On the real merge-base all are grandfathered:
  `+0 new`.

`--base 4fd179818` (pre-#1830) was additionally PASS at `875faac0c` — between
`4fd1798` and `46663192d` no audited edge was added, no `>1500` file appeared,
SCCs unchanged. (At the post-merge head the same base now spans the upstream
growth and correctly fails — the PASS claim is scoped to `875faac0c`.)

Server-entry gate on real history: the same `--base 24add632b` run fires the
new port check — **13 real violations** (8 value + 5 type-only) that entered
`server/start/**` after that base: the barrel import
(`server/start/acceptance-server.ts → src/capabilities/index.ts`), seven
`observability` `api/*-contracts` Zod schema modules (value), and five
`ui/*-client` edges (type-only, blocked per owner ruling — no private
type exemption). At the current merge-base every one is base stock →
`0 approved/0 blocked`.

## R1 fixes (second pass)

Independent review R1 (`review-r1-glm.md`, external evidence dir): 0 P0 /
2 P1 / 9 P2. Both P1s fixed; direct text errors corrected; remaining P2s
recorded for the coordinator.

- **P1-1 — F1 forward shapes widened to the approved set (closed in three
  passes).** `forwardArgsShape` now accepts the approved decidable shapes —
  same-order params (`direct`), a full permutation of distinct params
  (`reordered`), a single rest param spread verbatim (`spread`), and a plain
  verbatim/permuted prefix followed by a same-binding trailing `...rest`
  spread (`direct+spread` / `reordered+spread`), each incl. `return await`;
  `export default` arrows/function expressions run through the same F1
  pipeline (`symbol=default`). Everything else still fails F1: defaults/
  patterns/transforms/dropped-or-duplicated params never match, and a
  permutation requires sorted element-wise equality of distinct names
  (`(a,b) => t(a,a)` is not a forward). The shape is recorded in the site
  `detail` (`forward:<imported>;<shape>[+await];<hash>`).
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

### PR #1895 bot findings (third author pass)

Three confirmed P1s, fixed narrowly:

- **Post-dated `compatShims` records could stretch the 14-day window** —
  `validateCompatShimFields(record, today)` now hard-fails a future `date`;
  with `deadline ≤ date+14d` the whole approval window is bounded against
  today. `shimIsLive` unchanged (expiry still fails while a covered site
  remains live).
- **`serverToCapabilityDeep` could be raised by any justification** —
  `compareBaselineChanges` now fails every increase record on that debt
  unconditionally (offset, `recorded_ruling`, `owner_approval` alike), keeping
  the approved zero-deep boundary a hard gate; the measured-nonzero check
  then fails via the ordinary baseline reconciliation. Other debts keep
  their existing approval/offset semantics.
- **Export-from granularity collapsed to target modules** — value re-export
  statements now record `{exported symbol, target}` pairs (real exported
  names: `export {a as b} → 'b'`, `export * as ns → 'ns'`, `export v → 'v'`;
  `export *` stays `*`). Adding `export { b } from './m'` beside an existing
  `{ a }` site is a NEW site requiring coverage. `shimCoversSite` narrows
  site-kind coverage to the recorded `symbol` when the record names one.
  Scanner version bumped 1→2; base/head diff representation identical.

### PR #1895 bot findings (fourth author pass)

Three confirmed P1s, fixed narrowly:

- **Historical `edgeRecords` could cover new edges** —
  `auditEdgeRecords` covering is now restricted to the tail appended in this
  change (`records.slice(previousRecords)`); each added edge must be covered
  by a new record whose `kind`/`symbols` are verified against the measured
  edge in the same pass. A stale type-edge record can no longer launder a
  type→value upgrade. Historical records stay append-only, never re-punished.
- **`export { f as a, f as b }` collapsed to one alias** —
  `localToExported` is now a multi-map keeping every real exported name per
  local (specifier aliases, `export default` function names, direct named
  exports); each exported alias emits its own `function` site, so adding or
  reordering aliases can never hide an existing one. Type-only specifiers
  remain excluded; body-transform checks unchanged.
  (Fifth pass: `export default f` / `export default f as T` now also
  registers `default` into f's exported set, so a local forward candidate
  re-exported as default emits a `default` site alongside any named aliases;
  an `export default ident` that names an import binding still emits the
  `alias` site, and non-forward `export default` expressions/candidates
  produce no site.)
- **`server/**` (composition root + Start frontdoor) was unscanned** —
  `DEPENDENCY_ROOTS` still covers only `src/capabilities` + `src/server`
  (the three debt buckets and the zero-deep boundary are untouched). A new
  independent check collects real `server/**` → `src/capabilities/**` imports
  at base and head with the same parser/resolution/rename map, diffs them
  kind-aware, and hard-fails any **new edge** whose target is not a
  `public`/`ui-public` entrypoint — that includes the `src/capabilities`
  barrel (a second composition-root entry). Owner ruling: new edges to
  private capability targets fail **regardless of kind** — top-level server
  has no type-only exemption (the kernel reverse-edge type split is a
  different direction); `newTypeEdges` is still counted for reporting.
  A type→value upgrade on an existing pair counts as a new edge.
  `server/**` → `src/kernel`/`src/core`/`src/server` targets are approved
  ports and stay out of this collector.

### R1-fix negative-evidence status (honest)

- `reordered`/`spread`/`direct+spread`/`reordered+spread` F1 shapes and
  `export default` arrow forwards: **NOT_RUN on real history** — no real file
  at current head exercises them (0 occurrences in the `--base` violation
  details at `24add632b`/`46663192d`; `rg` over `src/|server/|web/` finds no
  top-level `(...args) => fn(...args)` or permuted exports —
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
- Fourth/fifth-pass fixes on real history: tail-only `edgeRecords` covering
  is **NOT_RUN** (the ledgers stay empty — no real non-empty tail exists to
  observe); multi-alias `export { f as a, f as b }` and `export default f`
  local-alias branches are **NOT_RUN** (no real file re-exports one local
  under two names or re-exports a forward candidate as default — branch
  verified by inspection only); the server-entry port gate **IS exercised**
  on real history at `--base 24add632b` (13 real blocked edges — see above).

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

## Latest ordinary-main integration

After the bot P1 fixes at `068fea678`, this branch normally merged main
`dc8d7c27db1fe8e56eb8049cb167d71a4b9e1ae8` (including ingestion budget #1891)
and later `2338e0192e77a7a80769e8fad7b08f559e42927a` (mastery compat exits
#1892, configuration docs #1899, retired approved HTTP aliases #1894 — the
retired `api/legacy-*` deletions dropped capability→server to 406 and
`>1500`-line files to 15). Main records capability→server 406, cross 43,
SCC 1×5 and 15 files >1500. Earlier 417 readings above remain historical
validation, not a current count. The merges change no audit rule or
exception; new ledgers remain empty, main changes/notes are preserved.
Product/test/CI/package content relative to this main is unchanged. Parent
validation and new exact CI are recorded against the post-integration head
in the external evidence directory.

## Sixth pass — server worker entry, variable-alias binding, self-consumer block, stable_contract rulings

Three bot P1s plus the coordinator-approved public-port classification, in
the same narrow fix series (no new framework/job/registry):

1. **Server-entry gate now covers `scripts/worker.ts`**
   (`SERVER_ENTRY_ROOTS = ['server', 'scripts/worker.ts']`). `headSourceInputs`
   accepts explicit file roots (file → itself when it matches SOURCE_RE/non-test,
   directory → `sourceFiles` recursion); `refSourceInputs` matches exact-path
   roots in the base tree, not only `root/` prefixes; the rename map pathspec
   gains `scripts/worker.ts` so a renamed worker cannot launder an edge. New
   value AND type edges to non-public capability modules hard-fail — the
   owner ruling allows only `public`/`ui-public`/kernel ports; base stock is
   grandfathered. Other `scripts/` maintenance files stay out of scope;
   `DEPENDENCY_ROOTS`/size/debt semantics unchanged.

2. **`const wrapper = imported` is a real alias binding.** The scanner
   registers `const X = imported` as a permanent alias
   (`let`/`var`/member-expr/call RHS excluded), resolved after the full-file
   pass so declaration/export order cannot hide it; each actual export name
   (named or `default`) emits its own site. Type-only imports still excluded.
   Sites now carry `targetSymbol` (export-from → the `from` specifier's local
   name, namespace → `*`, `export *` → `*`, alias/function sites → the
   imported symbol), so a retargeted or re-aliased site diffs as a NEW site.

3. **Self-referencing consumer evidence is rejected.** A declared consumer
   whose normalized path equals the record's own file fails closed —
   normalization is `posix.normalize` after separator unification, so `./x`,
   backslashes, `a/./x` AND `a/server/../x` all resolve to the real file
   identity; absolute paths and `..` root-escapes are rejected outright as
   non-repo-relative evidence. Self-reference can never be a real consumer
   for either `compatShims` or `stable_contract` records.

4. **`stable_contract` rulings in the existing `changes` ledger.** New
   discriminated record (field shape in `scripts/lib/source-size.ts`:
   `type`, `file`, `siteKind`, `symbol`, `targetModule`, `targetSymbol`,
   `owner`, `consumers[{file,line}]`, `evidence`, `rationale`, `issue`,
   `approval`, `date`). Debt replay skips `'type' in change` members — they
   are provenance classifications, never numeric exemptions; totals,
   baseline reconciliation, protected debts and append-only prefix checks
   are untouched. Only the tail appended after base can cover a new site; a
   ruling must still match an exact current site (no alias/target/owner
   drift, no module-wide exemption — `'*'` is refused outright for both
   `symbol` and `targetSymbol` so a namespace never inherits a ruling), its
   consumer evidence is verified against real head source, and its `date`
   may not be post-dated. Ledger dates are UTC (`toISOString().slice(0,10)`
   everywhere); the recorded approval date is the coordination's actual UTC
   day — file names and commit dates in JST do not set the ledger day. The
   `approval` URL is shape-checked only — coordinator authority is verified
   by the parent/coordination review, not by this code.

   Approved ruling recorded (verbatim five-field material in
   `docs/planning/2026-10-21-frontier-port-site-decisions.md`, proposal SHA
   `c89165fc…`): `knowledge/public.ts` `learnableFrontierResolved`
   (`siteKind: module`, target `knowledge/server/frontier-read.ts` same
   symbol, owner `knowledge`, consumer
   `practice/server/learnable-frontier.ts:5`, evidence `frontier-read.ts:220-352`
   @ `de061af07`, Linear approval comment URL). This is an existing base
   site receiving classification — it does not claim a new-site exemption.
   The `practice/server/learnable-frontier.ts:9` same-name re-export is
   ruled COMPAT (not stable), stays un-punished base stock, and receives NO
   new approval/deadline; retirement is a follow-up slice. Original approved
   proposal added verbatim as
   `docs/planning/2026-10-20-architecture-no-regression-proposal.md`.
