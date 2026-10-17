import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';

// YUK-1522 (R8) — IngestionAgentTask: one durable agent run per ingestion
// session over the WHOLE source package (pages, figures, docx text). The model
// drives the shared source-package tools for reading/media and the unified
// draft lane (edit_question → compose_presentation → submit_question) for
// writes, plus the two R8 tools for contract progress and durable asks.
// Prompt text lives in the spec; per-run context (document id, package
// manifest, resume ledger) arrives as the user-message JSON input built by
// server/agent/run.ts.

const AgentRunReport = z.object({
  outcome: z.enum(['done', 'awaiting_ask', 'blocked']).optional(),
  summary: z.string().optional(),
});
export type AgentRunReportT = z.infer<typeof AgentRunReport>;

function buildIngestionAgentPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}录入 agent（R8）。一次 run 覆盖整个来源包的所有页面、图片与文字。你只做录入结构化，不做判分。

工具面（全部可用）：
- read_source：先取包 manifest（kind、每页 image_ref、text_class），再按 page_index 读页文本（word 包用 offset 翻整篇 markdown）。
- view_image / crop_image / rotate_image / glm_ocr：看原页图、裁/转题图、需要时对指定区域跑 GLM 版式 OCR。所有 ref 都是 ast1 版本化引用；裁出的新 asset 才能进材料。
- edit_question：创建/修改草稿文档（schema_version=2）。创建传完整 document；结构是 parts[] → units[]（select/blank/free 的 response_spec + method）。
- compose_presentation：给草稿生成 declarative presentation spec（本版本不造自定义 block）。
- submit_question：提交草稿走发布闸。提交结果一律 withheld pending admission——这是正常终态，不是失败。
- report_ingestion_progress：发出契约进度事件（stage / item / error）。这是学习者看到的唯一进度真相。
- ask_learner：拿不准时发 durable 询问；或传 {ask_id} 轮询。

工作流程：
1. stage=reading：读 manifest + 每页（文本为主，图片按需核对）。
2. stage=segmenting：确定题目切分——大题（含材料/篇/多小问）组为一个 item，小问进同一草稿文档的不同 part。为每个 item 定一个稳定 item_id（如 item_1）与印刷题号 question_no。逐个 item 发 status=queued。
3. stage=structuring：逐 item 用 edit_question(document) 建草稿，发 item status=structuring + preview_text（从原文摘 ≤100 字，系统会脱敏截到 80 字）。
4. stage=presenting：对每个草稿调 compose_presentation 生成展示层。
5. 对每个草稿调 submit_question 提交。成功（withheld/pending）→ 发 item status=withheld；被拒/冲突/失败 → status=failed 并发 error(scope=item, code=structure_failed, retryable=false)。
6. 全部 item 到终态后发 stage=done，counts 带 {items_total, items_done, items_withheld, items_failed}，并结束。

铁律：
- 答案先自己解：结构草稿的 unit.key / reference 必须来自你自己的求解，绝不抄写页面印出的答案或学生手写痕迹——它们只是证据，永远不进入 key。允许 omit key（提交照样 withheld 待 admission 独立判分）。
- item 上报用 page_index（read_source manifest 的 0 基页索引，系统会转 1 基）。preview_text 只放题目原文节选，不放手写内容、姓名、学校等身份线索。
- 页/图不可读、裁剪失败、模型问题等局部失败：对该 item 发 status=failed + error(scope=item, retryable 如实填)，继续其它 item。整包不可读时才发 error(scope=session)：它不会直接报错退出，而是记录为终止请求，随后整轮结束（session 失败），所以不要再用它做「提醒」——发出后不要再发任何 stage/item 进度。
- document.source 是系统字段：创建草稿时系统会盖上 ingestion_agent 印记，你在 document 或 ops 里写 source 会被工具直接拒绝；已发布题的 question_id 编辑在本 lane 不可用。
- ask_learner 只在真拿不准时用（如小问归属、材料归属、缺页歧义）。placeholder 可省略（系统会按题型补默认文案）。发出后**继续处理其它 item**或结束本轮；绝不在文本里假装等回答。resume 后输入里的 asks 数组带答案或 open 状态，按答案继续该 item。
- edit_question 返回的 draft_ref 在后续 item 进度上报时带上（draft_ref 字段）；提交成功后带 question_id。
- 跨页大题必须合成一个 item；不要把同一题拆成多个 item。
- question_no 是印刷显示号，item_id 是你的稳定身份，两者都用 ASCII。`;
}

export const ingestionAgentTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'IngestionAgentTask',
    description:
      'YUK-1522 (R8) — whole-package ingestion agent. One durable run per ingestion session: reads the source package via shared tools, segments items, structures each into a draft via edit_question, composes presentation, submits via submit_question (always withheld pending admission), emits the R8 progress contract, and raises durable non-blocking asks. Resumed segments rebuild context from the job_events ledger.',
    // xiaomi mimo-v2.5 is the multimodal lane member — mimo-v2.5-pro is
    // text-only (catalog: input ['text']) and would fail this task's
    // vision gate; vision tasks use mimo-v2.5 per server/ai/AGENTS.md.
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 120, timeout: 1_200_000 },
    needsToolCall: true,
    isMultimodal: true,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildIngestionAgentPrompt },
  },
  outputSchema: AgentRunReport,
  parseText: (text) => {
    try {
      const trimmed = text.trim();
      if (trimmed.startsWith('{')) return AgentRunReport.parse(JSON.parse(trimmed));
    } catch {
      // Terminal text is advisory only — durable truth is the event ledger.
    }
    return { summary: text.slice(0, 500) };
  },
} satisfies TaskSpec<unknown, AgentRunReportT>;
