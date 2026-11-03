# practice 拆分设计（YUK-1677）

状态：设计，未实施。测量基线 `origin/main` `1bea01753`（#2216、#2302 已合并）。统计脚本、原始输出与 SHA256 见
`/Volumes/YukovalSBak/yukoval-projects/tlp-docs/planning/yuk1677-practice-split-evidence.md`（下称「证据」）。本文不改产品代码，没有跑测试、DB 或 provider。

## 0. 结论

**切法：practice 按真实职责拆成 9 个 owner。** 每个 owner 拥有一项完整事实，并通过自己的 `public.ts` 暴露稳定业务操作。依赖方向自下而上、无环：

```
kernel / core / db / 平台层(ai, boss, durable, orchestration)
  └─ grading 作答与判分（含模型执行器与模型切片登记）
       ├─ settlement 结算与撤回重放 ............ YUK-1665 迁移线直接落位
       └─ question-bank 题库与准入
            └─ failure-learning 错因学习
                 └─ session 整卷与做题会话
                      └─ scheduling 学习安排（复习排程 + 今日练习流）
                           └─ supply 供题与备题员 ............ YUK-1468/1664 功能线自行落位
                                └─ placement 定位
                                     └─ face 练习面（解题辅导/提示 + 旧练习 UI）
```

settlement 只依赖 grading，与 question-bank 互不依赖。上面每一层只能 import 下面各层的 `public.ts`。

**形态（推荐 LIGHT）：先在 practice 内建子 owner 目录 `src/capabilities/practice/<owner>/`，暂不拆成独立 capability。**

- 现行审计对跨 capability 的 value 依赖做只减不增的 ratchet：`scripts/capability-boundary-baseline.json` 当前总计 5，YUK-1677 目标 3 要求 ≤2。
- 如果直接拆成独立 capability，仅新 owner 之间的下行 value import 就约 47 个导入文件（按 `src/capabilities/practice` 现状计，不含练习面），总计会从 5 升到约 50（§6），与同票目标冲突。
- 子 owner 目录之间的边界由扩展后的 `audit:capability-boundaries` 强制，规则见 §5.1。外部消费方仍只 import `@/capabilities/practice/public`，所以 Start 前门、shell、agency 等外部文件一行都不用改。
- FULL 方案（每个 owner 独立成 capability）作为后续升级路径保留：某个 owner 的下行依赖全部收敛到 kernel 端口后，再单独升级。

**迁移顺序：自上而下。** 底层两块正被重写线改动，所以架构线先拆只向下依赖的上层 owner：

1. 先拆错因学习、整卷与做题会话、学习安排。这三个 owner 的文件不被任何供题线、YUK-1665 或开放 PR 的文件 import，组合入口除外（证据 §6）。核心侧只需修 2 条反向边。
2. 判分在 #2303 合并、并完成迁移线的 kernel 端口票之后搬。
3. 题库与准入、定位在功能线完成供题落位之后搬。
4. 结算由迁移线落位，供题由功能线落位。
5. 最后剩下的 practice 根目录就是练习面。

**两个场景**（§4）：

| 场景 | 拆分前 | 拆分后 |
|---|---|---|
| 新功能：今日计划数字（YUK-1622） | 在 521 文件的包内改 9 个文件，其中包括 63 次改动的热点 `public.ts` | 只在 scheduling 内改（52 文件，约 9.7k 行），外部调用方只依赖 kernel 读模型 |
| 维护：整卷不可绘制题型拒绝开卷（YUK-1573） | — | 落在 session 6 个文件。原本经 grading 的一行转发被删除，改为直连 kernel；唯一多出来的 owner 是旧 UI `PfPaper.tsx`，已给出调整 |

## 1. 现状地图

### 1.1 规模与职责区

practice 当前有 521 个文件、132,465 行，已不是票面写的 437 文件、11 万行。下表是按职责归类的 16 区（证据 §1）：

| 职责区 | 文件/行 | 代表文件 |
|---|---|---|
| 题库 | 88 / 20.7k | `question-*`、`serving-actions`、`draft-*`、`proposal-appliers`、`quiz/{matcher,pool-fetch,content-fingerprint}`、`tools/{bank-*,search/read/check-bank,edit-question}`、`ui/library/*` |
| 供题 | 68 / 20.4k | `question-supply/*`（含 placement-starter*）、`jobs/{quiz_gen*,supply_*,question_supply_nightly}`、`tools/{submit-question,file-bank-gap,jyeoo/web-fetch,generate-question-candidate}` |
| 准入与验证 | 42 / 16.2k | `admission/*`、`quiz/verify-*`、`verify-dispatch-outbox`、`jobs/{quiz_verify*,source_verify*,question_admission_run,model_slice_admission_run}` |
| 卷与打印 | 50 / 13.4k | `paper-*`、`practice-read`、`answer-draft`、`worksheet/*`、`assessment/paper-*` |
| 判分引擎与投递 | 50 / 10.8k | `judge/*`、`judge-run-*`、`judge-operational`、`judge-engine-client`、`jobs/{judge_run,judge_pending_reconcile}` |
| 练习面外壳 | 18 / 7.9k | `ui/PracticeFacePage`、`ui/blocks/*`、`ui/practice-{api,client}` |
| 作答捕获与发卷 | 29 / 7.3k | `assessment/{issue,submit,attempt,durable-attempt,study-context}`、`review-operation`、`attempt-snapshot` |
| 练习流与选题 | 34 / 7.0k | `stream-*`、`selection-*`、`softmax-selection`、`post-filter`、`variant-rotation`、`candidate-signals` |
| 错因学习 | 30 / 5.6k | `failure-learning*`、`cause-*`、`jobs/{attribution_followup,variant_gen}`、`tools/{attribute-mistake,propose-variant,query-mistakes,get-attempt-context}` |
| 解题/提示会话 | 20 / 5.1k | `solve-session`、`solve-operations`、`tutor-session`、`hint-explanation`、`ui/solo/*` |
| 复习排程 | 31 / 4.9k | `due-list`、`daily-review-plan`、`question-pace`、`review-weekly`、`advice-operation`、`review-session-lifecycle`、`learner-return-wake` |
| 难度与判分校准 | 16 / 4.7k | `item-prior-*`、`fixed-anchor`、`calibration-sample-*`、`jobs/{item_prior_backfill,recalibration_nightly,judge_calibration_sample}` |
| 定位会话 | 17 / 3.3k | `placement-{session-lifecycle,select,assessment,advance,profile,termination}`、`session-operations/placement-*` |
| 组合与共享壳 | 17 / 2.5k | `manifest.ts`（1350 行）、`public.ts`（385 行）、`queue-runtime`、`task-runtime`、`tasks/parse-output` |
| 结算撤回/申诉 | 9 / 1.5k | `judge-retraction-applier`、`appeal-operation`、`assessment/appeal*`、`jobs/rejudge` |
| 干预余项 | 2 / 1.3k | `intervention-author`、`intervention-diagnostics`（#2302 已把物化迁入 kernel） |

### 1.2 内部依赖：主要环（证据 §2）

- **题库 ↔ 供题 ↔ 准入是三角环。**
  - 题库到供题：`quiz/matcher.ts` 直接调 `question-supply/dispatcher`；`bank-search` 与 `question-parts` 取 `evidence-demand` 类型；`edit-question` 与 `proposal-appliers` 调 `tools/submit-question`。
  - 准入到供题：取 `placement-starter-attempts` 的定位授权和 `placement-supply-lock`，共 20 条边。
  - 供题到题库：取 `content-fingerprint`、`pool-fetch`、`question-parts`、`embed_backfill`，共 12 条边。
- **作答 ↔ 判分：** `jobs/judge_run.ts` 回写 `assessment/durable-attempt` 与 `review-operation`。`judge/evaluate-submission.ts` 是枢纽：它内联调用 `src/server/assessment/runtime` 的 `activateEvaluation` 与 `learningSettlement`，还调用 `assessment/appeal-execution` 的评价槽分配。
- **复习排程 ↔ 练习流 ↔ 卷：**
  - 排程到流：`daily-review-plan` 调 `stream-inputs`，`learner-return-wake` 调 `stream-store`。
  - 流到排程：`stream-inputs` 调 `due-list`，`stream-store` 调 `review-session-lifecycle`。
  - 排程到卷：`session-operations/review-session` 调 `paper-issuance`；反方向是 `paper-session-create` 调 `review-session`。
- **定位 ↔ 供题：** `placement-session` 调 starter claim/outcome；`placement-starter-recovery` 反调 `placement-select` 与 `placement-session-lifecycle`。
- **服务端反向依赖 UI 目录：** `server/custom-block-preview/*` 依赖 `ui/blocks/custom-sandbox.ts`。

### 1.3 对外公开面（证据 §4）

practice 之外有 142 个文件引用 practice。从 `public` / `ui-public` 静态导入的名字按职责区计：题库 34、供题 26、练习面 UI 24、校准 19、判分 14、排程 10。

| 消费方 | 取什么 |
|---|---|
| `server/start/*`（TanStack Start 前门） | 题库读写（list/detail/update/archive/restore/serving action/draft enable）、卷（list/detail/submit）、复习会话 create/transition、流 get/recompose/item、advice、weekly、solve/hint、定位 session、作答与 study-reference |
| `src/server` | item-prior DBOS 候选（19 个名字）、DBOS judge 宿主（judge 引擎身份/投递/对账，12 个）、供题 dispatcher/target-discovery、verify outbox 恢复 |
| `observability` | 供题 `scanCoverageGaps`、`assembleScanInput` 等（覆盖格） |
| `shell` | `queryReviewDue` |
| `agency` | `materializeInterventionDiagnostics` 等（#2302 后改由 kernel 承担）；`resolveDailyReviewPlanInputs` 经 kernel 读模型 |
| `copilot` | `practice-port.ts`：`executeGetReviewDue`、作答提交 |
| `kernel` | `placement.ts`、`judge.ts`、`quiz-gen-contract.ts`、`read-models/cause-policy.ts` 的类型 |
| `web/router.tsx` | ui-public 页面 loader |

另有 68 处深层 import，全部在 scripts 和测试里。

### 1.4 冲突热点（证据 §3）

2026-10-01 以来有 291 个提交改到 practice：

- 129 个（44%）同一提交跨 ≥2 个职责区，55 个跨 ≥3 个。
- 壳文件是第一冲突源：`public.ts` 被 63 个提交改过，`manifest.ts` 25 个，`ui-public.ts` 9 个。碰过壳的提交共 98 个。
- 共改最多的对：准入+供题 24、准入+题库 19、练习流+供题 19、题库+供题 18、作答+练习面 17、排程+练习流 16、排程+供题 16。
- 单文件热点：`jobs/source_verify.ts` 23、`ui/practice-client.tsx` 17、`jobs/question_admission_run.ts` 16、`proposal-appliers.ts` 16、`tools/submit-question.ts` 14、`jobs/quiz_gen.ts` 14。

按本设计的目标 owner 重新分桶后，跨 ≥2 个 owner 的提交有 109 个（37%），跨 ≥3 个的 37 个。

这个降幅不大，说明一个事实：冲突的主体是壳文件，加上题库/准入/供题这条接缝（43 次）。所以本设计的两个杠杆是：
1. 把壳拆成每个 owner 自己的 manifest 片段和 public（§5.1）；
2. 准入与它的执行 job 归同一个 owner（§3.2）。

## 2. 新 owner

以下「拥有」指唯一写者，或唯一决策者。表与事件只列写者，读取经 kernel 读模型或对方的 public。

### 2.1 grading 作答与判分 — `practice/grading/`

- **拥有：**
  - 发卷（issuance）、作答草稿与提交（不可变、幂等）。
  - 判分路由与判分器、评价候选的冻结输入与落库。
  - 判分投递：DBOS judge_run、pending 对账、运营收据。
  - 判分校准采样。
  - 依迁移线裁定，还拥有模型执行器（`src/server/assessment/{jev,pi,rubric}-model-executor.ts`、`assessment-model-assets.ts`）与模型切片登记（`src/server/assessment/model-slice-registry.ts`）。
  - `model_slice_admission_run`：模型切片选择与准入。
- **不拥有：** 结算，以及结算产生的 FSRS/掌握度效果，这些归 settlement。干预诊断余项登记和退役诊断题排程的写入调用点见 §6.4。
- **稳定操作：**

  | 操作 | 输入 → 输出 | 失败结果 |
  |---|---|---|
  | `issueAssessment(tx, IssueAssessmentRequest)` | → `IssueAssessmentResult` | 冻结 revision 不可服务时 withheld |
  | `saveResponseDraft` / `saveSubmission` / `getIssuanceState` | 草稿用 `expected_save_epoch` 防覆盖 | 同 payload 重放无副作用；不同 payload 返回 `conflict` |
  | `prepareFormalAttemptSubmission` / `recordFormalAttemptCapture` / `commitFormalAttempt` / `previewFormalAttempt` | 作答 → 捕获 → 提交 | `not_found`、`coordinate_mismatch`、`capture_entry_required`、`rating_required` |
  | `evaluateSubmission(submissionId, groupId, policy)` | → `EvaluateSubmissionResult` | 判不了是显式 pending，不发明结论（ADR-0073） |
  | `readJudgeRunStatus` / `readPermanentJudgeRun` / `reconcileJudgeAttempts` | DBOS 宿主入口 | — |
  | `revealFrozenStudyReference` | — | — |

  模型切片相关的公开入口建议见 §3.1。
- **表与事件：**
  - 表：`assessment_issuance`（经 `kernel/records/assessment-issuance`）、`assessment_response_draft`、`assessment_submission`、`evaluation`、`evaluation_group`。`evaluation_effective_head` 的切换语义由 settlement 的激活决定，见 §3.1。
  - 事件：`attempt`、`judge`、`experimental:assessment_attempt`、`experimental:assessment_placement_*`、`experimental:record_capture`、`judge_delivery_*`、`judge_pending_attempt`、`judge_calibration_*`、`mastery_progress`。`assessment_activation` / `assessment_publish` 与 `assessment_feedback_released` 的写者分别在 settlement 与 session。
- **依赖：** 只依赖 kernel/core/db/平台。`placement-scope` 下沉到 kernel。`review-operation` 对定位容器的校验，改为 issuance 容器端口（§3.1）。
- **manifest 贡献：**
  - 路由：`POST /api/attempts`、`/api/issuances*`、`POST /api/submissions`、`GET /api/jobs/judge_run/[id]/status`。
  - 任务：`judge_run`、`judge_pending_reconcile`（DBOS）、`judge_calibration_sample`、`model_slice_admission_run`。
  - 工具：`submit_review_answer`。
- **AGENTS 约束延续：** 历史判分不可变，rejudge 是新事件；attempt 事务内不调慢的 LLM。

### 2.2 settlement 结算与撤回重放 — YUK-1665 迁移线直接落位

§3.1 给出目标与边界，本设计不安排架构线搬迁。

### 2.3 question-bank 题库与准入 — `practice/question-bank/`

- **拥有：**
  - 题目事实与生命周期：草稿 → 准入（六项门）→ 发布 → 暂停出题/恢复 → 归档/恢复。
  - 题目编辑的接受落点：`question_edit`、`question_draft`、`variant_question` 三类提议的 applier。
  - 内容指纹与精确去重、题库检索与 agent 读面（ADR-0072）。
  - 验证 handoff：`verify-dispatch-outbox`，按 ADR-0052 留在 owner 本地。
  - 准入框架 `admission/*`、`quiz/verify-*`、`quiz_verify`、`variant_verify`。
  - 题目难度标定：`item_calibration` 单写者，包括 item-prior、fixed-anchor、recalibration。
  - 参考解与答案类回填、自定义块预演、embedding 回填（`knowledge.embedding` 写入后续归 YUK-1665 所说的独立 embedding owner）。
  - 干预包作者 `intervention-author`：它的验证走本 owner 的 verify 框架。
- **稳定操作：**

  | 操作 | 输入 → 输出 | 失败结果 |
  |---|---|---|
  | `readPracticeQuestionList` / `readQuestionDetail` / `readDraftReviewDetail` / `readPracticeDraftList` | 查询 → 读模型 | 不存在为 null，路由映射成 404 |
  | `updatePracticeQuestion` / `archivePracticeQuestion` / `restorePracticeQuestion` | 带 `version` 的 CAS | `conflict`、`not_found`、`validation_error` |
  | `runPracticeServingAction(command, Idempotency-Key)` | 已付费批次不会重复付费 | 缺少键或键超长时 `validation_error` |
  | `enablePracticeDraft` / `forceEnablePracticeDraft` | verify-then-promote | — |
  | 入库闸核心 | 校验 → 去重 → 写草稿 → 同事务写 verify intent | — |
  | `canonicalQuestionContentHash`、`poolFetch` / matcher 召回、`search/read/check_bank` | 读面 | — |

  入库闸核心现在混在 `tools/submit-question.ts` 里，由功能线拆出（§3.2）。matcher 只返回 `used` / `residual`，不再自己派发供题。
- **表与事件：**
  - 表：`question`（目标是唯一写者；现在题库 16 处、准入 14 处、供题 6 处、作答 2 处直接写）、`bank_search_snapshot`、`item_calibration`、`question_answer_anchor` 中属于发布的部分。
  - 事件：`question_archive/restore/structure_edit`、`question_serving_action`、`quiz_verify`、`variant_verify`、`question_admission_purpose`、`selection_miss`、`QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION`。
- **依赖：**
  - 依赖 grading 的 public：`question-contract`、`steps-judge`，供验证使用。
  - 指向供题的边全部改走 kernel 契约或端口（§3.2），不能反向 import 供题。
  - 提议落库只经 kernel proposals。
- **manifest 贡献：**
  - 路由：`/api/questions*`（列表、详情、PATCH/DELETE、restore、serving-actions）、`/api/review/drafts*`、`POST /api/practice/calibration/anchors`。
  - 任务：`quiz_verify`、`variant_verify`、`item_prior_backfill`、`recalibration_nightly`、`embed_backfill`、`reference_answer_backfill`、`answer_class_backfill`。
  - 订阅：`practice.question-admission-enqueue@v1`。
  - 提议类别：`variant_question`、`question_draft`、`question_edit`。
  - 工具：`search_bank`、`read_bank`、`check_bank`、`edit_question`、`author_question`、`propose_question_edit`（仅登记，无授权面）。

### 2.4 failure-learning 错因学习 — `practice/failure-learning/`

- **拥有：** 失败作答资格判定、归因、变式提议的完整操作（ADR-0051 首个竖切），错因目录扩张与 overlay，错题查询与作答上下文工具，连错提醒，丢失归因回填。
- **稳定操作：**

  | 操作 | 输入 → 输出 |
  |---|---|
  | `requestFailureLearning(attemptEvent)` | 订阅入口：资格不符时 no-op，不报错 |
  | `proposeFailureVariant(ProposeFailureVariantInput)` | → `VariantProposalResult`，只做提议 |
  | `effectiveCauseCategoryForFailureAttempt` / `getCauseCategoryOverlaysByIds` | 读 |

- **表与事件：**
  - 表：`cause_category_overlay`。目前由题库的 `proposal-appliers` 代写，随 `cause_category` 提议类别迁回本 owner。
  - 事件：归因结果写成 `judge` 事件，`caused_by` 指向原作答，不回写 attempt。
- **依赖：** grading 的 public（`study-context`），以及 kernel 读模型 `failure-attempts`、`cause-policy`。
- **manifest 贡献：**
  - 订阅：`practice.failure-learning-attempt@v3`，id 与版本逐字保留。
  - 任务：`attribution_followup` → `variant_gen`，队列名不变。
  - 提议类别：`cause_category`。
  - 工具：`attribute_mistake`、`propose_variant`、`query_mistakes`、`get_attempt_context`。

### 2.5 session 整卷与做题会话 — `practice/session/`

- **拥有：**
  - `learning_session(type='review')` 生命周期：start、pause、resume、reopen、complete、abandon，以及孤儿会话清理。
  - 卷：唯一容器是 `tool_quiz` artifact（ADR-0029）。卷架列表、卷详情、整卷发卷绑定、冻结卷重开。
  - 答题卡草稿（`answer` 表：每个槽位只有一条活草稿）、整卷/逐槽交卷。
  - 会话小结、作答卷导出与 PDF 渲染、`write_quiz` 组卷。
- **稳定操作：**

  | 操作 | 输入 → 输出 | 失败结果 |
  |---|---|---|
  | `createReviewSession` / `transitionReviewSession` | — | `not_found` |
  | `abandonOrphanReviewSession` | — | — |
  | `readPaperList` / `getPaperDetail` | — | `validation_error` |
  | `createPracticePaperSubmission` / `submitPaperSlot` | 交卷 | `validation_error`；`paper_mode_unsupported_slot_kind`（409） |
  | 草稿 save/read | — | — |
  | 导出 create/get/pdf/page、region-map 存档 | — | — |

- **表与事件：** `learning_session`（type=review）、`answer`、`artifact`（tool_quiz）、`worksheet_export`、`worksheet_export_item`、`worksheet_region_map_page`；事件 `experimental:adaptation`、`assessment_feedback_released`。
- **依赖：** grading 的 public（发卷、提交、作答捕获、评价可见性），question-bank 的 public（matcher 召回）。发卷记录直接 import `kernel/records/assessment-issuance`：原 `server/assessment/issue.ts` 转发壳（全文件只是对它的 re-export）在 S4 删除，`paper-issuance`、`paper-detail`、`worksheet/export-store` 等全部消费方同片改为直连 kernel。
- **manifest 贡献：**
  - 路由：`/api/review-sessions*`、answer-drafts、submissions、`/api/papers*`、`/api/practice/[id]`（legacy）、`/api/worksheet-exports*`。
  - 任务：`session_summary`、`worksheet_render`（`WORKSHEET_RENDER_QUEUE` 常量随本 owner 移动）。
  - 工具：`write_quiz`。

### 2.6 scheduling 学习安排 — `practice/scheduling/`

- **拥有：**
  - 「何时复习」的读取：due 队列、`material_fsrs_state` 投影读取、每日复习计划事实（装入 `kernel/read-models/daily-review-plan`）、实测题目节奏、评级建议、周报。
  - 「今日练什么」（ADR-0037 唯一 picker）：流组成、候选输入、softmax 选题、L3 学习混合守卫、流物化与条目推进、夜间组流。
  - 「回来即可练」唤醒。
- **不拥有：** `material_fsrs_state` 的任何写入调用点，只读它。写入机制与各写入调用点的归属见 §6.4。
- **稳定操作：**

  | 操作 | 输入 → 输出 | 失败结果 |
  |---|---|---|
  | `queryReviewDue` / `executeGetReviewDue` | — | — |
  | `getPracticeStream` / `recomposePracticeStream` / `updatePracticeStreamItem` | — | `not_found`、`validation_error` |
  | `previewReviewAdvice` | — | `not_found`、`validation_error` |
  | `loadWeeklyReview` | — | `invalid_timezone`、`validation_error` |
  | `installDailyReviewPlanFacts` | — | — |
  | 选题原语 `variant-rotation`、`candidate-signals` | 定位与供题落位后公开 | — |

  AI 不可用时，流回落到确定性 due 队列。
- **表与事件：** `practice_stream_item`（唯一写者 `stream-store.ts`；#2302 合并后已没有第二写者）、`selection_observation`。
- **依赖：** session 的 public（`practice-read`、`paper-sections`、`review-session-lifecycle`），failure-learning 的 public（`cause-context`），grading 的 public（`judge-rating`、`activity-ref`）。指向供题只经 kernel 端口：refill 与夜间供题的触发走 `kernel/supply-dispatch` 或组合根装入的端口，不 import 供题模块。
- **manifest 贡献：**
  - 路由：`GET /api/review/due`、`POST /api/review/advice`、`GET /api/review/weekly`、`/api/practice/stream*`。
  - 任务：`practice_stream_compose_nightly`、`learner_return_wake`。
  - 订阅：`practice.learner-return-wake@v1`，逐字保留。
  - 工具：`get_review_due`、`get_question_context`。按 ADR-0072，题库内容层由 bank 工具取代后，后者退役。

### 2.7 supply 供题与备题员 — 功能线自行落位

见 §3.2。

### 2.8 placement 定位 — `practice/placement/`

- **拥有：** `learning_session(type='placement')` 生命周期、探针选题、推进与终止、持有释放、画像读取。
- **稳定操作：**

  | 操作 | 失败结果 |
  |---|---|
  | `startPlacementProbe` | `not_found`（含 `placement probe is not enabled`） |
  | `readPlacementSession` / `transitionPlacementSession` / `selectNextPlacementQuestion` / `releaseHeldPlacement` / `readPlacementProfile` | — |

- **依赖：** supply 的 public（starter claim/outcome），scheduling 的 public（选题原语、day-one priors），grading 的 public。
- **manifest 贡献：** `/api/placement-sessions*`、`GET /api/placement/profile`。

### 2.9 face 练习面 — practice 根目录的最终形态

- **拥有：** `learning_session(type='tutor')` 解题辅导、提示梯与讲解封存（AGENTS 中「提示」两条约束整体留在这里）、旧练习页 UI 外壳与题块渲染。
- **manifest 贡献：** `/api/solve-sessions*`、`ui.pages`。
- 组合：`manifest.ts` 只拼接各 owner 的 manifest 片段；`public.ts` 按名字转出各 owner public 中供外部使用的符号，不用 `export *`（pass-through 台账只能给具名符号分类）。

## 3. 重写线占用部分（不安排架构线搬）

### 3.1 结算与撤回重放（YUK-1665 迁移线）及迁移线裁定

**裁定原文要点：** 判分模型执行器与 `src/server/assessment/model-slice-registry` 归 grading。结算只消费判分结果，不拥有模型执行，也不拥有模型切片选择。结算与撤回重放本身由 YUK-1665 直接落位。

**判分代码落点（迁移线 YUK-1683 已确认）：** `src/capabilities/practice/grading/server/`。迁移线先把 `src/server/assessment/model-slice-registry.ts`、Jev/Rubric/Pi 三个执行器（`{jev,rubric,pi}-model-executor.ts`，连同它们使用的 `assessment-model-assets.ts`）落在这个目录。S4 把 practice 内其余判分文件搬进同一个子 owner 目录，不另建第二个落点。

**目标 owner：** settlement，建议目录 `practice/settlement/`，位于 grading 之上，与 question-bank 互不依赖。迁移线直接落入的路径：

| 当前路径 | 内容 |
|---|---|
| `src/server/assessment/{settle,settle-apply,settle-plan,settle-read,settle-replay,activate,learning-scope,faulty-item-inference}.ts` | 结算、激活、学习范围快照、疑似坏题推断 |
| `practice/server/{judge-retraction-applier,appeal-operation,attempt-snapshot}.ts` | 撤回、申诉、快照括号 |
| `practice/server/assessment/{appeal,appeal-execution}.ts` | 其中申诉请求与裁决归 settlement；评价槽分配归 grading，见下 |
| `practice/jobs/rejudge*`、`api/appeal.ts`、`server/tools/propose-grading-correction.ts` | 重判、申诉路由、判分纠错工具 |
| `practice/server/review-operation.ts` | 旧复习作答路径。捕获部分归 grading，结算部分归 settlement |
| 提议类别 `judge_retraction` | 从 `proposal-accept-applier.ts` 移入 settlement 的 manifest 片段 |

**迁移线落位时需要倒置的耦合**（只标注，由迁移线决定实现）：

1. `judge/evaluate-submission.ts` 内联调用 `activateEvaluation` 和 `learningSettlement`，形成 grading → settlement 的上行边。目标形态是 settlement 消费评价结果：激活后事件，或由组合根装入的 kernel 端口。在倒置之前，grading 搬迁时保留对 `src/server/assessment/runtime` 的现有 server 边，不新增新的边。
2. `assessment/appeal-execution.ts` 的 `bindAppealExecution` / `reservedEvaluationAttempt` 是「在 evaluation-group 锁下分配评价槽」，非申诉的分配者也会调用。槽分配归 grading；申诉只作为它的一个消费方。
3. `review-operation.ts` 调用 `placement-assessment.validatePlacementSubmission`，形成作答到定位的上行边。改为 grading 拥有「发卷容器仍有效」的端口，由 placement 装入。
4. `judge-retraction-applier.ts:24-28`（归 settlement）从 `./proposal-appliers`（归 question-bank）取三样东西：`recordPracticeProposalDecision`（本地改名为 `recordProposalDecisionSignal`）、`PracticeApplierOpts`、`ProposalInboxRow`。这条边会形成 settlement → question-bank 的依赖，与 §0「settlement 与 question-bank 互不依赖」矛盾。修法：settlement 直接依赖 kernel，不经 question-bank。
   - `recordPracticeProposalDecision` 本身只是 `proposal-appliers.ts:61-68` 对 `@/kernel/proposals/signals` 的 `recordProposalDecisionSignal` 的一层转调，改为直接 import kernel 实体。
   - `ProposalInboxRow` 改为从 `@/kernel/proposals/inbox` 直接 import。`proposal-appliers.ts:58` 只是把它转导出。
   - `PracticeApplierOpts`（`proposal-appliers.ts:113-120`）是题库 applier 的结构化选项，混有题库的 `enqueueVariantVerify` 和结算的 `enqueueRejudge`。settlement 在本地声明只含 `decision`、`user_note`、`enqueueRejudge` 的结构化选项类型。分发壳传入的 `AcceptAiProposalOpts` 仍然可以赋值给它，题库一侧保留自己的类型。
   - 反方向 `proposal-accept-applier.ts:25` → `./judge-retraction-applier` 由「`judge_retraction` 提议类别移入 settlement 的 manifest 片段」一并消解（见上表）。两步完成后，settlement 与 question-bank 之间没有任何 import。

**kernel 两处反向依赖（迁移线另票负责）：**

- `src/kernel/records/assessment-issuance.ts:48-52` 依赖 `@/server/assessment/model-slice-registry`，用到 `lookupGroupSubjects`、`resolveModelAdmissionContext`、`GroupSubjectLookup`。
- `src/kernel/scheduling.ts:4-9` 依赖 `@/server/fsrs/*`，用到 `selectedForgettingEngine`、`retrievabilityForKc`、state。纯调度算法可能下沉到 core 或 kernel。

**grading 公开入口建议**（供迁移线选择「依赖 grading public」或「kernel 端口注入」）：

| 入口 | 形状 | 消费方 | 建议通道 |
|---|---|---|---|
| `readModelAdmissionContext(db \| tx)` | → `ModelAdmissionContext`：当前 pin 与已准入切片 | kernel 发卷记录、服务门 | kernel 端口 `kernel/ports/grading-admission.ts`，由 grading 的 `installGradingAdmissionReader()` 装入，与 `installDailyReviewPlanFacts` 同一模式。kernel 不得 value import capability |
| `lookupGroupSubjects(db \| tx, groupIds)` | → `Map<groupId, GroupSubjectLookup>` | kernel 发卷记录、settlement | 同上端口一并装入。它是纯读，也可以整体下沉为 kernel 读模型，由迁移线二选一 |
| `currentModelPins()` / `gradingSliceMatchesLivePin(...)` / `modelSliceIdFor(...)` | 只读判定 | grading 内部、`core/schema/assessment/serving-admission`（目前只是注释镜像） | grading public |
| `registerModelAdmissionSlice` / `retireModelAdmissionSlice` / `assertModelAdmissionSliceRegistrable` | 写 | 只有 grading 自己的 `model_slice_admission_run` | 不公开 |
| `evaluateSubmission` 的结果类型、`readEffectiveEvaluation` | 已激活评价 | settlement | grading public；读取也可以继续经 `kernel/read-models/assessment-verdict` |

### 3.2 供题与备题员（YUK-1468/1664 功能线自行落位）

以下路径整块归功能线。架构线的任何切片都不要求在功能线落位之前改动它们：

- `practice/server/question-supply/*`：web-supply、placement-starter*、plan-executor、dispatcher、refill、target-discovery 等。
- `practice/jobs/{supply_execute,question_supply_nightly,source_verify*,question_admission_run}.ts`，以及 `quiz_gen*`、`supply_planner`、`confusable_contrast_nightly`、`jyeoo_staged_asset_reap`。
- `server/tools/submit-question.ts` 的供题候选路径，以及 `file-bank-gap`、`jyeoo-fetch-candidates`、`web-fetch-candidates`、`generate-question-candidate`、`question-author`、`store-sourced-question`。
- `server/{placement-starter-recovery,supply-plan-operation,web-sourcing-operation,question-generation-grounding}.ts`，供题相关 tasks，`api/quiz-gen-trigger*`。

**建议目标：** `practice/supply/` 子 owner，位于 scheduling 之上、placement 之下。也可以是独立的 `src/capabilities/supply`，但它对题库/判分的 value 依赖会使跨能力 ratchet 上调，见 §6，由功能线权衡。

**依赖方向：**
- supply 依赖 question-bank 的 public（入库闸、指纹、召回）、grading 的 public（`question-contract`）、scheduling 的 public（选题原语）。
- question-bank、scheduling、placement 指向 supply 只经 kernel 契约或端口。

**落位接口要求**（落位时由功能线提供，架构线据此再搬题库与定位）：

1. **契约下沉 kernel。** `EvidenceDemandV1`、`SupplyTraceV1`、`PlacementVerificationAuthority` 下沉到 kernel 契约模块（建议 `src/kernel/supply-contracts.ts`）。目前题库、准入在 9 处直接 import 这些类型或 schema。
2. **供题派发只走 kernel/supply-dispatch。** matcher 在残差时触发的派发、`stream-store` 的 refill、`learner-return-wake` 的夜间供题，都走 `kernel/supply-dispatch` 或组合根装入的端口。现有 `enqueueSupplyDispatchJob` 已覆盖 `supply_execute` 和 `quiz_gen` 两个队列。
3. **定位授权与锁以端口提供给 verify。** 定位授权断言 `assertPlacementAuthority` 与供题范围锁 `lockPlacementSupplyScopes` 以端口形式提供，锁的顺序不变（ADR-0052 稳定身份是 question、verifier、placement authority 三元组）。锁 key 建议进 kernel 锁登记。
4. **拆分 `tools/submit-question.ts`。** 唯一入库闸的核心（校验、去重、写草稿、同事务 verify intent）归 question-bank；供题候选路径留在 supply。ADR-0069 和 ADR-0072 说的唯一入库闸是这里的 owner 问题，不新增第二个 commit seam。
5. **`placement-starter-recovery` 不再直接调用定位会话。** 它现在直调 `placement-select` / `placement-session-lifecycle`，改经 `kernel/placement.ts` 端口。
6. **准入执行 job 的归属（建议，由功能线定）。** `source_verify` 与 `question_admission_run` 是准入（六项门）的执行者，建议落到 `question-bank/jobs/`，与 `admission/*`、`verify-dispatch-outbox` 同一个 owner。理由：准入+供题共改 24 次，准入与题库目录同一提交共改 17 次。一道门由一个 owner 拥有，可以消除题库 ↔ 供题 ↔ 准入的三角环。功能线若选择留在 supply，题库对这两个 job 的调用（serving-action 的 reverify、`verify-and-promote` 调 `source_verify_lifecycle`）就必须改走发布事件或端口。

## 4. 两个真实修改场景

### 4.1 新功能：今日计划数字由 due 队列与预算算出（YUK-1622，#1872 `fcf7fb530`）

| | 拆分前 | 拆分后 |
|---|---|---|
| 要读懂的范围 | practice 全包 521 文件。due-list ↔ stream-inputs ↔ variant-rotation 的环，`review-session-lifecycle`、`practice-read`、`paper-sections` 的跨区调用，385 行的 `public.ts` | scheduling 52 文件、约 9.7k 行。跨 owner 只读 session 的 `practice-read` / `paper-sections`、grading 的 `judge-rating` 这几个稳定读操作 |
| 要修改的 practice 文件 | 9 个：热点 `public.ts`（同期还被 #2216、#2302、#2303 改动），以及 `daily-review-plan`、`question-pace`、`softmax-selection`、`stream-budget`、`stream-composer`、`stream-inputs`、`stream-store`、`stream-view` | 8 个 scheduling 文件，加 `scheduling/public.ts`；根 `public.ts` 不变（外部调用方经 kernel 读模型读取，不需要新的具名转出） |
| 跨 owner | practice、agency（coach_daily、coach task）、core | scheduling、agency、core，数量相同 |
| 调用方是否只依赖稳定业务操作 | agency 经 kernel 读模型 `daily-review-plan` 读取（已是端口） | 不变。装入者 `installDailyReviewPlanFacts` 随 scheduling 移动 |

结论：owner 数量没有变化。冲突面从全包共享的 `public.ts` 收窄到 scheduling 自己的 public，阅读范围从约 13.2 万行缩到约 9.7k 行。

### 4.2 旧功能维护：整卷页画不出的题型拒绝开卷和交卷（YUK-1573，#1823 `e76e1ff3d`）

| | 拆分前 | 拆分后 |
|---|---|---|
| 要读懂的范围 | `assessment/` 目录混放作答、发卷、卷三类事务；`issue.ts` 只是 kernel 转发 | session（卷发卷绑定、冻结重开、交卷）；grading 只读 `prepareFormalAttemptSubmission` / `recordFormalAttemptCapture` 两个稳定操作 |
| 要修改的 practice 文件 | 8 个：3 个 api、4 个 `assessment/*`（含 `issue.ts` 加一行转发）、`ui/PfPaper.tsx` | session 6 个：`api/{paper-answer-route,paper-session-create,review-session-detail}`、`paper-{attempt,issuance,session-transition}`。grading 0 个：S4 删除了 `issue.ts` 转发壳，`paper-issuance` 直接 import `kernel/records/assessment-issuance`，以后要用的符号直接从 kernel 取，不再需要转发。外加 UI `PfPaper.tsx`。（注：在 `1bea01753` 上 `paper-issuance.ts:24` 仍然 `from './issue'`；S2 搬迁时保留了这条 import，S4 之后这一列才成立。） |
| practice 之外 | `core/schema/assessment/{serving-admission,slot-renderers}`、`kernel/records/assessment-issuance`、`ui/components/response/ResponseSlotField` | 不变 |
| 跨 owner | 1 个 | session 与 face 的旧 UI，2 个 |

**发现：拆分后跨的 owner 反而多了一个**，来源是旧 UI 文件 `PfPaper.tsx` 留在 face。

**调整切法：**
1. 卷相关 UI（`PfPaper`、`PfShelf`、`ui/worksheet/*`）的归属随 session 走。
2. 它们共用的 `practice-api` / `practice-client` 按 owner 拆出 session 的客户端模块，由 UI 线（唯一 UI 写者）执行。
3. 如果旧 UI 按既定计划在 #2303 之后退役，新 UI（`src/ui-next/practice-studio`）只消费 `session` 的 ui-public，这个场景就回到单一 owner。

在调整完成之前，`api/paper-contracts.ts`、`api/worksheet-contracts.ts`、`server/worksheet/region-map-validate.ts` 暂留 practice 核心，避免旧 UI 与 session 互相依赖。退出条件：旧 UI 退役，或 UI 客户端完成按 owner 拆分。

### 4.3 反例核对：夜间任务按活跃度做资格判定（YUK-1560，#1822）

- **现象：** 原来在一个 `manifest.ts` 里给每个 job 加资格声明，拆分后分散到 question-bank、supply、scheduling 三个 manifest 片段。
- **判断：** 资格策略本身是平台层 `kernel/nightly-eligibility`，不在拆分范围。每条声明跟它所属的 job 在一起，是正确的局部性，不调整。
- **调整切法：**
  1. `activity-tier.ts`（供题夜间任务与回来唤醒都读它）下沉为 kernel 读模型，消除 supply → scheduling 的边。这一步需要改 `question_supply_nightly` 的 import，所以在功能线落位时一起做，或由功能线做。
  2. `learner-return-wake` 留在 scheduling，供题一步只经 kernel 端口触发。

## 5. 迁移顺序与切片

### 5.1 通用规则（每片都适用）

- **目录与边界：**
  - 子 owner 目录 `src/capabilities/practice/<owner>/{server,api,jobs,tasks,tools,ui}`，每个目录有自己的 `public.ts` 和 `manifest-part.ts`。
  - 根 `manifest.ts` 只拼接各 owner 片段；根 `public.ts` 按名字转出各 owner public 中供外部使用的符号（`export { a, b } from './<owner>/public'`），不用 `export *`：pass-through 台账（`scripts/pass-through-classifications.jsonl`）只能给具名符号逐条分类，`export *` 会把 owner 的整个 public 不加区分地变成外部契约。保持现有懒加载包装，迁移 bundle 不得引入 SDK（`public.ts` 头注释所述约束）。
  - S0 在 `audit:capability-boundaries` 增加 practice 子 owner 规则：
    - 顺序表按 §0。
    - 子 owner 之间只能 import 对方的 `public.ts`。
    - 子 owner 指向根目录里尚未迁出的文件，记入只减台账，每片随迁出递减。
    - 根目录里尚未迁出的文件指向子 owner，只能 import 子 owner 的 `public.ts`。
- **不留转发壳：** 原路径文件随 consumer 一起删除。scripts 与测试里的深层 import 做机械路径更新：命中既有已批模式，按 AGENTS 规则直接改。不新增测试，不改断言。
- **durable 身份逐字保留：** 订阅 id 与版本（`practice.failure-learning-attempt@v3`、`practice.learner-return-wake@v1`、`practice.question-admission-enqueue@v1`），队列名，DBOS workflow 与 queue 名（`JUDGE_DBOS_*`），提议类别名，事件 action 名。`events.actions` 的声明随写者所在 owner 的片段移动，组合后的集合不变。
- **每片的验证：**
  - 本地：`pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm audit:capability-boundaries`、`audit:architecture-deepening`、`audit:test-policy`。
  - 组合根的路由、job、工具清单在迁移前后逐项一致（manifest 快照对照，作为 PR 证据，不另建测试）。
  - 按文件路径登记的审计台账必须与搬迁同片同步：只改路径，不改条目语义、计数或分类。漏改的话，对应审计或 CI 会失败。`1bea01753` 上登记了 practice 路径的台账有 5 份 JSON，另有 3 处在审计脚本源码内联登记：
    - `scripts/pass-through-classifications.jsonl`：55 条，转发点分类，由 `audit:architecture-deepening` 的 pass-through ratchet 读取。
    - `scripts/audit-advisory-locks-baseline.json`：20 条，按调用点计数，`audit:advisory-locks`。
    - `scripts/audit-flags-ledger.json`：7 条，flag 的 reader 文件，`audit:flags`。
    - `scripts/audit-hub-sync-writers-allowlist.json`：2 条，`audit:hub-sync-writers`。
    - `scripts/audit-mastery-provenance-allowlist.json`：1 条，`audit:mastery-provenance`。
    - 源码内联：`scripts/audit-fold-writes.ts` 4 条（`audit:fold-writes`）、`scripts/audit-learner-copy.ts` 32 条（`audit:learner-copy`）、`scripts/audit-mastery-provenance.ts` 的 `TRACKED_CONSUMERS` 3 条。
  - 每片 PR 列出本片涉及的台账条目（旧路径 → 新路径），并在本地跑 `audit:advisory-locks`、`audit:flags`、`audit:hub-sync-writers`、`audit:mastery-provenance`、`audit:fold-writes`、`audit:learner-copy`。
  - CI：exact-head CI Gate。
- **审查：** 涉及 grading、question-bank 和 worker job 的切片属于 Tier A（多 lane 独立审），其余是 Tier B。

### 5.2 切片表

**写集不重叠的规则：** 同一波里各片只碰自己的子 owner 目录和自己的 manifest/public 片段。根 `manifest.ts` 与 `public.ts` 只在 S0 改一次。

| 片 | 文件范围 | 目标 | 预计改动文件 | 前置 | 风险点（事务/锁/幂等/恢复） | 执行线 |
|---|---|---|---:|---|---|---|
| **S0 壳拆分与边界规则** | 根 `manifest.ts`、`public.ts`、`tasks/index.ts`。把错因学习、session、scheduling 三个 owner 的条目机械抽成各自的片段（文件暂不移动）；供题、判分、题库条目原地不动，避免与功能线、#2303 冲突；扩展审计规则并登记台账 | 组合根 | ~10 | #2303 合并后再做，以免 rebase 冲突 | manifest 组合前后路由、job、工具、订阅、事件 action 集合逐项一致；`public.ts` 懒加载不得退化成急加载（迁移 bundle） | 架构线 |
| **S1 错因学习** | 错因职责区 30 个文件（24 个产品文件，6 个测试）；`proposal-appliers.ts` 只改 1 个 import（cause-overlay 改为 `kernel/read-models/cause-overlay`）；`proposal-accept-applier.ts` 中 `cause_category` 两个 applier 移出；`scripts/backfill-lost-attribution.ts` 路径更新 | failure-learning | ~36 | S0 | 订阅从已提交 attempt 同事务投递（ADR-0051），id/version 不变；`attribution_followup` → `variant_gen` 链的幂等；只做提议 | 架构线 |
| **S2 整卷与做题会话** | session 映射的 49 个文件减去 3 个暂留契约（§4.2）。`assessment/issue.ts` 转发壳不在本片删除：S2 只随文件搬迁 session 内的 3 个消费方（`paper-issuance`、`paper-detail`、`worksheet/export-store`），保留它们对转发壳的 import；转发壳及其全部消费方（session 3 个、placement 的 `placement-assessment`、grading 的 `assessment/{submit,study-context}`、承接出卷请求的 `grading/server/assessment/request.ts` 与 `api/assessment-route`、根 `public.ts` 的 `issueAssessment` 转出，以及测试）改为直连 `kernel/records/assessment-issuance`，在 S4 完成。测试消费方做机械路径更新。另外还要更新 `src/server/assessment/admission.db.test.ts` 等深层测试的路径 | session | ~62 | S0；可与 S1、S3 并行 | `learning_session(type=review)` 状态机；冻结卷重开事务 `withFrozenPaperReopen`；答题卡草稿唯一索引与 save epoch；交卷逐槽幂等；`worksheet_render` 队列身份；`session_summary` best-effort 入队；孤儿清理 cron（经 public，不变） | 架构线 |
| **S3 学习安排** | 排程 + 练习流 52 个文件，减去暂留核心的 `variant-rotation`、`candidate-signals`、`activity-tier`、`day-one-priors`；`stream-date` 下沉 kernel；`api/review-planning-contracts.ts` 中的校准锚 schema 归还题库侧；深层测试路径更新（`settle-forgetting`、`recalibration`、`advisory-locks`、`admission` 四个 db test） | scheduling | ~55 | S0；可与 S1、S2 并行 | `practice_stream_item` 单写者；`compose-paid-work-lock` advisory lock；夜间组流与回来唤醒 singleton（180s）；AI 不可用回落确定性 due；refill 与夜间供题先经根 `public.ts` 下行调用（台账项），功能线落位后改 kernel 端口 | 架构线 |
| **S4 判分** | grading 映射约 89 个文件（判分、作答、校准采样、`model_slice_admission_run`、干预诊断余项），落点是 `practice/grading/server/`（§3.1）。`model-slice-registry` 与 Jev/Rubric/Pi 执行器由迁移线 YUK-1683 先落到这里，不在 S4 范围；S4 只把 practice 内的判分文件并入同一目录。`runtime.ts` 拆成 grading 侧与 settlement 侧 | grading | ~100 | #2303 合并；迁移线 kernel 端口票先落（否则 kernel 会 value import capability）；与迁移线约定 §3.1 第 1、2 条的过渡形态 | DBOS judge 身份与旧 pg-boss 义务排空（ADR-0066）；evaluation-group 锁顺序（激活：learning-state G → group advisory → FOR UPDATE）；提交幂等；pending 对账；付费重试不重复付费 | 架构线（Tier A），迁移线审结算接缝 |
| **R1 结算与撤回重放** | §3.1 清单 | settlement | 由迁移线定 | S4 或与 S4 同步 | 撤回闭包、重放、快照括号、FSRS 写入只经单一机制（§6.4） | 迁移线 YUK-1665 |
| **R2 供题落位** | §3.2 清单与落位接口要求 1–6 | supply | 由功能线定 | 无 | ADR-0069 唯一入库闸；ADR-0052 verify handoff；定位预算/付费授权 | 功能线 YUK-1468/1664 |
| **S5 题库与准入** | question-bank 映射约 100 个文件（目录、编辑、检索工具、准入框架、verify outbox、难度标定、干预作者），加上功能线移交的准入 job（若按 §3.2 第 6 条落到这里） | question-bank | ~105 | R2 完成落位接口 1–4 | verify intent 与草稿同事务、`FOR UPDATE SKIP LOCKED`、孤儿恢复（ADR-0052）；定位供题锁的顺序；准入 generation CAS；`item_calibration` 单写者；`question` 收敛到单写者 | 架构线（Tier A） |
| **S6 定位** | placement 映射 16 个文件；暂留核心的选题原语迁入 scheduling 的 public，`activity-tier` 下沉 kernel | placement（scheduling 少量） | ~22 | R2 落位接口 5；R1 或 S4 完成发卷容器端口 | `learning_session(type=placement)`；探针运行时开关；持有释放；画像读取 | 架构线 |
| **S7 收口** | 根目录剩下的就是 face：`queue-runtime` / `task-runtime` 消解为各 owner 直接用平台 `boss` / `ai`；`tasks/parse-output`、`generation-prompt-support` 下沉 kernel；`ui/blocks/custom-sandbox` 与 `envelope` 下沉 kernel 契约；更新 AGENTS.md 与 CONTEXT.md；清空台账 | face | ~25 | S1–S6、R1、R2 | 无数据面风险；迁移 bundle 外部化检查 | 架构线 |

**可并行：**
- S1、S2、S3 在 S0 之后同时开，3 个 lane，写集互不相交。
- S4 与 R2 可以并行。
- S5、S6 在 R2 之后并行。
- 全程同时开的 lane 不超过 4 条，在票面 ≤8 的上限之内。

### 5.3 UI 的处理（只迁归属，不改视觉交互）

- 旧练习 UI（`ui/*`：PracticeFacePage、PfStream、PfPaper、PfShelf、PfRetro、solo、blocks、library、worksheet）在 S0–S6 期间原地不动，归属记在 face。
- 原因有两个：这些组件同属一个页面，共用 `practice-api` / `practice-client`，互相 import；UI 线是唯一 UI 写者，#2303 之后计划退役旧路由。
- 页面 loader（`loadQuestionLibraryPage`、`loadWorksheetPrintPage` 等）继续从根 `ui-public.ts` 导出。外部的 `web/router.tsx` 与 `server/start/*` 不变。
- 如果旧 UI 在 S5 之后仍然保留，由 UI 线做一次纯归属迁移：
  - `ui/library/*` 归 question-bank；
  - `ui/worksheet/*`、`PfPaper`、`PfShelf` 归 session；
  - `PfStream`、`PfRetro` 归 scheduling；
  - `practice-api` 按 owner 拆成客户端模块。
  这次迁移不改任何视觉或交互。
- 新 UI（`src/ui-next/*`）只经根 `ui-public.ts` 按名字转出的入口消费，不受影响。

## 6. 取舍与待协调线裁定

1. **子 owner 目录（LIGHT，推荐）还是独立 capability（FULL）。**
   - 按 §0 的 DAG，FULL 会新增以下跨能力 value 依赖：scheduling 指向 session、failure-learning、grading、practice；session 指向 grading、question-bank、practice；failure-learning 指向 grading；supply 指向 question-bank、grading、scheduling。按导入文件计，仅下行依赖就约 47 个：供题→题库 15、session→判分 6、题库→判分 5、供题→判分/排程各 3、排程→session 3、定位→供题 3 等（证据 §8，`owners.py`）。另有约 24 个上行导入文件，无论哪种形态都必须消除。
   - 这些新增依赖与 YUK-1677 目标 3（跨能力 value 依赖 ≤2）以及现行只减 ratchet 直接冲突。
   - LIGHT 的代价是在现有审计上新增子 owner 规则。它的 live consumer 就是本次拆分本身。
   - 子 owner 的下行依赖全部收敛为 kernel 端口之后，可以单独升级为 capability，目录结构不变。
2. **准入执行 job 的归属**（§3.2 第 6 条）：建议归 question-bank，最终由功能线决定。
3. **`question-scheduling-enrollment`（题目发布时登记排程）归 question-bank。** 它是发布的副作用，写在发布同一事务内。若改成 scheduling 订阅发布事件，就会从同事务变成异步，时序会变化，本设计不做这个改动。
4. **`material_fsrs_state` 的写入：机制只有一个，调用点分属各 owner，scheduling 只读。**
   - ADR-0037 的「单写者」指写入机制：产品写入都经 `src/server/fsrs/state.ts` 的 `upsertFsrsState`、`enrollFsrsStateIfAbsent`、`retireQuestionFsrsState`、`retireFsrsStateOnMerge`，并在全局 learning-state G 锁之后取行锁。迁移线 YUK-1683 之后，这个机制会改到 `kernel/records/scheduling-state`。 例外是两处非经机制的原始写：`revert/restore-snapshot.ts:82` 的 `tx.delete`（撤回快照恢复，YUK-1665）与 `corpus.ts:815` 的 `db.insert`（种子数据，非产品路径）；搬迁时随各自 owner 处理，不新增此类写点。
   - 在 `1bea01753` 上，产品写入调用点及其归属如下：
     - settlement：`src/server/assessment/settle-apply.ts:190` `upsertFsrsState`。这是作答结算的复习效果。
     - question-bank：`server/question-scheduling-enrollment.ts:65` `upsertFsrsState`、`:82` `enrollFsrsStateIfAbsent`。这是发布时登记排程，与发布同事务（§6.3）。
     - grading：`server/intervention-diagnostics.ts:27` `enrollFsrsStateIfAbsent`、`:34` `retireQuestionFsrsState`。这是诊断题的登记与退役，作为 leaves 装入 kernel 的干预诊断物化。
     - practice 之外：knowledge `server/proposals.ts:748` `retireFsrsStateOnMerge`（知识合并，属于 YUK-1665 知识变更）；`src/server/revert/restore-snapshot.ts:82,90`（撤回还原快照，属于 YUK-1665）。
     - 非产品：`src/server/rehearsal/corpus.ts:815`、`scripts/seed-synthetic.ts:497`。
   - scheduling 没有写入调用点。
   - 搬迁只移动调用点所在的文件，不改变写入机制，也不改锁顺序。`src/server/fsrs` 纯算法的下沉由迁移线另票处理（§3.1）。
5. **本设计不覆盖的项：**
   - `src/server/orchestration`、`kernel/nightly-eligibility` 属平台层；
   - `src/server/*` 其余业务模块的归位属于 YUK-1677 的工作面 1；
   - 知识变更操作属于 YUK-1665。`proposal-appliers.ts` 中的知识变更协议段由迁移线处理；S1 只改该文件里与 cause-overlay 相关的那一个 import。
