# src/capabilities/practice — 练习消费侧

> FSRS 传感器、判分评级、Failure Learning、卷（paper）机制、复习会话编排、题库 CRUD、placement 探针。所有消费类练习行为都落 `event(action='attempt'|'review'|'judge')`。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 组合根：根目录条目加各子 owner 的 `manifest-part.ts`，按固定顺序拼接（路由注册顺序即匹配顺序） |
| `<owner>/` | 子 owner 目录（grading、settlement、question-bank、failure-learning、session、scheduling、supply、placement），各有 `public.ts` 与 `manifest-part.ts`；根目录其余文件归练习面，尚未迁出的按 `scripts/audit-practice-subowners.ts` 的映射计归属 |
| `api/*.ts` | review/submit/appeal、placement、drafts、practice/paper、questions/solve、calibration anchors |
| `server/placement-session-lifecycle.ts` | Placement 完整状态操作与运行时 flag；跨域 orphan 操作经 `public.ts` |
| `server/verify-dispatch-outbox.ts` | 验证 intent、同事务派发与 orphan 恢复；基础设施 adapter 在 `src/server/boss/verify-dispatch-recovery.ts` |
| `server/question-supply/coverage-lattice.ts` / `api/coverage-lattice.ts` | 供题覆盖细目只读读模型与 `/api/admin/coverage-lattice`：供题扫描器四规则的 KC 池级覆盖 + 缺口 targets + 供给活动聚合；Observability admin 页只展示 |
| `failure-learning/server/failure-learning.ts` | 失败尝试 eligibility、归因、变式提议的 owner operation；durable subscriber 只调用该入口 |
| `server/` | 判分路由、paper 编排、placement、mastery 交互 |
| `jobs/` | Practice 后台任务；错因学习的 `attribution_followup` → `variant_gen` durable 链在 `failure-learning/jobs/` |
| `tasks/` / `tools/` | Practice-owned AI TaskSpecs 与 DomainTool 适配层；错因学习的在 `failure-learning/{tasks,tools}/` |
| `ui/` | PracticeFacePage；`ui/library/` 题目库（全部 / 做错过 / 待审核 / 暂不出题）与单题页 |

## CONVENTIONS
- 子 owner 依赖自下而上：grading → settlement / question-bank → failure-learning → session → scheduling → supply → placement → 练习面（`docs/design/2026-11-03-practice-split.md` §0）。目录外只经 `<owner>/public.ts` 引用子 owner，根 `manifest.ts` 另可引用 `manifest-part.ts`，根 `tasks/index.ts` 另可引用 `<owner>/tasks/*`；owner 之间的 import 边只减不增，由 `pnpm audit:practice-subowners` 强制。
- 外部消费方只 import 根 `public.ts` / `ui-public.ts`，不直接引用子 owner 目录。
- 判分走 `JudgeResultV2`：coarse_outcome × score_meaning，历史判分不可变（rejudge = 新 event）。
- paper/组卷容器是 `tool_quiz` artifact；session 内 attempt 走 `learning_session(type='review')`。
- draft 题须经 `verifyAndPromote` 才能 active；漏 `draft_status` 会被 `audit:draft-status` 抓。
- 提示生成遇到额度（429）、502 或解析失败时，响应带原因、`stop_retry`（停止重试）和确定性下一步或封存参考。没有这些材料时只建议跳过。
- 提示只在题干对上并集、单调区间或合法替代写法时核讲解。讲对的原文保留；讲反了改发封存说明。digest、task-run、provider/model 与费用留在 `experimental:hint_request`，教学回合另写 `experimental:help_explanation_replay`。未知费用保持 null。早于完整解的提示不写出单调区间的具体端点。
- 每次提示请求在 `experimental:hint_request` 上封存四段时延和分母。未经验证的模型正文不记成已验证可执行帮助。失败和超时照样入账，未知费用保持 null。18 秒预算在尝试行和提示事件上都是超时。

## ANTI-PATTERNS
- 别把 judge 结果回写 attempt event；因果链用 `caused_by_event_id`。
- 别在 attempt tx 内调慢/重 LLM；background job 用 `attribution_followup` / `variant_gen` 链。
- 别绕过 `draft_status` 把未审核题放进练习池。
