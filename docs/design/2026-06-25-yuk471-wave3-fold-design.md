设计稿已写出。这是基于 ADR-0044 真相源 + 全部 grounding payload + W1 已建模式（fold-event.ts / knowledge.ts / gather.ts / genesis.ts / materialized-id-index.ts / export constants）逐项核验后的可驱动实施稿。

**产出文件**（绝对路径）：
`/Users/yukoval/yukoval-projects/the-learning-project/docs/design/2026-06-25-yuk471-wave3-artifact-question-block-fold.md`

**核心设计结论（9 个要求逐项覆盖）**：

1. **payload #2-#7 最终 schema**：`BodyBlocksEdit`（promote 出 experimental，full-snapshot fold + previous_body_blocks 供 revert）；`GenerateArtifact` 扩字段（废 artifact_kind 改 `type: ArtifactType`，加 generation_status/verification_status/body_blocks/attrs/tool_state 等，5 处归一）；`EditQuestionBlockStructured`（新 KnownEvent，`affected_blocks[]` 多块 after）；`ArtifactStatusExperimental`（#7 reserved experimental，可 defer）。

2. **RowSnapshot + reducer 聚合**：ArtifactRowSnapshot 无可排除衍生列（body_blocks/attrs/history 全真相）；QuestionBlockRowSnapshot 唯一排除 `crop_refs`（figures.map 派生，IO shell write-through 重算）。**Codex #5** 解法 = 方案 A3（GenesisExperimental.subject_kind 扩 'question_block'，applyExtractionResult 同步写 genesis seed，不止迁移当下）；**Codex #6** 解法 = affected_blocks[] 多行 after + gather Q3 jsonb @>（类比 W1 knowledge merge `gather.ts:106`，absorbed block 不入 materialized_id_index）。

3. **5 处归一**：learning_intent ×3 + legacy-record-appliers + quiz_gen 各补 writeEvent(GenerateArtifact)；runNoteGenerate（#3）补填充转移。

4. **job_events→canonical**：6 个 block-structured-edit op 在 writeJobEvent 后**额外** writeEvent（共存，job_events 留作 SSE 传输层）。

5. **YUK-358 合流**：最关键红线是 fold 重放 note_refine_apply 时 **必须 `enforceUserVerifiedGuard: false`**（fold-only 回放非在线 AI 写），否则历史 op + 后续 verify 会触发 user_verified_protected 致 fold 失败；type-dispatch 跳 opaque 类型；不复活 advisory/孤儿链。

6. **genesis backfill + 切换序**：question_block 先于 artifact（FK 序更靠前、无 artifact 依赖）；artifact 末位。**关键发现**：本 Wave 无新表（artifact/question_block/materialized_id_index 均已在 FK_ORDER，当前 SCHEMA_VERSION 4.9），故 **5 处登记的「新表」步骤退化为不 bump**；materialized_id_index 的 MaterializedSubjectKind 需扩 'artifact'，但 question_block 不入 index。

7-8. **测试矩阵 + 9 PR 切片**（A1-A4 question_block / B1-B4 artifact / C1 #7），标 P0/P1，#7 可 defer。

9. **5 个 owner 待拍分叉**：Q1 import 路径 event、Q2 mirror 链 artifact genesis、Q3 #7 defer 边界（强调 **archived_at 不建议 defer**——软删读路径硬依赖）、Q4 refine replay vs snapshot、Q5 事件行体积。

**Linear 捕获**：本任务是设计综合（产出 design doc），未发现需新建 Linear issue 的代码 follow-up——所有 deferable 项（#7、5 个分叉）已落入 doc 的 §8 切片表与 §10 未决问题，属 Wave 3 实施 lane 的范围内决策，不溢出成独立 issue。design doc 按记忆 `feedback_docs_sync_to_linear` 应在 owner review 后 save_document 同步挂 YUK-471 镜像（owner 操作，非本 subagent 范围）。