# src/capabilities/practice — 练习消费侧

> FSRS 传感器、判分评级、卷（paper）机制、复习会话编排、题库 CRUD、placement 探针。所有消费类练习行为都落 `event(action='attempt'|'review'|'judge')`。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 28 条 API 路由 + 10 个夜链 job + 4 proposal kinds + 8 copilot tools |
| `api/*.ts` | review/submit/due/advice/weekly/appeal/sessions、placement、drafts、practice/paper、questions/solve、calibration anchors |
| `server/` | 判分路由、FSRS 投影、paper/流编排、stream-store、placement、mastery 交互 |
| `jobs/` | `rejudge`（归属元数据）、`item_prior_backfill`、`practice_stream_compose_nightly`、`question_supply_nightly`、`confusable_contrast_nightly`、`recalibration_nightly`、`embed_backfill`、`reference_answer_backfill`、`answer_class_backfill`、`kt_estimate_nightly`、`axis_state_nightly` |
| `ui/` | PracticeFacePage、DraftReviewPage、QuestionsPage、QuestionDetailPage |

## CONVENTIONS
- 判分走 `JudgeResultV2`：coarse_outcome × score_meaning，历史判分不可变（rejudge = 新 event）。
- paper/组卷容器是 `tool_quiz` artifact；session 内 attempt 走 `learning_session(type='review')`。
- draft 题须经 `verifyAndPromote` 才能 active；漏 `draft_status` 会被 `audit:draft-status` 抓。

## ANTI-PATTERNS
- 别把 judge 结果回写 attempt event；因果链用 `caused_by_event_id`。
- 别在 attempt tx 内调慢/重 LLM；background job 用 `attribution_followup` / `variant_gen` 链。
- 别绕过 `draft_status` 把未审核题放进练习池。
