# Advisory locks — 静态登记（排序待核）

> **修正状态（2026-10-20，四项已修）**
>
> 上一版登记的四项事实错误已按源码 revision
> `4419f4fbb8c93cc5c6b42f08c2e44502a3788a34` 逐站点修正：
>
> 1. **intervention 反向边**：`corrections:all → intervention-instance` 已证
>    存在（store.ts:557→597），原“未见反向”撤回；登记边集含
>    `instance ⇄ corrections:all` 2-环，双方向路径全程持 G 共同串行化，
>    已核站点内不可达 runtime 死锁——见 §4/E4。
> 2. **appeal 拆族及补边**：native appeal、resolution 的 `hashtext` 键与历史
>    rejudge 的 `hashtextextended` 键拆为 #10/#80/#81 三族；补登
>    `request → group` 与激活回调内 `group → resolution`——见 §3/E9。
> 3. **durable 跨事务假边**：`family-control(int 对) → per-tick` 同段拼接
>    撤回；install tx（`fence → 族控制锁`）与 runtime tx（control 行锁 →
>    tick）分别登记——见 §4/E6。
> 4. **锁空间表述**：单参 `hashtext`（int4 符号扩展）、`hashtextextended`
>    （int8）与 int 字面量同处**一个** bigint 锁空间；双参
>    `(integer,integer)` 是另一锁空间——见 §1/§5。
>
> 修正证据（仓库外）：
> `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1577/4419f4fbb8c93cc5c6b42f08c2e44502a3788a34/four-facts-correction/`
> （`family-table.md` 81 族、`edge-evidence.md` 逐边修正、`README.md`
> 修正清单与 SHA）。其后 R1 复核（
> `…/ecf0bf0269d263442a546310c32ed6cb04c44233/review-r1-glm.md`）命中一处
> 新登记失实——session-orphan retirement 路径的 `session_orphan_control`
> 行锁实为 FOR UPDATE（`lockControl` :121-125）而非 FOR SHARE；修正 overlay
> 见 `…/ecf0bf0269d263442a546310c32ed6cb04c44233/r1-correction/`，当前
> `edge-evidence` 以该 overlay 为准（§4 指针）。封存旧件 `fc619732/` 与
> `…/2ecfde0840ad3dbf3c60eac6763c604d34aea99e/r1-correction/` 含已修错误，
> 保留为历史反例，不覆盖。
>
> **限度不变**：本文件仍是**登记**而非完整排序证明——行锁全图、动态
> dispatch 路径、跨 backend 等待与动态 key 实例域未证（§5），不得据本
> 图迁移锁顺序或宣称无死锁。原票：
> [YUK-1577](https://linear.app/yukoval-studios/issue/YUK-1577#comment-cb554f32-4d12-477b-8087-cbb8ab8e1a6b)。

> 锁登记文档（YUK-1577）。本文件是**静态盘点**：全仓生产代码 `pg_advisory*` /
> `pg_try_advisory*` / `pg_advisory_unlock` 文本站点的归并清单，以及待核对的
> 排序登记。它不注册、不校验、不改任何锁行为——生产代码 diff 为 0。
>
> 原始证据（仓库外，随 head 固化，含已修错误）：
> `/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1577/fc619732/`
> —— `raw-lock-sites.txt`（148 行原始匹配）、`site-classification.txt`
> （exec/comment 分类）、`family-table.md`（旧 79 行族表）、`edge-evidence.md`
> （旧逐边调用链）、`registry-snapshot.ts`（被撤下的机器清单稿）。

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
归并后得到 **81 个 family**（§3 表）——分母是"本次扫描归并出的 distinct key
模板/命名空间数"，不承诺覆盖运行时动态 key 的全部实例域（见 §5 unknown）。

编码面（键派生记号，**不是**锁空间）：`hashtext(key)`(int4 结果)、
`hashtext(ns),hashtext(key)`(int4 pair)、`hashtextextended(key,salt)`(int8；
salt ∈ {0,1,1393})、int 字面量（`597_001`、`406_440_3`）、int pair 字面量
（`(1356,1)`、`(1356,2)`、`(1393,1)`、`(1355,1)`）。

锁空间只有**两个**，由 PG 官方函数签名决定（`functions-admin.html` §9.28.10，
`pg_advisory*(key bigint)` 与 `pg_advisory*(key1 integer, key2 integer)`）：

- **bigint 单参空间**：一切单参调用。`hashtext` 的 int4 结果经 int4→bigint
  符号扩展、`hashtextextended` 的 int8、int 字面量同在此空间——单参
  `hashtext` 与 `hte` **不隔离**，跨编码异族数值相等即同锁。
- **int-pair 双参空间**：`hashtext,hashtext` 对与 int pair 字面量。两种形态
  是不同的锁标识（`pg_locks` advisory 行 objsubid 单参=1、双参=2），互不重叠。

族间仅靠字符串相等面防碰撞，有限哈希碰撞**无法**由任何清单消除。

## 2. Lock helpers

| Helper | 位置 | 语义 |
|---|---|---|
| `acquireLearningStateWriteLock` / `withLearningStateLock` | `src/db/learning-state-lock.ts` | G=`hashtext('learning-state:write')` xact；Db 开真 tx、Tx 内联；tx 内可重入 |
| `acquireSortedAdvisoryLocks` | `src/db/learning-state-lock.ts` | `hashtext(<ns>:<id>)` sorted，consistent-ordering 原语 |
| `withinSessionAdvisoryLock` | `src/db/session-advisory-lock.ts` | reserved conn `pg_try_advisory_lock`+retry 至 deadline；`begin`/`savepoint` 补丁到持锁连接，inner tx 全部跑在同一 backend；finally unlock+release |
| `acquireProposalDecisionLock` | `src/server/proposals/applier-helpers.ts` | `proposal_decision:<id>` hte0 |
| `withProposalGateLock` | `src/kernel/proposals/signals.ts` | `<kind>:<cooldown_key>` 多键 sorted xact gate；Db 开真 tx、Tx 内联 |
| `lockPaidEffectControlFamily` / `lockEntityGate` | `src/db/paid-effect-control.ts` / `paid-effect-store.ts` | paid-effect family/entity 锁（只读盘点） |
| `lockProducerFenceInstaller` 等 | `src/server/durable/*` | durable family install/control/tick |
| `withinComposePaidWorkLock` | `practice/server/compose-paid-work-lock.ts` | `stream:compose-paid:<date>` session |
| `acquireControlPlaneLockSql` | `server/subjects/control-plane-lock.ts` | int 597001 |

## 3. 族表（81）

`sites` = 直接语句站点计数（含 helper 内语句与 trigger）。`after` = §4 顺序登记
——已证同一 critical section 内的 advisory 前驱族；行锁前驱不在此列（§4/E6）。
`after` 为空不表示无锁序约束，只表示未观察到 advisory 前驱。

<!-- 机读版见外部 artifact four-facts-correction/family-table.md；改后请同步 -->

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
| 10 | assessment-appeal-claim | evt_native_appeal_<hash> | hashtext | transaction | xact | 1 |  |
| 11 | assessment-review-answer | review-answer:<evaluation_group_id>:<idempotency_key> | hashtextextended:0 | transaction | xact | 1 |  |
| 12 | question-request-claim | <request_id> | hashtext | transaction | xact | 3 |  |
| 13 | paper-native-issuance | paper-native:<issuance_id> | hashtext | transaction | xact | 1 |  |
| 14 | paper-review-session | paper-review-session:<paperId> | hashtextextended:0 | transaction | xact | 1 |  |
| 15 | proposal-decision | proposal_decision:<proposalId> | hashtextextended:0 | transaction | xact | 3 | write-quiz, conjecture-fold |
| 16 | proposal-signal | <kind>:<cooldown_key> | hashtextextended:0 | transaction | xact | 2 |  |
| 17 | write-quiz | write_quiz:<taskRunId> | hashtextextended:0 | transaction | xact | 1 |  |
| 18 | misconception | misc:<misconceptionId> | hashtext | transaction | xact | 2 |  |
| 19 | intervention-instance | intervention:<interventionId>:<version> | hashtextextended:0 | transaction | xact | 4 | learning-state:write, intervention-corrections-all |
| 20 | intervention-corrections-all | intervention:corrections:all | hashtextextended:0 | transaction | xact | 5 | intervention-instance, learning-state:write |
| 21 | intervention-source | intervention:source:<sourceEventId> | hashtextextended:0 | transaction | xact | 5 | intervention-corrections-all, copilot-execution-settlement |
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
| 80 | assessment-resolution-claim | evt_native_resolution_<hash> | hashtext | transaction | xact | 1 | assessment-evaluation-group |
| 81 | appeal-rejudge-legacy-claim | hte(<appeal.id>, 0) | hashtextextended:0 | transaction | xact | 1 |  |

#10/#80/#81 由旧版混族行 `assessment-appeal-claim`（sites 3）拆出：request
（appeal.ts:24）、resolution（appeal.ts:78）、历史 rejudge（rejudge.ts:45）
是三个不同 key 模板/锁值，同族合并会遮蔽 `request→group`、`group→resolution`
已证边（§4/E9）。

## 4. 顺序登记（已修四项；限度见 §5）

完整逐边调用链以最新修正版为准（旧件保留，不覆盖）：
`/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/architecture-deepening/YUK-1577/ecf0bf0269d263442a546310c32ed6cb04c44233/r1-correction/edge-evidence.md`
SHA-256：`73849eea044365d81785e736e3ec5c4a553236ae65dd4fc0fd904c21f02ae630`
——该版 = four-facts 版
`…/4419f4fbb8c93cc5c6b42f08c2e44502a3788a34/four-facts-correction/edge-evidence.md`
（SHA-256 `020f9ed77111856f0823612be79b2f32224d69345314d77d3fe28b84a8e05e52`）
加 R1 P1 修正：E6/E9 的 `session_orphan_control` 行锁按 helper 分列
FOR SHARE（consume 四站）/ FOR UPDATE（retirement 一站）。核对源码 revision
`4419f4fbb8c93cc5c6b42f08c2e44502a3788a34`（所引站点文件与首轮 R1 核对
revision `2ecfde0840ad3dbf3c60eac6763c604d34aea99e` 逐字节一致；其
edge-evidence 版 SHA-256
`98bf4f84be2da50d66d4ea7598df8f12b1aac9847c09fefdd78e1b05cfa6b751`，其中 E4/E6/E9/
未决 1–3、5 已被本版替代，E3x 纠正保留）。以下为摘要。**`after` 边集不是无环图**：
`instance ⇄ corrections:all` 是已证 2-环（E4），在已核站点内由 G 共同串行化而
不可达 runtime 死锁；其余经动态 dispatch、跨文件闭包与未知运行时路径的边未全
证，§5 逐一标注——不得把边集当作完整排序或无环证明使用。

- **learning spine**：`G → fsrs:<kind>:<id>(sorted) → mastery:ability_global(sorted)`；
  merge accept：`event row FOR UPDATE → G → knowledge rows → knowledge_edge(sorted) →
  retire 命名空间`（dyn：applyX 内 retire 顺序按 mutation 分支分发）。
- **assessment group spine**：`G → group(xact pair) → evaluation/submission/
  effective_head/group-root 行锁 → fsrs:* → ability_global`（activate.ts:225-235 起；
  group 锁另有 submit/appeal/review-answer/withdraw/trigger 路径，均未见 group→G 或
  group→fsrs 的反向语句序）。
- **intervention**：两条已证同 tx 路径方向相反——activate
  `G → intervention:<id>:<ver> → corrections:all → source:<eventId>`
  （store.ts:350→352→372→375）；native review `G → corrections:all → instance`
  （store.ts:555→557，同 tx 调 `recordInterventionDiagnosticReview` → 内联
  `withLearningStateLock` 对已持 G 重入 :595 → instance :597）。另：
  settlement-subscription 经顶层 Db 独立 tx `G → instance`；reconcile:212 /
  probe-result-subscription:115 / writeEvents:342 三处 `corrections:all → source`
  不持 G；failInterventionPreparation:757 独取 instance（无 G）；
  review-answer-consumer:45→47 `copilot-execution-settlement → source`。
  **guard**：所有“同 tx 同取 instance 与 corrections”的已见路径全程持 G
  （单一 xact 键 `hashtext('learning-state:write')`，xact 互斥使两路径不能
  并发互等）；不持 G 的 corrections 站点均不取 instance，不持 G 的
  instance 站点不取 corrections → 已核站点内环不可达。**不宣称无 runtime
  死锁**：新增“corrections→instance 且不持 G”或反向路径即成未证形态。
- **stream**：`session(compose-paid) → xact(compose)`（同一 backend 多 tx，session
  锁跨 model span）；`scope → session-partition`；`deliver → compose`（5s lock_timeout）。
- **durable**：install 与 runtime 是**不同事务**。install tx（已证同 tx）：
  `fence-install → 族控制锁`——judge `(1356,1)`（judge-family.ts:42→43）、
  prune `(1355,1)`（prune-family.ts:33→34）、review-orphan `(1393,1)`
  （review-orphan-family.ts:336→337）、session-orphan `hte('session-orphan:v1:install',0)`
  （session-orphan-backend.ts:336→338）；install tx 内**不取**任何
  per-tick/reconcile 锁。runtime tx（另一事务，行锁→advisory）：
  `review_orphan_control FOR SHARE/UPDATE → hte(tickId,1393)`（:130/:217/:433 →
  :133/:218/:461）；`session_orphan_control` 行锁按 helper 分列——
  consume/tick 四站 `FOR SHARE → session-orphan-tick`
  （`lockSessionOrphanControl` family.ts:184-186 → :256/:356/:381/:405），
  retirement 一站 `FOR UPDATE → session-orphan-tick`（`lockControl`
  backend.ts:121-125，:199 → :226）；
  `judge_run_control FOR SHARE → (1356,2)`（judge_pending_reconcile.ts:60→61）。
  prune runtime 只持 `prune_job_events_control` 行锁，无 advisory 后继。
  advisory 族控制对与 per-tick 从未同 tx 共现；旧版
  `family-control → per-tick` 同段拼接撤回。
- **paid-effect**：`control → identity row → gate → control row`（pinned，文件注释）。
- **provider**：`op-kind → sorted attempt → lane`。
- 小边：probe-question → conjecture-fold → proposal_decision；write_quiz →
  proposal_decision(sorted)；note_refine effect → product；paper-native →
  attempt-claim；G → attempt-claim（capture 路径）；appeal-claim(request) →
  group（appeal.ts:24→41）；激活 tx 内 `group → resolution-claim`（record
  回调，settle `fsrs:*` 条件插入其间，dyn）；review-answer → group；
  serving → admission 行锁；durable 各 runtime tx `control 表行锁 →
  session/review-orphan/judge tick`（行锁介导边，非 advisory 边）。

## 5. 已知边界与未决（不冒称证明）

1. **session(group) 与 xact(group) 同键跨模式**：`evaluate-submission.ts`
   的 session wrapper (:783–790) 包裹 `run`；load tx :407 首先获取 group :411，
   model 执行后 seal tx :684 插入候选/读取冲突回放，不获取 G。G :820 属于独立的
   `activateSubmissionCandidate` 事务 :818，不在 `run` 回调内。因此撤回旧版
   “A 持 session(group) 再等 G，B 持 G 再等 group”的候选环；A→G 前提为假。
   `activate.ts:226→235` 的 G→group 顺序保留。跨 backend 同组等待仍覆盖
   model span；其他行锁介导形态未知，不能据此证明无死锁。**无 DB 运行证据**。

2. **匿名 claim 族**（`evt_assessment_*`、`evt_native_*`、`<requestId>`、
   `<runId>`、`<claimId>`、`<task_id>`、`evt_native_resolution_*`）：值域格式
   静态不全证；`<requestId>` 三处是否同源、`<runId>` 两处是否同域均 unknown。
   共享 bigint 单参锁空间的异族碰撞无实例证据，也无法由清单排除。
3. **单参 bigint 共享面**：裸 id 形（probeQuestionId/probeResultEventId/
   storageKey/artifactId/tickId-salt1393/appeal.id）与带前缀模板、
   `hashtext` int4 值、int 字面量同居**同一** bigint 锁空间——编码面不隔离，
   跨编码异族数值相等即同锁；实例域 unknown。
4. **反向序**：`fsrs:* → group`、`group → G` 未见语句序站点；动态分发路径
   未逐条展开 → 记 no-observed-counterexample，不记 impossible。
   （原“`corrections:all → intervention-instance` 未见站点”已撤回——
   store.ts:557→597 已证，见 §4/E4。）
5. **动态 key 实例域**：`ingestion-operation:<session>:<key>`、
   `<kind>:<cooldownKey>`、scope 变量等模板已证、实例域 unknown。
6. **行锁全图与跨 backend 等待**：`control` 表行锁 → tick 已按行锁介导边
   登记（§4 durable）；行锁互等全图与跨 backend session/xact 混合形态未证，
   无 DB 运行证据。

## 6. session-helper 连接纪律（`withinSessionAdvisoryLock`）

- try-with-deadline on reserved conn；失败先 release 池槽再 ≤25ms backoff；
  mid-try 超时等 query settle→unlock→release；
- `begin`/`savepoint` 补丁到持锁连接 → `work` 的 inner tx 全部在同一 backend；
- `busy()` 由调用方给（compose=503、evaluate=`evaluation_busy`）；
  超时路径 unlock 失败仅 log，正常路径 unlock 失败在 work settle 后传播。
