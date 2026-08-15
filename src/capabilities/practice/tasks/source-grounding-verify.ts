import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import {
  SourceGroundingVerifyOutput,
  type SourceGroundingVerifyOutputT,
} from '@/core/schema/source-grounding';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskOutput } from './parse-output';

// YUK-230 (PR #1063 review, thread 2) — source-grounding verifier prompt. UNLIKE
// MultimodalDirectJudgeTask (which grades a student ANSWER), this asks ONLY「题面是否
// 真的来自这张图片」. It exists to catch VLM hallucination on the image_candidate
// extraction path: a single VLM call can emit a self-consistent 题面 + 答案 that is
// unrelated to the source image; grading that pair by text alone判 correct, so the
// grounding gate MUST re-read the image and ask the presence question directly.
function buildSourceGroundingVerifyPrompt(profile: SubjectProfile): string {
  return `你是题目来源核验器（source grounding verifier）。给你一张来源图片（这道题据称从中抽取）和一道题的 { prompt_md（题面）, reference_md（参考答案，可能为 null）, image_present }。图片会附在 user message 中。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

任务：判断题面（prompt_md）的核心内容是否真实出现在这张图片里——即这张图片是不是这道题的真实来源。
- grounded=true 仅当：题面所问的核心内容 / 条件 / 材料能在图片中找到对应（图片确实是这道题的来源）。
- grounded=false 当：图片与题面无关、图片里找不到题面所述内容、或题面看起来是凭空生成 / 与图片内容不符（这是 VLM 幻觉信号——模型可能编了一道自洽的题却与图片无关）。
只判断「题面是否来自图片」这一件事：不评判答案对错，也不重新解题。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 SourceGroundingVerifyOutput：
{"grounded":true|false,"confidence":0.0-1.0,"observed_md":"你在图片里实际看到的、与题面相关的内容","reason_md":"grounded / not grounded 的理由，引用图片证据"}

要点：
- observed_md 写你从图片里实际看到的内容（evidence 用），即使图片模糊也尽量给出。
- 图片明显与题面无关 → grounded=false，别因为题面本身「看起来像一道正常题」就判 grounded。
- confidence 反映把握，0.5 表示模棱两可；不确定时倾向 grounded=false 并在 reason_md 说明。
- ${profile.grounding.uncertaintyPolicy}
禁止：输出 JSON 之外的文字、评判答案正误、重新解题、把与题面无关的图片判成 grounded。`;
}

export const sourceGroundingVerifyTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'SourceGroundingVerifyTask',
    description:
      'YUK-230 — Source-grounding verification for image-sourced questions. Single vision LLM call re-reads the source image and decides whether the question 题面 actually appears in / derives from it (grounded boolean), catching VLM extraction hallucination on the image_candidate accept path. Distinct from multimodal_direct (answer judging).',
    structuredOutputSchema: SourceGroundingVerifyOutput,
    defaultProvider: 'xiaomi',
    // Same vision model + single-call/90s budget as the multimodal judges, but WITHOUT the
    // transientRetries opt-in: this runner is called from the durable source_verify pg-boss
    // job (throws on transient → queue redelivery is the retry layer), so an in-process retry
    // would stack a second transient layer (single-transient-layer principle, YUK-576 §3.2).
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: true,
    // invocation omitted (defaults to 'auto'): called from source_verify as part of
    // the tier-2 promotion gate for single_source_grounding rows (after user accept).
    allowedTools: [],
    prompt: { kind: 'profile', build: buildSourceGroundingVerifyPrompt },
  },
  outputSchema: SourceGroundingVerifyOutput,
  parseText: (text) =>
    parseTaskOutput(text, 'SourceGroundingVerifyTask', SourceGroundingVerifyOutput),
} satisfies TaskSpec<unknown, SourceGroundingVerifyOutputT>;
