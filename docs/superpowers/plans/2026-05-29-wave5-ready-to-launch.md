# Wave 5 Ready-to-Launch — Drawer `/today` MVP + Global Coach Orchestrator

> 状态：ready-to-launch draft as of 2026-05-29。按 master roadmap §5.1 Wave 5，本 wave 把 Layer 8（drawer + coach）落到 `/today` 试点，是 vision 兑现起点。两条 active track 上限内的双 worktree 并行。

## Source of truth

- `docs/superpowers/status.md` 当前 Phase 行：Wave 4 ✅ closeout 完成，下一站 Wave 5。
- `docs/superpowers/plans/2026-05-27-master-roadmap.md` §5.1 Wave 5 + §3.2 长链 1 + §Card T-D3 / §Card T-D6 / §Q3 (`/today` summary-driven 选址决策).
- T-D3 source design：`docs/design/2026-05-15-design-brief-v2.1.md` §1.2（30s dwell trigger）+ §1.6（tool-use 三段式 + `<ToolUseCard>` primitive + 6 tool SEED）+ `docs/design/loom-design-v2.1/` 全套。
- T-D6 source spec：`docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md` §Phase 3 Global Coach Orchestrator（每天/每周 run、今日主目标、今日复习 session、最多 1 个轻量新内容、周复盘、计划调整、Maintenance 全走可回滚 proposal）+ §完成标准 ("用户打开系统时不需要从多个模块里自己找下一步").
- Allowlist surfaces 已 pre-staged：`src/server/ai/tools/allowlists.ts` 含 `COPILOT_TOOLS` + `COACH_TOOLS`，本 wave 直接消费，不动 surface 枚举。

## Preflight state

| Item | State | Evidence / action |
|---|---|---|
| `origin/main` | ✅ at `d99c3bb1` (Wave 4 merge); Wave 4 closeout PR #175 待 merge | Re-fetch + merge PR #175 before branching lanes. |
| Wave 4 full gate | ✅ post-merge clean install + full gate green | Per `docs/audit/2026-05-28-wave4-closeout-drift.md`. |
| T-D2 read tools | ✅ shipped Wave 2 | `query_review_due` / `query_memory_brief` / `query_learning_item_context` / `query_records` / `expand_knowledge_subgraph` 等 10 个 M2 readers 可用。Drawer summary 直接消费。 |
| T-DR Dreaming Lane | ✅ shipped Wave 4 | `dreaming_nightly` 跑通；Coach 可参考 handler 模板。 |
| T-D4 propose/write tools | ✅ shipped Wave 3 | Coach `propose_*` 全套 ready；不需要新 mutator。 |
| T-37 brief writer | ✅ shipped Wave 1 | `memory_brief_note` 三窗口 markdown 可读；`query_memory_brief` 已暴露。 |
| `/today` page | ✅ baseline live (`app/(app)/today/page.tsx`) | KPI 卡片 + proposal 列表 + cost ribbon 全在；只需挂 Drawer。 |
| Coach surface | ✅ allowlist `'coach'` + `COACH_TOOLS` 已定义 | Pre-staged in `src/server/ai/tools/allowlists.ts:46/86`. |
| Copilot surface | ✅ allowlist `'copilot'` + `COPILOT_TOOLS` 已定义 | Same file，drawer 直接复用。 |
| `experimental:tool_use` mirror | ✅ 写路径稳定 | `src/server/ai/tools/mcp-bridge.ts` 跑通；drawer UI 消费这层 event。 |
| Linear T-D3 parent + lanes | ✅ 已建 | [YUK-117](https://linear.app/yukoval-studios/issue/YUK-117) parent + [YUK-122](https://linear.app/yukoval-studios/issue/YUK-122) / [YUK-123](https://linear.app/yukoval-studios/issue/YUK-123) / [YUK-124](https://linear.app/yukoval-studios/issue/YUK-124) / [YUK-125](https://linear.app/yukoval-studios/issue/YUK-125) lanes (Backlog)。 |
| Linear T-D6 parent + lanes | ✅ 已建 | [YUK-116](https://linear.app/yukoval-studios/issue/YUK-116) parent + [YUK-118](https://linear.app/yukoval-studios/issue/YUK-118) / [YUK-119](https://linear.app/yukoval-studios/issue/YUK-119) / [YUK-120](https://linear.app/yukoval-studios/issue/YUK-120) / [YUK-121](https://linear.app/yukoval-studios/issue/YUK-121) lanes (Backlog)。 |
| Linear Foundation D milestone | ✅ 已建 | M3 — Copilot Drawer MVP on /today (target 2026-06-26)；M5 — Phase 3 Global Coach Orchestrator (target 2026-07-03)。命名遵循 `status.md` 既定占位（M3=drawer / M5=coach / M6=experimental:tool_use promote 留给 T-D7）。 |
| Stale plan docs in main worktree | ⚠️ 4 个 untracked | `2026-05-26-yuk88-p{1,2}-*.md` + `2026-05-27-{td2,wave2}-*.md`：Wave 2 时期产物，已落地。建议本 wave T-PD lane 归档或删除，不要 carry forward。 |

## Wave 5 scope

| Lane | 子项 | pts | Linear | Branch intent | Worktree |
|---|---|---|---|---|---|
| **T-D6/A** | `CoachTask` registration + prompt + `TodayPlan` result schema | 4 | [YUK-118](https://linear.app/yukoval-studios/issue/YUK-118) | `yuk-118-td6-coach-task` | A |
| **T-D6/B** | `coach_daily` + `coach_weekly` pg-boss handlers + cron schedule | 4 | [YUK-119](https://linear.app/yukoval-studios/issue/YUK-119) | `yuk-119-td6-coach-cron` | A |
| **T-D6/C** | Proposal writers for plan items (defer / split / relearn / archive)：`relearn` / `completion` 走现有工具；新增 `propose_learning_item_defer` + `propose_learning_item_archive` DomainTools 并把它们 + `propose_knowledge_mutation`（for `split`）加进 `COACH_TOOLS` allowlist | 6 | [YUK-120](https://linear.app/yukoval-studios/issue/YUK-120) | `yuk-120-td6-coach-proposals` | A |
| **T-D6/D** | T-D6 closeout：tests / status / roadmap / allowlist policy doc | 3 | [YUK-121](https://linear.app/yukoval-studios/issue/YUK-121) | `yuk-121-td6-closeout` | A |
| **T-D3/A** | `<CopilotDrawer>` + `<ToolUseCard>` primitives + tweaks (`chainRowCost` / `toolUseDetail`) | 4 | [YUK-122](https://linear.app/yukoval-studios/issue/YUK-122) | `yuk-122-td3-drawer-primitive` | B |
| **T-D3/B** | `/today` 30s dwell trigger + drawer mount + summary endpoint（消费 `query_memory_brief` + `get_review_due` + `get_learning_item_context`） | 3 | [YUK-123](https://linear.app/yukoval-studios/issue/YUK-123) | `yuk-123-td3-today-mount` | B |
| **T-D3/C** | Copilot chat endpoint + tool-use 三段式 流 + 6 tool SEED chip 直触发（不走 sendUser）。**Two-surface routing**：默认聊天用 `copilot` allowlist（reader + `propose_knowledge_edge`）；chip-direct-trigger 路由到 `copilot_user_suggested_mistake_action` surface（已含 `attribute_mistake` + `propose_variant`），无需改 allowlist | 4 | [YUK-124](https://linear.app/yukoval-studios/issue/YUK-124) | `yuk-124-td3-tool-use-flow` | B |
| **T-D3/D** | T-D3 closeout：tests / status / roadmap / loom-design alignment audit | 2 | [YUK-125](https://linear.app/yukoval-studios/issue/YUK-125) | `yuk-125-td3-closeout` | B |
| **T-PD** | Doc sweep gap-filler：archive stale Wave 2 plan docs；resolve [YUK-115](https://linear.app/yukoval-studios/issue/YUK-115)（NoteVerificationIssue half-migration，Option A 或 B） | ~4 | YUK-115 existing | doc-only / minor | gap (any worktree) |

Parents: [YUK-116](https://linear.app/yukoval-studios/issue/YUK-116) (T-D6, 17 pts post-review-fix) + [YUK-117](https://linear.app/yukoval-studios/issue/YUK-117) (T-D3, 13 pts). Milestones: M3 (drawer, target 2026-06-26) + M5 (coach, target 2026-07-03).

总计：**~34 pts**（post-review-fix；原 ~32 pts；+2 pts 来自 T-D6/C 扩 scope 加 2 个新 propose 工具）。仍在 master roadmap §5.1 Wave 5 估算（~32 pts，~5-6 周）的 ±10% 范围内。

## Chain order

1. Merge PR #175 (Wave 4 closeout docs) to `main` before branching any lane. **Already merged** as `2a8b68a3` 2026-05-28.
2. **Worktree A (T-D6) starts before Worktree B (T-D3)** by ~1 week so `TodayPlan` result schema is in `main` when Drawer summary endpoint needs it. If parallel from day 1, T-D3/B can mock the contract for early dev — concretely, define a local `TodayPlanPlaceholder` type in `app/api/today/copilot-summary/route.ts` matching the §T-D6/A acceptance fields (`daily_focus`, `review_session_proposal`, `at_most_one_new_item`, `weekly_reflection`, `plan_adjustments[]`, `maintenance_proposals[]`), mark it `// TODO(YUK-118): replace with import from src/core/schema/coach once T-D6/A merges`, and use the same shape in tests. Remove the placeholder during T-D3/D closeout audit.
3. Inside A: A → B → C → D（sequential chain-merge）. `CoachTask` schema must land in `main` before cron handler writes proposals against it. **T-D6/C now touches `src/server/ai/tools/allowlists.ts` non-trivially** (adds 3 entries to `COACH_TOOLS`) plus creates 2 new propose tools in `src/server/ai/tools/proposal-tools.ts`.
4. Inside B: A → B → C → D（sequential chain-merge）. Primitive must land in `main` before mount + tool-use flow consume it.
5. T-D6/C and T-D3/C ordering：T-D6/C must merge **before** T-D3/C kicks off. T-D6/C makes a real `COACH_TOOLS` change (3 additions) and creates 2 new propose tools; T-D3/C only routes between two pre-staged copilot surfaces (no allowlist change). Kicking off T-D3/C without T-D6/C merged risks duplicate `src/server/ai/tools/allowlists.ts` edits and possibly stepping on the new propose tool files. Enforce via lane gate: T-D3/C kickoff checklist starts with `git log origin/main --oneline -- src/server/ai/tools/allowlists.ts | grep YUK-120` — empty result blocks kickoff.
6. T-PD lane runs in any capacity gap. YUK-115 resolution (drift follow-up from Wave 4 closeout) is the natural insert point.

## Wave gate

Before declaring Wave 5 complete:

```bash
CODEX_FULL_GATE=1 pnpm typecheck
CODEX_FULL_GATE=1 pnpm lint
CODEX_FULL_GATE=1 pnpm audit:schema
CODEX_FULL_GATE=1 pnpm audit:partition
CODEX_FULL_GATE=1 pnpm audit:profile
CODEX_FULL_GATE=1 pnpm test
CODEX_FULL_GATE=1 pnpm build
```

UI smoke (manual, pre-merge of T-D3/D)：

- `pnpm dev` (注意 OrbStack `:3000` 占用 → 可能落 `:3001`；用浏览器实际访问验证，不只看 CI)
- 打开 `/today`，停留 30s 不交互 → 期望 drawer 自动浮，summary 含今日 review_due + memory_brief 摘录 + 一条 Coach 提议（若 cron 已跑）
- Drawer 内 ask "现在有哪些错题可以推荐" → 期望 ToolUseCard 三段式渲染 `query_mistakes` 调用 + 结果
- chip "出 3 道变式" 直接触发 `propose_variant` tool-use，**不**写 user ask event（per §1.6 §3b）

Then run `/audit-drift`, update `docs/superpowers/status.md`, refresh master-roadmap §5.1 Wave 5 to "shipped" with PR refs, reconcile Linear states.

## Human decision points (locked 2026-05-28)

All 5 points resolved before Wave 5 lane kickoff. Lane issues already synced.

- **✅ `/today` summary first paint 内容选型** — **Locked: Coach > review_due > brief > dreaming**. Order: (1) Coach `TodayPlan.daily_focus`, (2) `get_review_due` 摘要, (3) `query_memory_brief(scope='global')` 首段, (4) 一条 dreaming proposal from inbox. T-D3/B implements this exact order; T-D3/D closeout audits unchanged. (§Q3 summary-driven default.)
- **✅ CoachTask LLM model** — **Locked: `defaultModel: 'mimo-v2.5-pro'`, `fallbackChain: [{ provider: 'xiaomi', model: 'mimo-v2.5' }]`**. Matches project convention (registry.ts §所有非 vision task)：`mimo-v2.5-pro` 是 text-only 推理强 default，`mimo-v2.5` 是 multimodal fallback。CoachTask 无 vision 需求（读 brief / event / proposal 文本，输出 `TodayPlan` JSON），用 -pro 默认。每天 1 daily + 每周 1 weekly = ~30 calls/月。1 周后观察是否调。
- **✅ Coach 写 proposal 的 actor_ref** — **Locked: `{ kind: 'agent', ref: 'coach' }`**（与 `dreaming` 同级，新 actor，不复用 dreaming）。T-D6/C 在 actor taxonomy 加这行。
- **✅ YUK-115 (NoteVerificationIssue half-migration)** — **Locked: Option A (完成 schema rename, 1 pt)**。rename `NoteVerificationIssue.section_id` → `block_id`，sweep 所有 verifier 输出 + UI type call sites。T-PD lane 优先级，作为 Wave 5 gap-filler。
- **✅ Drawer 跨 6 routes (T-D5)** — **Locked: NOT in Wave 5**。T-D5 等 T-D3 试点在 `/today` 跑 1-2 周稳定 + 用户反馈后再启 Wave 6+ scope。避免 6 routes 同时变 UI 而无法回滚单点失败。

## Final lane state (待 wave 跑完填写)

| Lane | Status | Blocked by | Notes |
|---|---|---|---|
| T-D6/A | ⬜ | none | Coach schema 落地，unblocks B/C |
| T-D6/B | ⬜ | T-D6/A | cron 注册 + handler |
| T-D6/C | ⬜ | T-D6/A | proposal 写路径 + 2 个新 propose tools + `COACH_TOOLS` 扩 3 项 (post-review-fix) |
| T-D6/D | ⬜ | T-D6/A/B/C | closeout |
| T-D3/A | ⬜ | none | primitives 落地，unblocks B/C |
| T-D3/B | ⬜ | T-D3/A + (T-D6/A 推荐已 land) | drawer mount + summary fetch |
| T-D3/C | ⬜ | T-D3/A + T-D6/C merged | tool-use flow + two-surface routing (`copilot` 默认 / `copilot_user_suggested_mistake_action` chip 触发) — gate per §Chain order #5 |
| T-D3/D | ⬜ | T-D3/A/B/C | closeout |
| T-PD | ⬜ | YUK-115 owner pick | gap-filler |

## Post-merge review fixes (2026-05-28)

PR #176 merged then received 3 P2 findings from Codex + 3 nitpicks from CodeRabbit. Applied via follow-up PR (Option B = expand scope to cover missing tools):

| Finding | Source | Status |
|---|---|---|
| `query_learning_item_context` not in repo; real name `get_learning_item_context` | Codex line 41 | ✅ fixed in §Wave 5 scope row T-D3/B |
| T-D6/C promised `defer / split / archive` proposals but `COACH_TOOLS` only has `relearn / completion` | Codex line 38 | ✅ scope expanded — T-D6/C now creates `propose_learning_item_defer` + `propose_learning_item_archive` DomainTools and adds them + `propose_knowledge_mutation` (for `split`) to `COACH_TOOLS`; +2 pts |
| T-D3/C chip → `propose_variant` would fail under `copilot` surface | Codex line 42 | ✅ documented two-surface routing in §Wave 5 scope row T-D3/C; no allowlist change needed |
| Stale evidence ref for wave4 drift report | Codex line 18 | ✅ resolved by PR #175 merge (`2a8b68a3`) |
| "mimo" term unclear | CodeRabbit line 85 | ✅ expanded to "xiaomi/mimo provider (Anthropic-compatible, CLAUDE.md 已 codify)" in §Human decision points |
| "T-D3/B mock contract" not spelled out | CodeRabbit line 53 | ✅ concrete `TodayPlanPlaceholder` recipe added in §Chain order #2 |
| Summary order decision lacks owner+deadline | CodeRabbit line 84 | ✅ owner=user, deadline=2026-06-12 (T-D3/B kickoff -2 weeks from M3 target) added in §Human decision points |
| T-D6/C ↔ T-D3/C wall-clock-day coord fragile | CodeRabbit line 56 | ✅ replaced with hard merge gate in §Chain order #5 — T-D3/C kickoff checklist runs `git log ... | grep YUK-120`; empty = blocked |
