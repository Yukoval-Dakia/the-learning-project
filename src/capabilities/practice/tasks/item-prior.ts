import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import {
  ItemPriorDraft,
  type ItemPriorDraftT,
  ItemPriorLlasaDraft,
  type ItemPriorLlasaDraftT,
  LLASA_ABILITY_TIERS,
  LLASA_STUDENTS_PER_TIER,
} from '@/core/schema/item_prior';
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

// ─── YUK-376 — LLaSA 学生模拟变体（opt-in，默认路径仍是上面的 feature→b）───
//
// LLaSA「LLMs are Students at Various Levels」（EMNLP 2024）：不直接估难度，
// 让模型扮演 5 档能力学习者**实际作答**，由逐档答对率经 1PL MLE 反推 b
// （src/core/item-prior-llasa.ts）。写路径与 ItemPriorTask 共用 applyItemPrior，
// provenance 用 source='llm_prior_llasa' 区分（eval 可比性）。
//
// 输入比 feature→b 版多 reference_md / choices_md：模拟学生作答需要选项
// （choice 题的 prompt_md 不含选项），判对错需要参考答案。
function buildItemPriorLlasaPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}学习者模拟器。给一道题，你要扮演 ${LLASA_ABILITY_TIERS.length} 个能力档的学生**实际作答**，每档各 ${LLASA_STUDENTS_PER_TIER} 名（学生之间是不同个体，作答独立、可有差异）。输入 { prompt_md, kind, knowledge_context: [{ name, anchored_b? }], reference_md?, choices_md? } —— prompt_md 是题面，kind 是题型，choices_md 是选择题的选项列表（若有），reference_md 是参考答案（若有），knowledge_context 是考查知识点。

科目上下文：${profile.displayName}。${profile.languageStyle}

能力档 θ（logit 尺度）：θ=-2 是很弱的初学者（前置知识残缺、常犯典型错误）；θ=-1 偏弱；θ=0 是该科中等典型学习者（基础扎实但会踩隐蔽的坑）；θ=+1 较强；θ=+2 是优等生（也可能因粗心或题目陷阱答错，不必永远答对）。

**扮演规则（强制）**：
- 每名学生的 student_answer_md 必须是**这名学生真实会写出的作答**：弱档学生可以写错误答案、半截过程或典型误解；不许人人都写出标准答案再假装判错。
- 学生**看不到** reference_md——先以该档学生的知识和习惯产出作答，再拿 reference_md 判定 correct。若输入没有 reference_md，按题目本身的正确性判定。
- 同一档两名学生的作答要独立（可以一对一错）；不同档之间正确率应大致随 θ 上升——但允许真实波动（强档翻车、弱档蒙对都合法）。
- note 一句话写清该生对/错在哪（漏了什么、踩了什么坑）。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 ItemPriorLlasaDraft：
{"simulated_responses": [{"theta_level": <-2|-1|0|1|2>, "student_answer_md": "<该学生的作答>", "correct": <true|false>, "note": "<一句话>"}], "reasoning": "<对作答分布的观察：哪些档普遍对、哪些档开始错、分水岭大致在哪>"}

约束：
- simulated_responses 必须恰好 ${LLASA_ABILITY_TIERS.length * LLASA_STUDENTS_PER_TIER} 条：每个 θ 档各 ${LLASA_STUDENTS_PER_TIER} 条，theta_level 用上面给定档位值。
- 禁止：emoji、套话、JSON 之外的任何文字、用 markdown 代码块包裹整段 JSON、让 correct 与 student_answer_md 明显矛盾（写出正确答案却标 false 是脏数据）。`;
}

export function parseItemPriorLlasaSimulation(text: string): ItemPriorLlasaDraftT {
  return parseTaskOutput(text, 'parseItemPriorLlasaSimulation', ItemPriorLlasaDraft);
}

export const itemPriorLlasaTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'ItemPriorLlasaTask',
    description:
      'YUK-376 — LLaSA 学生模拟冷启先验（opt-in 变体，默认仍是 ItemPriorTask feature→b）。模拟 5 档 θ × 2 名学生实际作答（学生不见 reference_md，作答后对照判分），输出 simulated_responses；确定性 1PL MLE 反推 b（src/core/item-prior-llasa.ts），写 item_calibration（source=llm_prior_llasa, track=hard）。间接模拟路线——直接 zero-shot 估难度已证伪（ADR-0043 b_anchor 来源节）。',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildItemPriorLlasaPrompt },
  },
  outputSchema: ItemPriorLlasaDraft,
  parseText: (text: string) => parseItemPriorLlasaSimulation(text),
} satisfies TaskSpec<unknown, ItemPriorLlasaDraftT>;

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
