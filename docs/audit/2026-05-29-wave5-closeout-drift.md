# Drift Audit — 2026-05-29 (Wave 5 closeout)

**Scope**: ADR-0006 / ADR-0011 / ADR-0014 / ADR-0017 / ADR-0018 / ADR-0020 / ADR-0021 / ADR-0022; active plans in `docs/superpowers/plans/` (master roadmap §5.1 Wave 5, T-D3 / T-D6 ready-to-launch); CLAUDE.md Layer 4 / Layer 8 architectural notes.
**Run by**: Devin (single-PR Wave 5 — covers YUK-118 / YUK-119 / YUK-120 / YUK-121 / YUK-122 / YUK-123 / YUK-124 / YUK-125; parents YUK-116 / YUK-117).
**Gate state**: typecheck / lint / audit:schema / audit:partition / audit:profile / `pnpm test:unit` (727) / `pnpm test:db` (1057 passing, 1 todo) / `pnpm build` all green.

## Summary

- Aligned: 18 decision points across ADR-0006 / 0011 / 0014 / 0017 / 0018 / 0020 / 0021 / 0022 + master roadmap §5.1
- Documented-only: 0
- Undocumented: 1
- Contradicted: 0
- Phase-deferred: 3 (informational; explicit downstream Wave 6/7 follow-ups)

## Findings

### ✅ Aligned (highlights)

#### [master roadmap §5.1 ↔ src/server/boss/handlers/coach_daily.ts + coach_weekly.ts + src/server/boss/handlers.ts]  T-D6/B Coach cron schedules ship

- **声明**: master-roadmap §5.1 Wave 5 — "Coach 跑每日 / 每周 cron 出'今日安排' proposal".
- **代码**:
  - `src/server/boss/handlers.ts` registers `coach_daily` (cron `0 4 * * *` Asia/Shanghai) + `coach_weekly` (cron `30 4 * * 0` Asia/Shanghai).
  - `src/server/boss/handlers/coach_daily.ts:runCoach()` builds the COACH allowlist MCP bridge + runs `CoachTask` via `runAgentTask` + writes `experimental:trigger_coach_scan` + `experimental:coach_scan` events on entry/exit.
  - `src/server/boss/handlers/coach_weekly.ts` delegates to the same `runCoach()` with `runKind='weekly'`.
- **状态**: aligned. Test coverage: `src/server/boss/handlers/coach_daily.test.ts` (3 cases).

#### [ADR-0006 §1.2 propose-only mutation policy ↔ src/server/ai/tools/proposal-tools.ts (Wave 5 additions)]  Coach writes are proposal-only

- **声明**: ADR-0006 §1.2 "Coach / Dreaming 类 agent 只可写 propose_* 事件，禁止直接 DB mutate".
- **代码**:
  - `propose_learning_item_defer` / `propose_learning_item_archive` (new in this wave) call `writeAiProposal` only.
  - `COACH_TOOLS` allowlist now contains `propose_learning_item_defer` / `propose_learning_item_archive` / `propose_knowledge_mutation` — all `effect: 'propose'`.
  - `actor_ref` defaults to `'coach'` so the proposal trail records originator.
- **状态**: aligned. Test coverage: `src/server/ai/tools/proposal-tools.test.ts` (`registerCoreTools exposes Wave 3 proposal and write tools`) + `src/server/ai/tools/allowlists.test.ts` (`expands Coach surface for plan_adjustments (defer / split / relearn / archive)`).

#### [ADR-0011 §1 ToolUseExperimental ↔ src/server/copilot/chat.ts]  Two-surface routing preserves agent mirror events

- **声明**: ADR-0011 §1 "Copilot tool-use 路径 → experimental:tool_use mirror with actor_kind='agent'".
- **代码**: `runCopilotChat` builds the MCP bridge with `callerActor: { kind: 'agent', ref: ... }` for both `chat` and `chip` surfaces. mcp-bridge.ts emits `experimental:tool_use` mirror events automatically. Test coverage: `src/server/copilot/chat.test.ts`.
- **状态**: aligned.

### ⚠️ Undocumented

#### [Wave 5 T-D3/C contract ↔ src/server/copilot/chat.ts]  New experimental actions `experimental:copilot_user_ask` / `experimental:copilot_chip_trigger` are not yet ADR-cataloged

- **声明**: Wave 5 ready-to-launch T-D3/C → "default chat 写 user ask event；chip-direct-trigger 不写 user ask event".
- **代码**: `src/server/copilot/chat.ts:96` writes `experimental:copilot_user_ask` (chat path) or `experimental:copilot_chip_trigger` (chip path). Both fall through the generic `ExperimentalEvent` shape (per ADR-0006 v2 / src/core/schema/event/experimental.ts §RESERVED_EXPERIMENTAL_ACTIONS escape hatch).
- **冲突**: ADR-0011 §1 lists `experimental:tool_use` as the only catalogued experimental action with a dedicated schema. The two new actions piggy-back on the generic `ExperimentalEvent` escape hatch; that's intentional (they're CopilotTask metadata, not yet stable enough for promotion). But there's no driver-doc / ADR entry that records the new action names and their payload shape, so future drift audits will not catch payload changes.
- **建议**: Wave 6 T-D7 already plans to promote `experimental:tool_use` → `KnownEvent`. Add `experimental:copilot_user_ask` + `experimental:copilot_chip_trigger` to that promotion sweep (or to an ADR-0011 erratum), recording payload shape (`surface`, `user_message`, optional `chip_kind`) and stabilization criteria.
- **Linear**: deferred to T-D7 / Wave 6 (not blocking Wave 5 ship).

### ⏳ Phase-deferred (informational, not drift)

1. **T-D5 — extend Copilot Drawer to other 5 routes (`/learn`, `/record`, `/mistakes`, `/knowledge`, `/inbox`)**. Explicitly out of scope per Wave 5 ready-to-launch; the `<CopilotDrawer>` primitive + `<ToolUseCard>` 三段式 + `useCopilotDwell` hook are reusable for Wave 6+ extension. master-roadmap leaves T-D5 unscheduled (no pts yet).
2. **T-D7 — promote `experimental:tool_use` to `KnownEvent`**. Wave 6, 3 pts, Worktree B.
3. **Coach prompts not stress-tested end-to-end against live mimo-v2.5-pro**. Cron handlers + `CoachTask` registry shipped; first real Coach run will happen on the day after merge (BJT 04:00) and emit `experimental:coach_scan` events that `/api/today/copilot-summary` already consumes. No mock data path needed — the placeholder copy `昨晚 Coach 还没出新计划` covers the gap until the first scan lands.

## Closeout sign-off

- 8 of 8 Wave 5 lanes implemented (T-D6/A B C D + T-D3/A B C D).
- All gate runs green at this snapshot (see header).
- Single-PR strategy: every lane carries a `Closes YUK-…` reference in the commit body; Linear status sweep (Backlog → In Progress → In Review) runs at PR open; → Done runs at merge.

— Devin, 2026-05-29
