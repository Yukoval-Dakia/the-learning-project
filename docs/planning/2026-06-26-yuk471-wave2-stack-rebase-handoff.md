# YUK-471 Wave 2 stack — rebase/merge handoff (owner executes)

> Driver merged #592 (retract tx) + #593 (cascade) cleanly → `main @ d543d9e5`.
> The Wave 2 stack (#595 goal → #597 mistake_variant → #599 learning_item) needs rebasing onto
> post-#592 main. Conflict is **only `src/server/proposals/actions.ts`** and **only** because #592
> wrapped `retractAiProposal` in a single `db.transaction(async (tx) => {…})`. Rebase-merge needs a
> force-push (git-guard blocks it for the agent), so owner runs the pushes.

## The conflict, in one sentence
Each Wave 2 branch forked **before** #592, so it added its kind-block on bare `db.` at the
top-level of `retractAiProposal`. On main that function is now fully inside
`db.transaction(async (tx) => {…})` with every write on `tx`. **Resolution = keep main's tx
wrapper; move each branch's new block inside it; replace that block's `db.` → `tx.`; hoist the
branch's `const correctionAt = new Date()` to just before the in-tx `writeEvent` and feed it to the
correct event's `created_at` (so HIGH-1 single-clock survives the tx-wrap — the block was authored
to anchor on exactly this).**

## Order (bottom-up; retarget base to main as each merges)
1. `#595 goal` — rebase onto `origin/main`, resolve `actions.ts`, force-push, merge (rebase).
2. `#597 mistake_variant` — `gh pr edit 597 --base main`; rebase onto `origin/main`, resolve, force-push, merge.
3. `#599 learning_item` — `gh pr edit 599 --base main`; rebase onto `origin/main`, resolve, force-push, merge.

Each branch carries **2 commits** (feat + review-fix), so expect the `actions.ts` conflict to
surface on the commit that touches the retract block (and possibly re-surface on the fixup —
resolve identically).

## Per-branch resolution specifics (`actions.ts` retract block)

### #595 goal — `goal_scope` block
- Hoist `const correctionAt = new Date();` to inside the tx, **before** `writeEvent(tx, …)`; set that event's `created_at: correctionAt` (replaces main's inline `new Date()`).
- The `goal_scope` block becomes (inside the tx, using `tx`):
  ```
  if (proposal.kind === 'goal_scope' && proposal.target.subject_id) {
    const goalId = proposal.target.subject_id;
    if (projectionIsWriter('goal')) {
      await projectGoalGuarded(tx, goalId);
    } else {
      await tx.update(goal).set({ status: 'dormant', updated_at: correctionAt })
        .where(and(eq(goal.id, goalId), eq(goal.status, 'active')));
      const [written] = await tx.select().from(goal).where(eq(goal.id, goalId)).limit(1);
      await assertGoalParity(tx, goalId, written ? goalLiveRowToSnapshot(written) : null);
    }
  }
  ```
- Keep the new imports (`projectGoalGuarded`, `assertGoalParity`, `goalLiveRowToSnapshot`).
- **Drop** the branch's now-redundant `correctionAt` comment block duplication if it conflicts — main already has the single-tx rationale; keep one coherent comment.

### #597 mistake_variant — `variant_question` dismiss + retract
- `variant_question` retract block already on main (uses `tx`); the branch additionally write-throughs the variant projection. Port the write-through inside the tx on `tx`.
- The branch also threads `rate_at` out of `writeGenericRateEvent` and destructures it at the dismiss HTTP boundary — those edits are **outside** `retractAiProposal` (dismiss path / `DismissAiProposalResult`), should apply clean; only the retract write-through is in the conflict zone.

### #599 learning_item — `learning_item` archive block
- The `learning_item` block on main archives the rows; the branch replaces it with: genesis-if-missing (clamped `created_at = min(item.updated_at, correctionAt-1ms)`) + `learning_item_archive` event + write-through, all reusing `correctionAt`.
- **Leave the `artifact` archive UPDATE AS-IS** (the `⚠️ W3 COUPLING` comment) — it's a Wave-3 entity, intentionally not event-sourced here.
- Port all writes onto `tx`.

## Verify each branch after resolving (before force-push)
In the branch's worktree:
```
pnpm typecheck
pnpm exec biome check src/server/proposals/actions.ts
pnpm vitest run --config vitest.db.config.ts \
  src/server/proposals/actions.test.ts \
  src/server/projections/<entity>.db.test.ts
```
The retract suite (`actions.test.ts`) + the entity parity test are the load-bearing gates — they
assert `fold==row` through the real `retractAiProposal`, so they catch a wrong tx-port.

## Commands per branch (example: goal)
```
cd /Users/yukoval/yukoval-projects/tlp-wt-w2goal
git fetch origin && git rebase origin/main
# resolve actions.ts per above → git add → git rebase --continue (repeat for the fixup commit)
# verify (above)
git push --force-with-lease origin yuk-471-w2-goal-fold
gh pr merge 595 --rebase
```
Then repeat for #597 (retarget `--base main` first) and #599.

## Why the agent stopped here
`git-guard.mjs` blocks `git push --force` / `--force-with-lease` (rewrites shared history).
Per project rule the agent does not bypass git-guard, so the force-push is owner-run. The agent can
do the resolution + verification in the worktrees and hand back the force-push commands if you'd
rather split it that way — just say so.
