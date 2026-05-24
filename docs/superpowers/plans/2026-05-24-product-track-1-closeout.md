# Product Track 1 — Review / Learning Item / Teaching Loop 收口 Phase 大纲

> Phase-level outline，仿 [`2026-05-23-track2-and-foundation-closeout-phases.md`](2026-05-23-track2-and-foundation-closeout-phases.md) 模式。每条 lane 启动前另写 detailed plan doc。

**Roadmap source**: [`docs/planning/v0.3-generalized-ai-learning-framework.md`](../../planning/v0.3-generalized-ai-learning-framework.md) §1.5 "Product Track 1 — Review / Learning Item / Teaching Loop 收口"
**Linear Project**: [Product Track 1 — Review / Learning Item / Teaching 收口](https://linear.app/yukoval-studios/project/product-track-1-review-learning-item-teaching-收口-87f2e3007a16)
**Date**: 2026-05-24
**Status**: outline only —— per-lane plan docs to follow as lanes start
**Background**: [Track 2 起步 + Foundation 末尾收口](https://linear.app/yukoval-studios/project/track-2-起步-foundation-末尾收口-6ecf1ce05315) Project 已 Completed (2026-05-24)。Foundation A 单 invoker ([YUK-39](https://linear.app/yukoval-studios/issue/YUK-39))、Foundation B profile validator ([YUK-7](https://linear.app/yukoval-studios/issue/YUK-7) + [YUK-8](https://linear.app/yukoval-studios/issue/YUK-8))、Foundation C correction renderer ([YUK-40](https://linear.app/yukoval-studios/issue/YUK-40))、Track A admin obs ([YUK-41](https://linear.app/yukoval-studios/issue/YUK-41))、Track 2 proposal inbox ([YUK-42](https://linear.app/yukoval-studios/issue/YUK-42) + [YUK-43](https://linear.app/yukoval-studios/issue/YUK-43) + [YUK-44](https://linear.app/yukoval-studios/issue/YUK-44))、maintenance nightly ([YUK-48](https://linear.app/yukoval-studios/issue/YUK-48))、embedded-check MVP (PR #76 commit `d1d79e4`) 全部 ✅ Done in main。**Track 1 零外部 blocker**。

## 范围与边界

**本 outline 覆盖** Linear `Product Track 1` Project 全部 2 个 Milestone 共 17 启动单元（4 parent + 12 sub + 1 standalone 已在 Linear 拆完）：

- **M1 — Teaching 收口** (target 2026-06-10)：[YUK-13](https://linear.app/yukoval-studios/issue/YUK-13) / [YUK-14](https://linear.app/yukoval-studios/issue/YUK-14) / [YUK-15](https://linear.app/yukoval-studios/issue/YUK-15) / [YUK-47](https://linear.app/yukoval-studios/issue/YUK-47)
- **M2 — Note / Variant / Review UX 收尾** (target 2026-07-01)：[YUK-16](https://linear.app/yukoval-studios/issue/YUK-16) (4 sub) + [YUK-17](https://linear.app/yukoval-studios/issue/YUK-17) + [YUK-18](https://linear.app/yukoval-studios/issue/YUK-18) (8 sub) + [YUK-19](https://linear.app/yukoval-studios/issue/YUK-19)

**总估时**：5-7 周，~64 pts（M1 ~14 + M2 ~50），单人节奏。沿用 Track 2 / math MVP 已验证的"独立 PR + 独立 reviewer 关卡 + 独立 audit + chain-merge"模式。

**不在本 outline 内**：

- Subject #4（english / programming）—— 等 Track 1 完成后再启
- Track F multimodal / source grounding —— v0.3 §1.5 明确 Later
- Dreaming lane 完整实施 —— proposal inbox 已 ship 是 consumer
- ADR-0017 memory Mem0 + brief layer —— [YUK-37](https://linear.app/yukoval-studios/issue/YUK-37) 已 ship
- Standalone MCP / plugin —— v0.3 §1.5 明确 Later

## Phase 序列总览（按 Milestone）

### M1 — Teaching 收口（4 lane / ~14 pts / target 2026-06-10）

| Issue | 主题 | pts | priority | 启动可行性 | 依赖 |
|---|---|---|---|---|---|
| [YUK-13](https://linear.app/yukoval-studios/issue/YUK-13) | Teaching idle state machine 设计 | 2 | High | ✅ unblocked | — |
| [YUK-14](https://linear.app/yukoval-studios/issue/YUK-14) | Teaching idle state machine 实现 | 5 | High | 🟡 blockedBy YUK-13 | YUK-13 |
| [YUK-15](https://linear.app/yukoval-studios/issue/YUK-15) | record → proposal evidence loop | 5 | High | ✅ unblocked | (YUK-44 / YUK-48 已 ship) |
| [YUK-47](https://linear.app/yukoval-studios/issue/YUK-47) | Phase 2C chat deploy + browser E2E | 2 | High | ✅ unblocked | (embedded-check 已合 main) |

### M2 — Note / Variant / Review UX 收尾（13 lane / ~50 pts / target 2026-07-01）

**YUK-16 Note editor / read UX**（parent，4 sub 并行）

| Issue | 主题 | pts | priority | 启动可行性 |
|---|---|---|---|---|
| [YUK-52](https://linear.app/yukoval-studios/issue/YUK-52) | markdown 渲染 | 2 | Medium | ✅ |
| [YUK-53](https://linear.app/yukoval-studios/issue/YUK-53) | embedded check inline | 3 | High | ✅ |
| [YUK-54](https://linear.app/yukoval-studios/issue/YUK-54) | section edit-in-place | 5 | Medium | ✅ |
| [YUK-55](https://linear.app/yukoval-studios/issue/YUK-55) | verification badge | 2 | Medium | ✅ |

**YUK-17 Variant double-pass + VariantVerifyTask**

| Issue | 主题 | pts | priority | 启动可行性 |
|---|---|---|---|---|
| [YUK-17](https://linear.app/yukoval-studios/issue/YUK-17) | Variant double-pass + variants_max | 5 | Medium | ✅ unblocked, 独立 |

**YUK-18 Review session UX polish**（parent，8 sub，4 P2 + 4 P3）

| Issue | 主题 | pts | priority | 启动可行性 |
|---|---|---|---|---|
| [YUK-56](https://linear.app/yukoval-studios/issue/YUK-56) | P2.1 judge router auto-rating | 5 | High | ✅ |
| [YUK-57](https://linear.app/yukoval-studios/issue/YUK-57) | P2.2 skip + pause/resume | 5 | High | ✅ |
| [YUK-58](https://linear.app/yukoval-studios/issue/YUK-58) | P2.3 attempt history timeline | 3 | High | ✅ |
| [YUK-59](https://linear.app/yukoval-studios/issue/YUK-59) | P2.4 session-end CTA | 2 | High | ✅ |
| [YUK-60](https://linear.app/yukoval-studios/issue/YUK-60) | P3.1 subject switch marker | 2 | Medium | ✅ |
| [YUK-61](https://linear.app/yukoval-studios/issue/YUK-61) | P3.2 textarea markdown/math preview | 3 | Medium | ✅ |
| [YUK-62](https://linear.app/yukoval-studios/issue/YUK-62) | P3.3 ReviewIntent banner dismiss | 2 | Medium | ✅ |
| [YUK-63](https://linear.app/yukoval-studios/issue/YUK-63) | P3.4 abandoned session resume | 3 | Medium | ✅ |

**YUK-19 Learning-item rollback UI**

| Issue | 主题 | pts | priority | 启动可行性 |
|---|---|---|---|---|
| [YUK-19](https://linear.app/yukoval-studios/issue/YUK-19) | Learning-item proposal rollback UI | 3 | Medium | ✅ unblocked (YUK-40 + YUK-43 已 ship) |

## 启动 Wave 划分

按 **4-5 lane / wave** 节奏，**区域分散**降低 merge 冲突，**chain-merge 顺序按 wave 内 area 排**：

### Wave 1 —— 5 lane / 17 pts / 全 unblocked

| Lane | 主题 | pts | 区域 |
|---|---|---|---|
| [YUK-13](https://linear.app/yukoval-studios/issue/YUK-13) | Teaching idle 设计（doc-only） | 2 | docs/design/ |
| [YUK-47](https://linear.app/yukoval-studios/issue/YUK-47) | Phase 2C NAS deploy + E2E | 2 | docker-compose / NAS / browser E2E |
| [YUK-17](https://linear.app/yukoval-studios/issue/YUK-17) | Variant double-pass + variants_max | 5 | src/server/boss/handlers/variant_*.ts + 新 verify handler |
| [YUK-19](https://linear.app/yukoval-studios/issue/YUK-19) | Learning-item rollback UI | 3 | src/server/proposals/actions.ts + inbox surface |
| [YUK-56](https://linear.app/yukoval-studios/issue/YUK-56) | Review P2.1 judge auto-rating | 5 | app/api/review/submit + review page (review 区第 1 个) |

**Chain-merge order**：YUK-13 → YUK-47 → YUK-17 → YUK-19 → YUK-56（doc-only 先 land 起 reference，部署类提前暴露 NAS 问题，最复杂 review 改动放尾部 pre-merge gate）。

**为什么 W1 这 5 个**：
- 全部 unblocked（YUK-14 唯一 hard blocker，留 W2）
- 区域完全分散（docs / deploy / variant / proposal-inbox-surface / review），review page 区只放 1 lane 避免 page.tsx 多人改
- 含 YUK-13 design lane —— 早交付 design doc 解锁 W2 的 YUK-14 实现
- 含 YUK-47 deploy lane —— 早跑暴露 NAS 真机环境问题，不等所有 lane ship 后才发现部署炸

### Wave 2 —— 5 lane / 20 pts

| Lane | 主题 | pts | 依赖 |
|---|---|---|---|
| [YUK-14](https://linear.app/yukoval-studios/issue/YUK-14) | Teaching idle 实现 | 5 | hard ← W1 YUK-13 design doc |
| [YUK-15](https://linear.app/yukoval-studios/issue/YUK-15) | record → proposal evidence loop | 5 | 无 |
| [YUK-52](https://linear.app/yukoval-studios/issue/YUK-52) | Note markdown 渲染 | 2 | 无（Note 区第 1 个）|
| [YUK-57](https://linear.app/yukoval-studios/issue/YUK-57) | Review P2.2 skip + pause/resume | 5 | 无（review 区第 2 个，避开 YUK-56 submit）|
| [YUK-58](https://linear.app/yukoval-studios/issue/YUK-58) | Review P2.3 attempt timeline | 3 | 无（review feedback 阶段独立 API）|

**Chain-merge order**：YUK-14 → YUK-15 → YUK-52 → YUK-57 → YUK-58。

**冲突注意**：YUK-57 + YUK-58 都 touch `app/(app)/review/page.tsx`；按上述顺序 chain-merge，YUK-58 rebase 后再 PR。

### Wave 3 —— 5 lane / 12 pts

| Lane | 主题 | pts | 依赖 |
|---|---|---|---|
| [YUK-53](https://linear.app/yukoval-studios/issue/YUK-53) | Note embedded check inline | 3 | soft ← W2 YUK-52 markdown |
| [YUK-55](https://linear.app/yukoval-studios/issue/YUK-55) | Note verification badge | 2 | soft ← W2 YUK-52 |
| [YUK-59](https://linear.app/yukoval-studios/issue/YUK-59) | Review P2.4 session-end CTA | 2 | 无 |
| [YUK-60](https://linear.app/yukoval-studios/issue/YUK-60) | Review P3.1 subject switch marker | 2 | 无 |
| [YUK-61](https://linear.app/yukoval-studios/issue/YUK-61) | Review P3.2 textarea preview | 3 | 无 |

**Chain-merge order**：YUK-53 → YUK-55 → YUK-59 → YUK-60 → YUK-61。

### Wave 4 —— 3 lane / 10 pts（收尾）

| Lane | 主题 | pts | 依赖 |
|---|---|---|---|
| [YUK-54](https://linear.app/yukoval-studios/issue/YUK-54) | Note section edit-in-place | 5 | soft ← W2 YUK-52 + W3 YUK-53 |
| [YUK-62](https://linear.app/yukoval-studios/issue/YUK-62) | Review P3.3 ReviewIntent banner | 2 | 无 |
| [YUK-63](https://linear.app/yukoval-studios/issue/YUK-63) | Review P3.4 abandoned session resume | 3 | soft ← W2 YUK-57 pause/resume 入口 |

**Chain-merge order**：YUK-54 → YUK-62 → YUK-63。

**Wave 总计**：4 wave × 4-5 lane = 17 启动单元 / 59 pts（parent issue YUK-16/18 由 4+8 sub 自动 close）。

## Lane scope + exit criteria

> 启动每条 lane 前另写 detailed plan doc `docs/superpowers/plans/2026-05-2X-<issue-slug>.md`。本 outline 只给 outline-level scope。

### M1.1 — YUK-13 Teaching idle state machine 设计

**问题**：Phase 2C 教学循环 ship 后，session 没明确"用户走开"状态，UI 一直 spinner。

**Scope**：
- 状态枚举（active / awaiting_user / idle / abandoned / ended）
- 转移条件（用户消息 / 时间窗 / 显式 end / orphan cron）
- Persistence 字段（`learning_session(type='conversation')` 的 status）
- Reference pattern：ADR-0013 `/review` session lifecycle
- 输出：`docs/design/2026-05-2X-teaching-idle-state-machine.md` 设计 doc，user-approved 后 close

**Exit criteria**：
- [ ] 设计 doc 包含状态枚举 + 转移 + persistence + edge cases
- [ ] user-approved 标记落地
- [ ] [YUK-14](https://linear.app/yukoval-studios/issue/YUK-14) Pre-req unblocked

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-yuk-13-teaching-idle-design.md`

---

### M1.2 — YUK-14 Teaching idle state machine 实现

**问题**：YUK-13 设计 doc 落地后落实 server 状态机 + frontend idle UX。

**Scope**：
- `src/server/session/conversation.ts` 加状态转移
- Schema：`learning_session.status` 加 `awaiting_user` / `idle` / `abandoned`（如设计 doc 决定新枚举）
- Event 写入：状态转移作为 event 持久化
- Frontend：idle banner / resume CTA（chat 页）
- Migration：若 schema 改了

**Exit criteria**：
- [ ] 状态转移 server test 全绿
- [ ] frontend idle UX 真机走过一次（NAS）
- [ ] 集成测试覆盖 timeout → idle → resume / abandon 路径
- [ ] `pnpm test:db` + `pnpm test:migration` 通过
- [ ] `pnpm audit:schema` 通过（新字段加 write path 或 allowlist + resolves_when）

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-yuk-14-teaching-idle-impl.md`

---

### M1.3 — YUK-15 record → proposal evidence loop

**问题**：`/record` 条目当前无法作为 evidence_ref 浮现成 graph node / learning-item proposal，proposal 详情也没 backlink 回 record。

**Scope**（按 Linear issue 边界）：
- record 端打标 `unprocessed`
- proposal 详情页 UI backlink 区
- 不实现夜间 producer（YUK-48 已 ship）

**Exit criteria**：
- [ ] record 写入后可被 proposer 引用（schema 字段 evidence_refs 已存在）
- [ ] proposal 详情页能反向 backlink 到 record
- [ ] `pnpm test:db` 通过
- [ ] wenyan + math + physics fixture regression 通过

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-yuk-15-record-proposal-loop.md`

---

### M1.4 — YUK-47 Phase 2C chat deploy + browser E2E

**问题**：Phase 2C teaching session 代码已 ship 但 NAS 容器是旧 build，浏览器 E2E 未跑过。

**Scope**：
- NAS `docker compose up --build`
- 浏览器 E2E：3 轮真聊（不同 subject / 不同 prompt）
- 截图存档 `docs/agents/phase-2c-chat-e2e.png`
- 失败回归：console error / network 4xx/5xx / state 卡死全清

**Exit criteria**：
- [ ] NAS 容器跑新 build
- [ ] 3 轮真聊全跑通，无 console error
- [ ] embedded check inline 在 chat 入口正常显示
- [ ] 截图 + 简短 report 在 [docs/agents/](../../agents/)

**Per-lane plan doc**：不写（部署 + 验证类，无代码 SoT）

---

### M2.1 — YUK-16 Note editor / read UX（parent，4 sub）

**问题**：调研发现 Note 链路到 NoteVerifyTask Pass 2 已完整 ship，但**完全无用户编辑面**（no editor / no PATCH endpoint）。Schema 已支持 versioning + history，缺 API + UI。

#### Sub 1：YUK-52 markdown 渲染

**Scope**：atomic note section 内 markdown / code block / image 渲染统一，复用 `src/ui/lib/math-markdown.tsx`（KaTeX gating by subject notation）。改 `app/(app)/learning-items/[id]/page.tsx` 阅读视图 + `src/ui/components/NoteRenderer/`。

**Exit**：5 种 section kind 全部走统一 renderer；wenyan/math/physics fixture pass。

#### Sub 2：YUK-53 embedded check inline

**Scope**：note `check` section 末尾 1-3 道 inline 题目接入阅读视图，复用 `src/ui/components/EmbeddedCheckSection.tsx`。**依赖 W2 YUK-52 markdown 落地**避免 renderer 冲突。

**Exit**：check section 渲染 + attempt 路径调用 `/api/embedded-check/attempt`；judge 结果 surface 在 inline。

#### Sub 3：YUK-54 section edit-in-place

**Scope**：双击 / 编辑按钮 / 浮层 trigger inline edit；写新 PATCH `/api/artifacts/[id]/sections/[idx]/route.ts`；version conflict 检测；写 `ArtifactHistoryEntry`。

**Exit**：每个 section kind 可编辑保存；version conflict 报错可恢复；history 时间线 schema 写入。

#### Sub 4：YUK-55 verification badge

**Scope**：`src/ui/components/NoteRenderer/VerificationBadge.tsx`（verified / pending / failed / outdated）+ issues 列表展开。

**Exit**：4 种 verification 状态 UI 显示正确；点 badge 展开 issues。

**Per-lane plan docs**：每 sub 一份：`docs/superpowers/plans/2026-05-2X-yuk-5{2,3,4,5}-note-*.md`

---

### M2.2 — YUK-17 Variant double-pass + VariantVerifyTask

**问题**：调研确认 Pass 1 ship 完整（cause-targeted variant proposal + 3 层防繁殖），但 **variants_max=3 计数完全没实现**（per-mistake 计数表缺失），**VariantVerifyTask handler 未注册**。

**Scope**：
- 新建 `src/server/boss/handlers/variant_verify.ts`（仿 [`note_verify.ts`](../../../src/server/boss/handlers/note_verify.ts) 模式）
- 在 `src/ai/registry.ts` 注册 `VariantVerifyTask`
- 新表 / 字段：per-mistake variants 计数（schema 设计时决定 separate table vs `mistake.variants_count`）
- `variant_gen` handler 增 enforce variants_max=3 逻辑
- Proposal → 首次答对 → active 状态 transition（draft→active）

**Exit criteria**：
- [ ] VariantVerifyTask handler 注册 + 二轮检查产 `verdict + failure_reasons + cause_targeting`
- [ ] variants_max=3 enforce（4th 触发 skip）
- [ ] draft→active state transition 测试覆盖
- [ ] `pnpm test:db` + `pnpm test:migration` 通过
- [ ] `pnpm audit:schema` + `pnpm audit:profile` 通过

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-yuk-17-variant-double-pass.md`

---

### M2.3 — YUK-18 Review session UX polish（parent，8 sub）

#### Sub P2.1：YUK-56 judge router auto-rating

**Scope**：复用 `src/server/judge/invoker.ts` 单 invoker（YUK-39 已 ship）；exact / keyword 题自动判分；semantic 题给建议 rating；`app/api/review/submit/route.ts` 改 + `app/(app)/review/page.tsx` UX 改。

**Exit**：exact/keyword auto-rate 100% 命中；semantic 建议 ≥80% 用户接受；用户仍可 override。

#### Sub P2.2：YUK-57 skip + pause/resume

**Scope**：`app/api/review/sessions/[id]/{pause,resume,skip}/route.ts` + frontend 按钮 + persistence；ADR-0013 lifecycle 不动。

**Exit**：skip/pause/resume 走 server event；F5 后能 resume；NAS 真机走通。

#### Sub P2.3：YUK-58 attempt history timeline

**Scope**：`app/api/questions/[id]/timeline/route.ts` read 路径；feedback 阶段右栏 timeline 组件；按 cause 趋势着色。

**Exit**：当前题前 N 次 attempt 时间线显示，cause attribution 可视化。

#### Sub P2.4：YUK-59 session-end CTA

**Scope**：`SessionEndSummary` 加 CTA 区；按 evidence 决定 CTA 候选（learning-items / coach / 下一 session）。

**Exit**：session done 不再死胡同；至少 3 个 CTA 候选 + 选中跳转正确。

#### Sub P3.1：YUK-60 subject switch marker

**Scope**：混合 queue subject 切换插显式 marker（"下一题：math"）；题卡背景 / 顶部 stripe 按 subject 区分。

#### Sub P3.2：YUK-61 textarea markdown/math preview

**Scope**：split-view（textarea 左 + preview 右）；走 `src/ui/lib/math-markdown.tsx`。

#### Sub P3.3：YUK-62 ReviewIntent banner

**Scope**：决策点（启动前拍）—— 可 dismiss / 跨 session 复用 / stale 语义；落 design + 实现。

#### Sub P3.4：YUK-63 abandoned session resume

**Scope**：`/learning-sessions` 列表显示 + resume 入口；**soft 依赖 W2 YUK-57 pause/resume**（resume 入口统一）。

**Per-lane plan docs**：每 sub 一份：`docs/superpowers/plans/2026-05-2X-yuk-{56..63}-review-*.md`

---

### M2.4 — YUK-19 Learning-item proposal rollback UI

**问题**：调研确认 proposal lifecycle 已通用化（pending → accepted | dismissed | stale via rate + correction events），learning_item kind 已在 `AiProposalPayload` union 注册，producer `writeLearningItemProposal()` 已落地，但 **`/api/proposals/[id]/accept` 对 `kind='learning_item'` 返回 400 "unsupported"**，rollback UI 未 surface "已 retract" 标记。

**Scope**：
- `src/server/proposals/actions.ts` accept 路径加 `learning_item` 处理（unblock current 400）
- learning_item 列表 UI 加 `CorrectionStateRenderer`（YUK-40 已 ship）显示 retract 状态
- retract 走 L3 correction event（YUK-43 已 ship `/api/proposals/[id]/retract`，复用即可）

**Exit criteria**：
- [ ] `kind='learning_item'` proposal accept 正常工作
- [ ] retract 后 learning-item 列表显示 "已撤回 by [...]"
- [ ] `pnpm test:db` 通过
- [ ] `CorrectionStateRenderer` 复用，不新建组件

**Per-lane plan doc**：`docs/superpowers/plans/2026-05-2X-yuk-19-learning-item-rollback.md`

## 依赖关系图

```
W1 ──┬─ YUK-13 (design) ─────────────────→ W2 YUK-14 (impl)        [hard]
     ├─ YUK-47 (deploy + E2E)
     ├─ YUK-17 (variant double-pass)
     ├─ YUK-19 (rollback UI)
     └─ YUK-56 (review P2.1)

W2 ──┬─ YUK-14 (teaching impl)
     ├─ YUK-15 (record→proposal)
     ├─ YUK-52 (note markdown) ─────────→ W3 YUK-53/55  W4 YUK-54   [soft]
     ├─ YUK-57 (review P2.2) ────────────────────→ W4 YUK-63        [soft]
     └─ YUK-58 (review P2.3)

W3 ──┬─ YUK-53 (note inline check)
     ├─ YUK-55 (note verify badge)
     ├─ YUK-59 (review P2.4)
     ├─ YUK-60 (review P3.1)
     └─ YUK-61 (review P3.2)

W4 ──┬─ YUK-54 (note edit-in-place)
     ├─ YUK-62 (review P3.3)
     └─ YUK-63 (review P3.4)
```

**外部依赖（已解锁）**：
- Track 2 M3 ([YUK-40](https://linear.app/yukoval-studios/issue/YUK-40) correction renderer) → YUK-19 ✅
- Track 2 M5.2 ([YUK-43](https://linear.app/yukoval-studios/issue/YUK-43) inbox UI + retract route) → YUK-19 ✅
- Track 2 M5.3 ([YUK-44](https://linear.app/yukoval-studios/issue/YUK-44) producers) + [YUK-48](https://linear.app/yukoval-studios/issue/YUK-48) (nightly producer) → YUK-15 ✅
- embedded-check MVP PR #76 (commit `d1d79e4`) → YUK-47 + YUK-53 ✅
- Foundation A [YUK-39](https://linear.app/yukoval-studios/issue/YUK-39) JudgeInvoker → YUK-56 ✅

## Cross-cutting concerns（lane 启动必读）

Track 2 + Foundation 收口期间引入了若干 single-source-of-truth helper，**Track 1 任何 lane 触及对应领域必须复用，不要重写 invariant**。各 per-lane plan doc 启动时必须列出依赖的 cross-cutting helper。

### CC-1 — Cause precedence ([YUK-51](https://linear.app/yukoval-studios/issue/YUK-51) shared helper)

- **Helper**：[`src/server/events/cause-policy.ts`](../../../src/server/events/cause-policy.ts) 的 `effectiveCauseForFailureAttempt()` + `effectiveCauseCategoryForFailureAttempt()`
- **Invariant**：active `user_cause` > active `agent judge` > `null`；**不做** timestamp comparison（active state 由 `getFailureAttempts` 通过 effective-truth 已 resolve）
- **必须遵循的 lane**：
  - [YUK-17](https://linear.app/yukoval-studios/issue/YUK-17) Variant double-pass —— VariantVerifyTask 新 handler 选 cause-targeted variant 时
  - [YUK-56](https://linear.app/yukoval-studios/issue/YUK-56) Review P2.1 judge auto-rating —— auto judge 写入不得直接覆盖已有 user_cause，user override 必须走 `experimental:user_cause` channel
  - [YUK-58](https://linear.app/yukoval-studios/issue/YUK-58) Review P2.3 attempt timeline —— UI 显示 cause 走 `effectiveCauseCategoryForFailureAttempt()`，不自己 prefer judge
  - [YUK-15](https://linear.app/yukoval-studios/issue/YUK-15) record → proposal evidence loop —— 反查 cause 走 helper

### CC-2 — Correction state read model + renderer ([YUK-40](https://linear.app/yukoval-studios/issue/YUK-40))

- **Helper**：[`src/server/review/effective-truth.ts`](../../../src/server/review/effective-truth.ts) + [`src/ui/correction/CorrectionStateRenderer.tsx`](../../../src/ui/correction/CorrectionStateRenderer.tsx)
- **Invariant**：retract / mark_wrong / supersede 状态投射仅从 effective-truth 读；UI 仅复用 renderer，不新建 correction component
- **必须遵循的 lane**：
  - [YUK-19](https://linear.app/yukoval-studios/issue/YUK-19) Learning-item rollback UI —— 列表显示 retract 状态走 `CorrectionStateRenderer`（不新建）
  - [YUK-57](https://linear.app/yukoval-studios/issue/YUK-57) Review P2.2 skip/pause —— pause/resume 事件**不要**借用 correction event channel（pause 是 lifecycle 不是 correction）
  - [YUK-58](https://linear.app/yukoval-studios/issue/YUK-58) timeline —— attempt 列表 surface correction state

### CC-3 — JudgeInvoker single entrypoint ([YUK-39](https://linear.app/yukoval-studios/issue/YUK-39))

- **Helper**：[`src/server/judge/invoker.ts`](../../../src/server/judge/invoker.ts)
- **Invariant**：所有 judge 调用走 `JudgeInvoker`，不直接 `judgeExact` / `judgeKeyword` / `judgeRouter`；内置 telemetry hook 喂 admin obs surface
- **必须遵循的 lane**：
  - [YUK-56](https://linear.app/yukoval-studios/issue/YUK-56) Review P2.1 auto-rating —— 走 `JudgeInvoker`，不绕过
  - [YUK-17](https://linear.app/yukoval-studios/issue/YUK-17) Variant double-pass —— VariantVerifyTask 内部如有 judge step 走 invoker

### CC-4 — Proposal lifecycle (Track 2 M5 [YUK-42](https://linear.app/yukoval-studios/issue/YUK-42)/[YUK-43](https://linear.app/yukoval-studios/issue/YUK-43)/[YUK-44](https://linear.app/yukoval-studios/issue/YUK-44))

- **Helper**：[`src/server/proposals/{actions,inbox,producers,signals,writer}.ts`](../../../src/server/proposals/) + `/api/proposals/[id]/{accept,dismiss,retract}` 三个 route
- **Invariant**：所有 AI 提议走统一 `AiProposalPayload` union；accept 路径走 owner-service 产 `rate` event；retract 走 L3 correction event；不绕过 union 直接写 propose event
- **必须遵循的 lane**：
  - [YUK-17](https://linear.app/yukoval-studios/issue/YUK-17) Variant double-pass —— VariantVerifyTask 输出走 `variant_question` proposal kind，accept 路径已在 YUK-44 接通
  - [YUK-19](https://linear.app/yukoval-studios/issue/YUK-19) Learning-item rollback UI —— retract 走现有 `/api/proposals/[id]/retract`，不要新建路由；accept 路径补 `kind='learning_item'` 处理
  - [YUK-15](https://linear.app/yukoval-studios/issue/YUK-15) record → proposal —— evidence_refs 写入走现有 writer，不要绕

### CC-5 — Subject profile validator ([YUK-7](https://linear.app/yukoval-studios/issue/YUK-7) + [YUK-8](https://linear.app/yukoval-studios/issue/YUK-8))

- **Helper**：`pnpm audit:profile` + `SubjectRegistry.register()` 启动期校验
- **Invariant**：任何 subject profile 改动必须先跑 `pnpm audit:profile`；坏 profile 启动失败
- **必须遵循的 lane**：本 Track 1 不改 profile，但 [YUK-14](https://linear.app/yukoval-studios/issue/YUK-14) Teaching idle 实现如果引入新 session-type 字段且影响 `judgeCapabilities`，需补 capability registry

## 启动建议

按 wave 节奏，每 wave 约 1-1.5 周（含 launch-phase + per-lane impl + pre-merge gate + chain-merge）：

| Week | Wave | Lanes | 累计 pts | Cumulative coverage |
|---|---|---|---|---|
| W1 | Wave 1 | YUK-13 / 47 / 17 / 19 / 56 | 17 | 5/17 lanes |
| W2 | Wave 2 | YUK-14 / 15 / 52 / 57 / 58 | 37 | 10/17 lanes |
| W3 | Wave 3 | YUK-53 / 55 / 59 / 60 / 61 | 49 | 15/17 lanes |
| W4 | Wave 4 | YUK-54 / 62 / 63 | 59 | 17/17 lanes |
| W5 | 收口 | audit-drift + status.md update + v0.3 doc §1.5 状态更新 + retrospective | — | — |

**Wave 间 gate**：每 wave 结束 chain-merge 完后跑 `pnpm test` + `pnpm audit:schema` + `pnpm audit:partition` + `pnpm audit:profile` 全绿，再启下一 wave 的 `/launch-phase`。

## Linear 项目结构

按项目惯例（[docs/agents/issue-tracker.md](../../agents/issue-tracker.md) §"Layer mapping"）已 model 为 **Linear Project + Milestone + Issue**（**本 outline 不新建 Linear issue**，全部已存在）：

- **Project**：[Product Track 1 — Review / Learning Item / Teaching 收口](https://linear.app/yukoval-studios/project/product-track-1-review-learning-item-teaching-收口-87f2e3007a16) (priority=No priority, start=2026-05-23, target=2026-07-31)
- **2 Milestones / 17 issue**：

  | Milestone | Issue 数 | Issues |
  |---|---|---|
  | [M1 — Teaching 收口](https://linear.app/yukoval-studios/project/product-track-1-review-learning-item-teaching-收口-87f2e3007a16) (target 2026-06-10) | 4 | YUK-13 / 14 / 15 / 47 |
  | [M2 — Note / Variant / Review UX 收尾](https://linear.app/yukoval-studios/project/product-track-1-review-learning-item-teaching-收口-87f2e3007a16) (target 2026-07-01) | 13 | YUK-16 (parent) + 52-55; YUK-17; YUK-18 (parent) + 56-63; YUK-19 |

总计：1 Project + 2 Milestone + 17 Issue（含 2 parent 自动 close on 12 sub all-Done）。

## ADR 触发条件

以下情况需新写 ADR，不在本 outline 内默处理：

- **YUK-14 idle state 枚举** 若引入 "long_idle" / "human_pause" 等超出 ADR-0013 `/review` 模型的新状态语义 —— 需 ADR 记录跨 session-type 状态机统一
- **YUK-17 variants_max=3** 计数表 vs `mistake` 表内字段二选一 —— 若选独立表需 ADR 记录表 ownership
- **YUK-54 section edit-in-place** 若决定引入 OT / CRDT 类 conflict resolution 而非 simple version check —— 需 ADR

## 后续 follow-ups（不在本 outline 内）

- **Subject #4**（english / programming）—— Track 1 完成后再启
- **Living Note `NoteRefineTask`**（dreaming 触发的 Note 自我修订）—— YUK-54 edit-in-place 落地后再启
- **Note 申诉 / 标错流程**（用户标"这段有问题"触发 retract）—— ADR-0014 §6 已有 correction event 模型，UI 接入是后续 lane
- **Track F multimodal / source grounding** —— v0.3 §1.5 明确 Later
- **Dreaming agent 完整实施** —— proposal inbox 已 ship 是 consumer，待后续 phase
