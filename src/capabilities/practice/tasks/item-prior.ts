import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { ItemPriorDraft, type ItemPriorDraftT } from '@/core/schema/item_prior';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskOutput } from './parse-output';

// B1-W1 (ADR-0035 慢热阶段①) — ItemPriorTask prompt. 给一道新题估冷启先验
// 难度 b（logit 尺度）。反占位约束：直接主观打分难度文献 r≈0
// （phase2-synthesis-lanes:770）——prompt 强制「先抽教学特征（认知步骤数 / 所需
// 前置知识 / 典型错误类型 / 题型固有难度），再由特征推 b」。
function buildItemPriorPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}题目难度标定员，一次只给**恰好一道**题估冷启先验难度。输入 { prompt_md, kind, knowledge_context: [{ name, anchored_b? }] } —— prompt_md 是题面，kind 是题型，knowledge_context 是这道题考查的知识点（anchored_b 若给出是该知识点已标定的难度锚，可作参考）。
科目上下文：${profile.displayName}。${profile.languageStyle}

难度 b 用 **logit 尺度**：b=0 是该科目的中等难度（典型学习者约一半概率答对）；b 越大越难（b≈+2 很难），b 越小越易（b≈-2 很易）。常规范围约 -3 到 +3。

**方法（强制，不要直接主观打分）**：先分析这道题的**教学特征**，再由特征推 b：
- 认知步骤数：要几步推理/计算才能到答案？步骤越多越难。
- 所需前置知识：依赖几个前置概念？前置链越长越难。
- 典型错误类型：常见的坑/易错点有多少、多隐蔽？坑越隐蔽越难。
- 答案语义（结构描述符）：${kindDifficultyHint(profile)}
reasoning 里**必须**引用上述教学特征说明你为什么给这个 b，禁止只写「我觉得难/容易」。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 ItemPriorDraft：
{"b_logit": <number，logit 尺度的难度>, "confidence": <0-1，你对这个估计的把握>, "reasoning": "<引用认知步骤数/前置知识/典型错误/题型，说明 b 怎么推出来的>"}

约束：
- b_logit 是数值（不是 1-5 档位）；按上面 logit 语义给。
- confidence：纯文本特征推断本就不确定，多数题应给中低 confidence（0.3-0.6），除非特征极清晰。
- 禁止：emoji、套话、JSON 之外的任何文字、用 markdown 代码块包裹整段 JSON。`;
}

// 题型固有难度提示——按**答案语义结构描述符**（受限 vs 开放的答案空间）说明，而非
// 绑死某串题型名字，保持科目中立（不写死任何单一科目的题型套话）。
function kindDifficultyHint(_profile: SubjectProfile): string {
  return '答案空间**受限**（exact：选项/判断/唯一确定的最终值，可逐字或规范化比对）的题通常比同知识点**开放**（semantic：需自己组织表述、靠采分点核查的译/答/证/算过程）的题易——受限答案可猜测、空间小；开放答案要自行组织、固有难度更高。';
}

export function parseItemPriorOutput(text: string): ItemPriorDraftT {
  return parseTaskOutput(text, 'parseItemPriorOutput', ItemPriorDraft);
}

export const itemPriorTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'ItemPriorTask',
    description:
      'B1-W1 慢热阶段① — 给一道新题估冷启先验难度 b（logit 尺度）。输入=prompt_md + kind + knowledge_context（节点 name + 可选 anchored_b）。输出=b_logit + confidence + reasoning。单次结构化输出（无 tool loop，无 Tavily），写 item_calibration（source=llm_prior, track=hard）。⚠️ 不直接 prompt 估难度（文献 r≈0，phase2-synthesis-lanes:770），prompt 走「抽教学特征」路线。b 是 θ̂ 更新读的外部锚——只 propose-only 冷启锚，慢热由 fixed-anchor 校准 firm-up。',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildItemPriorPrompt },
  },
  outputSchema: ItemPriorDraft,
  parseText: parseItemPriorOutput,
} satisfies TaskSpec<unknown, ItemPriorDraftT>;
