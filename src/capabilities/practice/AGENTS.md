# src/capabilities/practice — 练习消费侧

> FSRS 传感器、判分评级、Failure Learning、卷（paper）机制、复习会话编排、题库 CRUD、placement 探针。所有消费类练习行为都落 `event(action='attempt'|'review'|'judge')`。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | API、event subscription、job、proposal kind、copilot tool 的组合声明 |
| `api/*.ts` | review/submit/due/advice/weekly/appeal/sessions、placement、drafts、practice/paper、questions/solve、calibration anchors |
| `server/placement-session-lifecycle.ts` | Placement 完整状态操作与运行时 flag；跨域 orphan 操作经 `public.ts` |
| `server/verify-dispatch-outbox.ts` | 验证 intent、同事务派发与 orphan 恢复；基础设施 adapter 在 `src/server/boss/verify-dispatch-recovery.ts` |
| `server/failure-learning.ts` | 失败尝试 eligibility、归因、变式提议的 owner operation；durable subscriber 只调用该入口 |
| `server/` | 判分路由、FSRS 投影、paper/流编排、stream-store、placement、mastery 交互 |
| `jobs/` | `attribution_followup` → `variant_gen` durable 链及其它 Practice 后台任务 |
| `tasks/` / `tools/` | Practice-owned AI TaskSpecs 与 Failure Learning DomainTool 适配层 |
| `ui/` | PracticeFacePage；`ui/library/` 题目库（全部 / 做错过 / 待审核 / 暂不出题）与单题页 |

## CONVENTIONS
- 判分走 `JudgeResultV2`：coarse_outcome × score_meaning，历史判分不可变（rejudge = 新 event）。
- paper/组卷容器是 `tool_quiz` artifact；session 内 attempt 走 `learning_session(type='review')`。
- draft 题须经 `verifyAndPromote` 才能 active；漏 `draft_status` 会被 `audit:draft-status` 抓。
- 提示生成遇到额度（429）、502 或解析失败时，响应带原因、`stop_retry`（停止重试）和确定性下一步或封存参考。没有这些材料时只建议跳过。
- 提示若把并集讲成同时属于，或把单调区间、合法替代写法讲反，改发封存说明。digest、task-run、provider/model 与费用留在 `experimental:hint_request`，未知费用保持 null。早于完整解的提示不写出单调区间的具体端点。
- 每次提示请求在 `experimental:hint_request` 上封存四段时延和分母。未经验证的模型正文不记成已验证可执行帮助。失败和超时照样入账，未知费用保持 null。18 秒预算在尝试行和提示事件上都是超时。

## ANTI-PATTERNS
- 别把 judge 结果回写 attempt event；因果链用 `caused_by_event_id`。
- 别在 attempt tx 内调慢/重 LLM；background job 用 `attribution_followup` / `variant_gen` 链。
- 别绕过 `draft_status` 把未审核题放进练习池。
