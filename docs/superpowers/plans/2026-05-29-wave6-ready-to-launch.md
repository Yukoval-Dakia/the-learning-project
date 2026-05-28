# Wave 6 Ready-to-Launch — Living Note v0 + experimental:tool_use promote

> 状态：ready-to-launch draft as of 2026-05-29。按 master roadmap §5.1 Wave 6，本 wave 把 Living Note mutator（T-88 P4）全 ship + ADR-0011 promotion 闭环（T-D7）。~3 周 cadence，收口后 Layer 5 Living Note v0 兑现 + Layer 8 experimental 命名空间闭环。

## Source of truth

- `docs/superpowers/status.md` 当前 Phase 行：Wave 5 进行中，下一站 Wave 6。
- `docs/superpowers/plans/2026-05-27-master-roadmap.md` §5.1 Wave 6 + §2.2 T-88 + §2.3 T-D7 + §Card T-88。
- T-88 P4 source spec：`docs/superpowers/plans/2026-05-26-yuk88-block-tree-rebuild-phase.md` §P4 lane 切分 + `docs/superpowers/plans/2026-05-26-yuk88-autonomous-driver.md` §XC-1/XC-2 cross-cutting constraints。
- T-88 P4 Linear parent：[YUK-94](https://linear.app/yukoval-studios/issue/YUK-94) (Backlog, 10 pts, parent YUK-88)。
- T-D7 source spec：`docs/adr/0011-tool-use-and-edge-event-paths.md` §1 stabilization criteria + 晋升路径。
- T-PD doc sweep items：master roadmap §2.7 T-PD1..PD13。

## Preflight state

| Item | State | Evidence / action |
|---|---|---|
| `origin/main` | ✅ at `891b29a` (Wave 5 decisions locked) | Re-verify main tip before branching lanes. |
| Wave 5 full gate | ⬜ pending — Wave 5 must ship before Wave 6 starts | Wave 6 lanes do NOT branch until Wave 5 closeout PR is merged and full gate green. |
| T-88 P0-P3 | ✅ shipped Waves 1-4 | P0 spike (PR #162) + P1 schema (YUK-91) + P2-basic editor (YUK-92) + P3 AI pipeline (YUK-93, PR #174). |
| T-88 P4 parent issue | ✅ [YUK-94](https://linear.app/yukoval-studios/issue/YUK-94) exists (Backlog) | Lane sub-issues created: [YUK-127](https://linear.app/yukoval-studios/issue/YUK-127) / [YUK-128](https://linear.app/yukoval-studios/issue/YUK-128) / [YUK-129](https://linear.app/yukoval-studios/issue/YUK-129) / [YUK-130](https://linear.app/yukoval-studios/issue/YUK-130) / [YUK-131](https://linear.app/yukoval-studios/issue/YUK-131). |
| P3 → P4 sequential dep | ✅ P3 merged to main as `d99c3bb` | P4 mutator patch op schema depends on P3 patch op definitions — satisfied. |
| NoteRefineTask queue slot | ⬜ to be created in P4 Lane A | pg-boss `note_refine` queue + handler registration. |
| Editing session coordination | ⬜ no existing heartbeat / idle system | P4 Lane C builds this from scratch (ephemeral in-memory state). |
| T-D7 stabilization criteria | ⬜ pending — needs 3 tools stable × 2 weeks post-Wave 5 | Per ADR-0011 §1: ≥ 3 tool 真实落地 + payload shape 稳定 2 周 + v2.1 design 已实装。Wave 5 T-D3 ships drawer tool-use → 2 weeks after that T-D7 can promote. |
| `experimental:tool_use` event count | ✅ schema live since YUK-82 | `src/core/schema/event/experimental.ts` ToolUseExperimental shape stable. |
| T-PD gap-filler pool | ⬜ master roadmap §2.7 lists 13 items (~31pt total) | Pick ~5pt from pool for Wave 6 gaps. |

## Wave 6 scope

| Lane | 子项 | pts | Linear | Branch intent | Worktree |
|---|---|---|---|---|---|
| **T-88/P4-A** | `NoteRefineTask` registration + patch op schema (`insert_after` / `replace_block` / `delete_block` / `append_block`) + apply 落 event | 3 | [YUK-127](https://linear.app/yukoval-studios/issue/YUK-127) | `yuk-P4A-note-refine-task` | A |
| **T-88/P4-B** | Mutator-mode apply pipeline (idle 直接落库) + propose-mode 分级 (激进 mutation 走 propose) | 2 | [YUK-128](https://linear.app/yukoval-studios/issue/YUK-128) | `yuk-P4B-mutator-apply` | A |
| **T-88/P4-C** | Editing session 协调 (client presence heartbeat + server idle detection + queue flush) | 2 | [YUK-129](https://linear.app/yukoval-studios/issue/YUK-129) | `yuk-P4C-editing-session` | A |
| **T-88/P4-D** | Undo 集中入口 (`/today` 活动卡 + artifact 页 "AI 改动" tab + 批量 undo) | 1 | [YUK-130](https://linear.app/yukoval-studios/issue/YUK-130) | `yuk-P4D-undo-ui` | A |
| **T-88/P4-E** | 5 trigger producers 接入 (mark_wrong / mastery / 错误率 / dwell / dreaming) | 2 | [YUK-131](https://linear.app/yukoval-studios/issue/YUK-131) | `yuk-P4E-trigger-producers` | A |
| **T-D7** | `experimental:tool_use` → `tool_use` KnownEvent promote：Zod schema rename + DB migration + ADR-0011 revision + event consumer sweep | 3 | [YUK-126](https://linear.app/yukoval-studios/issue/YUK-126) | `yuk-TD7-tool-use-promote` | B |
| **T-PD** | Doc sweep gap-filler (~5pt from §2.7 pool)：建议优先 T-PD8 modules doc 大 sweep 部分或 T-PD1 + T-PD4 + T-PD11 小项组合 | ~5 | N/A | doc-only / minor | gap (any worktree) |

Parents: [YUK-94](https://linear.app/yukoval-studios/issue/YUK-94) (T-88 P4, 10 pts) + [YUK-126](https://linear.app/yukoval-studios/issue/YUK-126) (T-D7, 3 pts). Milestone: M6 — experimental:tool_use promote to KnownEvent (target 2026-07-24). T-PD uses existing issues or ad-hoc commits.

总计：**~18 pts**（master roadmap §5.1 Wave 6 估算一致）。

## Chain order

1. **Wave 5 must be fully shipped and closed before any Wave 6 lane branches from `main`**. Verify: Wave 5 closeout PR merged + full gate green + `docs/superpowers/status.md` updated to "Wave 5 ✅".
2. **Worktree A (T-88 P4) is the primary track**. Lanes are sequential: A → B → C → D → E。`NoteRefineTask` patch op schema must land before mutator-mode can consume it; editing session must land before undo UI can depend on idle state; trigger producers are last because they depend on the full pipeline.
3. **Worktree B (T-D7) starts after Wave 5 Drawer tool-use has been live ≥ 2 weeks**. Stabilization criteria (ADR-0011 §1): ≥ 3 DomainTools with `experimental:tool_use` mirror calls + payload shape unchanged for 2 weeks. **Gate**: `SELECT COUNT(DISTINCT payload->>'tool_name') FROM event WHERE action = 'experimental:tool_use' AND created_at > NOW() - INTERVAL '14 days'` must return ≥ 3. If Wave 5 ships on schedule (~week of 2026-07-07), T-D7 can kick off ~2026-07-21.
4. **T-D7 is file-disjoint with T-88 P4**: T-D7 touches `src/core/schema/event/experimental.ts` + `src/core/schema/event/index.ts` + `src/server/ai/tools/mcp-bridge.ts` + migration file + ADR-0011. T-88 P4 touches `src/server/boss/handlers/` + `src/server/blocks/` + `src/ai/` + editor UI. No file conflicts expected — can run parallel in separate worktrees.
5. **T-PD lane runs in any capacity gap**. No dependency on either primary track.

## T-D7 promotion checklist (ADR-0011 §1)

Per ADR-0011 §1 stabilization criteria, the following must be verified before T-D7 kickoff:

1. **≥ 3 tools landed**: After Wave 5, the full DomainTool registry will have 13+ read tools + 8 propose/write tools = well over 3. ✓ (pre-satisfied by Wave 2/3)
2. **Payload shape stable 2 weeks**: `ToolUseExperimental` in `src/core/schema/event/experimental.ts` must have no field additions/removals for ≥ 14 days post-Wave 5 ship. Verify with `git log --since='14 days ago' -- src/core/schema/event/experimental.ts`.
3. **v2.1 design implemented**: Wave 5 T-D3 ships the Copilot drawer + tool-use 三段式 UI → satisfies "v2.1 design 已实装" criterion.
4. **cost_micro_usd decision**: Current schema has `cost_micro_usd` as optional field on the event. If this shape is kept in the promoted `tool_use` action, note it in the ADR-0011 revision.

### Promotion PR content (T-D7)

Per ADR-0011 §1 晋升路径:

1. **Zod schema rename**: `ToolUseExperimental` → `ToolUseQuery`; `action: z.literal('experimental:tool_use')` → `action: z.literal('tool_use')`.
2. **DB migration**: `UPDATE event SET action = 'tool_use' WHERE action = 'experimental:tool_use'`.
3. **Event union update**: Move from experimental import to KnownEvent discriminated union in `src/core/schema/event/index.ts`.
4. **Consumer sweep**: `mcp-bridge.ts` + any event query filters referencing `'experimental:tool_use'` string literal → update to `'tool_use'`.
5. **ADR-0011 revision**: Add §1.1 "Promotion record" with date, PR ref, and stabilization evidence.
6. **status.md update**: Mark Foundation D M6 as ✅.

## Wave gate

Before declaring Wave 6 complete:

```bash
CODEX_FULL_GATE=1 pnpm typecheck
CODEX_FULL_GATE=1 pnpm lint
CODEX_FULL_GATE=1 pnpm audit:schema
CODEX_FULL_GATE=1 pnpm audit:partition
CODEX_FULL_GATE=1 pnpm audit:profile
CODEX_FULL_GATE=1 pnpm test
CODEX_FULL_GATE=1 pnpm build
```

UI smoke (manual, pre-merge of P4-E)：

- `pnpm dev` → 打开一篇有 embedded check 的 atomic note
- 标记一个 block 为 "错误" → 期望 `NoteRefineTask` 触发（check pg-boss `note_refine` queue）
- 如用户正在编辑，patch 应 defer → blur 后 apply → 验证 block 更新
- `/today` 活动卡：看到 24h AI 改动 digest + 单条 undo 可点
- artifact 页 "AI 改动" tab：看到改动 timeline + 单条 undo + 批量 undo
- undo 一条改动 → block 回退到 pre-patch 状态

T-D7 smoke (post-promote)：

- `SELECT action FROM event WHERE action = 'tool_use' LIMIT 1` → 有结果（旧 `experimental:tool_use` 已迁移）
- `SELECT action FROM event WHERE action = 'experimental:tool_use'` → 0 行
- `pnpm typecheck` clean（无 `ToolUseExperimental` 残留引用）

Then run `/audit-drift`, update `docs/superpowers/status.md`, refresh master-roadmap §5.1 Wave 6 to "shipped" with PR refs, reconcile Linear states.

## Human decision points (to lock before lane kickoff)

- **T-88 P4 mutator-mode threshold**: What constitutes "小 patch" (mutator-mode, 直接落库) vs "激进 mutation" (propose-mode, 需用户 accept)? Proposed rule: ≤ 3 patch ops AND ≤ 2 new blocks → mutator; else → propose. **Needs lock**.
- **Editing session timeout**: How long without heartbeat before server considers user "idle"? Proposed: 15 seconds (matches YUK-94 description). **Needs lock**.
- **T-88 P4-E trigger signals v0 subset**: All 5 triggers (mark_wrong / mastery / 错误率 / dwell / dreaming) in v0, or ship a subset first? Proposed: ship all 5 — they share the same `note_refine` queue interface. **Needs lock**.
- **T-PD items selection**: Which of T-PD1..PD13 to pick for this wave's ~5pt budget? Proposed: T-PD1 (2pt) + T-PD4 (2pt) + T-PD11 (1pt) — small, independent, high leverage. **Needs lock**.

## Final lane state (待 wave 跑完填写)

| Lane | Status | Blocked by | Notes |
|---|---|---|---|
| T-88/P4-A ([YUK-127](https://linear.app/yukoval-studios/issue/YUK-127)) | ⬜ | Wave 5 ✅ | NoteRefineTask + patch op schema |
| T-88/P4-B ([YUK-128](https://linear.app/yukoval-studios/issue/YUK-128)) | ⬜ | P4-A | mutator + propose 分级 |
| T-88/P4-C ([YUK-129](https://linear.app/yukoval-studios/issue/YUK-129)) | ⬜ | P4-B | editing session 协调 |
| T-88/P4-D ([YUK-130](https://linear.app/yukoval-studios/issue/YUK-130)) | ⬜ | P4-C | undo UI |
| T-88/P4-E ([YUK-131](https://linear.app/yukoval-studios/issue/YUK-131)) | ⬜ | P4-D | trigger producers |
| T-D7 ([YUK-126](https://linear.app/yukoval-studios/issue/YUK-126)) | ⬜ | Wave 5 ✅ + 2 weeks stable | promote KnownEvent |
| T-PD | ⬜ | none | gap-filler |
