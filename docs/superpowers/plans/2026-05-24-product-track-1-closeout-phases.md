# Product Track 1 — Review / Learning Item / Teaching 收口 — Phase 大纲

> Phase-level outline，仿 [`2026-05-23-track2-and-foundation-closeout-phases.md`](2026-05-23-track2-and-foundation-closeout-phases.md) 模式。每条 lane 启动前另写 detailed plan doc（math MVP 级别）。

**Roadmap source**: [`docs/planning/v0.3-generalized-ai-learning-framework.md`](../../planning/v0.3-generalized-ai-learning-framework.md) §1.5 Product Track 1 + §7 Track A (stabilise) + Track D (proposal inbox lifecycle on existing producers)
**Date**: 2026-05-24
**Status**: outline only —— per-lane plan docs to follow as lanes start
**Background**: Track 2 起步 + Foundation 末尾收口 Project 几近完工（M1/M2/M3/M4/M6 ✅ Done，M5 ✅ Done，仅 [YUK-51](https://linear.app/yukoval-studios/issue/YUK-51) user_cause merge policy In Progress）。embedded check MVP + Judge v2 light 已 ship 到 main (PR #76)。本 outline 接手 v0.3 Track A 余下的 stabilise 工作 —— Review / Learning Item / Teaching 三条 loop 端到端跑通可信，再扩 subject #2。

## 范围与边界

**本 outline 覆盖** 8 条 lane（按 Milestone 划分 2 组）：

**M1 — Teaching 收口**：

- L1 — Teaching idle state machine 设计 ([YUK-13](https://linear.app/yukoval-studios/issue/YUK-13))
- L2 — Teaching idle state machine 实现 ([YUK-14](https://linear.app/yukoval-studios/issue/YUK-14))
- L3 — record → proposal evidence loop ([YUK-15](https://linear.app/yukoval-studios/issue/YUK-15))
- L4 — Phase 2C chat 部署 + browser E2E ([YUK-47](https://linear.app/yukoval-studios/issue/YUK-47))

**M2 — Note / Variant / Review UX 收尾**：

- L5 — Note editor / read UX ([YUK-16](https://linear.app/yukoval-studios/issue/YUK-16) parent + 4 sub-issue [YUK-52](https://linear.app/yukoval-studios/issue/YUK-52)~[YUK-55](https://linear.app/yukoval-studios/issue/YUK-55))
- L6 — Variant double-pass + VariantVerifyTask ([YUK-17](https://linear.app/yukoval-studios/issue/YUK-17))
- L7 — Review session UX polish ([YUK-18](https://linear.app/yukoval-studios/issue/YUK-18) parent + 8 sub-issue [YUK-56](https://linear.app/yukoval-studios/issue/YUK-56)~[YUK-63](https://linear.app/yukoval-studios/issue/YUK-63)，4 P2 + 4 P3)
- L8 — Learning-item proposal rollback UI ([YUK-19](https://linear.app/yukoval-studios/issue/YUK-19))

**不在本 outline 内**：

- Subject #2（english / programming）—— Foundation B + math profile pressure test 已 ship，但需先收 L5/L7 再扩 subject 以避免 UX 重写
- Product Track 2 (Maintenance Agent + Dreaming Lane 消费 inbox) —— [YUK-48](https://linear.app/yukoval-studios/issue/YUK-48) 是 Track 2 Project 内的 maintenance producer，L3 是 record 端，consumer 侧另起 outline
- Track F multimodal / source grounding —— 留待 Product Track 1+2 双收口后
- Standalone MCP / plugin —— v0.3 §1.5 明确 Later
- Phase 3 Coach Orchestrator —— 等 Track 1 收口后的 evidence 累积

## Phase 序列总览

| Lane | 主题 | 估时 | 关键 acid test / exit | sub-issue | 依赖 |
|---|---|---|---|---|---|
| L1 | Teaching idle state machine 设计 | 1-2 day | 设计 doc + 用户 approve | 0 | — |
| L2 | Teaching idle state machine 实现 | 3-5 day | idle → resume E2E 通过 | 0 | L1 |
| L3 | record → proposal evidence loop | 3-4 day | record ↔ proposal 双向 backlink | 0 | [YUK-44](https://linear.app/yukoval-studios/issue/YUK-44) + [YUK-48](https://linear.app/yukoval-studios/issue/YUK-48) (Track 2) |
| L4 | Phase 2C chat browser E2E | 0.5-1 day | NAS 浏览器 3-turn 真聊 + 无 console error | 0 | embedded-check-mvp 已合 main (PR #76 ✅) |
| L5 | Note editor / read UX | 7-13 day | markdown + inline check + edit-in-place + verification badge | 4 | embedded-check-mvp 已合 main ✅ |
| L6 | Variant double-pass | 3-4 day | VariantVerifyTask + variants_max + state transition | 0 | — |
| L7 | Review session UX polish | 8-15 day | 8 sub-lane 全 ship + 日用 1 周无新 friction | 8 | [YUK-39](https://linear.app/yukoval-studios/issue/YUK-39) invoker ✅ (P2.1 lane) |
| L8 | Learning-item rollback UI | 2-3 day | accept → rollback round trip E2E | 0 | [YUK-43](https://linear.app/yukoval-studios/issue/YUK-43) (Track 2, ✅) + [YUK-40](https://linear.app/yukoval-studios/issue/YUK-40) renderer ✅ |

**总估时**：28-47 day（5.5-9.5 周，单人节奏）。M1 内部 L1→L2 sequential，L3/L4 独立；M2 全部独立 lane，sub-issue 内部可并行。

## Lane scope + exit criteria

### L1 — Teaching idle state machine 设计 ([YUK-13](https://linear.app/yukoval-studios/issue/YUK-13))

**问题**：Phase 2C teaching session ship 后（`src/server/session/conversation.ts`），session status 只有 `active` / `ended`，没明确"用户走开"状态。UI 卡 spinner，6h orphan cron 兜底但不优雅。

**Scope**：

- 设计 doc 落 `docs/design/2026-05-2X-teaching-idle-state-machine.md`
  - 状态枚举（`active` / `awaiting_user` / `idle_short` / `idle_long` / `abandoned`）+ 各状态语义
  - 转移条件（用户 / Agent message / 时间阈值 / 显式 abandon / pagehide）
  - AI 介入时机（idle_short 是否主动 ping / idle_long 是否归档）
  - Persistence 策略（status enum 直接存 vs derived view 投影；与 ADR-0006 v2 event 表骨架对齐）
  - 与 ADR-0013 `/review` session lifecycle 的对齐 / 差异
- 必要时新 ADR（若引入新 KnownEvent action 或 schema column 破坏现有形态）
- 启动前跑 `superpowers/brainstorming` + `superpowers/grill-me`

**Exit criteria**：

- [ ] 设计 doc 含 5+ 状态枚举 + 各转移条件
- [ ] 至少 1 个 mermaid sequence diagram 描述 idle → ping → resume 路径
- [ ] persistence 策略与 ADR-0006 v2 一致
- [ ] 与 ADR-0013 对齐点 / 差异点显式列出
- [ ] 用户 approve 设计 doc 后才 close issue

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-l1-teaching-idle-design.md`

---

### L2 — Teaching idle state machine 实现 ([YUK-14](https://linear.app/yukoval-studios/issue/YUK-14))

**问题**：L1 设计 doc 落定后，server 状态机 + schema migration + frontend idle banner / resume 入口要落地。

**Scope**：

- `src/server/session/conversation.ts` —— 状态机 transition logic + persistence
- `src/db/schema.ts` —— 必要时加 status enum / `idle_at` column / migration（决于 L1 设计）
- `app/api/teaching-sessions/[id]/ping/route.ts` —— Agent ping 路径（若设计要）
- `app/(app)/learn/[id]/chat/page.tsx` —— frontend idle banner + resume button
- pg-boss cron handler `teaching_idle_scan` 若设计要定时扫
- 单测覆盖每条转移 + E2E：发消息 → idle → resume → 继续 → end

**Exit criteria**：

- [ ] 状态机 server 端实现 + 单测覆盖每条转移
- [ ] frontend idle banner 在 `idle_short` / `idle_long` 显示
- [ ] resume 按钮恢复 session 不丢消息
- [ ] abandoned 状态由 cron 或显式按钮兜底
- [ ] `pnpm typecheck` / `pnpm test` PASS
- [ ] `pnpm audit:schema` PASS（新 column 走 write path 或入 allowlist）

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-l2-teaching-idle-impl.md`

---

### L3 — record → proposal evidence loop ([YUK-15](https://linear.app/yukoval-studios/issue/YUK-15))

**问题**：`/record` 条目当前与 proposal 系统无双向 link；用户 record 内容产 proposal 时引用 record id，但 UI 不能反向追溯 record → proposal。

**边界（2026-05-23 决议）**：与 Track 2 [YUK-48](https://linear.app/yukoval-studios/issue/YUK-48) 互补 —— YUK-48 = 夜间 maintenance producer 实现（写 record id 进 `evidence_refs`）；L3 = record 端打标 unprocessed + proposal 详情页 UI backlink。

**Scope**：

- `src/db/schema.ts` —— `learning_record` 加 `processed_proposal_ids[]` 或 `unprocessed_at` 列
- `src/server/records/` —— record write path 标 unprocessed；producer accept proposal 时标 processed
- `app/(app)/records/[id]/page.tsx` —— record 详情显示"已产生的 proposal"列表
- `app/(app)/inbox/[id]/page.tsx`（YUK-43 已建）—— `evidence_refs.record` 渲染为 backlink chip
- 测试：record 写入 → unprocessed → producer 产 proposal 引用 record → UI 双向跳转

**Exit criteria**：

- [ ] record 表 schema 支持 unprocessed / processed 状态
- [ ] producer accept proposal 时正确标 record processed（与 YUK-48 producer 接口对齐）
- [ ] inbox UI 渲染 `evidence_refs.record` 为可点击 backlink
- [ ] record 详情页显示"已产生 N 个 proposal" + 各自链接
- [ ] `pnpm test:db` 覆盖双向跳转
- [ ] `pnpm audit:schema` PASS

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-l3-record-proposal-loop.md`

---

### L4 — Phase 2C chat 部署 + browser E2E ([YUK-47](https://linear.app/yukoval-studios/issue/YUK-47))

**问题**：Phase 2C teaching loop ship 后没在浏览器 E2E 跑过；NAS 容器还是旧 build。`docs/superpowers/status.md` §7 列为"高严重度"遗留项。

**Scope**：

1. NAS 上 `docker compose up --build`
2. 浏览器开 `/learn/[id]/chat` 跟 mimo 真聊 3 轮
3. 观察 console error / network failure / latency
4. 记录任何回归 bug 到新 issue（不在本 lane 修）
5. 若 L2 idle 实现已 ship，一并验 idle → resume 路径
6. cost ledger / ai_task_runs 表确认 mimo call 落库

**Exit criteria**：

- [ ] NAS 容器 rebuild 成功（最新 main commit）
- [ ] 浏览器 `/learn/[id]/chat` 完成 3-turn 真聊
- [ ] 无 console error / hydration mismatch
- [ ] `ai_task_runs` / `cost_ledger` 看到 mimo call
- [ ] 任何发现的 bug 录入新 issue + 标 priority

**Per-lane plan doc**：不写（验证类 lane，无 design 需要）

---

### L5 — Note editor / read UX ([YUK-16](https://linear.app/yukoval-studios/issue/YUK-16) parent，4 sub-issue)

**问题**：embedded check 数据通路 ship 但 UI 没接入；atomic note 阅读 + 编辑体验未收口。

**Scope（4 sub-issue 并行）**：

- **L5.1 markdown 渲染** ([YUK-52](https://linear.app/yukoval-studios/issue/YUK-52))：atomic note section markdown / code block / 图片渲染统一（est 1-2 day）
- **L5.2 embedded check inline 显示** ([YUK-53](https://linear.app/yukoval-studios/issue/YUK-53))：note `check` section 末尾 inline 题目 UI 接入（est 2-3 day）
- **L5.3 edit-in-place** ([YUK-54](https://linear.app/yukoval-studios/issue/YUK-54))：note section 直接编辑 + 保存（不跳页面）（est 3-5 day，**可能触发 edit KnownEvent ADR**）
- **L5.4 verification status 可视化** ([YUK-55](https://linear.app/yukoval-studios/issue/YUK-55))：NoteVerifyTask 状态 badge / failed 提示（est 1-2 day）

各 sub-issue 启动时**动 UI 前走 design-doc pre-flight**（CLAUDE.md `feedback_ui_preflight` 强约束）。

**Exit criteria**：

- [ ] 4 sub-issue 全部 close
- [ ] `/learning-items/[id]` 阅读 + 编辑体验通过用户验收
- [ ] 无 hydration mismatch / accessibility 退化

**Per-lane plan doc**：每个 sub-issue 各自启动时写

---

### L6 — Variant double-pass + VariantVerifyTask ([YUK-17](https://linear.app/yukoval-studios/issue/YUK-17))

**问题**：当前 `variant_gen` handler 是单 pass MVP，无二次验证；`variants_max` 计数未实现；draft → active state transition 缺。

**Scope**：

- `src/server/ai/tasks/variant-verify.ts` —— `VariantVerifyTask`（等价性 + 难度漂移检查）
- `src/server/boss/handlers/variant_verify.ts` —— pg-boss handler，串在 `variant_gen` 之后
- `src/db/schema.ts` —— `question` 加 `state` column（draft / active / rejected）或独立 `variants_max` 计数表
- `src/server/boss/handlers/variant_gen.ts` —— 生成完入队 verify，先标 draft
- 测试：等价通过 → active；漂移失败 → rejected + log

**Exit criteria**：

- [ ] `VariantVerifyTask` 加入 capability registry
- [ ] handler 串入 `variant_gen → variant_verify` pipeline
- [ ] 等价 + 难度漂移检查 LLM call 落 `ai_task_runs`
- [ ] `variants_max` 计数（per parent question）
- [ ] draft → active state transition（rejected 状态可标）
- [ ] `pnpm test:db` 覆盖 verify pass / fail 两路径
- [ ] `pnpm audit:schema` PASS

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-l6-variant-verify-pass2.md`

---

### L7 — Review session UX polish ([YUK-18](https://linear.app/yukoval-studios/issue/YUK-18) parent，8 sub-issue: 4 P2 + 4 P3)

**问题**：`/review` 已稳定（ADR-0013 session lifecycle + 2-fetch 队列 + ReviewIntent 字幕 + SessionEndSummary），但日用累积 8 个 friction，2026-05-23 brainstorm 拆分。

**Scope —— P2 lanes (日用 friction，优先做)**：

- **L7.P2.1 接 judge router 自动判分** ([YUK-56](https://linear.app/yukoval-studios/issue/YUK-56))：exact / keyword 题自动判，semantic 题给建议 rating（est 3-5 day，复用 [YUK-39](https://linear.app/yukoval-studios/issue/YUK-39) invoker + Judge v2 light）
- **L7.P2.2 跳过题目 + 暂停/恢复** ([YUK-57](https://linear.app/yukoval-studios/issue/YUK-57))：skip / pause / resume 按钮 + persistence（est 3-5 day）
- **L7.P2.3 当前题历史 attempt timeline** ([YUK-58](https://linear.app/yukoval-studios/issue/YUK-58))：feedback 阶段显示历史 attempt + cause 趋势（est 2-3 day）
- **L7.P2.4 session end 下一步引导** ([YUK-59](https://linear.app/yukoval-studios/issue/YUK-59))：done 状态加 CTA（est 1-2 day）

**Scope —— P3 lanes (体验深化)**：

- **L7.P3.1 混合 subject queue 视觉分隔** ([YUK-60](https://linear.app/yukoval-studios/issue/YUK-60))：wenyan ↔ math 切换显式 marker（est 1-2 day）
- **L7.P3.2 answer textarea markdown / math preview** ([YUK-61](https://linear.app/yukoval-studios/issue/YUK-61))：split-view live preview（est 2-3 day）
- **L7.P3.3 ReviewIntent 字幕 dismiss / persist 行为定义** ([YUK-62](https://linear.app/yukoval-studios/issue/YUK-62))：多 session 复用 / dismiss 行为（est 1-2 day，**含 design 决策点**）
- **L7.P3.4 abandoned session resume 入口** ([YUK-63](https://linear.app/yukoval-studios/issue/YUK-63))：`/learning-sessions` 列表 + resume（est 2-3 day，与 P2.2 协调）

**Exit criteria**：

- [ ] 8 sub-issue 全部 close（4 P2 优先做完）
- [ ] 日用 1 周后无明显新增 friction
- [ ] review session 数据（duration / rating 分布）无回归

**Per-lane plan doc**：每个 sub-issue 各自启动时写

---

### L8 — Learning-item proposal rollback UI ([YUK-19](https://linear.app/yukoval-studios/issue/YUK-19))

**问题**：误 accept 的 proposal 当前只能 DB 操作 rollback；UI 没反向入口。

**Scope**：

- `app/(app)/learning-items/[id]/page.tsx` —— accepted proposal 列表 + "撤回 / rollback" 按钮
- 复用 `app/api/proposals/[id]/retract/route.ts`（[YUK-43](https://linear.app/yukoval-studios/issue/YUK-43) 已建）或 learning-item 端独立 route
- `src/ui/components/CorrectionStateRenderer.tsx`（[YUK-40](https://linear.app/yukoval-studios/issue/YUK-40) 已建）—— 显示 effective truth + rollback CTA
- 测试：accept → rollback → 状态反映 → 重新 propose 可能

**Exit criteria**：

- [ ] learning-item 详情页 accepted proposal 有"撤回"按钮
- [ ] rollback 走 correction event `retract`（不绕 owner service）
- [ ] CorrectionStateRenderer 显示 retracted 状态
- [ ] rollback 后原 hub / atomic LearningItem 状态正确
- [ ] 单测 + E2E 覆盖 accept → rollback round trip

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-l8-learning-item-rollback-ui.md`

---

## 依赖关系图

```
M1: L1 → L2 (设计 → 实现)
    L3 ←─ Track 2 [YUK-44](M5.3) ✅ + [YUK-48](maintenance producer) (codex 在做)
    L4 ←─ embedded-check-mvp 合 main ✅ (PR #76)

M2: L5 (4 sub-issue 并行) ←─ embedded-check-mvp ✅
    L6 独立
    L7 (8 sub-issue: P2 → P3 推荐)
       L7.P2.1 ←─ Foundation A [YUK-39](invoker) ✅
       L7.P3.4 与 L7.P2.2 协调（resume 入口统一）
    L8 ←─ Track 2 [YUK-43](M5.2) ✅ + Foundation C [YUK-40](renderer) ✅
```

**关键观察**：M1/M2 几乎所有 cross-project 依赖都已 ✅。只剩 L3 弱依赖 [YUK-48](https://linear.app/yukoval-studios/issue/YUK-48)（Track 2 内 maintenance producer，codex 在做）+ L1→L2 内部顺序。

## 启动建议

| 周 | 启动 lane | 说明 |
|---|---|---|
| W1 | L1 + L4 + L6 + L5.1 (markdown) | 设计 / 部署 / 独立 lane 并发；L5.1 是 L5 内最小 lane |
| W2 | L2 + L3 + L5.2 (inline check) + L7.P2.1 (judge router) | L2 等 L1；L3 已 unblock；L7.P2.1 是 review 最高 ROI |
| W3 | L5.3 (edit) + L7.P2.2 (skip/pause) + L7.P2.3 (timeline) | M2 核心 lane 推进 |
| W4 | L5.4 (verify badge) + L7.P2.4 (CTA) + L8 + L7.P3.1/3.2 | M1 收口 + P3 起 |
| W5 | L7.P3.3 (intent dismiss) + L7.P3.4 (resume entry) + 收口 | P3 完成 + audit-drift + status.md / v0.3 doc §1.5 状态更新 |

按一周一批节奏，5-6 周可全 ship；codex 在 lane 间并行可压到 4 周。

## Linear 项目结构

按项目惯例（[docs/agents/issue-tracker.md](../../agents/issue-tracker.md) §"Layer mapping"）model 为 **Linear Project + Milestone**：

- **Project**：[Product Track 1 — Review / Learning Item / Teaching 收口](https://linear.app/yukoval-studios/project/product-track-1-review-learning-item-teaching-收口-87f2e3007a16) (priority=No priority, start=2026-05-23, target=2026-07-31)
- **2 Milestones**（lane → Milestone → issue 映射）：

  | Milestone | Lane | Issue | Target |
  |---|---|---|---|
  | M1 — Teaching 收口 | L1-L4 | [YUK-13](https://linear.app/yukoval-studios/issue/YUK-13) / [YUK-14](https://linear.app/yukoval-studios/issue/YUK-14) / [YUK-15](https://linear.app/yukoval-studios/issue/YUK-15) / [YUK-47](https://linear.app/yukoval-studios/issue/YUK-47) | 2026-06-10 |
  | M2 — Note / Variant / Review UX 收尾 | L5-L8 | [YUK-16](https://linear.app/yukoval-studios/issue/YUK-16) + 4 sub + [YUK-17](https://linear.app/yukoval-studios/issue/YUK-17) + [YUK-18](https://linear.app/yukoval-studios/issue/YUK-18) + 8 sub + [YUK-19](https://linear.app/yukoval-studios/issue/YUK-19) | 2026-07-01 |

- **Related**（不在本 Project 内）：
  - Track 2 起步 [YUK-48](https://linear.app/yukoval-studios/issue/YUK-48)（maintenance producer）—— L3 的上游
  - Track 2 起步 [YUK-43](https://linear.app/yukoval-studios/issue/YUK-43)（inbox UI retract）—— L8 复用 API
  - Foundation A [YUK-39](https://linear.app/yukoval-studios/issue/YUK-39)（judge invoker）—— L7.P2.1 复用
  - Foundation C [YUK-40](https://linear.app/yukoval-studios/issue/YUK-40)（correction renderer）—— L8 复用

总计：1 Project + 2 Milestone + 8 parent + 12 sub = 20 Issues。

## ADR 触发条件

以下情况需新写 ADR，不在本 outline 内默处理：

- **L1 / L2**: 若设计要新 KnownEvent action（如 `event(action='idle_*')`）或 schema column 破坏现有形态，需 ADR
- **L5.3 edit-in-place**: 若引入 `event(action='edit')` KnownEvent 或 artifact versioning 模型，需 ADR
- **L7.P2.1 judge router**: 若改变 `/api/review/submit` response contract（加 judge result + 建议 rating），可能需 ADR for response schema migration
- **L7.P3.3 ReviewIntent dismiss**: 若引入 `event(action='dismiss', subject_kind='review_intent')` 或新表，需 ADR

## 后续 follow-ups（不在本 outline 内）

- **Subject #2 启动** —— L5 / L7 收口后才扩 english / programming，避免边扩边改 UX
- **Product Track 2 (Maintenance Agent + Dreaming Lane)** —— L3 ship 后 inbox 端有真实 record evidence 喂数据；Maintenance / Dreaming 是 inbox 的消费者
- **Phase 3 Coach Orchestrator** —— 用 Track 1 收口后的 evidence 累积做 daily lane + plan suggestion
- **Track F multimodal / source grounding** —— Track 1 + Track 2 双收口后启动
- **`docs/superpowers/status.md` 更新** —— 每完成一个 Milestone 就 update Phase 路线图 + 当前 ⬜ / 🟡 / ✅ 状态
