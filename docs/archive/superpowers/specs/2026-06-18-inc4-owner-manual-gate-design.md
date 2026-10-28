# inc-4 — owner manual gate path（draft 池审核面）设计

> Phase 1 matcher 形态（YUK-397）增量 inc-4。owner 对话 2026-06-18 拍板：**独立 route**。前置 inc-1/2/3 + YUK-401 已 merge。**UI 须走 design pre-flight**：本文出零风格功能 handoff，视觉由 claude design 出，回来 slice-by-slice 实现（[[feedback_claude_design_workflow]]）。

## 1. Goal

给 owner 一个**手动 gate**：审核 `question` 表的 draft 切片（`draft_status='draft'`），逐条**启用**（过 B5 verify→promote）或**强制启用**（override，跳 verify，evidence-first 留痕 `actor=owner, skipped_verify, reason`）。这是 spec §3.3 gate 三 caller 的第三个（matcher lazy / pre-warm / **owner manual**），后端 gate op `verifyAndPromote` inc-3 已建。

**自包含**：审的是**现有 draft 池**（sourcing/quiz_gen 产的草稿），**不需先把 matcher 接 live caller**。matcher 接线是后续独立增量。

## 2. 后端（inc-4a，纯后端可自主，无 UI 依赖）

新增 3 个 route（capability manifest 贡献制，practice 或新 review 子面；`/api/*` 自动套 internal-token 中间件）：

| method | path | 作用 |
|---|---|---|
| GET | `/api/review/drafts` | 列 `draft_status='draft'` 题（分页）。每条投影：id / prompt_md 预览 / kind / source / created_at / **verify 状态**（从 verify event log 或 agent note 派生：未验过 raw vs needs_review/failed + 驳回理由） |
| POST | `/api/review/drafts/[id]/enable` | `verifyAndPromote({db, questionId, actor:'user'})`——跑 B5 verify（复用 quiz_verify/source_verify per-source handler），过则 promote，不过返 needs_review/failed + 理由 |
| POST | `/api/review/drafts/[id]/force-enable` | `verifyAndPromote({db, questionId, actor:'user', skipVerify:{reason}})`——override，promote + 写 `actor_kind:'user'` + `skipped_verify:true` + reason verify event |

**YUK-400 B 段守门随本增量落**（inc-4 是 override + 直接 caller 的真实 caller，守门必须到位 + 测）：
1. `verifyAndPromote` normal/override 分支 promote 前验 `draft_status==='draft'`（非 draft → `skipped:not_draft`）——挡 owner UI 重试传 active 行。
2. override 分支验各 `knowledge_ids` 的 `archived_at`（归档 KC 不建 FSRS 卡）。
3. override 分支验 `metadata.archived_at`（已归档 draft 不复活）。
4. override source 验（只 web_sourced/quiz_gen 可 promote；teaching_check/copilot_authored 容器 draft 拒）——inc-3 round-1 P2-6 已加，inc-4 补测真实 caller。

**验收**：3 route db/route 测试（list 投影 / enable 三态 / force-enable 留痕）；B 段 4 守门各有测试（非 draft / 归档 KC / 归档 draft / 非法 source 全拒）；零 A5 回归（gate 仍只读 draft_status 那条、override 自产 event）。

## 3. UI（inc-4b，**design pre-flight 后**，零风格功能 handoff 给 claude design）

**组件类型**：独立 route `/review`（draft 池审核面），page。**touch 文件**（实现期，design 回来后）：新建 `src/capabilities/<review|practice>/ui/DraftReviewSurface.tsx` + `web/src/router.tsx` 加 `/review` route + manifest `ui.pages` 声明。

### 功能 handoff（零风格——claude design 出视觉，勿在此规定颜色/间距/动效）

**这个面做什么**：owner 浏览待审草稿池，逐条决定启用 / 强制启用 / 跳过。

**信息架构（每条 draft 要让 owner 看到的）**：
- 题目预览（prompt_md，够判断这题是什么即可）
- 题型（kind）+ 来源（source：web 采集 / 生成 / 录入）
- verify 状态：未验过 / 验证未过（needs_review/failed + 驳回理由，让 owner 知道为何卡着）
- 创建时间

**两个动作（每条）**：
- **启用**：过正常 verify（可能耗时——B5 跑 LLM；要 loading/pending 态 + 结果反馈：过了→该条消失/转 active，没过→显示驳回理由）
- **强制启用**：跳 verify 直接启用，**必须让 owner 填 reason**（evidence-first 留痕），带「绕过验证」的明确意味（owner 知道自己在 override）

**列表层**：分页 / 可按 source/kind 过滤（owner 量大时）；空态（没有待审草稿）。

**不在本 handoff（claude design 别加）**：匹配上下文（哪个 demand 命中——matcher 没接 caller，现在没这数据）；批量操作（v1 逐条）；编辑题目（审核面只 gate，改题走既有编辑路径）。

## 4. 决策已定 / 不在 scope

- ✅ 独立 route（非挂 observability/admin）。
- ✅ 审核面展示 = 预览 + 状态 + 来源；动作 = 启用 / 强制启用（reason）。
- ✅ 审现有 draft 池，**不**依赖 matcher 接 live caller。
- ❌ 不在 inc-4：matcher 接 live caller（独立增量）；pre-warm gate caller；compositeParentOnly/cause→JobData 完整透传（YUK-400）；批量审核 / 审核面编辑题。

## 5. 增量切分

- **inc-4a 后端**：3 route + YUK-400 B 段 4 守门 + 测试。**纯后端可自主**（无 UI 依赖），TDD。
- **inc-4b UI**：`/review` 审核面。**等本 handoff → claude design 出视觉 → owner 批 → slice-by-slice 实现**。

后端先行不阻塞 UI；UI 等设计回来。
