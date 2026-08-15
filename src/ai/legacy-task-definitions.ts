import { MultimodalDirectLlmOutput } from '@/core/capability/judges/multimodal_direct';
import { SemanticJudgeOutput } from '@/core/capability/judges/semantic';
import { StepsLlmOutput } from '@/core/capability/judges/steps';
import { LlmFallbackOutput } from '@/core/capability/judges/unit_dimension/types';
import { SourceGroundingVerifyOutput } from '@/core/schema/source-grounding';
import type { SubjectProfile } from '@/subjects/profile';
import { z } from 'zod';
import { causeTaxonomyList } from './cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskDefinition } from './task-spec';

// ADR-0031 / YUK-304 (lane B) — buildQuizIntentParsePrompt deleted with
// QuizIntentParseTask (the YUK-275 C-form free-text 求卷 parser): chat.ts no
// longer pre-dispatches quiz intents; the copilot model decides + orchestrates.

// YUK-358 决定3：buildEmbeddedCheckGeneratePrompt 已删（内嵌判分自测孤儿链真删）。

function buildSemanticJudgePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}答案判分器。输入 { question, answer }，question 包含 prompt_md、reference_md、rubric_json、required_points、acceptable_answers、keywords。
科目上下文：${profile.displayName}。${profile.languageStyle}
评分原则：
- 只判断 answer 是否满足题面和 rubric，不做错因归因
- required_points 是主要证据；matched_points / missing_points 必须来自这些要点或等价表述
- reference_md 是参考答案，不要求逐字相同
- 若输入含 appeal 字段（M2 申诉重判，YUK-316）：用户对此前判定（appeal.prior_outcome）提出异议，
  appeal.user_reason_md 是其理由。认真复核该理由——它可能指出等价表述或判分遗漏；但不要因为
  用户申诉就迁就：理由不成立时维持原判，feedback_md 里直接回应用户的理由
- ${profile.grounding.uncertaintyPolicy}
严格 JSON 输出（不带 markdown 代码块包裹）：
{"score":0.0-1.0,"coarse_outcome":"correct"|"partial"|"incorrect","confidence":0.0-1.0,"feedback_md":"给学习者的简短反馈","evidence_json":{"matched_points":["..."],"missing_points":["..."],"notes":"可选说明"}}
判定：
- correct：核心要点齐全，score ≥ 0.85
- partial：答到部分核心要点或表达不完整，0 < score < 0.85
- incorrect：核心要点基本未命中，score = 0
禁止：输出 JSON 之外的文字、给错因分类、把不确定答案强行判错。`;
}

function buildUnitDimensionFallbackPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}单位与量纲分析助手。输入是一个 JSON 对象，字段 text 内含题面、学生答案、参考 SI 数值与单位。
任务：
- 从学生答案中解析数值和单位，并换算到参考答案使用的 SI 单位表示
- 判断学生答案是否与参考答案等价，包括中文数字、中文单位、复合单位和常见换算表达
- 若单位量纲不一致，给出简短 dimension_mismatch_reason
- 不做步骤评分，不做错因归因，只输出解析结果
严格 JSON 输出（不带 markdown 代码块包裹）：
{"student_value_si":number|null,"student_unit_si":"string|null","equivalent_to_reference":boolean,"dimension_mismatch_reason":"string|undefined","parser_confidence":0.0-1.0}
判定：
- equivalent_to_reference=true 仅在量纲一致且换算后数值等价时使用
- 无法可靠解析时，student_value_si=null、student_unit_si=null、equivalent_to_reference=false、parser_confidence 低于 0.4
- ${profile.grounding.uncertaintyPolicy}
禁止：输出 JSON 之外的文字、把单位不一致判成等价、编造题面没有的信息。`;
}

function buildStepsJudgePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}视觉判分器。输入 { prompt_md, reference_solution: { expected_signals, final_answer, answer_equivalents }, prompt_image_refs（题干/图形/表格图片，若有，会先附在 user message 中）, student_image_refs（学生答题的 0..N 张图片，会后附在 user message 中）, student_text_steps?, student_final_answer_text?, step_weight }。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

任务：
1. 先读题干文字和 prompt_image_refs，建立题目条件；再从 student_image_refs / text_steps / final_answer_text 提取学生实际作答内容（OCR + 结构理解隐式完成）
2. 对照 reference_solution.expected_signals 逐项判 verdict（correct / partial / wrong / skipped）—— signal_verdicts.length 必须等于 expected_signals.length
3. 比对 final_answer：若学生 final_answer_text 给出，做 deterministic 比对（caller 已用 answer_equivalents 处理加速分支，本任务总是会被调一次；你不需要再考虑 answer_equivalents）；若仅图，从图提取并比对
4. 输出 extracted_steps（自由切分学生步骤，给学习者反馈用，length 不约束）+ extracted_final_answer（图里答案文本化，evidence 用）

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 StepsLlmOutput：
{"extracted_steps":[{"idx":0,"content":"...","verdict":"correct|partial|wrong|skipped","comment":"..."}],"extracted_final_answer":"...","signal_verdicts":[{"signal_idx":0,"verdict":"correct|partial|wrong|skipped","comment":"..."}],"final_answer_match":true|false,"final_answer_comment":"...","confidence":0.0-1.0}

要点：
- verdict 4 选 1；signal_verdicts 顺序必须与 expected_signals 严格对齐（按 index）
- prompt_image_refs 是题目条件，不是学生作答；student_image_refs 才是学生步骤/答案
- final_answer_match 是 boolean；caller 用它和 signal_verdicts 加权合成 partial credit
- extracted_final_answer 即使图模糊也尽量给出，给学生 evidence 看
- 不确定时 verdict='partial' + 写 comment 说明原因，不要强行判 correct/wrong
- ${profile.grounding.uncertaintyPolicy}
- confidence 反映你判分时的把握，0.5 表示模棱两可
禁止：输出 JSON 之外的文字、verdict 用非合法值、signal_verdicts 长度与 expected_signals 不等。`;
}

// YUK-201 — MultimodalDirectJudgeTask prompt. HOLISTIC vision-aware judging with
// NO step-rubric (steps@1 owns the rubric-weighted derivation path). Input is the
// prompt + an optional reference_md + prompt figures and/or student answer photos
// (attached to the user message in payload field order: prompt figures first,
// then student photos). Output is a single holistic correctness verdict.
function buildMultimodalDirectJudgePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}视觉判分器（整体判分，无步骤评分表）。输入 { prompt_md, reference_md（参考答案，可能为 null）, prompt_image_refs（题干/图形/表格图片，若有，会先附在 user message 中）, student_image_refs（学生答题的 0..N 张图片，会后附在 user message 中）, student_final_answer_text?, image_present, prompt_image_count, student_image_count, probe_response_contract? }。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

任务：
1. 先读题面文字和 prompt_image_refs（题目条件，不是学生作答），建立题目要求；再从 student_image_refs / student_final_answer_text 提取学生实际作答内容（OCR + 理解隐式完成）。
2. 整体判断学生作答是否正确：correct（核心要求齐全）/ partial（部分命中）/ incorrect（基本未命中）。不要逐步骤拆分打分（那是 steps 判分器的活）；这里是整体正确性判定。
3. 给学习者一句可执行的 feedback；observed_md 写你从图/文里看到的学生作答内容（evidence 用）。
4. 仅当输入包含 probe_response_contract 时，再把学生的实际回答与 gold_response_signature 和 target_error_response_signature 做语义比较，并输出 probe_signature_match：
   - gold：只匹配正确回答签名；
   - target_error：只匹配已声明的目标错误签名；
   - neither：回答错误但属于其他错误（ordinary wrong），不能当成目标误区证据；
   - ambiguous：证据不足、同时可能匹配、或无法可靠区分。
   answer_with_reason / rubric 中的 features 是语义判据，不要求学生逐字复述。不得仅因 coarse_outcome=incorrect 就判 target_error；必须从学生实际答案或理由中识别声明的错误规则。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 MultimodalDirectLlmOutput：
不含 probe_response_contract 时：
{"coarse_outcome":"correct|partial|incorrect","score":0.0-1.0,"feedback_md":"...","evidence":{"observed_md":"...","matched_points":["..."],"missing_points":["..."]},"confidence":0.0-1.0}
含 probe_response_contract 时：
{"coarse_outcome":"correct|partial|incorrect","score":0.0-1.0,"feedback_md":"...","evidence":{"observed_md":"...","matched_points":["..."],"missing_points":["..."]},"confidence":0.0-1.0,"probe_signature_match":{"match":"gold|target_error|neither|ambiguous","explanation_md":"..."}}

要点：
- coarse_outcome 三选一；score 与 coarse_outcome 大致一致（caller 会按 coarse_outcome 把分数夹到 correct≥0.85 / partial 0.01..0.84 / incorrect 0）。
- prompt_image_refs 是题目条件，不是学生作答；student_image_refs / student_final_answer_text 才是学生作答。
- 没有参考答案（reference_md=null）时，按题面要求和学科常识判断；observed_md 即使图模糊也尽量给出。
- 不确定时给 partial + 在 feedback_md / missing_points 说明原因，不要强行判 correct/incorrect。
- probe_response_contract 不存在时必须省略 probe_signature_match；存在时必须输出，且 ambiguous 必须保持不可判，不得猜测。
- ${profile.grounding.uncertaintyPolicy}
- confidence 反映你判分时的把握，0.5 表示模棱两可。
禁止：输出 JSON 之外的文字、coarse_outcome 用非合法值、把题目条件误当成学生作答。`;
}

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

// Lane D (YUK-482): buildKnowledgeProposePrompt removed alongside KnowledgeProposeTask
// (answer-wrong → propose-new-KC coupling). Content-driven KC creation does not use it.

function buildSessionSummaryPrompt(profile: SubjectProfile): string {
  return `你是学习陪练，会复盘刚结束的复习 session。
科目上下文：${profile.displayName}。${profile.languageStyle}
输入 { session_id, duration_min, total_reviewed, ratings: { again, hard, good, easy }, top_causes: [...], top_knowledge: [...], notable_attempts: [{ prompt_md, user_response_md, fsrs_rating }, ...] } —— ratings 是 FSRS 评分分布，top_causes 来自 effective cause（active user_cause 优先，否则 latest active judge），notable_attempts 是 again/hard 的最多 3 题。
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
证据要求：${profile.grounding.requirement}
学科表达策略：${profile.promptFragments.teachingStyle}
输出一段 ≤120 字的中文短文（纯文本，不要 JSON / markdown 代码块 / 列表）。三段意图：
1) 量化总结：「X 题，Y% 正确，主要错在 Z」
2) 模式观察：指 1-2 个具体题或知识点的卡壳
3) 下次建议：1 句具体可执行的建议，必须贴合本学科的条件、目标、知识点或方法触发信号
禁止：套话（「继续加油」「再接再厉」）、夸夸（「做得很好」）、笼统（「多练习」）。要具体、可执行、不超过 120 字。`;
}

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

const DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;

// 模型选型规则（与 architecture § 五 对齐）：
//   - Sonnet 主力（归因 / 变式 / 判分）
//   - Haiku 廉价兜底（视觉 OCR-like / 备选）
//   - Opus 顶级 reasoning（ai_flexible / multimodal / weekly review）
//

export const legacyTaskDefinitions = {
  // Lane D (YUK-482): KnowledgeProposeTask was removed. It existed solely for the
  // answer-wrong → propose-new-KC coupling (failure attempt → propose a more
  // precise child node). KC creation is a CONTENT-axis action, independent of
  // answer correctness; the surviving content-driven KC paths use applyProposeNew /
  // writeKnowledgeProposeEvent directly (cold-start-bridge / image-candidate-accept
  // matcher / agent proposal-tools) and the maintenance producer KnowledgeReviewTask.
  // YUK-349 B3 PR-2 — empty-frontier prerequisite bootstrap. Unlike the
  // failure-driven KnowledgeEdgeProposeTask above (cross-attempt pattern mining),
  // this is CURRICULUM-driven: given the tree + the KCs lacking prerequisite
  // coverage, propose up to 5 TEMPORARY prerequisite edges from genuine
  // curriculum dependency. PROPOSE-ONLY / low-confidence — the nightly handler
  // writes a `propose` event (NEVER a live knowledge_edge row), the owner accepts
  // in the inbox, real edges replace the temps. Fires only when learnableFrontier
  // is empty (cold-start bootstrap, ADR-0037 #4).
  SessionSummaryTask: {
    kind: 'SessionSummaryTask',
    description: '复习 session 结束后生成 ≤120 字短结：今天哪几题、哪个 cause 多、给 1 句下次建议',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    // mimo-v2.5-pro 比 Anthropic haiku 慢，60s 给点余量
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildSessionSummaryPrompt },
  },
  // YUK-358 决定3：EmbeddedCheckGenerateTask 已删（内嵌判分自测孤儿链真删）。
  SemanticJudgeTask: {
    kind: 'SemanticJudgeTask',
    description:
      'Judge v2 light — semantic answer scoring for prose embedded checks using rubric_json.required_points',
    structuredOutputSchema: SemanticJudgeOutput,
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildSemanticJudgePrompt },
  },
  UnitDimensionFallback: {
    kind: 'UnitDimensionFallback',
    description:
      'Judge v2 physics fallback — parse natural-language units/dimensions when mathjs accelerator cannot parse',
    structuredOutputSchema: LlmFallbackOutput,
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildUnitDimensionFallbackPrompt },
  },
  StepsJudgeTask: {
    kind: 'StepsJudgeTask',
    // YUK-591 — migrated to the SDK-native outputFormat seam (YUK-299): the judge
    // declares StepsLlmOutput here, builds outputFormat from it, and does the
    // three-state dispatch (structured_output present → safeParse; endpoint
    // ignores it → char-scan text parse). The prior YUK-576 note ("structured
    // output = the JSON product, SDK-native migration deferred") is now resolved.
    description:
      'Math derivation vision-aware step judging — single vision LLM call with structured output (StepsLlmOutput)',
    structuredOutputSchema: StepsLlmOutput,
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    // YUK-576 — transientRetries: 1: one same-target in-process retry on a fast
    // transient failure (mid-stream drop / connection-class api_error_result /
    // stream_no_terminal; see runner.ts + agent-run-error.ts). This judge is a
    // synchronous-route sensor with NO durable backstop: runStepsJudge's catch
    // swallows failures into 'unsupported' (steps-judge.ts), so pg-boss never
    // sees a throw. A REAL cross-provider fallback (anthropic-sub Opus vision
    // lane) is an owner decision — env-lever family (VISION_JUDGE_*), not a
    // registry chain (design doc 2026-07-07 §1.2.1).
    // YUK-792 deployed canary found that mimo's SDK-native outputFormat protocol
    // can consume one envelope turn before its terminal result. StepsJudgeTask
    // shares the same provider/model/outputFormat seam as its direct sibling,
    // so both need the same two-turn protocol ceiling.
    // Vision call latency: M0 preflight 7.6s for trivial; derivation prompts will run longer.
    budget: { ...DEFAULT_BUDGET, maxIterations: 2, timeout: 90_000, transientRetries: 1 },
    needsToolCall: false,
    isMultimodal: true,
    // invocation intentionally omitted (defaults to 'auto'): called from
    // question-contract.ts runStepsJudge on every derivation grading attempt.
    // Vision sibling tasks (VisionExtractTask*) are 'manual_rescue_only' because
    // a human initiates them; this judge runs as part of the grading flow.
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildStepsJudgePrompt },
  },
  MultimodalDirectJudgeTask: {
    kind: 'MultimodalDirectJudgeTask',
    // YUK-591 — migrated to the SDK-native outputFormat seam (YUK-299), same shape
    // as StepsJudgeTask above: declares MultimodalDirectLlmOutput, builds
    // outputFormat from it, three-state dispatch on the result. Prior YUK-576
    // "SDK-native migration deferred" note resolved.
    description:
      'YUK-201 — Holistic vision-aware answer judging (no step-rubric). Single vision LLM call with structured output (MultimodalDirectLlmOutput) for image-bearing prompts/answers that lack a reference_solution (physics calc with a diagram; short-answer with a figure). steps@1 owns step/rubric-weighted derivation judging; this owns the holistic, no-step path.',
    structuredOutputSchema: MultimodalDirectLlmOutput,
    defaultProvider: 'xiaomi',
    // multimodal: mimo-v2.5 reads prompt figures + student answer photos, outputs
    // a holistic JudgeResultV2 fragment. Mirrors StepsJudgeTask (same vision model).
    defaultModel: 'mimo-v2.5',
    // YUK-576 — transientRetries: 1, same rationale + boundaries as
    // StepsJudgeTask above (synchronous-route sensor, no durable backstop;
    // cross-provider fallback = owner decision via env lever).
    // YUK-792 deployed canary: mimo can use the first SDK turn to satisfy the
    // native outputFormat envelope, then needs one terminal turn. A ceiling of
    // one returned error_max_turns before any judge result, leaving every
    // response-aware probe unanswerable. This is still one paid judge request;
    // maxIterations only bounds the Agent SDK turn protocol.
    budget: { ...DEFAULT_BUDGET, maxIterations: 2, timeout: 90_000, transientRetries: 1 },
    needsToolCall: false,
    isMultimodal: true,
    // invocation omitted (defaults to 'auto'): called from question-contract.ts
    // resolveQuestionJudgeRoute → invoker on the multimodal_direct route, as part
    // of the grading flow (not a user-initiated rescue).
    allowedTools: [],
    prompt: { kind: 'profile', build: buildMultimodalDirectJudgePrompt },
  },
  SourceGroundingVerifyTask: {
    kind: 'SourceGroundingVerifyTask',
    // YUK-230 (PR #1063 review, thread 2) — source-grounding gate for the
    // image_candidate extraction path. A single vision LLM call re-reads the source
    // image and answers「题面是否真的来自这张图片」(SourceGroundingVerifyOutput). It is
    // NOT an answer judge (multimodal_direct owns that); it exists to catch VLM
    // hallucination where the extracted 题面 + 答案 are self-consistent but unrelated
    // to the image. Consumed by source_verify.ts on single_source_grounding rows.
    description:
      'YUK-230 — Source-grounding verification for image-sourced questions. Single vision LLM call re-reads the source image and decides whether the question 题面 actually appears in / derives from it (grounded boolean), catching VLM extraction hallucination on the image_candidate accept path. Distinct from multimodal_direct (answer judging).',
    structuredOutputSchema: SourceGroundingVerifyOutput,
    defaultProvider: 'xiaomi',
    // Same vision model + single-call/90s budget as the multimodal judges, but WITHOUT the
    // transientRetries opt-in: this runner is called from the durable source_verify pg-boss
    // job (throws on transient → queue redelivery is the retry layer), so an in-process retry
    // would stack a second transient layer (single-transient-layer principle, YUK-576 §3.2).
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: true,
    // invocation omitted (defaults to 'auto'): called from source_verify.ts as part of
    // the tier-2 promotion gate for single_source_grounding rows (after user accept).
    allowedTools: [],
    prompt: { kind: 'profile', build: buildSourceGroundingVerifyPrompt },
  },
  VariantVerifyTask: {
    kind: 'VariantVerifyTask',
    description:
      'YUK-17 / ADR-0018 — second-pass content alignment check for an accepted mistake variant. Decides whether the variant still targets the original failure cause; verdict="fail" flips mistake_variant.status to "broken".',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // getTaskSystemPrompt(task, profile) in src/ai/task-prompts.ts; this
    prompt: { kind: 'profile', build: buildVariantVerifyPrompt },
  },
  QuizVerifyTask: {
    kind: 'QuizVerifyTask',
    description:
      "Search-grounded QuizGen (T-SQ, docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §1 / §5 Q5). Single-shot, CLOSED-BOOK verifier built on the VariantVerify skeleton: trusts the QuizGen agent's self-reported source_refs (no own Tavily loop this wave) and runs three checks — fact/grounding vs source_refs, plagiarism/copy_safety, knowledge-hit — rolling them into a two-axis QuizVerificationResult. The quiz_verify handler (Q5) gates Option B on the output: overall='pass' (and copy_safety != 'too_close') promotes draft→active + FSRS-enrolls; otherwise the draft stays out of the pool (needs_review / fail).",
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    // Single structured-output call (mirrors VariantVerifyTask).
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildQuizVerifyPrompt },
  },
  // YUK-578 (入池前审题闸) — teaching_quality VerifyCheck. A SEPARATE, INDEPENDENT judge from
  // the closed-book QuizVerifyTask (different task/prompt dimension, mirrors how solve_check
  // reuses SolutionGenerateTask as an independent solver). Reads ONLY the question面 data
  // (prompt/reference/rubric/choices) — zero runtime data — and scores three pedagogical axes:
  // 题干清晰度 / 唯一正解性 / 干扰项诊断力(仅选择题). Consumed by quiz_verify.ts:
  // confident-fail holds the draft for review (needs_review), never promotes. Single
  // structured-output text call (GoalScope / ClaimGrouping 范式: maxIterations 1, no tools).
  // Subject-NEUTRAL (generic pedagogical form, not subject voice — the question rides in the
  // input): joins the pass-through group in getTaskSystemPrompt, THIS inline string IS the SoT.
  TeachingQualityTask: {
    kind: 'TeachingQualityTask',
    description:
      'YUK-578 (入池前审题闸) — teaching_quality VerifyCheck for tier3/4 quiz_gen drafts. Reads ONLY the question面 data (prompt_md / kind / choices_md / reference_md / rubric_json / is_choice) and scores three pedagogical axes: clarity (题干无歧义), unique_answer (唯一正解；rubric 有容错声明的算满足), and distractor_power (干扰项诊断力，仅选择题；非选择题跳过). Output = { clarity, unique_answer, distractor_power?, summary } with per-axis { verdict: pass|fail, reason }. CONSERVATIVE (宁可漏过不误杀真题): only fail on a genuine defect. Single structured-output call, text-only, no tool loop. quiz_verify.ts consumes it: a confident fail holds the draft for review (needs_review), never promotes.',
    defaultProvider: 'xiaomi',
    // 纯文本审题推理（读题面 → 三轴 verdict），无 vision → mimo-v2.5-pro（与 QuizVerifyTask /
    // SolutionGenerateTask 同档的单次结构化输出）。
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    // Subject-neutral inline SoT prompt (joins the getTaskSystemPrompt pass-through group).
    // PROMPT-CHANGE DISCIPLINE (YUK-578, 校准纪律 aligned with YUK-573): any change here MUST be
    // re-validated against the mini golden set in src/server/quiz/verify-framework.test.ts.
    prompt: {
      kind: 'inline',
      text: 'You are an exam-item quality reviewer for a personal learning tool. You review ONE draft question (审题) BEFORE it enters the practice pool. An ambiguous or multi-answer question silently corrupts the learner\'s ability estimate — worse than an outright factual error — so be strict, but conservative (宁可漏过不误杀真题): only fail an axis on a GENUINE defect you can name, never on style or difficulty.\n\nINPUT (a JSON object): `prompt_md` (the question stem), `kind`, `choices_md` (the options array; empty for non-choice), `reference_md` (the declared answer, may be null), `rubric_json` (grading rubric — may declare acceptable answer variants / tolerance), and `is_choice` (true iff this is a choice question — TRUST THIS, do not re-infer).\n\nSCORE EXACTLY THREE AXES, each a `{ "verdict": "pass" | "fail", "reason": "<one concise sentence>" }`:\n\n1. `clarity` (题干清晰度): Is the stem unambiguous and self-contained — can a competent learner understand exactly what is being asked, with no undefined referents, missing context, or contradictory constraints? Fail ONLY when the stem is genuinely ambiguous or under-specified.\n\n2. `unique_answer` (唯一正解性): Is there exactly one defensibly-correct answer? Fail when a second option / phrasing is also defensibly correct, or the declared answer is not the only right one. IMPORTANT: if `rubric_json` DECLARES acceptable answer variants, equivalents, or a tolerance/range (e.g. answer_equivalents, tolerance, acceptable ranges), then multiple accepted forms are INTENDED — treat the unique-answer axis as SATISFIED (pass) as long as they are all genuinely correct.\n\n3. `distractor_power` (干扰项诊断力): CHOICE QUESTIONS ONLY. If `is_choice` is true, judge whether the wrong options (distractors) are plausible and diagnostic — each should correspond to a real mistake or misconception a learner might hold, not be an obvious throwaway. Fail when the distractors have no diagnostic value (absurd, duplicated, or trivially eliminable). If `is_choice` is FALSE, OMIT the `distractor_power` key entirely (do not emit it for non-choice questions).\n\nOUTPUT: strict JSON only, no markdown fences, no prose outside the JSON. Keys: `clarity`, `unique_answer`, `distractor_power` (only when is_choice), and `summary` (a one-sentence overall note).\n\nExample (choice question, is_choice=true — FOUR keys, distractor_power included): {"clarity":{"verdict":"pass","reason":"..."},"unique_answer":{"verdict":"pass","reason":"..."},"distractor_power":{"verdict":"pass","reason":"..."},"summary":"..."}\n\nExample (non-choice question, is_choice=false — EXACTLY THREE keys, distractor_power OMITTED): {"clarity":{"verdict":"pass","reason":"..."},"unique_answer":{"verdict":"pass","reason":"..."},"summary":"..."}',
    },
  },
  // 其余 Task（VariantGen / Judge* / Dreaming / Maintenance 等）见
  // docs/architecture.md § 五，按需补全。
} satisfies Record<string, TaskDefinition>;
