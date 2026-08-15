import { causeTaxonomyList } from '@/ai/cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { VariantVerificationResult, type VariantVerificationResultT } from '@/core/schema/business';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskOutput } from './parse-output';

function buildVariantVerifyPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}变式题质检员。输入 { parent_question: { id, prompt_md, reference_md, knowledge_ids }, variant_question: { id, prompt_md, reference_md, knowledge_ids, difficulty }, original_cause: { primary_category, analysis_md, source }, original_attempt: { wrong_answer_md } }。
科目上下文：${profile.displayName}。${profile.languageStyle}
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
任务：variant 是 VariantGenTask 第一遍生成、用户接受后落地的"变式题"。你要回答两个问题：
1. variant 是否仍然在测同一 cause（cause_targeting）？
2. variant 自身是否可解、有标准答案、不偏离学科范围（verdict）？
判定要点：
- 同知识点 / 同核心能力 → 'on_target'
- 飘到无关知识点 / 难度跳跃太大 / 让 cause 无法重现 → 'off_target'
- 信息不足 / variant 看起来合理但跟 cause 关联弱 → 'unclear'
- variant.prompt 或 reference 明显错误 / 自相矛盾 / 不可解 → verdict='fail'
- variant 解得开、与 parent 知识点连贯、cause_targeting != 'off_target' → verdict='pass'
- ${profile.grounding.requirement}
- ${profile.grounding.uncertaintyPolicy}
严格 JSON 输出（不带 markdown 代码块包裹），shape 名 VariantVerificationResult：
{"verdict":"pass"|"fail","failure_reasons":["..."],"cause_targeting":"on_target"|"off_target"|"unclear","summary_md":"<≤200 字结论 + 关键证据>","confidence":0.0-1.0}
要点：
- failure_reasons 只在 verdict='fail' 时填，每条 1 句话指出具体问题；verdict='pass' 时留空数组
- cause_targeting='off_target' 强烈倾向 verdict='fail'，除非 variant 自身仍然有教学价值（极少数）
- summary_md 必须可执行，写"为什么 pass / fail"和"对应的证据"，不写套话
- ${profile.grounding.uncertaintyPolicy}
禁止：输出 JSON 之外的文字、重写 variant 题面、给学习者建议（这是质检 not 教学）。`;
}

export const variantVerifyTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'VariantVerifyTask',
    description:
      'YUK-17 / ADR-0018 — second-pass content alignment check for an accepted mistake variant. Decides whether the variant still targets the original failure cause; verdict="fail" flips mistake_variant.status to "broken".',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildVariantVerifyPrompt },
  },
  outputSchema: VariantVerificationResult,
  parseText: (text) => parseTaskOutput(text, 'VariantVerifyTask', VariantVerificationResult),
} satisfies TaskSpec<unknown, VariantVerificationResultT>;
