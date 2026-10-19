# Advisory locks — 静态登记（排序待核）

> **已知不准确（2026-10-20，以下四处尚未修正）**
>
> 1. **遗漏反向 intervention 边**：native diagnostic review 存在
>    `corrections:all → intervention-instance`，与 activate 的顺序相反；两条路径
>    当前先取 G。下文“未见反向序”不准确，不能据此判断无环。
> 2. **appeal 混族及缺边**：native appeal、resolution 的 `hashtext` 键与历史
>    rejudge 的 `hashtextextended` 键被混在同一族；还漏记成功激活回调中的
>    `group → resolution` 顺序。
> 3. **durable 跨事务假边**：installer 的 `fence-install → family-control` 和
>    runtime 的 `control-row → tick` 属于不同事务，不能拼成同一持锁区间的
>    `family-control → per-tick` 边。
> 4. **单参锁空间表述错误**：单参数 `hashtext` / 整数字面量与
>    `hashtextextended` 都进入 bigint 锁空间；只有双整数参数是另一空间。
>    下文将单参 int4/int8 分为两个空间的表述不准确。
>
> 原票与后续修正：[YUK-1577](https://linear.app/yukoval-studios/issue/YUK-1577#comment-cb554f32-4d12-477b-8087-cbb8ab8e1a6b)。
> 锁线下一片先修这四处，再扩展登记。本文件当前只是**登记**，不是完整排序证明；
> 不得据下文未修正的图或键空间说明迁移锁顺序。新增声明不表示四处已修复。

> 锁登记文档（YUK-1577）。本文件是**静态盘点**：全仓生产代码 `pg_advisory*` /
> `pg_try_advisory*` / `pg_advisory_unlock` 文本站点的归并清单，以及待核对的
> 排序登记。它不注册、不校验、不改任何锁行为——生产代码 diff 为 0。
>
> 证据（仓库外，随 head 固化）：
> `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1577/fc619732/`
> —— `raw-lock-sites.txt`（148 行原始匹配）、`site-classification.txt`
> （exec/comment 分类）、`family-table.md`（79 行族表）、`edge-evidence.md`
> （逐边调用链）、`registry-snapshot.ts`（被撤下的机器清单稿）。

## 1. 覆盖口径（不冒称全覆盖）

文本扫描 `pg_advisory_xact_lock|pg_try_advisory_lock|pg_try_advisory_xact_lock|
pg_advisory_unlock|pg_advisory_lock`（`-g '*.ts'`，排除 `*.test.ts`/`*.spec.ts`/`tests/`）：

| 类别 | 站点数 |
|---|---|
| `pg_advisory_xact_lock` 直接语句 | 120 |
| `pg_try_advisory_xact_lock` | 1（provider-session-admission.ts:458） |
| `pg_try_advisory_lock`（session 级） | 5（helper×2、model_slice、migration-apply、rehearsal fence） |
| `pg_advisory_unlock` | 4（helper×2、model_slice、migration-apply） |
| 注释/文档引用（非语句） | 18 |
| **合计** | **148** |

在此之上另有 **helper 转调获取点**（同一 SQL 经函数发出，不计入上表）：
`acquireSortedAdvisoryLocks` 11 个调用文件、`acquireLearningStateWriteLock` /
`withLearningStateLock` ~24 个调用文件、`withinSessionAdvisoryLock` 2 个调用文件、
`acquireProposalDecisionLock` / `lockPaidEffectControlFamily` / `lockEntityGate` /
`lockProducerFenceInstaller` / `acquireControlPlaneLockSql` 各若干。
归并后得到 **79 个 family**（§3 表）——分母是"本次扫描归并出的 distinct key
模板/命名空间数"，不承诺覆盖运行时动态 key 的全部实例域（见 §5 unknown）。

编码面：`hashtext(key)`(int4)、`hashtext(ns),hashtext(key)`(int4 pair)、
`hashtextextended(key,salt)`(int8；salt ∈ {0,1,1393})、int 字面量
（`597_001`、`406_440_3`）、int pair 字面量（`(1356,1)`、`(1356,2)`、`(1393,1)`、
`(1355,1)`）。所有单参 `hashtext` 共享一个 int4 keyspace，所有 `hte(·,0)` 共享一个
int8 keyspace——族间仅靠字符串相等面防碰撞，有限哈希碰撞**无法**由任何清单消除。

## 2. Lock helpers

| Helper | 位置 | 语义 |
|---|---|---|
| `acquireLearningStateWriteLock` / `withLearningStateLock` | `src/db/learning-state-lock.ts` | G=`hashtext('learning-state:write')` xact；Db 开真 tx、Tx 内联；tx 内可重入 |
| `acquireSortedAdvisoryLocks` | `src/server/advisory-locks.ts` | `hashtext(<ns>:<id>)` sorted，consistent-ordering 原语 |
| `withinSessionAdvisoryLock` | `src/db/session-advisory-lock.ts` | reserved conn `pg_try_advisory_lock`+retry 至 deadline；`begin`/`savepoint` 补丁到持锁连接，inner tx 全部跑在同一 backend；finally unlock+release |
| `acquireProposalDecisionLock` | `src/server/proposals/applier-helpers.ts` | `proposal_decision:<id>` hte0 |
| `lockPaidEffectControlFamily` / `lockEntityGate` | `src/db/paid-effect-control.ts` / `paid-effect-store.ts` | paid-effect family/entity 锁（只读盘点） |
| `lockProducerFenceInstaller` 等 | `src/server/durable/*` | durable family install/control/tick |
| `withinComposePaidWorkLock` | `practice/server/compose-paid-work-lock.ts` | `stream:compose-paid:<date>` session |
| `acquireControlPlaneLockSql` | `server/subjects/control-plane-lock.ts` | int 597001 |

## 3. 族表（79）

`sites` = 直接语句站点计数（含 helper 内语句与 trigger）。`after` = §4 顺序登记（包含顶部列出的未修正项）。

<!-- 生成自 registry-snapshot.ts；改后请同步外部 artifact -->

| # | family | key template | encoding | scope | acquire | sites | after |
|---|---|---|---|---|---|---|---|
| 1 | learning-state:write | learning-state:write | hashtext | transaction | xact | 1 |  |
| 2 | fsrs-subject | fsrs:<kind>:<id> | hashtext | transaction | xact | 5 | learning-state:write, assessment-evaluation-group |
| 3 | mastery-ability-global | mastery:ability_global:<domain> | hashtext | transaction | xact | 2 | fsrs-subject, learning-state:write |
| 4 | kc-typed | kc_typed:<subject_kind>:<id> | hashtext | transaction | xact | 3 |  |
| 5 | axis-state | axis_state:<subject_kind>:<id> | hashtext | transaction | xact | 2 |  |
| 6 | knowledge-edge | knowledge_edge:<id> | hashtext | transaction | xact | 3 | learning-state:write |
| 7 | knowledge-create | knowledge:create:<id> | hashtext | transaction | xact | 1 |  |
| 8 | assessment-evaluation-group | ('assessment-evaluation-group', <evaluation_group_id>) | hashtext-pair | session+transaction | xact | 10 | learning-state:write, assessment-appeal-claim, assessment-review-answer |
| 9 | assessment-attempt-claim | evt_assessment_<submission_id> | hashtext | transaction | xact | 4 | learning-state:write, paper-native-issuance |
| 10 | assessment-appeal-claim | evt_native_appeal_<hash> \| evt_native_resolution_<hash> \| hte(<appeal.id>, 0) | hashtext | transaction | xact | 3 |  |
| 11 | assessment-review-answer | review-answer:<evaluation_group_id>:<idempotency_key> | hashtextextended:0 | transaction | xact | 1 |  |
| 12 | question-request-claim | <request_id> | hashtext | transaction | xact | 3 |  |
| 13 | paper-native-issuance | paper-native:<issuance_id> | hashtext | transaction | xact | 1 |  |
| 14 | paper-review-session | paper-review-session:<paperId> | hashtextextended:0 | transaction | xact | 1 |  |
| 15 | proposal-decision | proposal_decision:<proposalId> | hashtextextended:0 | transaction | xact | 3 | write-quiz, conjecture-fold |
| 16 | proposal-signal | <kind>:<cooldown_key> | hashtextextended:0 | transaction | xact | 1 |  |
| 17 | write-quiz | write_quiz:<taskRunId> | hashtextextended:0 | transaction | xact | 1 |  |
| 18 | misconception | misc:<misconceptionId> | hashtext | transaction | xact | 2 |  |
| 19 | intervention-instance | intervention:<interventionId>:<version> | hashtextextended:0 | transaction | xact | 4 | learning-state:write |
| 20 | intervention-corrections-all | intervention:corrections:all | hashtextextended:0 | transaction | xact | 5 | intervention-instance |
| 21 | intervention-source | intervention:source:<sourceEventId> | hashtextextended:0 | transaction | xact | 5 | intervention-corrections-all |
| 22 | intervention-deliver | intervention:deliver:<questionId> | hashtext | transaction | xact | 1 |  |
| 23 | stream-compose | stream:compose:<date> | hashtext | transaction | xact | 3 | intervention-deliver |
| 24 | stream-session-partition | stream:session:<sessionId> | hashtext | transaction | xact | 2 | stream-scope |
| 25 | stream-scope | stream:scope:<date>:<knowledgeId> | hashtext | transaction | xact | 1 |  |
| 26 | stream-compose-paid | stream:compose-paid:<date> | hashtext | session | session-try-until-deadline | 2 |  |
| 27 | producer-fence-install | pgboss:producer-fence:install:v1 | hashtextextended:0 | transaction | xact | 5 |  |
| 28 | judge-family-control | (1356, 1) | int-pair-literal | transaction | xact | 1 | producer-fence-install |
| 29 | judge-family-reconcile | (1356, 2) | int-pair-literal | transaction | xact | 1 |  |
| 30 | judge-obligation-claim | <obligation.task_id> | hashtext | transaction | xact | 1 |  |
| 31 | judge-run-claim | <runId> | hashtext | transaction | xact | 2 |  |
| 32 | judge-recorded-claim | <claimId> | hashtext | transaction | xact | 1 |  |
| 33 | prune-family-control | (1355, 1) | int-pair-literal | transaction | xact | 1 | producer-fence-install |
| 34 | review-orphan-control | (1393, 1) | int-pair-literal | transaction | xact | 1 | producer-fence-install |
| 35 | review-orphan-tick | hte(<tickId>, 1393) | hashtextextended:1393 | transaction | xact | 3 |  |
| 36 | session-orphan-install | session-orphan:v1:install | hashtextextended:0 | transaction | xact | 1 | producer-fence-install |
| 37 | session-orphan-tick | session-orphan:v1:<family>:<tickId> | hashtextextended:0 | transaction | xact | 1 |  |
| 38 | paid-effect-control | paid-effect:control:v1:<family> | hashtextextended:0 | transaction | xact | 2 |  |
| 39 | paid-effect-gate | paid-effect:gate:v1:<family>:<entityId> | hashtextextended:0 | transaction | xact | 1 | paid-effect-control |
| 40 | provider-attempt-operation-kind | provider-attempt-operation-kind:<operationId>:<provider>:<lane>:<operationKind> | hashtextextended:0 | transaction | xact | 1 |  |
| 41 | provider-attempt | provider-attempt:<attemptId> | hashtextextended:0 | transaction | xact | 5 | provider-attempt-operation-kind |
| 42 | provider-attempt-lane | provider-attempt-lane:<lane> | hashtextextended:0 | transaction | xact | 2 | provider-attempt |
| 43 | provider-session-admission | provider-session-admission:<laneId> | hashtextextended:0 | transaction | xact-try | 1 |  |
| 44 | ingestion-ask | ingestion-ask:<sessionId>:<item_id> \| ingestion-ask:<askId> | hashtext | transaction | xact | 2 |  |
| 45 | ingestion-agent-run | ingestion-agent-run:<sessionId> | hashtext | transaction | xact | 1 |  |
| 46 | ingestion-operation | ingestion-operation:<sessionId>:<idempotency_key> | hashtext | transaction | xact | 1 |  |
| 47 | ingestion-operation-dispatch | ('ingestion-operation-dispatch', <operationId>) | hashtext-pair | transaction | xact | 1 |  |
| 48 | ingestion-import-settlement | ('ingestion-import-settlement', <operationId>) | hashtext-pair | transaction | xact | 1 |  |
| 49 | ingestion-paper | ingestion_paper:<sessionId> | hashtextextended:0 | transaction | xact | 1 |  |
| 50 | image-candidate-accept | image_candidate_accept:<proposalId> | hashtextextended:0 | transaction | xact | 2 |  |
| 51 | image-asset-storage | <storageKey> | hashtextextended:0 | transaction | xact | 1 |  |
| 52 | ingest-source-dedup | ingest-source:<source> | hashtext | transaction | xact | 1 |  |
| 53 | note-refine-trigger | note_refine:<kind>:<artifactId> | hashtext | transaction | xact | 1 |  |
| 54 | note-refine-effect | note_refine:effect:<attemptEventId>:<artifactId>:mastery_change | hashtext | transaction | xact | 1 |  |
| 55 | note-refine-product | note_refine:product:<artifactId>:mastery_change | hashtext | transaction | xact | 1 | note-refine-effect |
| 56 | note-handoff-complete | notes:handoff-complete:<completionId> | hashtextextended:0 | transaction | xact | 1 |  |
| 57 | artifact-presence | hte(<artifactId>, 0) | hashtextextended:0 | transaction | xact | 3 |  |
| 58 | copilot-chat-idempotency | copilot-chat:<idempotencyKey> | hashtextextended:0 | transaction | xact | 1 |  |
| 59 | copilot-session-queue | ('copilot-session-queue', <sessionId>) | hashtext-pair | transaction | xact | 1 |  |
| 60 | copilot-run-dispatch | ('copilot-run-dispatch', <runId>) | hashtext-pair | transaction | xact | 1 |  |
| 61 | copilot-execution-settlement | ('copilot-execution-settlement', <runId>) | hashtext-pair | transaction | xact | 1 |  |
| 62 | copilot-revert | copilot_revert:<checkpointEventId> | hashtextextended:0 | transaction | xact | 1 |  |
| 63 | copilot-session-selection | copilot:session-selection | hashtext | transaction | xact | 1 |  |
| 64 | research-meeting-execution | research_meeting_execution:<executionId> | hashtextextended:0 | transaction | xact | 1 |  |
| 65 | probe-serve-cap | 4064403 | int-literal | transaction | xact | 2 |  |
| 66 | probe-question | hte(<probeQuestionId>, 0) | hashtextextended:0 | transaction | xact | 3 |  |
| 67 | conjecture-fold | hte(<conjectureEventId>, 1) | hashtextextended:1 | transaction | xact | 1 | probe-question |
| 68 | probe-result-claim | hte(<probeResultEventId>, 0) | hashtextextended:0 | transaction | xact | 1 |  |
| 69 | family-calibration | family_calibration:<familyKey> | hashtext | transaction | xact | 1 |  |
| 70 | contract-epoch-transition | contract-epoch:transition | hashtext | transaction | xact | 1 |  |
| 71 | subject-control-plane | 597001 | int-literal | transaction | xact | 1 |  |
| 72 | serving-command | yuk1514:serving:<eventId> | hashtextextended:0 | transaction | xact | 1 |  |
| 73 | placement-supply | placement-supply:v1:<knowledgeId> | hashtextextended:0 | transaction | xact | 3 |  |
| 74 | memory-ingest | memory:ingest:<sourceId> | hashtextextended:0 | transaction | xact | 3 |  |
| 75 | memory-dispatch | memory:dispatch:<sourceEventId> | hashtextextended:0 | transaction | xact | 2 |  |
| 76 | memory-operator-request | memory:operator-request:<requestId> | hashtextextended:0 | transaction | xact | 1 |  |
| 77 | model-slice-admission | model-slice-admission:<sliceId> | hashtext | session | session-try | 1 |  |
| 78 | migration-apply-fence | yuk1050:migration-apply | hashtext | session | session-try | 2 |  |
| 79 | yuk1406-repair-operation | yuk1406_select_display_label_repair | hashtextextended:0 | transaction | xact | 1 |  |

## 4. 顺序登记（已知不准确见顶部）

完整逐边调用链以 R1 修正版为准（旧件保留，不覆盖）：
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1577/2ecfde0840ad3dbf3c60eac6763c604d34aea99e/r1-correction/edge-evidence.md`
SHA-256：`98bf4f84be2da50d66d4ea7598df8f12b1aac9847c09fefdd78e1b05cfa6b751`。修正版核对源码 revision
`2ecfde0840ad3dbf3c60eac6763c604d34aea99e`，仅纠正 E3x；以下为摘要。**`after` 图无环只说明
登记的这组边本身无环，不等于"0 reachable cycles"**——经动态 dispatch、跨文件闭包
与未知运行时路径的边未全证，§5 逐一标注。

- **learning spine**：`G → fsrs:<kind>:<id>(sorted) → mastery:ability_global(sorted)`；
  merge accept：`event row FOR UPDATE → G → knowledge rows → knowledge_edge(sorted) →
  retire 命名空间`（dyn：applyX 内 retire 顺序按 mutation 分支分发）。
- **assessment group spine**：`G → group(xact pair) → evaluation/submission/
  effective_head/group-root 行锁 → fsrs:* → ability_global`（activate.ts:225-235 起；
  group 锁另有 submit/appeal/review-answer/withdraw/trigger 路径，均未见 group→G 或
  group→fsrs 的反向语句序）。
- **intervention**：`G → intervention:<id>:<ver> → corrections:all → source:<eventId>`。
- **stream**：`session(compose-paid) → xact(compose)`（同一 backend 多 tx，session
  锁跨 model span）；`scope → session-partition`；`deliver → compose`（5s lock_timeout）。
- **durable**：`fence-install → family-control(int 对) → per-tick`。
- **paid-effect**：`control → identity row → gate → control row`（pinned，文件注释）。
- **provider**：`op-kind → sorted attempt → lane`。
- 小边：probe-question → conjecture-fold → proposal_decision；write_quiz →
  proposal_decision(sorted)；note_refine effect → product；paper-native →
  attempt-claim；G → attempt-claim（capture 路径）；appeal-claim → group；
  review-answer → group；serving → admission 行锁；control-for-share →
  session/review-orphan tick。

## 5. 已知边界与未决（不冒称证明）

1. **session(group) 与 xact(group) 同键跨模式**：`evaluate-submission.ts`
   的 session wrapper (:783–790) 包裹 `run`；load tx :407 首先获取 group :411，
   model 执行后 seal tx :684 插入候选/读取冲突回放，不获取 G。G :820 属于独立的
   `activateSubmissionCandidate` 事务 :818，不在 `run` 回调内。因此撤回旧版
   “A 持 session(group) 再等 G，B 持 G 再等 group”的候选环；A→G 前提为假。
   `activate.ts:226→235` 的 G→group 顺序保留。跨 backend 同组等待仍覆盖
   model span；其他行锁介导形态未知，不能据此证明无死锁。**无 DB 运行证据**。

2. **匿名 int4 claim 族**（`evt_assessment_*`、`evt_native_*`、`<requestId>`、
   `<runId>`、`<claimId>`、`<task_id>`）：值域格式静态不全证；`<requestId>` 三处
   是否同源、`<runId>` 两处是否同域均 unknown。共享 keyspace 的异族碰撞无实例
   证据，也无法由清单排除。
3. **hte(·,0) 大共享面**：裸 id（probeQuestionId/probeResultEventId/storageKey/
   artifactId）与带前缀模板同居 int8 空间；实例域 unknown。
4. **反向序**：`fsrs:* → group`、`corrections:all → intervention-instance` 均未见
   语句序站点；动态分发路径未逐条展开 → 记 no-observed-counterexample，不记
   impossible。
5. **动态 key 实例域**：`ingestion-operation:<session>:<key>`、
   `<kind>:<cooldownKey>`、scope 变量等模板已证、实例域 unknown。

## 6. session-helper 连接纪律（`withinSessionAdvisoryLock`）

- try-with-deadline on reserved conn；失败先 release 池槽再 ≤25ms backoff；
  mid-try 超时等 query settle→unlock→release；
- `begin`/`savepoint` 补丁到持锁连接 → `work` 的 inner tx 全部在同一 backend；
- `busy()` 由调用方给（compose=503、evaluate=`evaluation_busy`）；
  超时路径 unlock 失败仅 log，正常路径 unlock 失败在 work settle 后传播。
