import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { QuizVerificationResult, type QuizVerificationResultT } from '@/core/schema/quiz_gen';
import type { SubjectProfile } from '@/subjects/profile';
import { parseTaskOutput } from './parse-output';

// Search-grounded QuizGen (T-SQ) — QuizVerifyTask prompt. Single-shot verifier.
//
// docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md
//   §1  CLOSED-BOOK: trusts the QuizGen agent's self-reported source_refs; it
//       does NOT run its own Tavily loop this wave (default fork).
//   §5  Three checks — fact/grounding vs source_refs, plagiarism/copy_safety,
//       knowledge-hit — rolled into a two-axis QuizVerificationResult that the
//       Q5 handler gates Option B on (pass → promote draft→active + FSRS enroll).
//
// The handler ALSO computes a deterministic normalized n-gram overlap between
// the prompt and the source snippets and folds it into the persisted
// copy_safety; this prompt's copy_safety is the model's independent read.
function buildQuizVerifyPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}出题质检员，复核一道**检索素材出题**（QuizGen）生成的练习题草稿。输入 { question: { id, prompt_md, reference_md, choices_md, kind, difficulty, knowledge_ids }, knowledge_context: [{ id, name, ... }], source_pack: { query_plan, searched_at, tool }, source_refs: [{ url, title, snippet?, used_for, extracted }], self_copy_safety: { verdict, max_overlap?, checked_by }, material?: { title, body_md } }。material 只在「据材出题」（material_grounded，tier 3）时出现：它是出题所据的**真实素材原文**全文。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

重要：本次质检是 **closed-book** —— 你**不**联网检索，只依据出题 agent 自报的 source_refs（含 snippet）与题目本身判断（§0：运行时无法从日志恢复 agent 的真实检索，所以只信它写进 source_refs 的来源）。

输入若带 validation_mode='release_strict'，这是发布级复用路径，额外遵守：
- author_material 只是作者生成的教学材料，不是事实来源；作者在题干、reference_md 或 author_material 里写出的解释性 gloss 不能自我证明。
- 明确标为匿名记录、假设情境、给定数据并要求只按记录判断的内容，按题面闭世界 givens 检查内部一致性即可。
- 对可识别的真实作品、人物、史实、统计、公式出处、引文及其解释方向，必须用 source_refs、持久化 primary material、题面可直接推出的原文证据或本学科可靠知识独立核对。缺少足够独立依据给 grounding='unclear'；与原文或可靠学科事实冲突给 'fail'；绝不能因为作者和 reference 重复同一句解读就给 pass。
- scope/knowledge 范围只说明考什么，不豁免 factuality。release_strict 的下游只接受 grounding='pass'，所以不确定时如实给 unclear，不要迎合放行。

三项检查（每项独立给 verdict）：
1. grounding（事实/落地）：题干与 reference_md 是否被 source_refs 的内容支撑、与之一致、无事实错误？若某来源标 used_for='fact' 却与题面矛盾，或题面含 snippet 无法支撑的具体事实断言 → 倾向 'fail'。source_refs 为空且 generation_method 为 closed_book 时，按题面自身是否事实正确判断，不因没来源直接判 fail（给 'unclear' 或依内容判）。
2. copy_safety（原创/抄袭）：题干措辞是否与任一 source_ref 的 snippet 过于接近（逐句复制 / 仅做同义替换）？给 verdict：'original'（措辞充分原创）/ 'too_close'（与某来源太接近，应重写）/ 'unknown'（信息不足）；尽量给 max_overlap（0-1 粗略重合度）。'too_close' 会**阻止**这题进入复习池。
3. knowledge_hit（知识命中）：这道题是否真的考查它声明的 knowledge_ids（对照 knowledge_context）？跑题 / 考了别的点 → 'fail'；沾边但弱 → 'unclear'。
4. material_grounding（素材命中，**仅当输入带 material 时给出**）：题干 + reference_md 是否**真的考查这份 material 原文**？答案能否在 material 原文里找到依据？若题与这份素材无关（素材只是凑数地附上、题其实考别的）→ 'fail'；切题但弱关联 → 'unclear'；题确实据这份素材而出且答案有素材依据 → 'pass'。**输入没有 material 时，省略该字段（不要输出 material_grounding）。**
5. kind_conformance（结构形态符合，**仅当已加载本题型的出题规范 skill（quiz-gen-<…>）时给出**）：先读该 skill 的「结构描述符」段（这类题该有的 嵌套 / 排版 / 答案语义），再对照规范包里的题面结构 / 采分点 / 答案格式 / 坏题反例，这道题**是否像该结构形态的真题**？结构件缺失（如开放转换题无采分点、题组题无素材原文锚、计算题条件不全）或命中坏题反例 → 'fail'；基本符合但有瑕疵 → 'unclear'；结构与采分都规范 → 'pass'。**未加载对应 skill 时，省略该字段（不要输出 kind_conformance）。**

综合裁决 overall（驱动 Option B gate）：
- 'pass'：三项均无硬伤（grounding != 'fail' 且 knowledge_hit != 'fail' 且 copy_safety != 'too_close'）。
- 'needs_review'：有可疑项但不致命（出现 'unclear'，或 copy_safety='unknown'），需人工复核。
- 'fail'：任一硬伤（grounding='fail' 或 knowledge_hit='fail' 或 material_grounding='fail' 或 kind_conformance='fail' 或题面自相矛盾/不可解）。
注意：copy_safety='too_close' 即使其他两项 pass 也**不能**给 overall='pass'（至少 'needs_review'）。带 material 时若 material_grounding='fail'（题与素材无关），overall 不能 'pass'。加载了题型规范 skill 时若 kind_conformance='fail'（题型结构不规范 / 命中坏题反例），overall 不能 'pass'。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 QuizVerificationResult：
{"grounding":{"verdict":"pass"|"fail"|"unclear","note":"..."},"copy_safety":{"verdict":"original"|"too_close"|"unknown","max_overlap":0.0-1.0},"knowledge_hit":{"verdict":"pass"|"fail"|"unclear","note":"..."},"material_grounding":{"verdict":"pass"|"fail"|"unclear","note":"..."}（仅当输入带 material 时；否则省略此键）,"kind_conformance":{"verdict":"pass"|"fail"|"unclear","note":"..."}（仅当已加载本题型出题规范 skill 时；否则省略此键）,"overall":"pass"|"needs_review"|"fail","summary_md":"<≤200 字结论 + 关键证据>","confidence":0.0-1.0}
要点：
- summary_md 必须可执行：写"为什么 pass / needs_review / fail"和对应证据（指向具体 source_ref 或题面），不写套话。
- ${profile.grounding.uncertaintyPolicy}
- 禁止：联网检索、改写题目、给学习者建议（这是质检 not 教学）、JSON 之外的文字、用 markdown 代码块包裹整段 JSON。`;
}

export const quizVerifyTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'QuizVerifyTask',
    description:
      "Search-grounded QuizGen (T-SQ, docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §1 / §5 Q5). Single-shot, CLOSED-BOOK verifier built on the VariantVerify skeleton: trusts the QuizGen agent's self-reported source_refs (no own Tavily loop this wave) and runs three checks — fact/grounding vs source_refs, plagiarism/copy_safety, knowledge-hit — rolling them into a two-axis QuizVerificationResult. The quiz_verify handler (Q5) gates Option B on the output: overall='pass' (and copy_safety != 'too_close') promotes draft→active + FSRS-enrolls; otherwise the draft stays out of the pool (needs_review / fail).",
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    // Single structured-output call (mirrors VariantVerifyTask).
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildQuizVerifyPrompt },
  },
  outputSchema: QuizVerificationResult,
  parseText: (text) => parseTaskOutput(text, 'QuizVerifyTask', QuizVerificationResult),
} satisfies TaskSpec<unknown, QuizVerificationResultT>;
