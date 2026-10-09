# Conversation idle and Start ownership

This confirms the bounded future ownership under the existing non-UI migration authorization. It does not start an idle writer, reserve a migration number, or establish runtime correctness.

## Current check

Start worktree `/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor` is clean at `660532a76b0c2da0794d83e16e168b122871f2f9`. PR1623 is merged as `7472f4395f4a12a5167e33034d5d8af8bf695049`. This thread has no active writer or planned changes to the named Copilot/session/domain paths.

The read-only status inventory examined 77 registered worktrees; 75 were accessible. The only dirty proposed paths were in coordinator7631's active judge worktree: `assessment/attempt.ts`, `src/db/schema.ts`, the registrar, durable host, Drizzle journal and new0118. None of the three named Copilot files or `session/conversation.ts` was dirty. Two unavailable historical worktrees are excluded. This proves observed working-tree changes only; it does not rule out committed or unannounced work.

## Future coordinator ownership

After the judge writer releases and its shared changes are delivered, coordinator7631 may implement the following bounded idle extension from fresh main:

- New `src/db/conversation-activity-lock.ts` and transaction-local Conversation helpers in `src/server/session/conversation.ts`.
- `src/capabilities/copilot/server/conversation-writes.ts`, `server/durable-dispatch.ts` and `api/accept-chip.ts` for the actual user-event and acceptance transactions.
- `src/capabilities/practice/server/assessment/attempt.ts` for the existing capture insertion; first reconcile the final judge writer and lock order.
- The existing session family/backend/worker/operator, idle legacy handler, registrar/host collections, infra registration and observability manifest, additive schema/migration and scoped tests needed for this family. Retain one DBOS lifecycle and the common producer-fence installer lock.

0118 remains exclusively judge-owned. Idle gets no number until fresh inventory. Preserve orphan version1/workflow identities while extending the existing four physical tables for explicit idle version2 contracts. No generic runner, duplicate transition writer or parallel recovery owner is authorized. Necessary exact audit producer declarations must describe real writers or migration seeds; do not add broad allowances.

## Behavioral constraints

Keep the five-minute clock based on user events, with the existing started_at fallback. Do not substitute updated_at or introduce a resume grace period. Delayed ticks freeze their scheduled cutoff and first committed admission snapshot; do not claim every tick scheduled before a resume is automatically disallowed.

A new chat acceptance must recheck or resume within its accepted-input transaction through Conversation. An idempotent replay must not touch or resume the session. Chip acceptance remains strict and must not resume; preserve the existing separate proposal-commit boundary and make a final conflict explicit. Formal capture preserves its timestamp and no-resume semantics. Never hold these locks around model/provider work.

The lock graph, fresh post-lock statement, microsecond clock comparisons, phantom insertion protection and unknown-COMMIT handling still require real regression evidence. Source inspection and this ownership agreement do not prove deadlock freedom. Test each real writer in both race orders, the find/reserve gap, replay, ABA, delayed ticks and old-family recovery. Quiesce old binaries that do not participate in the new coordination before claiming the guarantee; schema compatibility is not mixed-version safety.

Start, UI/routes, app bootstrap, shutdown, generic SSE, kernel activation/event writer, planner and memory stay outside this transfer. Future Start consumers call delivered public operations and do not duplicate coordination. A concrete additional file or behavior change requires another overlap check, not a second writer.

## Evidence

Inventory timestamp: `2026-10-08T22:55:52.585904+00:00`. Local receipt: `/tmp/yuk1358-idle-scope-ownership-20261009.json`; SHA256 `cc41034a04ea48e455d0de96366ae1ef2726c56979119f8ba6c957c75bcc3608`. Read-only design: `/tmp/yuk1355-idle-clock-boundary-design-20261009.md`; SHA256 `9a2b7983d6263657983edcbec10d7d445c49aa6c19f1517ff10df3a3062b6a0a`. The design pins main96077; it must be reconciled against the final judge revision before implementation. No DB, container, provider, runtime lock or deployment was used in this check.
