# `draft_status` pool-visibility predicate dedup — design spec

- **Issue:** YUK-569 (#14 / FINAL of YUK-538 全项目逻辑打磨 worklist)
- **Register verdict source:** `docs/design/2026-07-02-project-logic-master-register.md` § draft-status-pool-gate-dup-predicate (table lines 1165 / 1193), verdict **RESHAPE**
- **Grounded at:** worktree `tlp-wt-draftpred` @ `81d67345` (branch `yuk-draft-status-dedup`)
- **Status:** ready to implement — behavior-preserving DRY

---

## Executive summary (is this safe-autonomous, or does it need owner sign-off?)

1. **This is pure prophylactic DRY, safe for autonomous execution.** The fail-open pool-visibility predicate `(draft_status IS NULL OR draft_status <> 'draft')` (contract: NULL≡active, 红线-4) is hand-copied across **19 code sites in 4 dialects** with zero shared export. Every site is individually tested and correct today; the extraction changes **no result set**.
2. **The adversarial critic surfaced ZERO misclassification errors.** The one thing that could have shipped a behavior change disguised as DRY — folding a truth-table-identical-but-semantically-distinct family-2 promote guard into the helper — was correctly avoided by all grounding passes and re-confirmed under attack.
3. **Four non-negotiable implementation constraints (not sign-off gates, just correctness):** (C1) fix a stale register exemption for `note-page.ts`; (C2) handle `fewshot-retrieve.ts:134` as a distinct bare-column sub-case; (C3) ship the robust SQL-shape audit as the enforced core, treat the JS ledger as optional; (C4) neutral helper name + guard comments at four family-2 look-alike sites.
4. **Only genuine judgment call for the owner (§10):** whether to include the JS twin helper (`isPoolVisible`) now or defer it (only 2 sites). Recommended: include. Everything else is mechanical and behavior-preserving.
5. **The NULL-backfill "free migration" (`NOT NULL DEFAULT 'active'`) remains explicitly OUT OF SCOPE** — it collides with family-2 exact-match gates and the `write.ts` soft-delete decision; it is a separate decision requiring full inventory of every `=== 'active'` / `eq(col,'active'|'draft')` site first.

---

## 1. Problem & scope

### 1.1 The RESHAPE recap

`question.draft_status` is a **nullable, no-default** `text` column (`src/db/schema.ts:304` — `draft_status: text('draft_status')`) with a three-state contract: **NULL ≡ active** (红线-4). The core pool-visibility rule is a **fail-open blocklist**: a row is pool-visible unless it is literally `'draft'`. Legacy `'active'` and `'final'` (matcher.ts) and NULL are all pool-visible.

That single predicate — `(draft_status IS NULL OR draft_status <> 'draft')` — is hand-copied **19 times across 4 syntactic dialects** with **no shared export**. Each copy is individually unit-tested and correct. The register's RESHAPE verdict: extract ONE shared helper + a read-side audit script so the invariant has a single definition and a lint that keeps new SELECTs honest.

### 1.2 In scope

- Extract a shared Drizzle predicate helper `notDraftPredicate(col)` (+ a JS twin `isPoolVisible(row)`; §3, §10).
- Migrate all **19 family-1 (F1)** fail-open pool-visibility sites to the helper (§4), byte-for-byte result-preserving.
- Add a read-side audit `pnpm audit:draft-status-reads` (§6) that mirrors the existing INSERT-side `pnpm audit:draft-status`, closing the "SELECT side is unenforced" gap the register calls out.

### 1.3 Out of scope (hard red lines — see §7)

- **Family-2 (F2)** fail-closed exact-match gates (`=== 'active'` / `=== 'draft'` / `eq(col,'active'|'draft')`) that gate FSRS enrollment, edit permission, promote, demote, and the draft-review pool SELECT. **Never fold these into the helper.**
- The **NULL-backfill + `NOT NULL DEFAULT 'active'`** migration — a distinct decision, collides with F2 + soft-delete.
- The two **container-read exemptions** (`active-question.ts`; `note-page.ts` — the latter now stale, see §7.3).
- UI `.tsx` exact-match / dirty-check logic (Bucket B′, §2.4).

### 1.4 Nature of the change

Prophylactic DRY, **not a live-bug fix**. §5 proves all four dialects are behavior-identical across the full value domain, so extraction changes no result set. Rollback is trivial (§9).

---

## 2. Family boundary — the definitive F1-migrate vs F2-leave table

The load-bearing trap: F1 and F2 are **shape-distinguishable in SQL/Drizzle but shape-IDENTICAL in JS** (`row.draft_status !== 'draft'` appears in both an F1 pool filter and F2 promote guards). The differentiator is intent, not operator — see §2.5.

### 2.1 Family (1) — fail-open pool-visibility blocklist — **MIGRATION TARGETS (19 sites)**

Uniform truth table for all 19: **NULL→visible · 'draft'→excluded · 'active'→visible · 'final'→visible**.

| # | file:line | dialect | action |
|---|---|---|---|
| 1 | `src/capabilities/practice/server/placement-select.ts:147` | drizzle `or(isNull,ne)` | → `notDraftPredicate` |
| 2 | `src/capabilities/practice/server/variant-rotation.ts:108` | drizzle `or(isNull,ne)` | → `notDraftPredicate` |
| 3 | `src/capabilities/practice/server/stream-store.ts:108` | drizzle `or(isNull,ne)` | → `notDraftPredicate` |
| 4 | `src/capabilities/practice/server/due-list.ts:236` (`notDraftQuiz`) | drizzle `or(isNull,ne)` | → `notDraftPredicate` |
| 5 | `src/server/question-supply/target-discovery.ts:615` | drizzle `or(isNull,ne)` | → `notDraftPredicate` |
| 6 | `src/server/boss/handlers/source_verify.ts:240` (inside `and()`) | drizzle `or(isNull,ne)` | → `notDraftPredicate` (touch ONLY :240; :484 is F2, §2.2) |
| 7 | `src/server/questions/write.ts:393` (soft-archive UPDATE WHERE) | drizzle `or(isNull,ne)` | → `notDraftPredicate` (§4 note) |
| 8 | `src/server/quiz/pool-fetch.ts:80` | raw-SQL `${col} IS NULL OR ${col} <> 'draft'` | → `${notDraftPredicate(question.draft_status)}` |
| 9 | `src/server/ai/tools/context-readers.ts:847` | raw-SQL | → `${notDraftPredicate(...)}` |
| 10 | `src/server/ai/tools/context-readers.ts:879` | raw-SQL | → `${notDraftPredicate(...)}` |
| 11 | `src/server/ai/tools/context-readers.ts:962` | raw-SQL | → `${notDraftPredicate(...)}` |
| 12 | `src/server/questions/list.ts:260` | raw-SQL | → `${notDraftPredicate(...)}` |
| 13 | `src/server/questions/list.ts:434` (ternary branch) | raw-SQL | → `${notDraftPredicate(...)}` |
| 14 | `src/server/questions/list.ts:647` | raw-SQL | → `${notDraftPredicate(...)}` |
| 15 | `src/server/quiz/fewshot-retrieve.ts:134` | raw-SQL **bare column** (no `${}`) | → `${notDraftPredicate(question.draft_status)}` **+ add `import { question }`** (§4, C2) |
| 16 | `src/capabilities/practice/jobs/recalibration_nightly.ts:140` | `IS DISTINCT FROM 'draft'` | → `notDraftPredicate` (result-identical; SQL text changes — §5 Caveat A) |
| 17 | `src/capabilities/practice/jobs/kt_estimate_nightly.ts:145` | `IS DISTINCT FROM 'draft'` | → `notDraftPredicate` (result-identical) |
| 18 | `src/capabilities/practice/server/variant-rotation.ts:126-127` (`isNonDraft`) | JS twin | → `isPoolVisible(row)` (drops dead `=== null ‖` disjunct — §4 note) |
| 19 | `src/server/quiz/matcher.ts:502` | JS twin `r.draft_status !== 'draft'` | → `isPoolVisible(r)` |

> Register lines 1165 cite `source_verify.ts:235` and `recalibration_nightly.ts:128` — those are **comment** lines; the executable predicates are at :240 / :140. The "≈17" in the verdict counts the 3 SQL-ish dialects; the 2 JS twins are the 4th, in-memory family. `write.ts:393` and both `IS DISTINCT FROM` nightly jobs were already named in the register inventory.

### 2.2 Family (2) — fail-closed exact-match gates — **DO NOT TOUCH**

Semantic: NULL is explicitly **NOT** `'active'`/`'draft'` (fail-closed). Gates promote / demote / edit-permission / enroll and the draft-review pool SELECT.

| file:line | code | role |
|---|---|---|
| `src/capabilities/practice/server/proposal-appliers.ts:364` | `existing.draft_status === 'draft'` | post-accept inconsistent-state assert |
| `src/capabilities/practice/server/proposal-appliers.ts:385` | `row.draft_status !== 'draft'` → throw 409 | **promote precondition** (NULL→throw) — look-alike of F1 twin (§2.5) |
| `src/capabilities/practice/server/proposal-appliers.ts:665` | `row.draft_status !== 'active'` | structure-edit permission (pooled only) |
| `src/server/quiz/verify-and-promote.ts:147` | `row.draft_status !== 'draft'` → `skipped:not_draft` | promote guard — look-alike |
| `src/server/quiz/verify-and-promote.ts:256` | `row.draft_status !== 'draft'` | promote guard — look-alike |
| `src/server/quiz/verify-and-promote.ts:303` | `post[0].draft_status !== 'draft'` (`alreadyActive`) | post-promotion state check — look-alike |
| `src/server/ai/tools/proposal-tools.ts:2148` | `row.draft_status !== 'active'` → `skipped:not_active` | act gate |
| `src/server/boss/handlers/source_verify.ts:484` | `eq(question.draft_status, 'active')` | **demote guard** (only active→draft) |
| `src/capabilities/practice/server/draft-review.ts:227` | `eq(question.draft_status, 'draft')` | **draft-review pool SELECT** (selects drafts) |
| `src/capabilities/practice/server/draft-review.ts:347` | `eq(question.draft_status, 'draft')` | draft-review pool SELECT |

### 2.3 F1/F2 in the same file — `source_verify.ts` (touch surgically)

`source_verify.ts` is mixed-family: F1 at `:240` (dedup SELECT — migrate), F2 at `:484` (demote guard `eq(...,'active')` — leave), plus Bucket-D writes at `:428/:483` (leave). Migrate ONLY `:240`.

### 2.4 Bucket B′ — UI exact-match / diff logic — **DO NOT TOUCH** (not F1)

React edit UI; `=== 'draft'` etc. but none are pool gates. Listed so a grep-replace doesn't sweep them.

| file:line | note |
|---|---|
| `src/capabilities/practice/ui/QuestionsPage.tsx:127` | `q.draft_status === 'draft'` (`isDraft`) — **inverse** of F1, UI badge |
| `src/capabilities/practice/ui/QuestionDetailPage.tsx:106` | UI status label |
| `src/capabilities/practice/ui/QuestionDetailPage.tsx:170` | normalize NULL→'active' for edit form only |
| `src/capabilities/practice/ui/QuestionDetailPage.tsx:478` | field-vs-field dirty check |
| `src/capabilities/practice/ui/QuestionDetailPage.tsx:585` | field-vs-field patch builder |
| `src/capabilities/practice/ui/QuestionDetailPage.tsx:954` | compares to loop var, toggle-button state |

### 2.5 The distinguishing rule (do NOT let operator-matching drive migration)

`row.draft_status !== 'draft'` is **NOT a safe grep target**. It appears in F1 twin `matcher.ts:502` (pool-include) AND in F2 guards `proposal-appliers.ts:385`, `verify-and-promote.ts:147/256/303` (throw/skip/state-check). The test is **intent**: iterating/filtering a pool (F1) vs. asserting one fetched-by-id row's state before a state transition (F2). This is exactly the conflation trap the register warns about — see §5 Caveat and §4 guard comments (C4).

---

## 3. Helper API

### 3.1 Location

**New file: `src/db/predicates.ts`.** Rationale: the helper takes a generic Drizzle `Column`, so it needs no schema import and creates no layering violation; `src/db/` already owns the drizzle dependency (unlike `src/core/`, which is Zod-only cross-subject, no-IO). Importable from both `src/capabilities/**` and `src/server/**`. The JS twin lives alongside it.

### 3.2 Drizzle helper (primary — covers 17 SQL sites)

```ts
import { type Column, type SQL, isNull, ne, or } from 'drizzle-orm';

/**
 * Family-1 fail-open pool-visibility predicate (红线-4): NULL≡active.
 * A row is POOL-VISIBLE unless it is literally 'draft'. Legacy 'active'/'final'
 * and NULL all stay visible.
 *
 * NOT for family-2 exact-match gates — `=== 'active'` / `=== 'draft'` /
 * `eq(col,'active'|'draft')` — which gate FSRS-enroll / edit-perm / promote /
 * demote / draft-review-pool SELECT. Never fold those in (see
 * docs/design/2026-07-05-draft-status-pool-predicate-dedup-spec.md §2.2/§2.5).
 */
export function notDraftPredicate(col: Column): SQL {
  return or(isNull(col), ne(col, 'draft')) as SQL;
}
```

**Return type is a definite `SQL`.** Both operands are always defined, so the runtime `or` never yields `undefined`; the `as SQL` cast is safe and is required so the fragment can be interpolated into a raw `sql\`\`` template (sites #8–#15) and composed inside `and(...)` (sites #6/#7). Byte-for-byte identical SQL to every current `or(isNull(...), ne(..., 'draft'))` inline copy.

### 3.3 JS twin (recommended — covers the 2 in-memory sites)

```ts
/**
 * JS twin of notDraftPredicate: an in-memory row is POOL-VISIBLE (红线-4,
 * NULL≡active, only literal 'draft' excluded).
 *
 * Do NOT apply to family-2 promote/enroll guards that also read
 * `row.draft_status !== 'draft'` — those are fail-closed state gates, not
 * pool filters (spec §2.5).
 */
export function isPoolVisible(row: { draft_status: string | null }): boolean {
  return row.draft_status !== 'draft';
}
```

Behaviorally identical to `isNonDraft` (drops its dead `row.draft_status === null ||` disjunct — redundant since `null !== 'draft'` is already `true`) and to `matcher.ts:502`. Type is `string | null`; even a defensive `undefined` maps to visible, matching SQL NULL (§5). See §10 for the include-vs-defer judgment call.

---

## 4. Migration table — per-site handling (incl. the tricky ones)

Every F1 site → exact replacement. The seven Drizzle sites (#1–#7) already write `question.draft_status` inline, so `notDraftPredicate(question.draft_status)` is a byte-identical drop-in (self-join alias risk is structurally moot — the column ref is reproduced exactly).

| site | current | replacement | note |
|---|---|---|---|
| #1–#5 (clean Drizzle `.where`) | `or(isNull(question.draft_status), ne(question.draft_status, 'draft'))` | `notDraftPredicate(question.draft_status)` | Cleanest targets; drop local `const notDraft`/`notDraftQuiz`, import helper. |
| #6 `source_verify.ts:240` | inline `or(...)` as 2nd conjunct in `and(ne(id), <this>, or(...overlap))` | `notDraftPredicate(question.draft_status)` | `and()` composes any number of `SQL`; substitution byte-for-byte. Touch ONLY :240. Migrate the adjacent intent comment to a pointer. |
| #7 `write.ts:393` (UPDATE WHERE) | inline `or(...)` in soft-archive `and(...)` | `notDraftPredicate(question.draft_status)` | Only F1 UPDATE-guard (not a SELECT); same fail-open predicate → belongs to the helper. **Reinforces** the write.ts soft-delete decision (docblock: "every consumer filters `<> 'draft'`, so `draft_status='draft'` is the natural soft-delete") — it does NOT entangle the backfill question. Intent here reads "eligible-to-archive"; keep the neutral name (do not rename to `isPoolVisible` at this site). |
| #8–#14 (raw `sql\`\``, `${question.draft_status}` interpolated) | `(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')` | `${notDraftPredicate(question.draft_status)}` | Drizzle nests `SQL` fragments inside `sql\`\``; `preds.push(...)` / `filters.push(...)` arrays take `SQL`. Result-identical. |
| **#15 `fewshot-retrieve.ts:134` (bare column) — C2** | bare `(draft_status IS NULL OR draft_status <> 'draft')` inside `db.execute(sql\`… FROM question …\`)`, **no interpolation, no schema import** | `${notDraftPredicate(question.draft_status)}` | **Distinct sub-case.** The helper emits **qualified** `"question"."draft_status"`; verified safe because the FROM is single-table unaliased (`FROM question`, line 132) — qualified resolves unambiguously alongside the other bare columns. **Must add `import { question } from '@/db/schema'`** (file currently imports only `sql` from `drizzle-orm`). Leave a one-line comment: `// helper emits qualified column; safe only while FROM is unaliased single-table`. |
| #16–#17 (`IS DISTINCT FROM`) | `sql\`${question.draft_status} IS DISTINCT FROM 'draft'\`` | `notDraftPredicate(question.draft_status)` | **Result byte-for-byte identical** (`IS DISTINCT FROM 'draft'` is the NULL-safe canonical form of the OR-predicate — §5). Emitted SQL *text* changes; task's "byte-for-byte" is result/behavior, which holds. If literal-SQL invariance were also required, these two could stay as-is (unnecessary). Recommend migrate for uniformity. |
| #18 `variant-rotation.ts:126-127` (`isNonDraft`) — JS | `row.draft_status === null || row.draft_status !== 'draft'` | `isPoolVisible(row)` | Drops the dead `=== null ||` disjunct — documented no-op simplification, not silent. Consumer at ~line 262 unchanged. |
| #19 `matcher.ts:502` — JS | `if (r.draft_status !== 'draft') {` | `if (isPoolVisible(r)) {` | Comment at 499-501 already documents F1 intent ('final'/NULL/'active' all visible). |

### C4 — mandatory guard comments at the four F2 look-alikes

At each site whose `!== 'draft'` is truth-table-identical to F1 but semantically F2, add a one-line guard so a future dev drawn to the named helper does not fold it in (tests would still pass — behavior-identical today — and a landmine would ship):

- `src/capabilities/practice/server/proposal-appliers.ts:385`
- `src/server/quiz/verify-and-promote.ts:147`
- `src/server/quiz/verify-and-promote.ts:256`
- `src/server/quiz/verify-and-promote.ts:303`

Comment, e.g.: `// NOT isPoolVisible — fail-closed promote guard (not-a-draft → reject/skip); do not fold into notDraftPredicate (spec §2.5).`

---

## 5. Dialect equivalence — proof + verdict

### 5.1 Truth table (5 value classes × 4 dialects)

Pool-visible ⟺ predicate evaluates TRUE (Postgres drops FALSE **and** UNKNOWN/NULL rows).

| col value | `IS NULL OR <> 'draft'` (Drizzle + raw) | `IS DISTINCT FROM 'draft'` | JS `!== 'draft'` | pool-visible? |
|---|---|---|---|---|
| **NULL** | `TRUE OR UNKNOWN = TRUE` | `TRUE` | `null !== 'draft' = true` | **YES** |
| **'draft'** | `FALSE OR FALSE = FALSE` | `FALSE` | `false` | **NO** |
| **'active'** | `FALSE OR TRUE = TRUE` | `TRUE` | `true` | **YES** |
| **'final'** (legacy) | `FALSE OR TRUE = TRUE` | `TRUE` | `true` | **YES** |
| **arbitrary str** | `FALSE OR TRUE = TRUE` | `TRUE` | `true` | **YES** |

All four columns identical across every value class. **VERDICT: provably equivalent — pure DRY, not a latent bug.** 红线-4 (`'final'` pool-visible under `<> 'draft'`) holds in all four dialects.

### 5.2 The three-valued-logic pivots

- **Drizzle + raw:** the `IS NULL` disjunct is **load-bearing**. For NULL, `NULL <> 'draft'` is UNKNOWN, which alone would fail-closed (drop the NULL row); `IS NULL` is TRUE and `TRUE OR UNKNOWN = TRUE` rescues it. The full predicate never yields NULL, so it is clean TRUE/FALSE.
- **`IS DISTINCT FROM`:** a NULL-safe comparison that **always returns boolean** — the canonical single-operator form of `(IS NULL OR <> 'draft')`. Exactly equivalent, not merely close.
- **JS:** `string | null` domain; matches SQL over every value class. The `=== null ||` disjunct in `isNonDraft` is redundant. `undefined` (cannot arise from a Drizzle DB read) → visible, still consistent.

### 5.3 Caveat A — result-preserving, not SQL-text-preserving at #16/#17

Substituting the helper at the two `IS DISTINCT FROM` sites changes emitted SQL *text* while the **result set is byte-for-byte identical**. The task's "byte-for-byte preserved" is about behavior/result — holds. Documented so a diff-of-emitted-SQL test (if any) is not surprised.

### 5.4 Caveat B — bare-column qualification (only #15)

A col-param helper emits qualified `"question"."draft_status"`. Safe at `fewshot-retrieve.ts:134` **only because** its FROM is single-table unaliased. Any raw-SQL site that aliases/joins `question` must be alias-checked before substitution — #15 is the sole such site and is verified safe (§4, C2).

### 5.5 Critic-refuted non-equivalence hunts (see Appendix A)

Every executable bare `<> 'draft'` lacking a NULL guard, and every exotic dialect (`NOT IN` / `coalesce` / `not(eq)` / `IS DISTINCT FROM 'active'`), was searched — all hits were comment lines. No latent fail-closed-on-NULL bug is hiding in the F1 bucket.

---

## 6. Read-side audit — `pnpm audit:draft-status-reads`

### 6.1 Purpose & the central constraint

Close the SELECT-side gap: unlike the INSERT-side `audit:draft-status` (already in the `pnpm test` chain), the pool-visibility predicate on reads is currently unenforced. The audit is a structural sibling of `scripts/audit-draft-status.ts` (file-walk + comment/string-aware tokenizer + JSON allowlist + `import.meta.url` CLI guard + sibling `.test.ts`).

**Central constraint:** F1 and F2 are shape-disjoint in SQL (F1 = `or(isNull,ne)` / `IS NULL OR <>` / `IS DISTINCT FROM`; F2 = `eq(col,'active'|'draft')` — zero collision), but shape-IDENTICAL in JS. So the audit splits into two engines.

### 6.2 Engine A — SQL/Drizzle positive-shape detection (robust core, ENFORCED)

Reuse the tokenizer from `audit-draft-status.ts` (`extractObjectBlock`'s scanner — line/block-comment + string + template-literal aware). Factor it into `scripts/lib/ts-tokenize.ts` and import from both scripts (or copy with a pointer comment). Anchor-scan the `draft_status` token; for every occurrence in **code or `sql\`\`` context** (comments/plain-string prose skipped for free), match a bounded window against:

- **D1 Drizzle:** an `or( … )` arglist containing BOTH `isNull(<expr>.draft_status)` AND `ne(<expr>.draft_status, 'draft')` in either order (paren-balance the `or(` arglist, test both sub-regexes). Order-agnostic so a reordered future copy still matches.
- **R1 raw blocklist:** window has `draft_status` AND matches `/IS\s+NULL\s+OR\b[\s\S]{0,80}?(?:<>|!=)\s*['"]draft['"]/i`, only inside a `sql\`\`` tag. Matches both interpolated (`${col} …`) and bare (`fewshot-retrieve.ts:134`) forms.
- **R2 `IS DISTINCT FROM`:** `/draft_status[\s\S]{0,40}?IS\s+DISTINCT\s+FROM\s+['"]draft['"]/i`, inside `sql\`\``.

A **migrated** site contains no inline `draft_status` token (it reads `notDraftPredicate(question)`), so it is invisible to the scanner by construction — no helper-call-site disambiguation needed. The lone legitimate inline predicate is the helper's own definition (excluded, §6.4).

**FN backstop:** any `draft_status` token in code/`sql` context that fails D1/R1/R2 → report `UNKNOWN-SHAPE (needs triage)` rather than silently passing. Catches novel dialects (`NOT IN`, `coalesce(...)`, cross-variable predicates). Document the cross-variable blind spot (predicate built from `const c = question.draft_status`) as a known limitation, mirroring the INSERT audit's own blind-spot docblock.

### 6.3 Engine B — JS closed-world ledger (optional / deferred — C3)

JS twins are shape-indistinguishable from F2 promote guards, so JS detection cannot be shape-based. Design: a hand-maintained registry `scripts/audit-draft-status-reads-js-registry.json` with two arrays — `family1_twins` (the 2 pool-visibility twins) and `family2_gates` (the ~7 known `!== 'draft'`/`=== 'draft'` guards). Each entry carries `file` + a `marker` substring (audit-relations style); the audit reverse-checks the marker still exists → ledger↔code drift fails loud. Any JS `draft_status` comparison in neither array → `UNCLASSIFIED-JS` (closed-world completeness gate).

**C3 recommendation:** ship Engine A as the **enforced** core; treat Engine B as **optional/deferred**. Rationale: Engine B relocates the copy-paste fragility into a JSON file that must be kept in sync — a weaker win than Engine A's robust zero-FP SQL detection. Post-migration the 2 JS twins route through `isPoolVisible`, so if Engine B is deferred, the audit should still emit an informational note flagging those 2 twins as known-uncovered-by-shape.

### 6.4 Exclusions & false-positive control

1. **Helper definition file** (`src/db/predicates.ts`) — the one legitimate inline predicate. Exclude via a top-of-file `HELPER_DEF_FILES` constant (permanent-by-design, **not** an allowlist entry with a `resolves_when`). Belt-and-suspenders: require a sentinel marker comment (`// AUDIT-DRAFT-READS: canonical-definition`) and reverse-check it exists, so a rename without updating the constant fails loud.
2. **Predicate prose in comments/docstrings** (dense: `write.ts:10`, `pool-fetch.ts:30`, `target-discovery.ts:599`, `context-readers.ts:871-877`, `matcher.ts:499-501`, `fewshot-retrieve.ts:13/82`, the allowlist JSON, the register itself) — eliminated for free by the tokenizer. This is why reusing the scanner (vs. naïve grep) is non-negotiable.
3. **F2 `eq()` / `=== 'active'` / `=== 'draft'`** — auto-excluded; positive-match on F1 shapes only, F2 matches none of D1/R1/R2.
4. **Schema / type / projection mentions** (`schema.ts` col def; `draft_status: string | null` type decls; `draft_status: question.draft_status` projections) — no F1 marker → never match.

### 6.5 Allowlist (mirror `audit-draft-status-allowlist.json`)

`scripts/audit-draft-status-reads-allowlist.json` — site-level exceptions for an F1 inline predicate that intentionally does not route through the helper (e.g. mid-migration). Reuse the exact `validateAllowlistHygiene` contract (`reason` non-empty + `resolves_when{kind∈{pr,phase,manual}, ref, expected_by:ISO}`) — import it from the INSERT audit, don't re-implement. **Seed empty** post-migration (baseline = 0).

### 6.6 Report-only default + owner-gated `--strict` + test wiring

Mirror `audit-relations.ts`'s CLI tail:
- default → print report (sites scanned, F1 inline hits by dialect, `UNKNOWN-SHAPE`, allowlist drift/hygiene), **`exit 0` always**.
- `--json` → machine output.
- `--strict` → `process.exit(1)` on any hand-rolled F1 inline (non-helper, non-allowlisted) OR any `UNKNOWN-SHAPE` OR allowlist hygiene issue (+ `UNCLASSIFIED-JS` if Engine B is shipped).
- CLI guard: `if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))` so pure functions are unit-importable without firing the walk.

**Test wiring recommendation (single PR, G1–G4 together):**
1. Land helper + migrate all 19 F1 sites → baseline provably clean (§5).
2. Ship the audit report-only by default (matches the sibling-audit convention).
3. In the **same** PR, wire `audit:draft-status-reads --strict` into the `pnpm test` script **immediately after** `audit:draft-status`, and add it to the pre-PR checklist line in root `CLAUDE.md`.

Because baseline = 0, the strict gate cannot block on pre-existing stragglers, and it is what actually *closes* 红线-4 on the SELECT side. This is the meaningful divergence from `audit:relations` (whose live dead-edge blocks a strict-in-test wire — here nothing does). Add an OWNER-DECISION-PENDING docblock stating this clean-state-is-immediately-achievable rationale. **Fallback if the owner prefers max caution:** land report-only first, flip `--strict`-in-`pnpm test` in a fast follow-up after one eyeballed clean run.

---

## 7. Exclusions (do not touch)

### 7.1 Family-2 sites

All of §2.2 + §2.4. Fail-closed / UI logic; folding any into the helper is a behavior change (tests pass today because behavior is identical — that is the trap, not a green light).

### 7.2 Container-read exemption — `active-question.ts` (LIVE, correct)

`src/capabilities/copilot/server/teaching/active-question.ts:64-74` — `getActiveQuestionState` reads `question` by `eq(question.source,'teaching_check')` + `session_id`, with **no `draft_status` filter at all**. Intentional: the `teaching_check` container question is itself a draft; a non-draft filter would hide it. **No audit handling needed** — it contains zero F1 shapes, so Engine A never fires. List it in a doc comment (KNOWN-INTENTIONAL-NO-FILTER container reads) for future maintainers, not in the executable exclusion set.

### 7.3 Container-read exemption — `note-page.ts` (STALE — register correction, C1)

`src/capabilities/notes/server/note-page.ts` **no longer reads the `question` table at all.** Verified: its only `question` reference is a comment at line 11 (`// YUK-358 决定3: embedded-check question projection removed`); zero `.from(question)`. The register's red-line-3 citing note-page.ts as a live container-read points at a read deleted in YUK-358.

- **Audit impact:** none — no question read, no predicate; drop it from any "reads-questions-without-filter" list.
- **Action (C1):** correct the register text (`docs/design/2026-07-02-project-logic-master-register.md`, the § draft-status-pool-gate note ~line 541) to list only `active-question.ts`. Captured as a YUK-569 doc-hygiene follow-up (§10).

### 7.4 The forbidden NULL-backfill (explicitly out of scope)

`schema.ts:304` is `text('draft_status')` — **nullable, NO `NOT NULL DEFAULT`**, confirming a backfill (`UPDATE … SET draft_status='active' WHERE NULL` + `NOT NULL DEFAULT 'active'`) is a **separate decision**. Why out of scope: (a) it collides with family-2 exact-match gates that treat NULL as explicitly-not-'active'; (b) it entangles the `write.ts` soft-delete decision (NULL≡active is the fail-open contract those consumers rely on). Any enum/backfill move requires a full prior inventory of every `=== 'active'`/`=== 'draft'`/`eq(col,'active'|'draft')` site — not this task.

---

## 8. Test plan

### 8.1 Helper unit tests (`src/db/predicates.test.ts`, no-DB unit)

- **Drizzle truth table:** for each value class {NULL, 'draft', 'active', 'final', arbitrary}, execute `notDraftPredicate` against a real Postgres row (DB test) OR assert the compiled SQL shape (unit). Prefer a DB test that inserts one row per class and asserts pool-visibility exactly matches §5.1.
- **JS truth table:** `isPoolVisible({draft_status: x})` for all value classes incl. `null` → matches §5.1 column 4.
- **Equivalence assertion:** parametrized test proving `isPoolVisible` and the SQL predicate agree on every value class (guards against future divergence).

### 8.2 Per-site regression (existing tests are the safety net)

Every one of the 19 F1 sites is already individually tested. Run the **full** touched-file test set (not targeted) after migration:
- practice server/jobs tests (placement-select, variant-rotation, stream-store, due-list, recalibration_nightly, kt_estimate_nightly, matcher).
- server tests (target-discovery, source_verify, write, pool-fetch, context-readers, list, fewshot-retrieve).
- Pre-PR: `pnpm typecheck` (after all edits incl. biome --write), `pnpm lint`, `pnpm audit:schema`, `pnpm audit:partition`, `pnpm audit:profile`, `pnpm audit:draft-status`, the new `pnpm audit:draft-status-reads`, `pnpm test`, `pnpm build`.

### 8.3 Audit-script tests (`scripts/audit-draft-status-reads.test.ts`)

Mirror `audit-draft-status.test.ts`. Cover: D1/R1/R2 positive detection (incl. reordered `or(ne,isNull)` and bare-column raw form); comment/string prose NOT flagged; F2 `eq()`/`=== 'active'` NOT flagged; helper-def file excluded via constant + sentinel-marker reverse-check fails loud when marker removed; `UNKNOWN-SHAPE` emitted for a synthetic novel dialect; allowlist hygiene (`resolves_when` shape) rejects malformed entries; `--strict` exit code 1 on a planted violation, 0 on clean tree.

---

## 9. Rollback

- **Helper migration** is pure substitution: `notDraftPredicate(col)` / `isPoolVisible(row)` are behavior-identical to the inline forms (§5). Revert = inline the predicate back at any site, or `git revert` the PR. No data migration, no schema change, nothing to un-backfill.
- **Audit script** is report-only by default and, when strict-wired, gates on a baseline that the same PR makes clean — so reverting the migration and the audit together (single PR) leaves no orphaned failing gate. If only the audit needs backing out, drop the `pnpm test` wire line; the script itself is inert without `--strict`.
- No production runtime behavior changes at any point (result sets identical), so there is no deploy-time rollback concern.

---

## 10. Open questions for owner

Behavior-preserving DRY, so almost none. Genuine judgment calls only. **All three were ACCEPTED autonomously and implemented in this PR (behavior-preserving DRY, YUK-569); per-item resolutions inline below.**

1. **Include the JS twin helper `isPoolVisible` now, or defer? (RECOMMEND INCLUDE.)** Only 2 sites (`variant-rotation.ts:127`, `matcher.ts:502`), but they carry the same copy-paste hole as the Drizzle side, and a named JS anchor makes the future in-memory story consistent. Defer is defensible (small surface); if deferred, the audit must flag the 2 twins as known-uncovered (§6.3). Mandatory either way: the C4 guard comments at the 4 F2 look-alikes. **ACCEPTED — INCLUDED: both JS twins (variant-rotation.ts `isNonDraft`, matcher.ts:502) now route through `isPoolVisible`; the 4 C4 guard comments shipped.**
2. **Wire `audit:draft-status-reads --strict` into `pnpm test` in this same PR, or land report-only first? (RECOMMEND same-PR strict.)** Baseline = 0 after migration makes strict non-flaky and it is what closes 红线-4 on the read side. Fallback: report-only now, flip strict in a fast follow-up (§6.6). **ACCEPTED — SAME-PR STRICT: `pnpm audit:draft-status-reads --strict` wired into the `pnpm test` composite immediately after `audit:draft-status`, plus the pre-PR checklist in root CLAUDE.md; baseline = 0.**
3. **Migrate the 2 `IS DISTINCT FROM` sites to the helper (SQL text changes, result identical), or leave them? (RECOMMEND migrate.)** Uniformity vs. literal-SQL invariance; result is byte-identical either way (§5.3). **ACCEPTED — MIGRATED: both `IS DISTINCT FROM 'draft'` sites (recalibration_nightly.ts:140, kt_estimate_nightly.ts:145) now use the helper.**

None of these block the core DRY. All three have a clear recommended default; the owner override, if any, is stylistic.

### Follow-up captured under YUK-569
- **Register doc correction (C1):** `docs/design/2026-07-02-project-logic-master-register.md` § draft-status-pool-gate note (~line 541) — remove `note-page.ts` from the container-read exemptions (it no longer reads `question`; YUK-358); list only `active-question.ts`.

---

## Appendix A — Refuted concerns (do not re-litigate)

The adversarial critic attacked and CLEARED these; recorded so they are not re-opened.

- **R1 — F2 guards misclassified as F1?** CLEARED. Every `!== 'draft'` look-alike (`verify-and-promote.ts:147/256/303`, `proposal-appliers.ts:385`) is correctly bucketed F2. Migrating any would pass existing tests (behavior-identical today) but be a landmine — grounding navigated the trap.
- **R2 — hidden fail-closed-on-NULL predicate bucketed as F1?** CLEARED. Every executable bare `<> 'draft'` lacking a NULL guard was a **comment** line (due-list.ts:230, matcher.ts:499, source_verify.ts:239, context-readers.ts:877). All executable F1 sites carry the NULL guard or NULL-safe `IS DISTINCT FROM`.
- **R3 — exotic dialect FN (`NOT IN` / `coalesce` / `not(eq)` / `DISTINCT FROM 'active'`)?** CLEARED. Grep hits were comments only; no such executable variant exists at `81d67345`.
- **R4 — extra-conjunct fusion (helper drops/adds a condition)?** CLEARED. Every F1 predicate is a self-contained conjunct sitting SEPARATELY inside its `and(...)`; substitution drops/adds nothing. The one site with an extra `archived_at IS NULL` conjunct (`draft-review.ts:227`) is F2, not a target.
- **R5 — self-join alias risk on Drizzle sites?** CLEARED (structurally moot). A col-param helper reproduces `question.draft_status` exactly. Only the bare-column raw site (#15) carries qualification risk, verified safe (§5.4).
- **R6 — scope creep toward NULL-backfill / touching a container exemption?** CLEARED. `schema.ts:304` nullable-no-default confirms backfill is quarantined; `active-question.ts` has no F1 shape (invisible to the audit).
- **R7 — count/completeness?** CONFIRMED at 19 F1 code sites; UI `.tsx` sites correctly bucketed do-not-touch. No new or line-shifted site outside the inventory.
