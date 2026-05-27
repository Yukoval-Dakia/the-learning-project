# Wave 1 Post-Ship Iter-2 — Code-Review Findings Fix Plan

> Lane plan written on fresh PR #163 HEAD (`50b407c`) inside worktree
> `worktrees/iter2-postship-fixes/`. Driver = `/code-review` xhigh-effort run
> against PR #163, returning 15 ranked findings (5 P1 + 3 P2 + 7 P3).

**Lane**: iter2-postship
**Branch**: `lane/iter2-postship-fixes-2026-05-27`
**Base**: PR #163 HEAD `50b407c` (closeout commit on top of f5e27ef / 013a9ad)
**Linear**: TBD per finding cluster — primary follow-up will be YUK-101 (outbox).

## 0. Scope

13 in-PR fixes + 1 Linear follow-up (architectural):

| ID  | Finding                                            | Fix                                              | Severity |
| --- | -------------------------------------------------- | ------------------------------------------------ | -------- |
| F1  | judgeAdvicePayload gate excludes server-judge path | gate on `judgeResult !== null`                   | P1       |
| F2  | "daily sweep is belt-and-braces" claim is wrong    | docs + link to YUK-101                           | P1       |
| F3  | writeEvent enqueue not actually fire-and-forget    | `void ... .catch(...)`                           | P1       |
| F4  | duplicate enqueue on onConflictDoNothing no-op     | `singletonKey: memory.ingest.${eventId}`         | P1       |
| F5  | (subsumed by F3)                                   | —                                                | P1       |
| F6  | no test exercises real boss path                   | add DB integration test                          | P2       |
| F7  | cold-start race vs boss.createQueue                | catch-and-create-queue retry once                | P2       |
| F8  | limit:1 masks older-with-cause attempts            | scan attempts; helper folds                      | P2       |
| F9  | identical log prefix layers                        | `[memory-ingest]` vs `[writeEvent]`              | P3       |
| F11 | redundant outer try/catch                          | drop outer                                       | P3       |
| F12 | duplicated seed helpers + ADR-0005 bypass          | `tests/helpers/event-seed.ts` via writeEvent     | P3       |
| F13 | duplicated cause resolution between routes         | `resolveAdviceCauseForQuestion(db, q)`           | P3       |
| F14 | lane plan §1.1 #4 doc drift                        | correct the §                                    | P3       |
| F15 | no admin-script escape hatch                       | `SKIP_BOSS_INGEST` env                           | P3       |
| L101 | altitude #10 outbox                               | Linear YUK-101 (separate phase)                  | P3       |

**Out of scope** (deferred to YUK-101): adding `event.ingest_at TIMESTAMP NULL`,
new poller, ADR amendment. F3+F4 band-aids are explicit phase-deferred —
comments will point at YUK-101.

## 1. Commit topology

Plan to land 5 commits on `lane/iter2-postship-fixes-2026-05-27`:

1. **`fix(review): thread cause into judge_advice for server-judge path`** — F1
2. **`fix(memory): writeEvent fire-and-forget + dedupe + cold-start retry`** — F3 + F4 + F7 + F9 + F11 + F15
3. **`fix(review): scan attempts until first cause-bearing`** — F8 + F13
4. **`refactor(tests): extract event-seed helper`** — F12
5. **`docs(audit): correct sweep recovery claim + lane plan drift`** — F2 + F14, references YUK-101

Then file Linear YUK-101 separately (L101).

## 2. Pre-PR gate

按 CLAUDE.md «Before PR»：

```
pnpm typecheck
pnpm lint
pnpm audit:schema
pnpm audit:partition
pnpm audit:profile
pnpm test
pnpm build
```

全绿 → 不 push（waiting for user）。

## 3. Risk / 显式不变

- **CC-1 invariant preserved**: route handlers still don't classify cause; F8
  changes ONLY which prior attempt's cause is read.
- **ADR-0005 invariant preserved**: test seeders refactored to go through
  writeEvent; raw `db.insert(event)` from tests is eliminated.
- **Backwards compat**: F12 helper refactor must not change the test fixture
  shape that hits prod path — verify mistake-mirror addition is opt-in.
- **F3 risk**: switching `await` → `void ... .catch()` changes ordering — the
  `event` INSERT still commits before writeEvent returns; only the enqueue
  becomes async. Phase-deferred comment must call out: in pre-YUK-101 state,
  a tx-rollback caller still leaks an orphan job (handler no-ops on missing
  row + F4 singletonKey dedupes future writes); YUK-101 outbox dissolves this.
