import { DEFAULT_TASK_BUDGET, type TaskDefinition } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';
import { noteGenerateTaskDefinition, noteVerifyTaskDefinition } from './note-tasks';

// YUK-863 / F3.2 — Notes capability owns these three TaskDefinitions.

function buildNoteRefinePrompt(profile: SubjectProfile): string {
  // YUK-127 / T-88 P4-A — Living Note refine prompt.
  //
  // Locked mutator threshold (see
  // `docs/superpowers/plans/2026-05-29-wave6-ready-to-launch.md` §Human
  // decision points): `≤ 3 patch ops AND ≤ 2 new blocks → mutator; else
  // propose`. The threshold itself is enforced by P4-B at the gating call
  // site — this prompt encourages the model to stay under it when the
  // mutation is genuinely small, so most refines can land via mutator-mode
  // without a propose round-trip.
  return `你是${profile.displayName}学习笔记 Living Note 编辑助手。输入 { artifact_id, artifact_type, title, knowledge_node, body_blocks, block_summaries, trigger: { kind, context_md, evidence_ids? } } —— body_blocks 是当前 atomic / long / hub 笔记的 TipTap doc JSON（ADR-0020 §1），block_summaries 给出每个 block 的 attrs.id + 摘要，trigger 描述触发本次 refine 的原因（mark_wrong / mastery_change / dreaming / verify 之一）。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
你的产出是一个 NotePatch —— 严格 JSON（不带 markdown 代码块包裹），shape：
{"ops":[NotePatchOp, ...]}

NotePatchOp 是 4 种 op 的 discriminated union（kind 字段判别）：
- {"kind":"insert_after","target_block_id":"<existing block.attrs.id>","block":{...PM JSON node, attrs.id 新建 cuid}}
- {"kind":"replace_block","target_block_id":"<existing block.attrs.id>","block":{...PM JSON node, attrs.id 必须等于 target_block_id（ADR-0020 §2 block_id 稳定）}}
- {"kind":"delete_block","target_block_id":"<existing block.attrs.id>"}
- {"kind":"append_block","block":{...PM JSON node, attrs.id 新建}}

关键约束：
- target_block_id 必须是 block_summaries 里实际存在的 attrs.id；编 ghost id 会导致 apply 失败
- replace_block 的 block.attrs.id 必须等于 target_block_id（ADR-0020 §2，否则 schema reject）
- 新 block 用合法 PM JSON 形态：{type, attrs, content?, marks?}，attrs.id 用短随机串
- atomic note 的 semantic_kind 体系（definition / mechanism / example / pitfall / check）不要打破——补充时尽量挂到合适的 semanticBlock 内或新建同 semantic_kind 的 block
- ${profile.grounding.uncertaintyPolicy}

mutator-mode 友好度提示：
- 目标 patch 通常 ≤ 3 个 op，且新增 block（insert_after + append_block）不超过 2 个 —— 这样可直接 apply（mutator-mode），用户在 idle 期回来无干扰
- 如果触发的改动确实需要更大范围重写，按需输出更长 patch；P4-B 的 propose-mode 会把它当 review 项交给用户
- 没有可行 refine 时输出 {"ops":[]}，apply 路径会 no-op，不写 event

禁止：rewrite 整篇 note、嵌 markdown 代码块、输出 JSON 之外的文字、引入 source_tier / lineage 字段。`;
}

const noteRefineTaskDefinition: TaskDefinition = {
  kind: 'NoteRefineTask',
  description:
    'Wave 6 / T-88 P4-A — Living Note refine pass. Given an atomic/long/hub note + a refine trigger, output a NotePatch (insert_after / replace_block / delete_block / append_block ops) for the apply pipeline to execute or surface as a proposal.',
  defaultProvider: 'xiaomi',
  defaultModel: 'mimo-v2.5-pro',
  budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
  needsToolCall: false,
  isMultimodal: false,
  allowedTools: [],
  prompt: { kind: 'profile', build: buildNoteRefinePrompt },
};

export const notesTaskSpecs: Record<string, TaskDefinition> = {
  NoteGenerateTask: noteGenerateTaskDefinition,
  NoteVerifyTask: noteVerifyTaskDefinition,
  NoteRefineTask: noteRefineTaskDefinition,
};
