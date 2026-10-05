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
