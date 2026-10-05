# YUK-1047 formal entry migration — implementation checkpoint

The target remains the approved eight-entry cutover in the original assessment
plan. This worktree is an unshipped checkpoint, not evidence that all entries
have migrated. No production, paid evaluation or dependency upgrade is included.
The Q20 approval recorded on 2026-09-25 applies to the existing response controls,
PfSolo/PfPaper hosts and hint drawer; no new route or drawer is introduced.

Prerequisites #1563 and #1564 merged to main 448ffe42 and 6e5d93ac respectively.
#1564 completed 94 DB / 107 scoped unit, local gates, the initial/sole-review
budget with all proven defects fixed, exact-head CI37234688601 and its 17-minute
window. The incremental CI did not run migration or browser tests.

Current implementation:

- Evaluations accept an operation key, bind its frozen input/intent digest under
  the existing group lock, and reuse the sealed candidate before another model
  invocation. Pending candidates also replay; explicit recovery uses a new key.
- Advice now requires a native immutable submission, validates question versus
  issuance scope, persists the original response, and returns a candidate without
  activating learning state. Published task identity selects native pi/Jev.
- Issuance recovery returns accepted original responses and evidence after draft
  archival, including the original idempotency key; it does not release paper
  feedback or publish scoring bases.
- Native response adapters preserve published option/item IDs, raw numeric text,
  confidence and original attachments. Upload receipts retain original digest,
  MIME, size and server timestamp where available.
- PfSolo now starts/restores a pinned issuance, renders frozen public material
  and slots, restores server drafts/accepted submissions, and sends the native
  response to advice. This host migration is not yet complete or acceptance-tested.

Completed scoped checks at this checkpoint: 19 evaluation/preview DB, 21
submission/recovery DB, 105 core/response unit cases and the 3 upload cases.
The native operation-key regression first failed before implementation. The
recovery test had a fixture variable error, corrected without dropping assertions.
API client and Postman generators ran. Typecheck passed after the first host
adapter correction; final local gates and independent review are not yet done.

Remaining on this branch before any release claim:

1. Solo commit and durable dispatch/worker must consume the same persisted
   candidate and activate through contract settlement, preserving once-only
   diagnostics, capture fields, pending recovery and appeal anchors. Remove the
   current legacy judge branch only after all actual callers move.
2. Explicit manual issuance needs its actual self-report candidate/FSRS-only
   confirmation flow. Advice currently executes automatic evaluation; a manual
   host must not silently send that request. No invented unit scores.
3. Persist assistance on the server before returning hints/reveals. Remove initial
   reference downloads and mutable current-row solution fallback; keep harmless
   clarification separate and unknown help abstaining.
4. Complete paper, solve, rejudge, probe and ingestion boundaries, including serve
   before response, whole-member grouping, paper feedback release, paid claims,
   frozen rejudge input and published ingestion input before evaluation.
5. Complete UI restoration/interaction fixtures and API/DB tests. Current old
   advice/submit fixtures are not acceptance evidence for the new mandatory input.
   Add native slot layout, subset evidence targeting and pending/manual behavior;
   preserve all previous meaningful assertions during fixture migration.
6. Rewrite registry/source census only when its claimed runtime callers are
   actually migrated, then complete local gates, independent review and exact-head CI.

The baseline still reports the original eight legacy dispositions. One advice
implementation has been changed in this unshipped branch; the other consumers
and publication evidence are intentionally not marked done from a partial edit.

## 22:02 UTC local checkpoint (unshipped)

The native request branch now reaches the actual solo HTTP commit handler.
Preview returns a CAS intent and commit verifies/reuses the sealed candidate;
unknown IDs cannot dispatch a model. Direct first commit expects the empty head,
so omission of an intent cannot silently replace a later regrade. A stable
`experimental:assessment_attempt` event captures participation without a fake
right/wrong bit or FSRS snapshot. Activation and the first capture share a
transaction; duplicates preserve the first capture and learning occurrence.
Explicit self-report uses unresolved scoring and updates FSRS only.

Assistance is written before hint/reference disclosure and snapshotted in the
submission receipt under its issuance lock. Unknown help abstains, verified
harmless clarification remains independent, and later help cannot rewrite an
accepted response. Tutor sessions bind their issuance in the existing start
receipt and read frozen question/reference bytes. New publications retain
per-part reference originals as private `sol_` materials. Old revisions are not
rewritten and a missing frozen solution returns null rather than current-row
fallback. Ordinary practice detail no longer includes reference/rubric/metadata.
The solution endpoint currently rejects container and intervention diagnostics;
paper release policies remain to be connected.

Native PfSolo submits its immutable input and CAS intent, supports explicit
manual practice, preserves restored evidence targets, and keeps undecided
ratings nullable. Its real interaction tests preserve process/confidence/upload
assertions and additionally verify native slot IDs and candidate binding.

Autosave integration exposed three reproducible defects: queued saves surviving
finalization, equivalent object values repeatedly counted as edits, and an older
ACK marking a newer failed save clean. All three failed before repair; all six
hook tests then passed. Host values are memoized and draft writes wait for
server restoration. These fixes belong to the same original autosave migration.

Latest checks: 61 DB across five files; 71 unit across normalizer, public DTO,
real PfSolo interactions and autosave; typecheck and production build passed.
API client and Postman spec/collection regenerated. No paid calls/deployment.
New private materials required count assertions to include the originals; all
prior public-material and per-part isolation assertions remain, with additional
private-byte checks. No independent review or exact-head CI has begun.

Still not release-ready: old non-native submit/worker paths remain; new neutral
attempt anchors need their history/failure/probe/durable consumers and native
appeal wiring. All eight entries must migrate before removing the legacy lane
and changing the registry. Model operation-key reuse only covers sealed
candidates: the next implementation must persist a pre-call claim and result so
a crash before candidate persistence cannot silently repeat a paid execution.
This is not a claim that existing candidate caching already solves that gap.

## 22:33 UTC local checkpoint (unshipped)

Persistent model claims now commit before dispatch on a separate connection.
Their operation identity binds group, submission, evaluation attempt and unit;
the immutable input digest and reserved cap prevent changed-input reuse. A
missing result after dispatch remains held with its original reservation, even
if a retry supplies a smaller cap. Sealed results survive candidate transaction
rollback. Native pi and Jev receive the claimed task-run identity. This prevents
automatic repeat dispatch; it does not claim automatic recovery of lost results.

Native appeals identify the current effective evaluation and retain the original
submission/revision/criterion. The learner objection travels as review context,
not replacement response text. Rejudge activation and its resolution receipt
share a transaction; a stale competing appeal is held before invoking a model.
The existing historical judge-event branch still awaits final entry cutover.

The real question timeline and failure readers now include neutral native
participation anchors. Their verdict comes from the current effective head,
with original/effective evaluation references kept separate from judge-event
IDs. Pending and self-report remain visible without becoming incorrect.
Pagination filters native verdicts before applying global/per-question caps.
Failure projections carry native response/evidence and revision coordinates;
legacy snapshot-dependent downstream attribution is still held rather than
reading the current question. Those attribution/tool consumers remain to migrate.

Native solve submission is now reachable through the canonical HTTP resource.
The bound session supplies stable group/key coordinates; replay reuses the first
submission. Candidate activation, participation capture, low-score learning
record and active→submitted→judged transitions are atomic. The returned solution
is the frozen original. A forced transition failure rolls back learning and
capture, while retry reuses the candidate. The old unbound session branch is
still present and must be removed with its obsolete API fixtures.

Verification: timeline regressions first failed 2/29, failure-reader regression
first failed 1/29, then the combined five-file DB run passed 101 tests (including
31 submission/entry tests and five durable-claim tests). A further native regrade
case exercises paging past five correct attempts and removing the corrected
failure. Four unit files passed 91 tests, including native/Jev review-context and
stable-run-ID assertions and neutral timeline rendering. Production build passed; typecheck caught an assignment-field typo in scoped
auto-commit eligibility, corrected to scoring_unit_ids membership, then passed.
No independent review or exact-head CI yet.
API/Postman generated artifacts include native appeal and solve coordinates.

Remaining release blockers: migrate/remove unbound solve and historical appeal
execution, durable submit/worker, paper, probe and ingestion grading; migrate
native failure-learning/diagnostic restore/tool consumers; complete hint visual
context and evidence subset selection. Registry remains honestly legacy until
all eight actual entry sites have switched. No production or paid provider calls.

## 22:50 UTC local checkpoint (unshipped)

Removed the solve-tutor legacy evaluator and current-reference generation path.
Unbound historical sessions now report historical_unknown; new sessions require
an issued snapshot. Removed the regeneration input and obsolete generation-result
flags. Service and HTTP fixtures now use real publisher/issuance/submission
contracts; no mocked legacy judge supplies the verdict. Partial-credit mistake
thresholds remain covered with four actual independently scored question parts.

The photo-only migration test found a real core defect: whole-page evidence plus
an empty text slot was marked blank/zero, ending the session and revealing the
answer. DB regression failed 1/23; core regressions failed 3/56. The core now
considers only evidence targeting the unit before applying blank policy, forwards
photo originals to declared model units, and leaves text comparators unable to
read those originals unjudgeable. An unrelated unit still follows its published
blank policy. Terminal unresolved automatic candidates now return review_required
without activation, session completion or reference disclosure; appeals also hold
such candidates instead of replacing an earlier effective score.

The photo regression additionally exercises explicit self-report after the held
candidate: one FSRS practice, no inferred correctness, one participation anchor,
and original pending candidate retained alongside the selected manual evaluation.
Native history validates that original reference against its submission/group;
it does not confuse first activation with the first execution receipt.

Latest scoped verification: 64 DB across six solve/API/submission files; 64 unit
across core evaluation, solve contracts and real HintLadder interactions; typecheck,
changed-file Biome and production build passed. Native/Jev tests from the previous
checkpoint remain evidence for their unchanged code. No PR/review/CI/paid calls or
production changes. Next: durable submission/job/poll/outbox migration, then the
remaining paper/probe/ingestion and downstream readers before final legacy removal.

## 2026-10-04 23:11 UTC — native durable submission checkpoint

Native submit now uses the existing judge_run outbox/queue/reconcile/poll protocol
when the scoped frozen execution plan contains model work and the session gate
admits it. Stable submission-derived run/job identities collapse HTTP retries;
accepted options are immutable, while capture observations remain first-write-wins.
The original submission and neutral participation anchor precede queue dispatch.
A refused admission leaves no pending outbox; dispatch failure preserves the
accepted outbox for existing reconciliation. Flag changes do not turn an already
queued retry into another synchronous operation.

The worker validates the delivery against the accepted outbox and immutable
submission. It uses the formal recorded model port and frozen task identity, with
no implicit provider switch or second enqueue admission. A later effective manual
choice blocks obsolete work before model dispatch. Activation, learning writes
and the durable completion receipt commit together; lost terminal notifications
recover from domain records, and lost activation transactions reuse the candidate.
Unjudgeable work completes the job as review_required without creating a grade.

Queued history resolves its first genuine evaluation independently of its first
activation. Poll recovery projects the current effective evaluation and explicit
rating through the common frozen scoring basis, retaining separate original and
effective references. PfSolo holds unresolved results and exposes self-rating,
while successful native poll responses use evaluation anchors for appeals.

Verification: eight new native DB cases cover concurrent HTTP/delivery replay,
queue failure, rejected admission, completion rollback, terminal notification
failure, original/effective references, queue tampering, later self-report and a
real HTTP202→worker→poll path. The six-file regression completed 117 DB tests;
35 unit tests passed. After the current-effective poll projection change, 46 DB
(native + verdict resolver + status route) passed. Typecheck, changed-file Biome,
API/Postman regeneration passed. Final typecheck and production build also passed
after the projection adjustment. All provider outputs
are offline fixture results; no paid call or production operation occurred.

Legacy queued-job execution is still present and must be removed with the old
submit producer. Paper/probe/ingestion and diagnostic/failure-learning consumers
remain release blockers. This checkpoint is not a PR, cutover or completed ticket.

## 2026-10-04 23:38 UTC — native paper opening/submission/read checkpoint

Opening a new paper now issues every published slot in the same transaction as
its review session. The opening receipt freezes slot scope/order, feedback policy,
question display metadata and independent per-slot issuance/group/key identities.
A missing/unadmitted slot rolls the entire opening back; no mutable-row grading
fallback is invented. Reopening an abandoned paper creates a fresh occurrence in
the transition transaction; pause/resume and same-state replay keep the old one.

Native paper requests validate those exact coordinates, save original responses
before evaluation, and freeze the neutral participation/answer-sheet records.
Concurrent retries reuse the original and the formal model execution receipt.
Original changes conflict before another evaluation. A session reopened during
execution cannot activate the old occurrence. Canonical response drafts and the
answer-sheet capture save atomically, with save-epoch conflicts and submission
archival preventing stale/autosave resurrection.

Paper detail reconstructs public materials, native response slots and original
references from issued revisions. The existing PfPaper controls now send canonical
responses and complete attachment originals; options use published IDs. Each
question keeps its own evaluation group. Draft restore/save/exit/keepalive share
the native payload, and a new occurrence resets client capture/timing state.

Buffered policy is enforced in submit, paper detail, the shelf counts and generic
question history/failure reads. A native regression first demonstrated timeline
leakage (failure visible before completion); the immutable capture now includes
policy plus occurrence time, and the reader holds the verdict until that exact
occurrence completes. Completing a later reopened session cannot reveal an older
abandoned occurrence. Advice/solo cannot use a bound paper issuance to bypass the
paper disclosure boundary. Original/effective evaluation references stay distinct.

Verification: 47 DB tests across paper/native submission/durable/session reopen;
58 UI tests across native paper interaction, autosave, capture, lifecycle and
timing passed. After shelf/current-occurrence changes, the five paper DB tests
passed again, including atomic opening failure, response changes, buffered/public
reads, draft conflicts and abandoned-generation isolation. Typecheck, changed-file
Biome, API/Postman generation and production build passed; final formatting and
typecheck were repeated. No paid invocation, deployment, PR, independent review or
CI for this worktree.

The legacy paper producer/executor and its old fixtures are the immediate next
removal step. Broader paper fixture migration is still required (including model
claim/provenance, KC/family/mastery and snapshot invariants). Legacy deterministic
or historical observations must not be confused with authorization to re-execute
old scoring. Remaining release blockers still include legacy solo/durable/rejudge
execution removal, probe/ingestion cutover, diagnostic/failure-learning consumers,
full evidence target editing/media acceptance and complete frozen teaching input.

## 23:55 UTC — 旧 paper 执行删除与学习信号恢复（未发布）

- 删除 paper-submit 中旧 evaluateAttempt/invoker、当前题行评分和旧付费 TTL claim 分支。缺原始发题绑定返回 historical_unknown；不按提交时的题目补造原件。旧 fixtures 逐项迁移中，整个旧 paper suite 尚未通过。
- 原生改判后重交原响应原先409，DB先RED再修：返回当前有效成绩，原答案变更仍409，不重新激活旧candidate或重复FSRS。capture/ack增加started_at代际检查。
- 真实评分成功却遗漏 mastery_progress、笔记 subscriber 不识别 native anchor 均已先RED后修。结算观察端口在原 occurrence 的有序位置读真实Δθ，后续重放不再发信号；信号与激活同事务，optional失败隔离。笔记验证冻结坐标后消费neutral native anchor，重复投递不重复入队。
- 原生未知评分不再自动推断again；snapshot回归改为断言零FSRS/零theta/零快照且原件保留；已评分快照仍对照实际学习状态验证。
- scoped DB：68例（settlement/submission/learning/snapshot/capture）+26例（durable/telemetry/notes/paper issuance/family）通过；包括有序晚到信号不误读后续状态。typecheck、changed Biome（0 errors/8 warnings）、build通过。没有新增付费模型请求。
- 继续迁移 paper-cycle/provenance/API fixtures；旧unit_dimension数学单位加速尚未映射原生冻结规则，必须保留本地确定性能力（不能以unsupported冒充完成，也不把旧固定分数梯度变成新默认）。其他入口和下游消费范围按原计划继续。无PR/push/review/CI/部署，1047仍In Progress。

## 2026-10-05 00:05 UTC — 原生数值/单位确定性执行（未发布）

- 按已锁 grounding §4.2 保留 mathjs 数值/单位校验：新增显式 numeric_unit_conversion executor，评分依据仍为冻结 numeric_key 的 expected/unit/tolerance。旧 numeric_tolerance 字面单位语义不变；不重写历史revision。新执行器只解析原始raw_input，不信任客户端派生value，不调用模型；格式不能解析保持unparseable_response。
- normalizer在原题确有数值/单位元数据时冻结numeric槽和规则；缺显式容差按精确匹配，不发明原unit_dimension默认5%或固定1/.7/.4/.3梯度。多小题不继承父题数值键，物理part发布载入各自metadata/kind/override；改元数据生成新revision，原版保持不可变。
- 10个纯回归先RED、发布子题及缺参考单位校验各1回归先RED后修。128unit/39DB、typecheck、changedBiome、build通过；gen:api-client和gen:postman通过（无生成差异）。
- paper provenance旧测试迁移：模型失败保留独立claim/result与保守预留，不把计划run ID当实际run，也不自动重付；重复提交执行一次。真实发布→开卷→提交验证30m/s和108km/h均本地给分，编辑当前元数据不影响冻结答案。无真实付费模型调用。
- 旧paper-cycle/API fixtures、其他正式入口和消费侧仍继续迁移；本分支尚未PR/push/review/CI，1047仍In Progress。

## 2026-10-05 00:25 UTC — 试卷生命周期/API/UI fixtures 切换（未发布）

- 32个paper-cycle用例改走真实发布/发题/原始提交；并发、失败保留认领、重开新代际、改判回执、缓冲、照片原件、KC单次theta均保留承重断言。模型端口为离线录制fixture，不是实际模型质量证据。历史只读partial案例仍保留原事件读取。
- paper detail/list API改用真实原生payload、候选和effective head；草稿恢复从assessment读取。旧格式草稿写入原先200的回归先RED后修为historical_unknown409；没有原始绑定的历史试卷仅可查看，不能编辑或交卷。
- UI原有自动保存、采集、生命周期和计时测试使用带原始发题记录的transport fixture。选择/配对/排序的观察文本映射到冻结标签与正文，保留原始ResponseSet身份，不再把opaque ID当可读答案。
- 63DB（cycle32/detail10/list15/issuance6）、93unit（paper59/response/solo interaction）通过；typecheck通过，changedBiome零errors/12warnings，build通过。补三项canonical review-session Postman示例并成功生成。UI新readonly测试首轮因matcher不可用失败，修matcher后通过，不计作语义RED证据。
- 仍为未发布WIP，无PR/push/review/CI/部署或付费调用。下一步继续solo/durable/rejudge旧执行移除、probe/ingestion与下游消费者，1047保持In Progress。

## 2026-10-05 00:45 UTC — 单题 HTTP 旧分支与旧队列 producer 删除（未发布）

- 单题HTTP缺assessment的旧请求现明确409 historical_unknown；原先仍写FSRS的回归先RED后修，不在提交时补造原件。删除旧同步settle调用分支、resolveDurableDivert和enqueueDurableJudge producer；worker仍引用旧judgeSubmit，待下一步迁移后删除，整个旧执行器尚未退出。
- 队列fixture改为真实发布/发题/原件/认领。保留会话准入、显式手动不入队、队列失败/空返回不丢答案、准入退款、独立重答、原请求复用run、稳定queue ID与完成通知恢复。空send回归揭示native错误写queued：首次发送不再把空返回无条件当已存在任务；原件保留给reconcile，退款且不伪造queued。
- 迁移复核发现原生激活时读当前KC/domain导致排队后修改学习写目标：3项真实DB断言先RED。原始submission事务现封存learning_scope（组与物理part的KC/难度/类型/来源以及学科映射）；激活只取已发范围，改判复用原组锚点快照。显式空学科映射也不能回查后来归属。历史无此字段仍按原读取语义，不改写历史原件。
- 后台冻结/改判/空学科边界、原件恢复、退款等60DB通过；会话/历史晚到/原生提交/联合组73DB通过；单题快照7DB通过（合计140distinct DB）。最后公共接口收敛后native/dispatch26DB再验通过。模型全为离线recorded端口，不作实际质量验收。
- typecheck、changedBiome（零errors/12warnings）、build、Postman通过。capability边界审计最初失败后收敛既有runtime装配/准入接口，删除未注册旧sessions handler、测试改测canonical路由；baseline只收紧450→448（practice→ai65→64、mastery23→22），无新增豁免，最终审计通过。
- 无PR/push/review/CI/部署或付费调用。仍需worker/rejudge、probe/ingestion、diagnostic一次认领恢复与native订阅、其他消费者，以及余下旧solo主suite迁移；1047保持In Progress，继续推进。

## 2026-10-05 00:55 UTC — 旧 solo scorer / worker 执行删除（未发布）

- 从submit.ts删除judgeSubmit及旧供应结果/旧provenance评分执行；worker删除current-row补造、旧deferred评分、末次自动provider fallback分支。仅保留历史结算fixture所用类型，旧原件/完成回执读取不删。
- 新回归先RED证明旧队列仍会执行并写FSRS；现未完成caller=submit旧任务终态historical_unknown，已接收答案原事件保留且不调用旧评分器。原生worker仅执行已持久化输入指针/实际一致性校验；已完成历史run仍走既有回执恢复。
- worker主suite24例迁到真实native原件/录制executor/真实结算；terminal五例实际注入job_event写失败，验证提交后通知失败不写FAILED、最终投递瞬时失败有界补写、原始失败仍进入DLQ。原有旧provider自动fallback/读current补造断言按已批准退出方向替换为不重付/不补造；晚到由原生有序重放覆盖，不靠吞掉练习维持计数。
- 118distinctDB（native11/worker24/terminal5/poll+reconcile+真实boss合同43/solo原生35）及30status unit通过；typecheck、changedBiome（零errors/8warnings）、build、Postman、capability边界审计通过，baseline再收紧448→447（practice→http4→3）。
- 仍未PR/push/review/CI/部署/付费；旧solo大suite与diagnostic/下游尚待迁移，rejudge/probe/ingestion旧执行仍在，不称八入口已完成。下一步申诉旧分支和诊断消费链。

## 2026-10-05 01:12 UTC — 申诉旧执行删除（未发布）

- 历史judge申诉API不再创建重判任务，返回409 historical_unknown；先RED证明原先200且新增事件。旧队列未决申诉写单一held回执，重放/并发幂等；历史已完成申诉继续读取，不改历史原判。
- 删除rejudge旧current-row/model/revert分支，只保留原生冻结original→新candidate→head CAS与结算。真实发布/原件/recorded离线端口替换旧judgeFn fixture，覆盖改判/同分/确定性/冻结输入/并发/试卷/明确用户FSRS/自动theta/失败回滚/晚到有序重放/KC合并保护。partial原生规则为未局部化则abstain，随后full才写一次success；不恢复已否决的旧partial→1。
- 59DB（API7/worker20/native提交32）、typecheck、changedBiome、build、Postman通过。边界去掉旧revert边，baseline收紧447→446，无新增豁免。所有模型为离线fixture，不代表真实质量验证。
- probe检查确认目标错误签名是独立承重语义，后续必须冻结并保留，不能只移植coarse score。剩余probe/ingestion/diagnostic生产与消费、旧solo主测试仍在1047主线。未PR/push/review/CI/部署/付费，不停止检查点。

## 2026-10-05 01:29 UTC — 诊断原生提交/消费/恢复（未发布）

- 原生ResponseSet可独立通过诊断答案校验；观察用response_md不再替代原答。已接收相同issuance/group/key的重试可恢复原candidate或202 outbox，改答/第二身份仍拒绝，不重付；尚无原件的并发认领仍只有一个成功。测试先RED后修。
- 原始submission的learning_scope冻结诊断归属元数据；保留空KC标签/题目级单次卡语义，不把canonical诊断KC误当普通学习调度目标。刷新读面从当前生效automatic/unassisted/model candidate恢复，返回真实evaluation_id而不伪造judge event；当前题metadata编辑不能改写原始诊断归属。
- Agency订阅version3增加真实assessment_activation；Practice注册其事件所有权（API生成组合校验先发现漏登记，修后通过）。消费在共享learning写锁内读取current head并推进原干预记录，迟到旧通知不会回写旧分数；申诉保持相同原review/暴露时点与follow-up due。首个真实原生消费用例先RED后修。
- 租约回收/日流恢复识别已有effective head的native attempt，已提交题不会因订阅延迟重新开放；回归先RED（draft被恢复成active）后修。无头pending仍由原durable pending/FAILED/REQUEUED护栏控制。
- 为保持锁序，干预activate/review/reconcile先取既有全局learning锁，再取干预锁。把原有无表SQL锁实现移到db/learning-state-lock.ts，server入口仅重导出同一实现，Agency直接消费db基础设施；没有复制锁namespace或隐藏server依赖。曾尝试新增server import的审计不通过，已收敛，baseline保持446/0/48不抬高。
- 128 distinct DB + 最后锁模块55DB、84 distinct unit（UI恢复/manifest/组合）、typecheck、changedBiome（零error/12warning）、build、API client/Postman生成和边界审计通过。全部模型均离线fixture；这不等于生产诊断producer已发布或模型质量准入通过。
- 仍需：生产诊断发题契约、native head转为manual/assisted/unsupported时撤销旧干预通过判定的显式未决态；probe签名/发题、ingestion先持久化发布、旧solo主suite及归因消费者。此后继续同一1047主线；无PR/push/review/CI/生产/付费。


## 2026-10-05 01:44 UTC — 诊断结论失效与原答更正（未发布）

- 原生当前评估变为manual/assisted/unsupported时，显式held撤销旧通过/失败结论；干预outcome清空，可信评估可恢复。原始作答、暴露时间、后续复查日期与一次性卡退休状态保留；详情刷新返回原答及unsupported/null评级，不丢原件。core与真实aggregate回归先RED后修。
- 原答mark_wrong/retract/restore通过统一correct事件联动，订阅升v4，observability登记实际已有correct写面所有权。读取当前head和原答更正状态在learning锁→correction锁→干预锁内；更正事件ID成为held依据，旧激活/更正迟到或重复不覆盖当前状态。恢复可复用原activation，aggregate更新时间使用当前消费时间，不能倒退。
- 真实原生提交/申诉/手动改判/受帮助重评/可信恢复/原答更正组合覆盖，65DB与22组合/schema unit通过；此前held阶段25unit通过。typecheck、changedBiome（零error/8warning）、build、API生成、Postman及边界446/0/48通过，无baseline提高。
- 仍未发布，无PR/push/review/CI/生产或付费调用。生产诊断发布准入、probe签名/发题、ingestion、旧solo suite与其余消费者仍在1047；继续修冻结讲解上下文遗漏原生选项/配对/布局。


## 2026-10-05 01:52 UTC — 冻结讲解上下文完整性（未发布）

- 提示任务携带公开的完整practice DTO：冻结选项顺序、配对/排序/表格与输入辅助、共享材料正文/说明都随已发题进入上下文；页面prompt不混入机器结构。私有评分材料和未发小题不进入该DTO。
- 评分参考按每个unit的slot_refs解析选项/条目，修复matching字段遗漏及跨槽同ID串用选择/排序正文的错误；真实输出原先把坡度配成设定坡度的回归先RED后修。
- 2纯投影回归、实际提示调用缺frozen_question的DB回归先RED；最终2unit+42DB、typecheck、changedBiome零error1warning、build、边界446通过。仅结构与文本上下文修复；TeachingTurnTask仍为文本输入，图像原始字节/多模态教学尚待接通，不能把alt_text冒充读图证据。
- 下一步迁移旧submit suite并核对校准/归因消费者，已发现native difficulty label尚未调用现有hook（plan字段为null）；归并1047，不通过删除旧断言掩盖遗漏。仍无PR/push/review/CI/生产/付费。


## 2026-10-05 01:59 UTC — 原生难度校准标签接线（未发布）

- 4项原生HTTP回归先RED：首次自动评估无label、显式FSRS评级下自动校准缺失、optional标签端口从未调用、改判重放无label。原始参与回执现于activation同事务的settle前写入；onActivated仍在成功激活后，两者失败均同事务回滚。
- central settle从原始native attempt读取实际stream_item_id，冻结到既有replay_inputs；现有校准hook用真实selection probability，标签绑定可撤销的settlement事件ID。改判删旧标签，晚于原判的其他自动作答有序重放时使用其自己的流身份。无流/错误题流不借概率，不回退按日期猜测。
- 正确和错误都产真实标签；显式FSRS评级不改自动θ/校准；self-report与assisted不进入校准。标签SQL除零故障在savepoint内真实失败，主原件/θ/FSRS/family仍提交。首次测试误把层级全局mastery行计入单KC计数，改为明确KC范围后验证，不当生产修复。
- 157 distinct DB（新校准9/settle30/native提交32/申诉20/诊断12/干预43/durable11）、typecheck、changedBiome零error4warning、build与边界446通过。无PR/push/review/CI/生产/付费；下一步旧submit/advice测试迁移及剩余正式入口/消费者。


## 2026-10-05 02:11 UTC — 单题/预览测试迁移与限流恢复（未发布）

- 旧submit/advice基线72项中64失败、8通过，主要为仍调用已退休flat/supplied-result路径，不当64个新生产缺陷。两套改为真实发布/发题/original/candidate/activation，55项新HTTP测试覆盖身份/校验/201定位/并发与幂等/FSRS日期与重答/显式评级与自动θ独立/真实run refs/照片原件/待复核/冻结参考/历史及native失败的cause建议。新增tests/fixtures/native-solo-http.ts仅录制离线模型，不冒充质量评测。
- 旧diagnostic场景由相邻12项原生套件覆盖，旧family/difficulty场景由9项新校准套件覆盖；旧手动评级写θ、未带原件却重建答案、供应判词/token直接成为分数、空白自动拒绝等已废弃语义改验显式self-report/原生评分/冻结空白政策。cause建议仍在preview测试，不能覆盖用户明确FSRS选择；不删除历史读面。
- 限流复核发现真实接线bug，原断言先RED实际200：checkRateLimit在认领后抛出，被封为不可重试pending。现recorded executor在锁内、写claim前做本地准入；纯core识别明确未启动拒绝，不封评分record；service保留原ApiError 429与Retry-After。原submission已存，稍后同原件重试可执行；已封存candidate重试不再耗token。调用已开始/结果失踪仍保守held，绝不放宽自动重付。
- 139distinctDB（最终128+后台11）、66评估core unit、typecheck、changedBiome最终零error/warning、build与边界446通过。新增限流测试通过真实formal executor，仅pi实际driver替换离线返回；无真实付费。类型检查曾发现fixture points可null，改为明确拒绝非points fixture，不填伪零分。
- 下一步迁移只剩测试引用的review-settlement及late-arrival套件后删除旧writer/types，继续probe/ingestion/诊断producer和消费者。仍无PR/push/review/CI/生产，不在检查点停止。

## 2026-10-05 03:18 UTC — owner要求停止并handoff

- 收尾最后两套旧settlement/late-arrival测试到native fixture；23DB、typecheck、两文件Biome与diff check通过。仅测试/文档改变，沿用上一实现提交build结果，不声称重跑。
- 旧review-settlement writer与JudgedSubmit尚未删除，已全仓确认只剩定义/内部类型引用；ValidatedSubmit仍live，不能一起删。生产诊断/probe/ingestion/消费者继续留1047未完成。
- 完整接手入口：`2026-10-05-yuk1047-handoff.md`。本地提交后停下；无PR/push/review/CI/生产/付费。1047维持In Progress，不新增重复票。

## 2026-10-05 本机续接：诊断生产发布与签名契约

- 恢复工作树后删除旧 `review-settlement.ts` writer 与无消费者的 `JudgedSubmit`；保留 live `ValidatedSubmit`。静态审计转向真实 native settlement。提交 `8588e31bb`；23 DB、19 invariant unit、typecheck、build 通过，boundary 446→440。
- 发布与归一化实现下沉到 `kernel/records/assessment-publication.ts`、`assessment-normalization.ts`，原 `server/questions` 路径仅显式兼容出口。两个实现只依赖共享 core/db/kernel，无 capability/server 反向依赖；诊断与接下来的 probe/ingestion 共用同一实现，不增加 deep import 债务。
- V2 probe 的完整正确/目标错误签名随私有评分契约冻结并参与 digest。原生 rule executor 保留独立 signature match；缺失、含糊、分数冲突或部分分产生待复核，不能由分数推断目标错误。公开 structure/response spec 不泄露签名。
- 诊断 materializer 原子发布三个诊断 revision，默认 withheld/no_admitted_executor；author/reviewer 审核不冒充模型评分准入。未准入不入 FSRS、不产生可执行 stream；已有 revision 与准入状态不被 reconciliation 重写。模型计划仅在 withheld 时允许 null slice，admitted 仍拒绝。
- 一次性发题在服务端强制 claim，即使调用方未显式传 claim；同 issuance ID 重试保留旧 revision/binding。诊断自动发题检查 due/draft，不允许 manual 绕过。提交处理租约独立于发题 claim，已持久化原答即使没有有效评分也阻止另开原答，允许原答幂等重试。
- 证据：44 intervention preparation DB、33 issuance/persistence DB、12 native diagnostic HTTP DB、30 publisher DB、151 scoped unit，通过；typecheck、build、boundary 440/0/48 通过。日志在 `/tmp/yuk1047-diag-*`、`/tmp/yuk1047-claim-regress.log`、`/tmp/yuk1047-native-publication-unit2.log` 与 `/tmp/yuk1047-withheld.log`。
- 未完成：Probe route/lifecycle、ingestion 原件先落库、native failure consumers、准入和入口登记。未调用付费 provider，未部署，未开 PR；1047 仍 In Progress。

## 2026-10-05 本机续接：Probe 原生链

- `serveProbeOnce` 在原事务冻结 publication，保留 pool-invisible draft 与三题上限。没有真实模型准入时 withheld；备课台只展示 admitted probe，并在实际送达时创建稳定 `iss_probe_<questionId>`，从公开 frozen DTO 读取题干。既有 ProbeAnswers UI/wire 未修改。
- 共享 issuance 实现下沉到 `kernel/records/assessment-issuance.ts`，practice 旧路径显式 re-export；可信 source_asset→EvidenceAttachment 解析供现有服务端入口复用。Probe 原件保存文本和图片 digest/MIME/大小/上传时间，再经原生 evaluateSubmission 产 candidate；响应 digest 保证同答重试不重复付费，改答保留独立原件，既有 per-probe claim 继续串行化。
- `answerProbe` 消费原生独立签名并持久化 issuance/submission/evaluation 关联。neither 为 terminal non-evidence，缺签名/含糊/冲突不产生猜测证据。提交或评估后撤回准入保留原件，但不写 probe_result。
- 不调用练习 activation。probe occurrence 只能走 conjecture 入口；中央 activate 拒绝 probe container，避免通用 endpoint 旁路写 FSRS/theta。单一槽兼任答案/证据时按并集送模型，修复此前重复传递。
- scoped 验证：Probe route 26 DB、生命周期25 DB、队列6 DB、真实运行链替换模型端口的18 closed-loop DB，以及33 issuance/11 activation DB；最终合跑70 DB与151unit通过。typecheck/build/Postman生成、boundary 439/0/48通过。全程无新付费provider调用、无部署、无PR。
- 下一步 ingestion 持久化先于评分、native failure消费者及准入/入口census。仅已完成代码接线，不以离线fixture准入冒充生产actual-output证据。

### 2026-10-05 shared evaluation transaction boundary

- Extracted the existing reserved-session advisory lock adapter into `src/db/session-advisory-lock.ts`; compose retains its prior lock key and busy contract. Native evaluation holds the group session lock across short input and candidate transactions, with model execution between transactions. Model ports reject an enclosing transaction.
- Exact membership, anchor, attempt allocation, admission snapshot and execution receipt replay retain the same group serialization. Added concurrent keyed replay and direct `pg_stat_activity` evidence that the model callback sees its group-lock holder idle with no open transaction.
- Scoped evaluation/compose lock suites: 22 DB passed; final evaluation/reserved-connection/provider-lock suites: 34 DB passed. Typecheck and build passed. No paid provider calls or deployment. Ingestion capture and native consumers remain in progress.

### 2026-10-05 ingestion and native failure consumers (in progress)

- Ingestion now captures the frozen publication, issuance, response and trusted image metadata before grading. Stable block/version identities replay the original revision after later publication. Unadmitted or unresolved originals remain persisted without fabricated failure. Human import retains or links the captured originals; automatic enrollment uses native settlement only. Captured work preserves scheduling, and withdrawal reverses its learning effects while replaying later overlapping evidence and refusing late activation.
- Native failure attribution and variant generation consume frozen issued controls, reference, response and learning scope. Activation deliveries resolve to the original participation anchor. A short write transaction rechecks the effective native verdict after model work; stale results do not write attribution or proposals. Image-only originals remain available, but text-only attribution cannot treat image metadata as image content.
- Shared failure reporting now returns frozen knowledge IDs. Weekly failure counts, due candidates, knowledge tools, association warnings and learner-state cache invalidation include native records. Historical attempt references remain counted after verdict changes. The one-time YUK-379 attribution backfill remains legacy-only.
- This resumed verification: 12 capture DB, 44 diagnostic preparation DB, 40 attribution/subscription DB, 30 variant DB, 80 reporting DB, and 4 native cross-consumer DB passed (overlapping suites, not summed as distinct). Typecheck, build and exact boundary audit (437/0/48) passed before the final formatting pass. No full local test, paid provider, deployment, or PR.
- Remaining: native review occurrence/rating aggregation and snapshot CSV exports; final production entry/admission census; final scoped gates then independent review and PR/CI. Reporting must count surviving actual FSRS effects once per evaluation group and preserve user rating independently from current correctness. CSV must retain original/effective distinction and frozen content. Existing CoachHub derives correctness from ratings and labels all non-correct rows wrong; that UI limitation needs tracked disposition, not invented correctness in backend data. No UI change is authorized here.

- Owner随后明确批准现有CoachReport最小修正（不新增页面、不扩Probe）。已按实际判决计算正确率，部分正确纳入已判分分母但不冒充全对，未判分不进入分母；逐日分四类，评级分布独立。新增daily incorrect/partial/ungraded字段。9 UI tests通过。
- 复习读面从存活FSRS结算收据按evaluation_group去重，沿用原occurrence时间并保留显式用户评级；capture-only/首次failed_pending不造复习，撤回排除，保留历史调度的失败替换不抹掉真实复习。共用纯reversion计算供settlement和报告，group verdict纯投影从DB loader中抽出供CSV接用。5 pure unit及10 weekly/native DB通过；另外group verdict/order/settlement回归49项通过（合跑59仅3旧weekly断言因新增字段失败，已修并重验10）。CSV与registry/final gates仍未完成。
