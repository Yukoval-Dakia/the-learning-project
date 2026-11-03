# src/capabilities/practice — 练习消费侧

> FSRS 传感器、判分评级、Failure Learning、卷（paper）机制、复习会话编排、题库 CRUD、placement 探针。所有消费类练习行为都落 `event(action='attempt'|'review'|'judge')`。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | 组合根：根目录条目加各子 owner 的 `manifest-part.ts`，按固定顺序拼接（路由注册顺序即匹配顺序） |
| `<owner>/` | 子 owner 目录（grading、settlement、question-bank、failure-learning、session、scheduling、supply、placement），各有 `public.ts` 与 `manifest-part.ts`；根目录其余文件归练习面，尚未迁出的按 `scripts/audit-practice-subowners.ts` 的映射计归属 |
| `api/*.ts` | appeal、solve 与共享契约；作答/发卷/提交路由在 `grading/api/`，定位路由在 `placement/api/` |
| `placement/server/placement-session-lifecycle.ts` | Placement 完整状态操作与运行时 flag；跨域 orphan 操作经 `public.ts` |
| `grading/` | 作答与判分：发卷/草稿/提交路由、formal attempt、判分路由与判分器、DBOS judge 投递与 pending 对账、判分校准采样、模型执行器（Jev/Rubric/Pi）与模型切片登记、`model_slice_admission_run`；结算接缝仍是 `src/server/assessment/runtime.ts` |
| `question-bank/` | 题库与准入：题目目录与编辑、`/api/questions*`、`/api/review/drafts*`、检索工具、准入框架（`server/admission/*`、`server/quiz/verify-*`、`jobs/{quiz,variant,source}_verify`、`question_admission_run`）、暂不出题复检（`serving-actions` 与订阅 `practice.serving-recheck@v1`）、难度标定（item prior / recalibration / fixed anchor）与回填 job、干预包作者 |
| `question-bank/server/verify-dispatch-outbox.ts` | 验证 intent、同事务派发与 orphan 恢复；基础设施 adapter 在 `src/server/boss/verify-dispatch-recovery.ts` |
| `supply/server/coverage-lattice.ts` / `api/coverage-lattice.ts` | 供题覆盖细目只读读模型与 `/api/admin/coverage-lattice`：供题扫描器四规则的 KC 池级覆盖 + 缺口 targets + 供给活动聚合；Observability admin 页只展示 |
| `failure-learning/server/failure-learning.ts` | 失败尝试 eligibility、归因、变式提议的 owner operation；durable subscriber 只调用该入口 |
| `server/` | 练习面：解题辅导/提示会话（`solve-*`、`tutor-session`、`hint-explanation`）、配置生效事实、对话确认题、`worksheet/region-map-validate`（§4.2 暂留）。另有待落位余项：供题生成（`question-generation-grounding`、`supply-plan-operation`、`web-sourcing-operation`、`quiz/*`、`tools/` 下其余候选工具，功能线落位到 `supply/`） |
| `jobs/` | 根目录只剩待落位余项：供题生成（`quiz_gen*`、`supply_planner`、`confusable_contrast_nightly`、`jyeoo_staged_asset_reap`）；`rejudge*` 已在 `settlement/jobs/` |
| `settlement/` | 结算与撤回重放：申诉请求与裁决（`server/appeal*`、`server/appeal-execution` 的 `authorizeConfirmationCorrection`）、`judge_retraction` accept、`attempt-snapshot` 快照括号、复习作答绑定（`review-answer-binding`）、`rejudge` job 与 `propose_grading_correction` 工具；判分侧的评价槽分配（`reservedEvaluationAttempt`、`bindAppealExecution`）在 grading，settlement 经 grading public 消费其 receipt 契约。settle 全族仍在 `src/server/assessment/`（mastery/revert 依赖未落位）|
| `tasks/` / `tools/` | `tasks/index.ts` 组合各 owner 的 TaskSpec；根 `tasks/` 其余是练习面的 `teaching-quality` 与待落位的供题生成 TaskSpec；`tools/types.ts` 是共享工具类型 |
| `ui/` | PracticeFacePage；`ui/library/` 题目库（全部 / 做错过 / 待审核 / 暂不出题）与单题页 |

## CONVENTIONS
- 子 owner 依赖自下而上：grading → settlement / question-bank → failure-learning → session → scheduling → supply → placement → 练习面（`docs/design/2026-11-03-practice-split.md` §0）。目录外只经 `<owner>/public.ts` 引用子 owner，根 `manifest.ts` 另可引用 `manifest-part.ts`，根 `tasks/index.ts` 另可引用 `<owner>/tasks/*`；owner 之间的 import 边只减不增，由 `pnpm audit:practice-subowners` 强制。
- 外部消费方只 import 根 `public.ts` / `ui-public.ts`，不直接引用子 owner 目录。
- 根 `public.ts` 按名字转出子 owner 的稳定符号，不用 `export *`：pass-through 台账只能给具名符号分类。
- AI 调用与队列直接用平台：`@/server/ai/runner-fn`（`makeRunTaskFn` / `makeRunTaskTextFn` / `BoundRunTaskTextFn`）、`@/server/boss/client` 的 `getStartedBoss`、`@/db/pg-boss-drizzle` 的 `fromPgBossDrizzleTx`；practice 内不设本地 runtime 包装。跨 owner 共用的纯件在 kernel：TaskSpec 输出解析 `@/kernel/parse-task-output`、出题 prompt 词表 `@/kernel/generation-prompt-support`、目标定位范围与种子根 `@/kernel/read-models/placement-scope`。
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
