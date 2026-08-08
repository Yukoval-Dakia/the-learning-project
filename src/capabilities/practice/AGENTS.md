# src/capabilities/practice — 练习消费侧

> FSRS 传感器、判分评级、Failure Learning、卷（paper）机制、复习会话编排、题库 CRUD、placement 探针。所有消费类练习行为都落 `event(action='attempt'|'review'|'judge')`。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | API、event subscription、job、proposal kind、copilot tool 的组合声明 |
| `api/*.ts` | review/submit/due/advice/weekly/appeal/sessions、placement、drafts、practice/paper、questions/solve、calibration anchors |
| `server/failure-learning.ts` | 失败尝试 eligibility、归因、变式提议的 owner operation；durable subscriber 只调用该入口 |
| `server/` | 判分路由、FSRS 投影、paper/流编排、stream-store、placement、mastery 交互 |
| `jobs/` | `attribution_followup` → `variant_gen` durable 链及其它 Practice 后台任务 |
| `tasks/` / `tools/` | Practice-owned AI TaskSpecs 与 Failure Learning DomainTool 适配层 |
| `ui/` | PracticeFacePage、DraftReviewPage、QuestionsPage、QuestionDetailPage |

## CONVENTIONS
- 判分走 `JudgeResultV2`：coarse_outcome × score_meaning，历史判分不可变（rejudge = 新 event）。
- paper/组卷容器是 `tool_quiz` artifact；session 内 attempt 走 `learning_session(type='review')`。
- draft 题须经 `verifyAndPromote` 才能 active；漏 `draft_status` 会被 `audit:draft-status` 抓。

## ANTI-PATTERNS
- 别把 judge 结果回写 attempt event；因果链用 `caused_by_event_id`。
- 别在 attempt tx 内调慢/重 LLM；background job 用 `attribution_followup` / `variant_gen` 链。
- 别绕过 `draft_status` 把未审核题放进练习池。
