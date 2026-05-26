# Track-1 Follow-up Phase 大纲

> Phase-level outline，仿 [`2026-05-24-product-track-1-closeout.md`](2026-05-24-product-track-1-closeout.md) 模式。每条 lane 启动前另写 detailed plan doc。

**Roadmap source**: [`docs/planning/v0.3-generalized-ai-learning-framework.md`](../../planning/v0.3-generalized-ai-learning-framework.md) §1.5 + [`docs/planning/v0.4-complete-form-roadmap.md`](../../planning/v0.4-complete-form-roadmap.md) §6
**Linear Project**: TBD（outline 批准后建）
**Date**: 2026-05-26
**Status**: outline only —— per-lane plan docs to follow as lanes start
**Background**: [Product Track 1 — Review / Learning Item / Teaching 收口](https://linear.app/yukoval-studios/project/product-track-1-review-learning-item-teaching-收口-87f2e3007a16) Wave 1-4 全部 ship to main（2026-05-25 PR #133），Wave 5 closeout 已写（[`docs/audit/2026-05-25-product-track-1-wave5-closeout.md`](../../audit/2026-05-25-product-track-1-wave5-closeout.md)）。[YUK-65](https://linear.app/yukoval-studios/issue/YUK-65) NAS compose auto-migrate 2026-05-26 已 Done（PR #146）。本 phase 是 Track-1 closeout 大纲 §"后续 follow-ups" + v0.4 §6 P1/P2 中跟 Note / Teaching / Review feedback 闭环相关项的打包。

## 范围与边界

**本 outline 覆盖 6 lane / ~23 pts**：

| Lane | 主题 | pts | 来源 |
|---|---|---|---|
| [YUK-66](https://linear.app/yukoval-studios/issue/YUK-66) | Teaching `ask_check` 落 question artifact | 5 | Track-1 closeout 大纲 line 459；v0.4 §5.3 |
| Living Note `NoteRefineTask` + 5 触发器 | NoteRefineTask handler + dreaming 触发逻辑 | 8 | [`docs/modules/notes.md`](../../modules/notes.md) §9；v0.4 §6 P2.3；closeout 大纲 line 455 |
| Note 申诉 / 标错 UX | 用户标"这段有问题"→ retract 走 ADR-0014 §6 correction event | 3 | v0.4 §6 P2.4；closeout 大纲 line 456 |
| Partial credit P3 rating advisory | `<RatingAdvisor>` 组件 + `rating-advisor.ts` server helper | 3 | v0.4 §6 P1.5；[`docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md`](../specs/2026-05-22-foundation-true-closeout-design.md) §P3 |
| `/today` KPI 第三格 → "AI 提议·待审" | 替换 vanity metric「知识点数」 | 2 | v0.4 §6 P2.10；[`docs/design/2026-05-15-design-brief-v2.1.md`](../../design/2026-05-15-design-brief-v2.1.md) §1.3 |
| wenyan `profile.causeCategories` 100% 迁移 | math 100%，wenyan partial 收尾 | 2 | v0.4 §6 P1.4；drift 2026-05-22 phase-deferred |

**总估时**：2-3 周，~23 pts，单人节奏。沿用 Track-1 closeout "独立 PR + 独立 reviewer 关卡 + 独立 audit + chain-merge" 模式。

**不在本 outline 内**（已明确分流）：

- **YUK-49 Phase 3 Global Coach Orchestrator** —— v0.4 §6 P0.4，独立大 phase（强耦合 Foundation D M2 read tools + P0.3 Dreaming Lane），不与 Note / Review polish 混
- **Dreaming Lane (P0.3)** —— 与 Coach 同 Phase 3 anchor
- **Foundation D M2-M5（Copilot tools / drawer / write tools / Coach）** —— 独立 milestone 序列
- **Subject #4 acid test 2** —— 重型 lane，估时 ~8-13 pts，留独立 phase 启动
- **Track 2 P2.1 acceptance-rate ranking / P2.2 PR-level revert** —— Track 2 收尾，不归 Track 1
- **TipTap 编辑器（P2.7）/ Knowledge graph force-directed（P2.9）** —— 重型 UI lane，留独立 phase
- **Track F multimodal / source grounding** —— v0.3 §6 明确 Later

## Phase 序列总览（按 Milestone）

### M1 — Quick wins / 区域分散收尾（3 lane / 7 pts / target 2026-06-04）

| Issue | 主题 | pts | priority | 启动可行性 | 依赖 |
|---|---|---|---|---|---|
| 新建 | wenyan `profile.causeCategories` 100% 迁移 | 2 | Medium | ✅ unblocked | — |
| 新建 | `/today` KPI 第三格 → "AI 提议·待审" | 2 | Medium | ✅ unblocked | — |
| 新建 | Note 申诉 / 标错 UX | 3 | Medium | ✅ unblocked（YUK-40 + ADR-0014 §6 已 ship） | — |

### M2 — Note / Teaching / Review 深化（3 lane / 16 pts / target 2026-06-18）

| Issue | 主题 | pts | priority | 启动可行性 | 依赖 |
|---|---|---|---|---|---|
| 新建 | Partial credit P3 `<RatingAdvisor>` | 3 | Medium | ✅ unblocked | — |
| [YUK-66](https://linear.app/yukoval-studios/issue/YUK-66) | Teaching `ask_check` artifact | 5 | Medium | ✅ unblocked（EmbeddedCheck pattern 已 ship 在 [YUK-53](https://linear.app/yukoval-studios/issue/YUK-53)） | — |
| 新建 | Living Note `NoteRefineTask` + 5 触发器 | 8 | Medium | ✅ unblocked（dreaming queue + proposal inbox 已 ship） | — |

## 启动 Wave 划分

按 **3 lane / wave** 节奏，**区域分散**降低 merge 冲突：

### Wave 1 —— 3 lane / 7 pts / 全 unblocked

| Lane | 主题 | pts | 区域 |
|---|---|---|---|
| W1.1 | wenyan causeCategories 100% | 2 | `src/subjects/wenyan/profile.ts` + `pnpm audit:profile` |
| W1.2 | `/today` KPI 第三格 | 2 | `app/(app)/today/page.tsx` + `src/server/today/` summary helper |
| W1.3 | Note 申诉 / 标错 UX | 3 | `src/ui/correction/` + `app/(app)/learning-items/[id]/page.tsx` |

**Chain-merge order**：W1.1 → W1.2 → W1.3（profile 改动先 land，UI 后续都依赖 profile validator pass；today / learning-items 是不同 page 文件互不冲突）。

**为什么 W1 这 3 个**：
- 全部 unblocked，区域完全分散（profile / today page / learning-items page）
- pts 偏小，作为本 phase 起手开机，把 cross-cutting 跑通：profile validator gate / inbox proposal API / correction event read path
- W1.1 wenyan migration 先 land 确认 `pnpm audit:profile` 完全 green，后续 lane 启动期 startup 不会被 profile 卡

### Wave 2 —— 3 lane / 16 pts

| Lane | 主题 | pts | 依赖 |
|---|---|---|---|
| W2.1 | Partial credit `<RatingAdvisor>` | 3 | 无 |
| W2.2 | [YUK-66](https://linear.app/yukoval-studios/issue/YUK-66) Teaching ask_check artifact | 5 | soft ← W1.3 correction event UI 复用经验；EmbeddedCheck pattern 已 ship |
| W2.3 | Living Note `NoteRefineTask` + 5 触发器 | 8 | 无 |

**Chain-merge order**：W2.1 → W2.2 → W2.3。

**冲突注意**：
- W2.1 + W2.2 都可能 touch `app/(app)/review/page.tsx`（W2.1 review submit UI / W2.2 通过 `LearningItem → Teaching → review` 链路触发）；W2.1 先 land 锁定 `judge_result_v2` 字段语义后 W2.2 再 PR
- W2.3 Living Note 是 pg-boss handler 新建，单独 server-side，不冲突

**Wave 总计**：2 wave × 3 lane = 6 启动单元 / 23 pts。

## Lane scope + exit criteria

> 启动每条 lane 前另写 detailed plan doc `docs/superpowers/plans/2026-05-2X-<issue-slug>.md`。本 outline 只给 outline-level scope。

### W1.1 — wenyan `profile.causeCategories` 100% 迁移

**问题**：math profile causeCategories 100% migration 已完，wenyan partial；`drift 2026-05-22` 标 phase-deferred。

**Scope**：
- 把 `src/subjects/wenyan/profile.ts` 剩余 cause 路径全部 profile-driven，去掉 hardcoded fallback
- `pnpm audit:profile` 全绿
- regression：wenyan fixture 7 类 cause attribution 命中率不降

**Exit criteria**：
- [ ] `pnpm audit:profile` 完全 green，wenyan no warning
- [ ] wenyan AttributionTask fixture pass，cause 7 类 coverage ≥ math baseline
- [ ] drift log 2026-05-22 wenyan deferred 项可关

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-wenyan-cause-migration.md`

---

### W1.2 — `/today` KPI 第三格 → "AI 提议·待审"

**问题**：[`docs/design/2026-05-15-design-brief-v2.1.md`](../../design/2026-05-15-design-brief-v2.1.md) §1.3 明确"必须把『知识点数』vanity metric 换成 actionable 数字"。

**Scope**：
- `app/(app)/today/page.tsx` 第三格替换为 inbox pending count
- 计数来源：`/api/proposals?status=pending` 或 server-side aggregate
- 点格子跳 `/inbox`
- 兼容现有 KPI loader

**Exit criteria**：
- [ ] `/today` 第三格显示 inbox 待审数（real-time within session）
- [ ] 点击跳 `/inbox`
- [ ] `pnpm test:db` 通过；KPI loader 单测 cover

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-today-kpi-inbox.md`

---

### W1.3 — Note 申诉 / 标错 UX

**问题**：ADR-0014 §6 correction event（retract / mark_wrong / supersede）已 ship 在数据层，UI 仅在 learning-item proposal 列表暴露（[YUK-19](https://linear.app/yukoval-studios/issue/YUK-19) 落地）。Note section 用户标错入口缺位 —— 用户没法标"这段 atomic 内容有问题"。

**Scope**：
- atomic note section 加 "申诉 / 标错" 按钮（隐藏在 `…` 菜单或 selection toolbar）
- 触发 `experimental:correction_event { kind='mark_wrong', target_kind='artifact', target_id, section_idx, note_md }`
- 列表 UI 显示 mark_wrong 状态走 `CorrectionStateRenderer`（YUK-40 已 ship）
- 不引入新 correction kind，复用现有 4 类

**Exit criteria**：
- [ ] atomic note section 有 mark_wrong 入口
- [ ] event 写入后状态投射正确（`CorrectionStateRenderer` 显示已标错）
- [ ] 不影响 proposal inbox 已有 retract UI
- [ ] `pnpm test:db` + `pnpm audit:schema` 通过

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-note-appeal-mark-wrong.md`

---

### W2.1 — Partial credit `<RatingAdvisor>` + `rating-advisor.ts`

**问题**：[`docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md`](../specs/2026-05-22-foundation-true-closeout-design.md) §P3 设计 partial credit 三档 advisory，server 层 score policy 已 ship（JudgeResultV2），但 review UI 没把 advisory 推给用户。

**Scope**：
- 新建 `src/server/review/rating-advisor.ts` — 输入 `JudgeResultV2` → 输出 `{ suggested_rating, reason_md }` 三档（{again, hard, good} / {good, easy}）
- `app/api/review/submit/route.ts` body 增 `judge_result_v2: JudgeResultV2`（optional，渐进）
- `src/ui/review/RatingAdvisor.tsx` 组件，在 feedback 阶段显示"模型建议 X，你可改"
- 用户最终 rating 仍是 user-overridable（CC-1 cause precedence 不动）

**Exit criteria**：
- [ ] `rating-advisor.ts` 三档映射纯函数 + unit test
- [ ] review feedback 阶段显示 advisor 卡片
- [ ] user override 走原 rating 路径，advisor 仅 informational
- [ ] `pnpm test:unit` + `pnpm test:db` 通过

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-rating-advisor.md`

---

### W2.2 — YUK-66 Teaching `ask_check` 落 question artifact

**问题**：Phase 2C 教学 MVP 故意 defer，[`src/server/orchestrator/teaching.ts:7`](../../../src/server/orchestrator/teaching.ts) 注释明确"no inline question persistence"。Linear [YUK-66](https://linear.app/yukoval-studios/issue/YUK-66) 已写完整 scope。

**Scope**（按 [YUK-66](https://linear.app/yukoval-studios/issue/YUK-66) description）：
- `TeachingTurnTask` `ask_check` schema 扩展：`structured_question: { judge_kind_override, rubric_json, reference_md }`
- `app/api/teaching-sessions/[id]/turn/route.ts` 当 turn_kind=ask_check 时写 `question(source='teaching_check', learning_item_id, ...)`
- 复用 `/api/embedded-check/attempt` 语义（或新 `/api/teaching-sessions/[id]/check/[question_id]/attempt`）
- judge 走 CC-3 `JudgeInvoker`
- `TeachingDrawer` 内嵌 `<EmbeddedCheckSection>` 渲染 structured question
- 用户答错触发 attribution → mistake → variant_gen chain（[YUK-17](https://linear.app/yukoval-studios/issue/YUK-17) 已 ship）

**Exit criteria**：
- [ ] `TeachingTurnTask` ask_check schema 扩展（zod + prompt）
- [ ] teaching ask_check 写 question + 出现在 `/today` FSRS 队列
- [ ] failure → mistake → variant chain 全路径 e2e test
- [ ] `JudgeInvoker` 单入口，不绕过
- [ ] `docs/architecture.md` Phase 2C 段去掉 "no inline question persistence" caveat
- [ ] `pnpm test:db` + `pnpm audit:schema` 通过

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-yuk-66-teaching-ask-check.md`

---

### W2.3 — Living Note `NoteRefineTask` + 5 触发器

**问题**：[`docs/modules/notes.md`](../../modules/notes.md) §9 锁定 5 触发器，但 `NoteRefineTask` 未实现（notes.md 表 §0 标 🟡）。dreaming queue 是 consumer，proposal inbox 已 ship，没接 Note 修订生产者。

**Scope**：
- 新 pg-boss handler `src/server/boss/handlers/note_refine.ts`（仿 [`note_verify.ts`](../../../src/server/boss/handlers/note_verify.ts) 模式）
- 新 AI task `NoteRefineTask`（input: atomic + 触发器 metadata，output: section diff proposal）
- 5 触发器分别加 producer 接入（夜间 batch 或 event-driven）：
  1. 该节点最近 7 天新错题 ≥ 2 → propose 更新 `pitfall`
  2. embedded check 错误率 >50% → propose 重写整个 atomic
  3. 对话中提到该节点 ≥ 3 次 → propose 在 `example` 加例子
  4. mastery > 0.85 且 >30 天 → 生成"精简复习版" atomic
  5. 节点 90 天没触达 → propose 归档 atomic + hub
- 全部走 proposal inbox（CC-4），不直接覆盖
- user-verified section 跳过自动覆盖（schema 已支持）

**Exit criteria**：
- [ ] `note_refine` handler 注册，单测 covers 5 trigger 路径
- [ ] 5 触发器 producer 接入（cron 或 event-driven hook）
- [ ] propose 输出走统一 `AiProposalPayload kind='note_refine'` union（CC-4）
- [ ] user-verified section 不被覆盖 regression test
- [ ] `pnpm test:db` + `pnpm test:migration`（如新字段）+ `pnpm audit:schema` 通过
- [ ] `docs/modules/notes.md` §0 把 `NoteRefineTask` 标 ✅

**ADR 触发条件**：5 trigger 中如有需要新 schema 字段（如 atomic 级 `last_refined_at`、`refine_cooldown_until`），需 ADR 记录字段归属。

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-living-note-refine.md`

## 依赖关系图

```
W1 ──┬─ W1.1 wenyan causeCategories ─────→ W2 全 lane（profile validator 必须 green）
     ├─ W1.2 today KPI 第三格 ────────────→ (independent)
     └─ W1.3 Note 申诉 / 标错 UX ────────→ soft ← W2.2 teaching ask_check 借鉴 UI 复用
                                                 W2.3 NoteRefineTask 出 proposal 后 UI 展示

W2 ──┬─ W2.1 rating advisory ───────────→ (independent)
     ├─ W2.2 YUK-66 ask_check artifact
     └─ W2.3 Living Note NoteRefineTask
```

**外部依赖（已解锁）**：
- [YUK-40](https://linear.app/yukoval-studios/issue/YUK-40) correction renderer → W1.3 + W2.3 ✅
- [YUK-42](https://linear.app/yukoval-studios/issue/YUK-42)/[YUK-43](https://linear.app/yukoval-studios/issue/YUK-43)/[YUK-44](https://linear.app/yukoval-studios/issue/YUK-44) proposal inbox → W2.3 NoteRefineTask 出 proposal ✅
- [YUK-39](https://linear.app/yukoval-studios/issue/YUK-39) JudgeInvoker → W2.1 rating advisory + W2.2 teaching judge ✅
- [YUK-48](https://linear.app/yukoval-studios/issue/YUK-48) maintenance nightly cron → W2.3 复用作为 5 触发器中夜间 batch 入口 ✅
- [YUK-17](https://linear.app/yukoval-studios/issue/YUK-17) variant chain → W2.2 teaching failure → mistake → variant 链路 consumer ✅
- [YUK-19](https://linear.app/yukoval-studios/issue/YUK-19) learning-item rollback UI → W1.3 mark_wrong UI 参考 ✅

## Cross-cutting concerns（lane 启动必读）

承接 Track-1 closeout 的 5 个 cross-cutting helper，**本 phase 任何 lane 触及对应领域必须复用，不要重写 invariant**。各 per-lane plan doc 启动时必须列出依赖的 cross-cutting helper。

### CC-1 — Cause precedence ([YUK-51](https://linear.app/yukoval-studios/issue/YUK-51) shared helper)

- **Helper**：[`src/server/events/cause-policy.ts`](../../../src/server/events/cause-policy.ts) 的 `effectiveCauseForFailureAttempt()` + `effectiveCauseCategoryForFailureAttempt()`
- **必须遵循的 lane**：
  - W2.1 rating advisory —— advisor 输出**不能**覆盖已有 user_cause；仅作 informational
  - W2.2 teaching ask_check —— failure attempt 写入走 attribution 标准路径，不直写 cause
  - W2.3 NoteRefineTask 触发器 1（错题 ≥ 2）—— 读 cause 走 helper，不自查 timestamp

### CC-2 — Correction state read model + renderer ([YUK-40](https://linear.app/yukoval-studios/issue/YUK-40))

- **Helper**：[`src/server/review/effective-truth.ts`](../../../src/server/review/effective-truth.ts) + [`src/ui/correction/CorrectionStateRenderer.tsx`](../../../src/ui/correction/CorrectionStateRenderer.tsx)
- **必须遵循的 lane**：
  - W1.3 Note 申诉 UX —— mark_wrong 状态显示**必须**复用 `CorrectionStateRenderer`，不新建组件
  - W2.3 NoteRefineTask 触发器 1（错题）—— 读 attempt 走 effective-truth，retract attempt 自动跳过

### CC-3 — JudgeInvoker single entrypoint ([YUK-39](https://linear.app/yukoval-studios/issue/YUK-39))

- **Helper**：[`src/server/judge/invoker.ts`](../../../src/server/judge/invoker.ts)
- **必须遵循的 lane**：
  - W2.1 rating advisory —— 读 `JudgeResultV2` 走 invoker 已 telemetry hook
  - W2.2 teaching ask_check judge —— 走 `JudgeInvoker`，不绕过

### CC-4 — Proposal lifecycle (Track 2 M5 [YUK-42](https://linear.app/yukoval-studios/issue/YUK-42)/[YUK-43](https://linear.app/yukoval-studios/issue/YUK-43)/[YUK-44](https://linear.app/yukoval-studios/issue/YUK-44))

- **Helper**：[`src/server/proposals/{actions,inbox,producers,signals,writer}.ts`](../../../src/server/proposals/) + `/api/proposals/[id]/{accept,dismiss,retract}` 三个 route
- **必须遵循的 lane**：
  - W2.3 NoteRefineTask —— output 走 `AiProposalPayload kind='note_refine'`（**新 kind**，需在 `src/core/schema/proposal.ts` union 注册）；accept 路径需补 owner-service 处理
  - W1.3 Note 申诉 —— mark_wrong **不走 proposal**，走 correction event channel；只是 UI 展示 mark_wrong 后的 retract state 时引用现有 `/api/proposals/[id]/retract`
  - W1.2 today KPI —— 计数来源走 `/api/proposals?status=pending`，不自查 event 表

### CC-5 — Subject profile validator ([YUK-7](https://linear.app/yukoval-studios/issue/YUK-7) + [YUK-8](https://linear.app/yukoval-studios/issue/YUK-8))

- **Helper**：`pnpm audit:profile` + `SubjectRegistry.register()` 启动期校验
- **必须遵循的 lane**：
  - W1.1 wenyan causeCategories —— 改 profile 后必跑 `pnpm audit:profile`；坏 profile 启动直接抛错

## 启动建议

按 wave 节奏，每 wave 约 1-1.5 周：

| Week | Wave | Lanes | 累计 pts | Cumulative coverage |
|---|---|---|---|---|
| W1 | Wave 1 | W1.1 wenyan / W1.2 today KPI / W1.3 Note 申诉 | 7 | 3/6 lanes |
| W2 | Wave 2 | W2.1 rating advisory / W2.2 YUK-66 / W2.3 Living Note | 23 | 6/6 lanes |
| W3 | 收口 | audit-drift + status.md update + v0.4 §6 P1.4/P1.5/P2.3/P2.4/P2.10 状态更新 + retrospective | — | — |

**Wave 间 gate**：每 wave 结束 chain-merge 完后跑 `pnpm test` + `pnpm audit:schema` + `pnpm audit:partition` + `pnpm audit:profile` 全绿，再启下一 wave 的 `/launch-phase`。

## Linear 项目结构

待 outline 批准后建：

- **Project**：`Track-1 Follow-up — Note / Teaching / Review polish`（priority=Medium, start=2026-05-26, target=2026-06-18）
- **2 Milestones / 6 issue**：

  | Milestone | Issue 数 | Issues |
  |---|---|---|
  | M1 — Quick wins（target 2026-06-04） | 3 | wenyan causeCategories / today KPI / Note 申诉 UX |
  | M2 — Note/Teaching/Review 深化（target 2026-06-18） | 3 | rating advisory / [YUK-66](https://linear.app/yukoval-studios/issue/YUK-66) / Living Note |

**新建 5 个 Linear issue**（YUK-66 已存在，移入本 project + M2）：
- wenyan `causeCategories` 100% migration → M1 / Medium / 2pts
- `/today` KPI inbox pending count → M1 / Medium / 2pts
- Note 申诉 / 标错 UX (atomic section mark_wrong) → M1 / Medium / 3pts
- Partial credit P3 `<RatingAdvisor>` → M2 / Medium / 3pts
- Living Note `NoteRefineTask` + 5 trigger producers → M2 / Medium / 8pts

## ADR 触发条件

以下情况需新写 ADR，不在本 outline 内默处理：

- **W2.3 Living Note** 若引入 atomic 级新字段（`last_refined_at`、`refine_cooldown_until`、`refine_history`）—— 需 ADR 记录字段归属 + 是否跨 hub/atomic
- **W2.2 YUK-66** 若决定走"新 `/api/teaching-sessions/[id]/check/[question_id]/attempt`"独立路由而非复用 embedded-check attempt —— 需 ADR 记录 attempt route 拓扑
- **W1.3 Note 申诉** 若用户提出"标错后自动 retract 整段"（automation），而非 informational mark_wrong —— 需 ADR 记录 mark_wrong → retract 自动化策略

## 后续 follow-ups（不在本 outline 内）

- **subject #4 acid test 2**（english / programming）—— 重型 lane，留独立 phase
- **YUK-49 Phase 3 Global Coach Orchestrator** —— v0.4 §6 P0.4，独立 phase（强耦合 Foundation D M2 + P0.3 Dreaming）
- **Dreaming Lane（P0.3）** —— 与 Global Coach 同 anchor
- **Foundation D M2-M5** —— Copilot tools / drawer / write tools / Coach 独立 milestone 序列
- **TipTap 编辑器（P2.7）** —— Note 编辑重型 lane，留独立 phase
- **Knowledge graph force-directed（P2.9）** —— UI 重型
- **Track 2 P2.1 acceptance-rate ranking / P2.2 PR-level revert** —— Track 2 收尾
- **YUK-50 Dependabot moderate alerts** —— ops hygiene，不归 Track 1
- **Track F multimodal / source grounding** —— v0.3 §6 Later
