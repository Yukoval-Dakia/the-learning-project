# YUK-1568 S3 — 共享 save/submit 事务内核（子实施记录）

- 日期：2026-10-21
- 分支：`feat/yuk-1568-shared-submit-intx-20261021`（隔离工作树 `t3-12b32ff3`，base = `origin/main` `214ecb0ef1c2d746316af5831ea79bbaa18345ef`）
- 子任务：`node:delegated-task:command%3Amcp%3A1b245de5-ec9a-4684-9829-ec78b93c5e5e%3Adelegate-task%3Astage1-yuk1568-shared-submit-intx-swe2-max-214-20261021`
- 协调登记：YUK-1568 评论 `4528709`（本线为该片唯一 writer；4 个交集文件由父串行接线）

## 范围

本 commit 只交付「共享 save/submit 事务内核」的可编译产品代码，不写 held 文件：

- `src/server/questions/edit-question.ts`（owned）— save 内核化。
- `src/server/questions/shared-submit.ts`（新）— submit 事务内核 + 声明组原子链。
- `src/server/questions/submit-decision.ts`（新）— 提交判定层（原 submit-question.ts helper 的完整迁移体）。
- `src/server/questions/typed-group.ts`（新）— 声明身份绑定 + 父子 question 行投影。
- `scripts/capability-boundary-baseline.json` — 两条 sourceSizeRecords 登记。

Held（父串行接，本 commit 未动）：`src/server/questions/submit-question.ts`、`src/server/questions/parts.ts`、`src/server/questions/draft-contract.ts`、`src/capabilities/practice/server/tools/submit-question.ts`（#1925 fixed23e 保护清单内）。

## 模块职责与接线点

### edit-question.ts（1298 → 1321 行，已登记）

- `saveDraftEditInTx(tx, params)`：原 `saveDraftEdit` 事务体整体提升为可信内核入口。请求形状校验、`pg_advisory_xact_lock(hashtext(request_id))` 认领、回执重放/复用冲突、草稿解析、双 CAS、ops 应用、create/edit 事件与块投影、回执写入全部原样。`Tx` 参数显式声明提交层级。
- `TxAbort` 改为 `export`：组合入口把 save 失败折叠进外层原子回滚。
- `saveDraftEdit(db, params)`：现有公开 API 面不变 —— 开外层事务 + `saveDraftEditInTx` + 事务外 TxAbort→result 转换。
- `writeReceiptEvent` 补 `task_run_id: ctx.taskRunId ?? null` envelope（save/submit 回执统一携带）。

### submit-decision.ts（352 行，新）

从 submit-question.ts 原样提取的判定层：`canonicalJson`、`runAdmissionChecks`（+`AdmissionCheckInput/Result`）、`SOURCE_KIND_TO_QUESTION_SOURCE`、`deriveKind`、`draftCarriesFigure`、`ScoringRevision`、`conversionWithheld`、`storedScoringCopied`、`admissionForContentEdit`、`scoringLayersUnchanged`、`contractBarrierIssues`、`presentationForDraft`、`attributableSourceIssue`、`nearDupComparableText`、`nearDuplicateInKnowledge`。仅可见性提升为 export，逻辑零改动。facade 接线时 submit-question.ts 的同名本地副本删除并改为 re-export。

### typed-group.ts（367 行，新）

- `bindDeclaredGroupIds(doc, {namespace})`：声明文档局部 id（part/unit/slot/item/material/criterion 六域 + 根组 `group`）按 `sha256('yuk1568:bind:'+namespace ‖ domain ‖ local)` 前 20 hex 铸确定性真实 id（`bd_<domain>_<h20>`）。先校验声明引用闭包：`part.material_ids`/`unit.material_refs`→material、`part.blank_order`→本 part slot、`unit.key.accepted_item_ids`→本 unit item、域内重复 id —— dangling/重复一律 `{ok:false, issues}` 拒绝。`doc.base`/`doc.presentation` 存在即拒绝（presentation 的 block_id/bind 内嵌声明 id，重绑会留悬空引用；presentation 由提交链 `presentationForDraft` 从契约生成）。不注入缺省 blank_order/answer_shape，不碰显示序与下标语义。
- `insertTypedGroupChildren(tx, seed)`：根行 `FOR UPDATE` 锁（parts.ts 根→子锁序）→ 绑定 part_id 撞任一既有 question 行抛 `TypedGroupProjectionError` → 每 part 一条 `question` 子行：`parent_question_id`=组 id、`part_index`=声明序、`kind='question_part'`、`draft_status='draft'`、`version=0`、内容列由单 part 文档走 `draftCanonicalIdentity`/`draftDocumentToStructuredQuestion`（choices 只在恰好一个 select 单元的 part 落列）、`withAnswerClass`。`created_by` 保持 NULL（ADR-0006 v2 part 写口约定），provenance 落 `metadata.produced_by`/`declared_part_id`/`draft_block_id`。

### shared-submit.ts（1078 行，新；已登记）

- `submitDraftQuestionInTx(tx, input, ctx, opts?)`：原 `submitDraftQuestion` 事务体完整内核形态 + `opts.producer`（`TrustedNewGroupProjection`）扩展面。原语义逐行保留：锁内回执、block 行锁、draft_version CAS、`expected_revision` 钉底/pinned base、准入组级 blocker、来源归属校验、`applyScoringEditPlan` 判分层原样拷贝、`contractBarrierIssues`、integrity seal、来源 URL claim（`claimHttpSourceDuplicate` onTerminal:'release'）、`mergeExactQuestionDuplicateKnowledgeIds`、近似去重、根行 insert/update、唯一 `publishQuestionGroup` seam、草稿终态 lifecycle 事件、verify outbox intent、回执事件。
- producer 扩展面（仅新组首次提交生效；与 `sourced` 可同现，重叠字段 producer 优先、metadata 按 sourced→producer 并入）：`newGroupId`（缺省铸 cuid2）、`materializeParts:'parent-parts'`（`doc.parts>1` 时在根行 INSERT 后同事务投影子行；不逐 child FromRow 重发 —— 发布 seam 一次覆盖全组）、`canonicalContentHash`/`dedupActor`/`createdBy`/`difficulty`/`sourceRef`/`rowSource`/`metadata` 覆盖；`qualityGate`/`paidOutput` 只进 request 指纹（持久化由调用方走 metadata）。producer 身份字段全部进 `submitRequestFingerprint`，簿记字段排除。
- `submitRequestFingerprint / findSubmitReceipt / claimSubmitRequestId / writeSubmitReceiptEvent`：与既有同名导出同语义，供 candidate/compat 提交路径与 facade 复用；`writeSubmitReceiptEvent` 补 `task_run_id` envelope。
- `SharedSubmitAbort{stage:'declare'|'save'|'submit', payload}`：步骤级回滚哨兵。冲突/投影失败在事务内抛出，外层不回退已提交业务。
- `drainSubmitVerifyIntents(db, result)`：事务外 source_verify 派发（按 `verify_enqueued` 而非 receipt.status 门槛）；失败留 durable intent。
- `persistDeclaredQuestionGroupInTx(tx, params)`：绑定→save→submit 同事务原子链。`expected_revision:null` 显式钉新组首提交 CAS；submit 返回 conflict ⇒ `SharedSubmitAbort('submit')` 整体回滚（草稿/根/子/claim 不落半个）；withheld（published:false / 发布 withheld）是合法已存终态，正常返回。
- `persistDeclaredQuestionGroup(db, params)`：Db 外层入口 —— 事务 + abort 转换（`declaration_failed|save_failed|submit_aborted|completed`）+ 事务后 drain。`declaration_failed` 绑定器问题原样透出。

## 父接线 TEXT（held 文件逐 hunk）

### A. `src/server/questions/submit-question.ts`

1. 删除判定层本地副本（现 `submit-decision.ts` 内同名实现）：`canonicalJson`、`runAdmissionChecks`、`AdmissionCheckInput/Result`、`SOURCE_KIND_TO_QUESTION_SOURCE`、`deriveKind`、`draftCarriesFigure`、`ScoringRevision`、`conversionWithheld`、`storedScoringCopied`、`admissionForContentEdit`、`scoringLayersUnchanged`、`contractBarrierIssues`、`presentationForDraft`、`attributableSourceIssue`、`nearDupComparableText`、`nearDuplicateInKnowledge`、`NEAR_DUP_POOL_LIMIT`。
2. 删除 claim/回执本地副本：`DRAFT_SUBMIT_ACTION`、`parseExpectedRevision`、`documentOfBlock`、`findSubmitReceipt`、`claimSubmitRequestId`、`writeSubmitReceiptEvent`。
3. `submitDraftQuestion` 主体替换为薄 wrapper：

```ts
export async function submitDraftQuestion(db: Db, input: SubmitDraftInput, ctx: SubmitContext): Promise<SubmitResult> {
  const out = await db.transaction(async (tx) => submitDraftQuestionInTx(tx, input, ctx));
  await drainSubmitVerifyIntents(db, out);
  return out;
}
```

   （原尾部 verify drain 块移入 `drainSubmitVerifyIntents` —— 已在新模块。）
4. 保持既有再出口契约：`canonicalJson`、`runAdmissionChecks`/`AdmissionCheck*`、`deriveKind`、`draftCanonicalIdentity`、`revisionToDraftDocument`、`claimSubmitRequestId`、`writeSubmitReceiptEvent` 改为 `export { ... } from './submit-decision'/'./shared-submit'` —— `tools/submit-question.ts`、`tools/edit-question.ts`、`tools/store-sourced-question.ts`、`jobs/source_verify.ts`、`edit-submit.db.test.ts` 的已登记 import 边复用，不加新边。
5. `SubmitDraftInput`/`SubmitResult`/`SubmitUnitOutcome`/`SubmitContext` 类型留在本文件（shared-submit 对其只做 type-only import，无运行时环）。

### B. `src/capabilities/practice/server/tools/submit-question.ts`（#1925 保护语义必须保留）

声明候选分支现状（约 890-1010）：两事务 `saveDraftEdit` → `submitDraftQuestion`。接线为单原子链：

```ts
const requestId = input.request_id;                       // 现确定性 id，勿改
const { document } = declaredCandidateDocument(q, input.source_route, knowledgeIds); // 现投影勿改
const result = await persistDeclaredQuestionGroup(db, {
  document,
  idNamespace: `yuk1568-candidate:${requestId}`,
  saveRequestId: `${requestId}:save`,
  submitRequestId: `${requestId}:submit`,
  availability: input.availability,
  sourced: { /* 现有 sourced 注入体逐字段原样（canonical_content_hash/created_by/difficulty/metadata/supply_trace/source_claim） */ },
  ctx: { actorRef: routeConfig.mergeActorRef, actorKind: 'agent', sessionId, taskRunId, causedByEventId, now },
});
// result: {status:'completed', save, submit} | declaration_failed | save_failed | submit_aborted
```

- `completed` ⇒ 按 `submit.status` 映射：published-withheld/admitted/pending 走现有回执组装；`withheld && published===false` ⇒ `draft_unpublishable` + `save.draft_ref`（保留可修草稿终态）。
- `submit_aborted` ⇒ 冲突终态（重复源/exact/near_dup/claim 冲突语义不变）。
- `save_failed`/`declaration_failed` ⇒ 拒绝终态，如实带 issues。
- #1925 语义钉：sourcing_web 且 `logTaskRunId` 存在时 `created_by={by:ai,task_kind:SourcingTask,task_run_id:logTaskRunId}`；candidate 与 declared 成功事件都落 `difficulty_reason=explainDifficultyEvidence(...)` 与 `task_run_id=logTaskRunId ?? taskRunId`；canonical request/claim/paid identity 不用 logTaskRunId 替换。
- 事件 `subject`：`writeSubmitReceiptEvent` 已支持 `{kind:'question'}`；工具侧候选成功事件保持 `question` subject 与 payload 形状。

### C. `src/server/questions/parts.ts`（如需）

`createQuestionPart` 不动；typed 首发子行由内核投影承担（同一 publish seam 覆盖，不调 `publishQuestionGroupFromRow` 逐子重发）。`db/schema.ts` 中 `parent_question_id`/`part_index` 注释把 parts.ts 列为唯一写口 —— typed-group 现为第二写口（同一投影约定），父接线时可顺手补注释。

### D. `src/server/questions/draft-contract.ts`

无需改动；内核只消费其既有导出。

## 仍缺证据（如实）

- 本机测试/断言：NOT_RUN（owner 规则：不写不断言脚本；`edit-submit.db.test.ts` 仍走旧 facade，未覆盖新内核路径 —— 父接线后由现有 case 间接覆盖）。
- 真实 DB 重放/并发/回滚实测：NOT_RUN（逻辑核对：save 原子段、submit 原子段、组合链段均有回执/锁/PK 兜底；TypedGroupProjectionError/TxAbort/SharedSubmitAbort 只在外层事务外转换）。
- `parent_published`/`admitted` 复合组下游消费（serving 对父/子完整性依赖）：NOT_RUN —— 现有消费方待父接线后验证。
- proposal-appliers 的 save→submit 顺序链是否应改走原子链：父决定（本 commit 未动）。
- 非供给链 typed 新组（producer 缺省）暂不投影子行 —— 与 main 同行为；如要扩展 materializeParts 覆盖面父裁决。

## 验证记录（本线）

- `pnpm exec biome format --write`（4 文件）exit 0
- `pnpm typecheck`（tsc --noEmit + server/start tsconfig）exit 0
- `pnpm lint` exit 0（181 warnings = main 既有基线，我文件 0 条）
- `pnpm audit:capability-boundaries` exit 0（新边 0；sourceSizeRecords 2 条登记；>1500 文件 12→12）
- `pnpm audit:schema` exit 0（stub unallowed 0；`parent_question_id`/`part_index` 实写路径保持）
- `pnpm audit:draft-status` exit 0（insert 站点含 draft_status）
- `pnpm build` exit 0
- 以上命令均经 `/Volumes/YukovalSBak/yukoval-projects/tlp-status/_work/heavy/heavy.sh` 串行，Node heap ≤3072MiB。
