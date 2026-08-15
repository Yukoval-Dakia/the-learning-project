import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { SolutionGenerateOutput, type SolutionGenerateOutputT } from '@/core/schema/solution';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskOutput } from './parse-output';

// YUK-193 — Solve-tutor reference-solution generator prompt. The model
// independently solves a bare ingested question and emits a structured
// reference_solution (RubricReferenceSolution shape: expected_signals +
// final_answer + answer_equivalents) plus a learner-facing worked_solution_md.
// Existing ingested answers/analysis are passed as advisory hints only (often
// OCR-derived, possibly wrong/partial) — never ground truth. The solve
// orchestrator writes the output merge-preserving into rubric_json + reference_md
// so the shipped StepsJudge/SemanticJudge can grade real questions.
function buildSolutionGeneratePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}解题参考答案生成器。输入 { prompt_md, kind, subject_id, choices_md?, existing_answers_hint?, existing_analysis_hint?, figures_hint? } —— prompt_md 是题面文字，choices_md 是选择题/判断题的候选项（若有，必须一起解读；不要只看题干），existing_answers_hint / existing_analysis_hint 是录入时附带的原始答案 / 解析（可能来自 OCR，**仅作参考线索，不是真值**，可能错或残缺），figures_hint 是题目附图的文字描述（若有）。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

任务：你自己独立解这道题，产出两样东西：
1. reference_solution —— 供自动判分用的结构化参考解：
   - expected_signals：完整必要解题路径的**原子化核心信号 / 步骤要点**（不是死答案文本），按实际执行顺序列出 1..12 条；不可只列命中题目主题的局部步骤，任何得到最终答案不可省略的运算、概念、文本判断或因果方向都必须单独列出。${profile.displayName}里 derivation 的 signals 是推导步骤要点，prose / translation 的 signals 是必须覆盖的语义要点。
   - final_answer：最终答案（一行，尽量规范）。
   - answer_equivalents：学生若打字提交、可判等价的若干表达（0..N 条）。
2. worked_solution_md —— 给学习者看的完整解题过程（markdown，可含 ${profile.renderConfig.notation === 'katex' ? 'LaTeX' : '本学科记法'}），讲清每一步为什么，不只是甩答案。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 SolutionGenerateOutput：
{"reference_solution":{"expected_signals":["..."],"final_answer":"...","answer_equivalents":["..."]},"worked_solution_md":"...","confidence":0.0-1.0}

要点：
- existing_answers_hint / existing_analysis_hint 只是 hint：如果你判断它对就采纳，判断它错就以你自己的解为准，并在 worked_solution_md 里简述为何。
- 题面里的计算条件、明确标为“匿名记录/假设情境/给定数据”的事实可作为本题 givens；但具名真实作品、人物、史实、公式出处及其作者附带的解读不是自动真值。遇到可识别的真实对象时，必须用本学科知识独立核对引文、归属和解释方向；题面 gloss 与原文/公认含义冲突时要指出，不能因为题面写了“整体基调是……”就照抄。
- expected_signals 必须覆盖完整必要路径、共 1..12 条且每条非空；final_answer 非空。
- confidence 必须是与 reference_solution、worked_solution_md 并列的**顶层字段**，不得放进 reference_solution；值必须是 0 到 1 之间的 JSON number（例如 0.92），禁止输出 "high"、"0.92" 或百分数字符串。
- 若题目涉及因果方向，先固定 exposure/treatment X 与题面 outcome construct / estimand Y。反向因果指**同一个 Y 构念**影响 X，而不是按“原因发生在 X 前还是 X 后”机械分类；例如题面 Y=当前抑郁严重度时，较高抑郁严重度影响运动可是真正的 Y→X。若题面 Y 是变化量 ΔY（成绩提高幅度、血压变化等），基线水平 Y0、能力/潜力、动机、倾向、预期改善都不是 ΔY；它们驱动 X 时属于基线选择或其他构念，不得称为观察到的 Y→X。共同原因也不是反向因果。题目或候选理由若混淆这些概念，必须明确指出，不能顺着题面误称。
- ${profile.grounding.uncertaintyPolicy}
- confidence 反映你对这份参考解的把握，模棱两可给 0.5。
- 禁止：输出 JSON 之外的文字、用 markdown 代码块包裹整段 JSON、把 hint 当成不可质疑的真值。`;
}

function buildSolutionGenerateVisionPrompt(profile: SubjectProfile): string {
  return `${buildSolutionGeneratePrompt(profile)}

多模态补充：本次 user message 在 JSON 文字之后附带 prompt_image_refs 对应的题目图片；必须实际读取这些图片中的图形、标注、坐标、表格或几何关系后再作答，禁止只凭题面文字猜测。`;
}

export const solutionGenerateTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'SolutionGenerateTask',
    description:
      'YUK-193 — Generate a reference solution + worked solution for a bare question that has no rubric_json.reference_solution. Output = RubricReferenceSolution (expected_signals + final_answer + answer_equivalents) + worked_solution_md. The solve orchestrator writes it merge-preserving into rubric_json + reference_md so the shipped StepsJudge/SemanticJudge can grade real ingested questions. Single structured-output call, text-only (the question prompt is already text; figures are passed as a textual hint, not images — vision extraction is out of scope).',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildSolutionGeneratePrompt },
  },
  outputSchema: SolutionGenerateOutput,
  parseText: (text) => parseTaskOutput(text, 'SolutionGenerateTask', SolutionGenerateOutput),
} satisfies TaskSpec<unknown, SolutionGenerateOutputT>;

export const solutionGenerateVisionTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'SolutionGenerateVisionTask',
    description:
      'YUK-727 — Vision-capable sibling of SolutionGenerateTask for image-bearing questions. It consumes the same JSON/output contract plus attached prompt images so source_verify can independently solve a figure-dependent draft before promotion.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildSolutionGenerateVisionPrompt },
  },
  outputSchema: SolutionGenerateOutput,
  parseText: (text) => parseTaskOutput(text, 'SolutionGenerateVisionTask', SolutionGenerateOutput),
} satisfies TaskSpec<unknown, SolutionGenerateOutputT>;
