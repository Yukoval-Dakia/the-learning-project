# Track 2 起步 + Foundation 末尾收口 — Phase 大纲

> Phase-level outline，仿 [`2026-05-22-foundation-true-closeout-phases.md`](2026-05-22-foundation-true-closeout-phases.md) 模式。每条 lane 启动前另写 detailed plan doc（math MVP 级别）。

**Roadmap source**: [`docs/planning/v0.3-generalized-ai-learning-framework.md`](../../planning/v0.3-generalized-ai-learning-framework.md) §1.5 Foundation A/B/C + Product Track 2
**Date**: 2026-05-23
**Status**: outline only —— per-lane plan docs to follow as lanes start
**Background**: ADR-0017（memory）刚 draft，physics P0/P1/P2 (Foundation B acid test) 已 ship 到 commit `b30d543`。本 outline 处理 **memory 之外**的剩余基础建设。

## 范围与边界

**本 outline 覆盖** 6 条独立可并行的 lane，**不重新设计**已 accept 的 ADR：

- L1 — Capability Registry 单 invoker（Foundation A 收尾，承接 ADR-0014）
- L2 — SubjectProfile Zod schema + 启动期 validator（Foundation B 收尾，承接 ADR-0014 §3）
- L3 — Correction state read model + 共享 renderer（Foundation C 收尾，承接 ADR-0014 §4 §6）
- L4 — AI 运行可观测性 admin surface（v0.3 Track A reliability signals）
- L5 — AiProposalPayload union + 统一 inbox lifecycle（Product Track 2 anchor，v0.3 §2 AI Proposal Inbox）
- L6 — `audit:schema` allowlist 过期约束（hygiene，v0.3 Track A drift audits）

**不在本 outline 内**：

- ADR-0017 memory 实施（Mem0 + brief layer）—— 由 YUK-37 单独承接
- Track F multimodal / source grounding —— 留待 L5 完工后再启
- Standalone MCP / plugin —— v0.3 §1.5 明确 Later
- 任何新增 subject（english / programming）—— L2 收尾后再启

## Phase 序列总览

| Lane | 主题 | 估时 | 关键 acid test / exit | 独立 PR | 依赖 |
|---|---|---|---|---|---|
| L1 | Capability Registry 单 invoker + `steps@1` 占位清理 | 3-5 day | 全仓 grep 无 ad-hoc judge 调用 | 1 | — |
| L2 | SubjectProfile Zod schema + startup validator（**复用 YUK-7 + YUK-8**） | 2-3 day | profile 文件被改坏时启动失败而非运行时 | 1 | — |
| L3 | Correction state read model + 共享 renderer | 3-5 day | retract / mark_wrong / supersede 在 review + list + item 三处都正确投射 | 1 | — |
| L4 | AI 运行可观测性 admin surface | 5-7 day | `ai_task_runs` / `cost_ledger` / `tool_call_log` 三表可在 `/admin/runs` 读出 | 1 | — |
| L5 | AiProposalPayload union + 统一 inbox lifecycle | 10-14 day | 9 类 proposal 走同一 writer / reader / accept / dismiss / retract | 2-3 | L1 弱, L3 弱 |
| L6 | `audit:schema` allowlist 过期约束 | 0.5-1 day | 已合 PR / 已 ship phase 的 entry 自动 fail | 1 | — |

**总估时**：24-35 day（5-7 周，单人节奏）。各 lane 独立 PR + 独立 reviewer 关卡 + 独立 audit，沿用 math MVP / Foundation Closeout 已验证模式。

## Lane scope + exit criteria

### L1 — Capability Registry 单 invoker

**问题**：[src/ai/registry.ts](../../../src/ai/registry.ts) 注册了 capability，[src/core/capability/judges/index.ts](../../../src/core/capability/judges/index.ts) `createDefaultRegistry` 注册了 judges，但 judge 调用散在 review handler / correction applier / proposal flow 多个 callsite，没经过单一 invoker。每加一个 capability（rubric / multimodal_direct / ai_flexible）都要找所有 callsite。`steps@1` 仍有部分 `'unsupported'` 占位需要清理（physics P2 unit_dimension 已 ship，相关 stub 应回收）。

**Scope**：

- 抽 `JudgeInvoker` 单 entrypoint（`src/server/judge/invoker.ts`），所有 callsite 走它
- 审计三个 callsite 簇：review submit / correction apply / proposal accept
- 顺手清掉 `steps@1` 占位 `'unsupported'`
- Invoker 内置 telemetry hook（route 选择 + confidence + elapsed），为 L4 obs surface 喂数据

**Exit criteria**：

- [ ] `grep -rn "createDefaultRegistry\|judges\." src/server app` 全部入口都通过 `JudgeInvoker`
- [ ] 旧 ad-hoc judge 调用 0 处残留
- [ ] `pnpm test:unit` + `pnpm test:db` 全绿
- [ ] `pnpm audit:schema` + `pnpm audit:partition` 全绿
- [ ] math + wenyan + physics fixture regression 通过

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-l1-judge-invoker.md`

---

### L2 — SubjectProfile Zod schema + startup validator

**已有 Linear issue**：[YUK-7 — build-time profile validator](https://linear.app/yukoval-studios/issue/YUK-7) (Backlog, 3pts) + [YUK-8 — profile validator 接入 pnpm test pre-PR gate](https://linear.app/yukoval-studios/issue/YUK-8) (Backlog, 1pt)。本 lane **不新建 Linear issue**，把这两条挂到本 Project 的 M2 Milestone 即可。

**问题**：[src/subjects/wenyan/profile.ts](../../../src/subjects/wenyan/profile.ts) / [math/profile.ts](../../../src/subjects/math/profile.ts) / [physics/profile.ts](../../../src/subjects/physics/profile.ts) 各自定义 `SlimSubjectProfile`，[src/subjects/profile.ts](../../../src/subjects/profile.ts) 的 `SubjectRegistry` 不在启动期验证 `judgeCapabilities` 是否都已注册、`causeCategories` id 是否唯一、`renderConfig` 字段是否齐。下一个 subject（english / programming）只能靠人肉对照。Foundation B v0.3 §1.5 明确写过的 "build-time profile validator" 至今未做。

**注意**：[`SubjectProfileSchema`](../../../src/subjects/profile.ts) (line 41-77) + [`validateProfile()`](../../../src/core/capability/validate-profile.ts) (line 96-) **已存在**。本 lane **不新建** schema/validator，只补 missing 接入。

**Scope**（YUK-7 + YUK-8 + 接入 startup validator）：

- YUK-7：`scripts/audit-profile.ts` build-time 脚本，调用现有 `validateProfile()` 遍历所有注册 profile（仿 `scripts/audit-schema-writes.ts` 风格）
- YUK-8：`audit:profile` script 接入 `pnpm test` pre-PR gate
- 本 outline 增量：在 [`SubjectRegistry.register()`](../../../src/subjects/profile.ts) (profile.ts:112) 或 `getDefaultSubjectRegistry()` (profile.ts:168) 调 `validateProfile()`，失败抛错；当前 register 只检查 id 非空/重复，**完全不调** validateProfile
- CI test：profile 改坏（漏字段 / 不存在的 capability id / 重复 cause id）时 audit + runtime startup 都失败

**Exit criteria**：

- [ ] 三个现有 profile（wenyan / math / physics）通过 schema
- [ ] 故意改坏 profile 时 `pnpm test:unit` 失败而非通过
- [ ] `SubjectRegistry` 启动失败时报错可读（指明哪个 profile 哪个字段）
- [ ] 文档：`docs/agents/adding-a-subject.md` 加一段"profile 验证机制"

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-l2-subject-profile-validator.md`

---

### L3 — Correction state read model + 共享 renderer

**问题**：[src/server/events/corrections.ts](../../../src/server/events/corrections.ts) `applyCorrectionEvent` 写完，但 UI 投射只在 [app/(app)/events/[id]/page.tsx](../../../app/(app)/events/[id]/page.tsx) 一处映射 `retracted` / `marked_wrong` → `'again'`，`superseded` → reference replacement。review submit 路径、错题列表、learning item 列表都没 surface "这条已 retract / superseded by"。

**Scope**：

- 服务端 effective-truth read model（`src/server/review/effective-truth.ts`）—— 给定 judge event id，返回当前 active state（含 supersede chain）
- 共享 `CorrectionStateRenderer` 组件（`src/ui/correction/CorrectionStateRenderer.tsx`）
- 审计三个 UI 入口：review submit 回放、错题列表、learning item 列表
- `app/api/review/*` 列表查询附带 effective state

**Exit criteria**：

- [ ] 三个 UI 入口都显示 retraction / supersede chain
- [ ] retract 后下一次 review 不再把该题当 mistake 推
- [ ] 集成测试覆盖 supersede chain N>1 场景
- [ ] wenyan + math regression 通过

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-l3-correction-read-model.md`

---

### L4 — AI 运行可观测性 admin surface

**问题**：[src/server/ai/log.ts](../../../src/server/ai/log.ts) 写满 `ai_task_runs` + `cost_ledger` + `tool_call_log`，但**没读路径** —— 用户没办法看 task health / cost trend / 失败聚类，只能 raw SQL。违反 ADR-0014 §6 "evidence-first 留痕"对称性。Memory（ADR-0017）落地后 LLM 调用频度上升，没有可视化盲飞。

**Scope**：

- `/admin/runs` + `/admin/cost` + `/admin/failures` page routes（`app/(admin)/admin/*/page.tsx`）
- **Auth**：新增 `app/(admin)/layout.tsx` 包 `<TokenGate>`（复用 `app/(app)/layout.tsx` 已用的 client gate 组件），或写独立 `<AdminTokenGate>`。**[middleware.ts](../../../middleware.ts) 现行 matcher 是 `/api/:path*`，不 cover page route**，因此 page 层必须自己接 gate；middleware matcher 不变
- 数据通过 `app/api/_/admin/*` 内部 API 路由读，API 自动受 middleware INTERNAL_TOKEN 守
- Read model only，不动 SoT

**Exit criteria**：

- [ ] 三个 admin 路由 typecheck + render 通过
- [ ] admin pages 在 token 缺失时被 TokenGate 拦截（不能直接看到内容）
- [ ] middleware.ts matcher 不变（继续只 cover `/api/*`），admin page 的 token 守在 layout 层
- [ ] 单 run 时间线含 pg-boss job id + tool_call_log 时间轴
- [ ] cost 折线按日/按 task kind 都能看
- [ ] 失败聚类对 ≥3 个真实 failure 样本能正确分组
- [ ] 文档：`docs/agents/admin-surface.md` 一篇 + 截图

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-l4-ai-obs-admin.md`

---

### L5 — AiProposalPayload union + 统一 inbox lifecycle（Product Track 2 anchor）

**已有相关 Linear issue（related, 不属于本 Project）**：

- [YUK-15 — record → proposal evidence loop 接通](https://linear.app/yukoval-studios/issue/YUK-15) (Backlog, 5pts, Product Track 1)：record 作为 evidence_ref 浮现成 proposal。L5 统一 inbox 是其基础，L5 完工后 YUK-15 才能落地。
- [YUK-19 — Learning-item proposal rollback UI](https://linear.app/yukoval-studios/issue/YUK-19) (Backlog, 3pts, Product Track 1)：learning-item proposal 误 accept 的 retract UI。复用 L5.2 retract 路径 + L3 correction event。

两者 belong Product Track 1 Project，不在本 closeout Project 范围内，但本 outline 注明 L5 是它们的前置框架。

**问题**：v0.3 §1.5 Product Track 2 标 ⬜ 未起步。当前 `action='propose'` 事件各 producer（knowledge_node / knowledge_edge / variant generation / note update / completion / archive）各自写 payload，没有 `AiProposalPayload` discriminated union，也没共享 writer/reader/lifecycle。**梦境流**与**维护流**都规划要走同一个 inbox。

**Scope**（按 v0.3 §2 AI Proposal Inbox 定义的 9 类）：

- Zod `AiProposalPayload` union（`src/core/schema/proposal.ts`）—— 9 类 `kind` × `reason_md` × `evidence_refs` × `proposed_change` × `rollback_plan` × `cooldown_key`
- 单 writer (`src/server/proposals/writer.ts`) —— 所有 producer 走它，强制 schema 守
- 单 reader (`src/server/proposals/inbox.ts`) —— 把散落 propose event 投射成 inbox 行
- `app/(app)/inbox/` 路由 —— 一个 UI 屏幕看所有 AI 提议
- accept / dismiss / retract 三个动作走 owner-service rate event（不直接改 SoT）
- acceptance-rate + cooldown 信号写入新表 `proposal_signals`
- 迁移现有 `knowledge_propose` + `knowledge_edge_propose` boss handler 到新 union

**拆分为 3 个 sub-PR**：

- L5.1 (3-4 day) — schema + writer + reader + 现有 2 个 producer 接入
- L5.2 (4-5 day) — `app/(app)/inbox/` UI + accept/dismiss/retract 路由
- L5.3 (3-5 day) — 剩余 7 类 producer 接入（variant / note_update / completion / relearn / archive / learning_item / judge_retraction） + acceptance-rate 信号

**Exit criteria**：

- [ ] 9 类 proposal 都能 round-trip 通过 union（schema test）
- [ ] inbox UI 单屏显示跨 kind 的混合 proposal 队列
- [ ] accept 路径走 owner-service，产 `rate` 因果 event
- [ ] retract 路径走 L3 correction event
- [ ] dreaming 夜间产 1 个 proposal 能在 inbox 立刻看到
- [ ] wenyan + math + physics fixture regression 通过
- [ ] `pnpm audit:schema` 通过（allowlist 该清的清）

**弱依赖**：L1 invoker（accept 时调 judge）、L3 correction（retract 路径）。如果 L1/L3 未完，L5.1 可先起，L5.2/L5.3 阶段补。

**Per-lane plan docs**：

- `docs/superpowers/plans/2026-05-2X-l5-1-proposal-union-writer.md`
- `docs/superpowers/plans/2026-05-2X-l5-2-inbox-ui.md`
- `docs/superpowers/plans/2026-05-2X-l5-3-producers-and-signals.md`

---

### L6 — `audit:schema` allowlist 过期约束

**问题**：[scripts/audit-schema-allowlist.json](../../../scripts/audit-schema-allowlist.json) 67 条业务 entry（共 69 keys，含 2 个 `_comment` marker）都带 `resolves_when`（指向某 PR / phase），但 CI 不校验过期，可无限累积。Top 簇（2026-05-23 基线）：artifact（18）/ memory_brief_note（10）/ event（8）/ learning_item（6）/ answer（5）/ knowledge_edge（5）/ learning_session（4）/ material_fsrs_state（4）/ question（4）/ 其他 3。

> 启动 L6 前重新跑 `jq '. | with_entries(select(.key | startswith("_") | not)) | length'` 复核基线 —— 数字会随其他 lane 落地变化。

**Scope**：

- `pnpm audit:schema` 加一段：解析 `resolves_when`，如果指向已合 PR 或已 ship phase 则 fail
- 给 `resolves_when` 一个最小 schema：`{ kind: 'pr' | 'phase' | 'manual', ref: string, expected_by: 'YYYY-MM-DD' }`
- 现有所有业务 entry 一次性按新 schema reformat（不实质改 allowlist，只改格式）

**Exit criteria**：

- [ ] 故意把一个 `resolves_when` 指向已合 PR，CI 失败
- [ ] 全部业务 entry（按启动时实际基线 `jq` 重新统计）按新格式
- [ ] `_comment` marker 保持不动（不强制 `resolves_when`）
- [ ] CLAUDE.md 的 "pnpm audit:schema" 段更新说明新格式
- [ ] 一次 PR 解决

**Per-lane plan doc**：不写（半天活，直接执行）。

---

## 依赖关系图

```
L1 ─┐
L2 ─┼─ (parallel) ──── L5.1 ─── L5.2 ─── L5.3
L3 ─┤                   ↑
L4 ─┤                   弱依赖 L1 (invoker)
L6 ─┘                   弱依赖 L3 (correction event for retract)
```

- L1–L4 + L6 全部互不依赖，可全并行
- L5 弱依赖 L1（accept 路径需要 invoker，但若先做 L5.1 schema 部分不依赖）
- L5.2 弱依赖 L3（retract 复用 correction event）
- 推荐顺序：**先并行收尾 L1/L2/L3/L6 → 单独做 L4 → 起 L5 三段**

## 启动建议

按一周一启的节奏：

| 周 | 启动 lane | 说明 |
|---|---|---|
| W1 | L1 + L2 + L6 | 三条短 lane 同周完结，L6 半天 |
| W2 | L3 + L4 | L3 收 Foundation C，L4 起观测 |
| W3 | L5.1 | inbox schema + writer + reader |
| W4 | L5.2 | inbox UI |
| W5 | L5.3 | 剩余 producer + signals |
| W6 | 收口 | audit-drift + status.md + v0.3 doc §1.5 状态更新 |

## Linear 项目结构

按项目惯例（[docs/agents/issue-tracker.md](../../agents/issue-tracker.md) §"Layer mapping"）model 为 **Linear Project + Milestone**：

- **Project**：[Track 2 起步 + Foundation 末尾收口](https://linear.app/yukoval-studios/project/track-2-起步-foundation-末尾收口-6ecf1ce05315) (priority=Medium, start=2026-05-23, target=2026-07-31)
- **6 Milestones**（lane → Milestone → issue 映射）：

  | Milestone | Lane | Issue | Target |
  |---|---|---|---|
  | M1 — Capability Registry 单 invoker | L1 | [YUK-39](https://linear.app/yukoval-studios/issue/YUK-39) | 2026-05-30 |
  | M2 — SubjectProfile validator | L2 | [YUK-7](https://linear.app/yukoval-studios/issue/YUK-7) + [YUK-8](https://linear.app/yukoval-studios/issue/YUK-8) | 2026-05-30 |
  | M3 — Correction state read model | L3 | [YUK-40](https://linear.app/yukoval-studios/issue/YUK-40) | 2026-06-06 |
  | M4 — AI 运行可观测性 admin surface | L4 | [YUK-41](https://linear.app/yukoval-studios/issue/YUK-41) | 2026-06-06 |
  | M5 — Proposal Inbox (Track 2 anchor) | L5 | [YUK-42](https://linear.app/yukoval-studios/issue/YUK-42) + [YUK-43](https://linear.app/yukoval-studios/issue/YUK-43) + [YUK-44](https://linear.app/yukoval-studios/issue/YUK-44) | 2026-06-27 |
  | M6 — allowlist 过期约束 | L6 | [YUK-45](https://linear.app/yukoval-studios/issue/YUK-45) | 2026-05-30 |

- **Related**（不在本 Project 内）：[YUK-15](https://linear.app/yukoval-studios/issue/YUK-15) + [YUK-19](https://linear.app/yukoval-studios/issue/YUK-19) → M5 完工后才能落地（属 Product Track 1）

总计：1 Project + 6 Milestone + 9 Issues。

**历史记录**：原 [YUK-38](https://linear.app/yukoval-studios/issue/YUK-38) issue/epic 已 Cancel，superseded by 上述 Project（按 2026-05-23 codex review on PR #105 的 F3b 反馈重 model）。

## ADR 触发条件

以下情况需新写 ADR，不在本 outline 内默处理：

- L5 accept 路径决定**直接调用 owner-service** vs **走异步 boss job** —— 如果选异步会改变 v0.3 §2 lifecycle 第 4 步语义，需 ADR
- L4 admin surface 决定**是否单独路由组** vs **复用 `/api/_/` 系列** —— 如果改为独立路由组需 ADR 记录权限边界

## 后续 follow-ups（不在本 outline 内）

- subject #4（english / programming）—— L2 完工后才有意义
- dreaming lane 实施（与 L5 inbox 是消费者关系）—— L5 完工后启动
- Track F multimodal / source grounding —— L5 完工后启动
- partial → mastery view —— Foundation 真 closeout phase（已在 `2026-05-22-foundation-true-closeout-phases.md` P3 后续）
