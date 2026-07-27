# PLAN — 活看板 (cockpit)

> Linear 是权威 tracker；本文件只镜像当前 active 线、下一步、parked 与 blockers。
> 四栏就地改写，正文 ≤200 行，不追加历史日志。
>
> 更新于：2026-07-27

> **【更新 2026-07-27 · 两项目联合 5/5 计划已启动】** 严格串行：
> Architecture Deepening 先通过 exit audit，之后才实施 Grounding Before Expansion。
> 架构代码已在隔离 worktree `architecture-deepening-closeout` 完成；完整 unit、
> DB、migration、typecheck、lint、build、boundary/API client audits 已通过。Linear
> 已建立架构 4 个、Grounding 5 个 milestones，并新建
> YUK-814/815/816。

## NOW

- **唯一 active 线：Architecture Deepening closeout**
  - Branch：`codex/architecture-deepening-closeout`，基于 `main@523fbfaa`。
  - YUK-751：Notes 真实 mastery subscriber；publisher/outbox/effect 同事务，
    attempt+artifact 幂等 ledger，重复投递、send rollback、causal sibling atomicity 已测。
  - Capability boundary：所有 provider 有顶层 `public.ts`；浏览器跨包只走
    `ui-public.ts`；生产跨 capability 深层 import audit = **0**。
  - YUK-771：proposal accept applier 归属 owner capability；中央 accept switch 已删除。
  - YUK-753：抽出统一 AI run lifecycle，覆盖 start/provider/retry/abort/cost/terminal/after-run；
    stream/collect 保留为 adapter。
  - YUK-773：dev-only `openapi-typescript` 生成并提交 API types；薄 fetch wrapper；
    regeneration diff + handwritten wire usage audits。
- **验证态**
  - 已绿：unit 5752 passed / 33 skipped；migration 26/26；typecheck；lint；build；
    boundary audit；API client generation/usage audits。
  - 全量 DB 第二轮：387 files，4188 passed / 9 skipped / 1 todo；首轮唯一既有
    heartbeat timing flake 已修为确定性等待，定向 30/30。
- **Linear 已对齐**
  - Architecture project → In Progress；4 milestones 已建。
  - YUK-751/753/771/773 → In Progress；YUK-752 → Duplicate of YUK-773；
    YUK-754 → Canceled（证据化否决巨型 Today endpoint）；YUK-797 → Done。

## NEXT

1. 组织 commit，push 并开 Architecture closeout PR。
2. 将 YUK-751/753/771/773 改为 In Review，附 PR 与验收证据；等待独立 review + CI。
3. Architecture PR 合并且 exit audit 全绿后：
   - Grounding project → In Progress；
   - 新建独立 product branch/worktree；
   - 先做真实数据闸门和猜想证据，再做干预准备、验证结算与 canary。
4. 产品实现顺序：
   - 真实 failure → grounded conjecture/probe/Judge；
   - versioned intervention snapshot → pedagogy → authored/verified package；
   - intervention-scoped practice + isolated FSRS verification；
   - deterministic settlement → Brief/Copilot/growth projection；
   - owner shadow/blind review → 10-run canary。

## PARKED

- **14 个产品模块**：Today、Conjecture、Probe、KC 专项、B3、Brief 控制区、
  pedagogy、QuestionAuthor、QuizGen/Verify、单题 Judge、效果 Judge、延迟/迁移、
  Copilot、成长档案。Architecture exit 前只规划/归票，不写产品代码。
- Grounding milestones 已建：
  1. 真实数据闸门
  2. 猜想证据
  3. 干预准备
  4. 延迟 / 迁移结算
  5. canary
- 新票：YUK-814 真实 owner 数据闸门；YUK-815 Copilot/Brief；
  YUK-816 intervention-history projection。
- 既有票已归阶段：YUK-787/788/795/799/800/803/804 → 猜想证据；
  YUK-791/796 → 干预准备；YUK-792 → 验证结算。

## BLOCKED-ON

- **Grounding 产品实施** ← Architecture PR 合并 + boundary 0 + event exactly-once +
  proposal/runner parity + OpenAPI drift 0 + 完整 gate 全绿。
- **真实数据扩大使用** ← YUK-814 shadow run / 6–10 失败簇盲评：
  grounding ≥80%，学科幻觉、claim/probe 错配、严重事实错误均为 0。
- **auto-intervention 扩大** ← 单 owner/cohort 10 次 canary 全部事后审阅且红线为 0。
- **自主 merge** ← 独立 review 与 CI 全绿；当前 session 不伪造独立 reviewer。

## 在飞（PR / workflow / worktree）

- Branch：`codex/architecture-deepening-closeout`
- Worktree：
  `/Users/yuqi/yukoval-projects/the-learning-project-worktrees/architecture-deepening-closeout`
- PR：尚未创建；本地 exit gate 已完整收口，下一步 commit/push/open。
- 主工作树不在本线写入。
