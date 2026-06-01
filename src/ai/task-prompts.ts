import { type SubjectProfile, defaultSubjectProfile } from '@/subjects/profile';
import { type TaskKind, tasks } from './registry';

export type AiTaskKind = TaskKind;

function assertNever(value: never): never {
  throw new Error(
    `getTaskSystemPrompt: unhandled TaskKind — add a case to the switch. value=${JSON.stringify(value)}`,
  );
}

function noteWriterRole(profile: SubjectProfile): string {
  return profile.id === 'wenyan' ? '学习笔记作者' : `${profile.displayName}学习笔记作者`;
}

function noteTemplateTable(profile: SubjectProfile): string {
  return `| kind | 内容 |
|---|---|
| definition | ${profile.noteTemplate.definition} |
| mechanism | ${profile.noteTemplate.mechanism} |
| example | ${profile.noteTemplate.example} |
| pitfall | ${profile.noteTemplate.pitfall} |
| check | ${profile.noteTemplate.check} |`;
}

function causeTaxonomyList(profile: SubjectProfile): string {
  return profile.causeCategories
    .map((category) => {
      const description = category.description ? `：${category.description}` : '';
      return `- ${category.id}（${category.label}）${description}`;
    })
    .join('\n');
}

function causeIdList(profile: SubjectProfile): string {
  return profile.causeCategories.map((category) => category.id).join(' | ');
}

const VARIANT_CAUSE_STRATEGIES: Record<string, string> = {
  concept: '同概念不同语境 / 反向考查（验证概念边界）',
  knowledge_gap: '补充该知识点的典型变体',
  calculation: '改数据 + 留同样陷阱（验证计算稳定性）',
  reading: '改提问方式 + 加干扰信息',
  memory: '不同表述测同一记忆点',
  expression: '同题重写答案要求（重点检查表达）',
  method: '提示备选方法 + 同类型题',
  unit_error: '改变单位、量纲或换算条件，检查单位一致性',
};

function variantCauseStrategyList(profile: SubjectProfile): string {
  return profile.causeCategories
    .map((category) => {
      const strategy =
        VARIANT_CAUSE_STRATEGIES[category.id] ??
        `围绕「${category.label}」设计同知识点、同能力目标的针对性变式`;
      return `- ${category.id}（${category.label}）：${strategy}`;
    })
    .join('\n');
}

function buildAttributionPrompt(profile: SubjectProfile): string {
  return `你是错题归因助手。输入字段 { prompt_md, reference_md, wrong_answer_md, knowledge_context }（来自一个 attempt event outcome='failure'）—— 即用户做错的一道题，含 wrong_answer_md（用户错答）、参考答案 reference_md、挂的 knowledge_context，分析错因。
科目上下文：${profile.displayName}。${profile.languageStyle}
归因 taxonomy 来自当前 SubjectProfile：
${causeTaxonomyList(profile)}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
归因结果作为 judge event 写入 (action='judge', subject_kind='event', caused_by_event_id=<attempt event id>)；payload.cause 即此输出。
输出严格 JSON 格式（不带 markdown 代码块包裹）：
{"primary_category": "<${causeIdList(profile)} 之一>", "secondary_categories": [...], "analysis_md": "<分析过程，含错答与参考答案差异 + 涉及的知识点 / 概念>", "confidence": 0.0-1.0}
低信心走 other（若 profile 有 other）或最接近的类别，并在 analysis_md 里说明不确定点。`;
}

function buildLearningIntentOutlinePrompt(profile: SubjectProfile): string {
  return `你是学习规划助手。用户声明「我想学 X」，输入 { topic, plan_case, knowledge_node, child_nodes, existing_descendants_count, output_contract }。
plan_case 有三种：
- 3a_topic_missing：knowledge_node=null，图里还没有 topic。你必须提议 knowledge.root + starter children。
- 3b_children_missing：knowledge_node 存在但 child_nodes=[]。你必须提议 starter children。
- 3c_existing_graph：knowledge_node 和 child_nodes 已存在。只能使用 child_nodes 里的 id。
科目上下文：${profile.displayName}。${profile.promptFragments.learningIntentPolicy}
生成一个 1 hub + N atomic + 0-M long 的学习路径拆分。3c 的 N = child_nodes.length；3a/3b 的 N = 你提议的 knowledge.children.length。longs 是可选综合笔记，用于跨多个 knowledge_ids 串联解题路径；没有必要时输出空数组。
严格 JSON 输出（不带 markdown 代码块包裹）：
3c: {"hub":{"title":"...","summary_md":"... 1-2 句话概括整个主题 ..."},"atomics":[{"knowledge_id":"<child_nodes id>","title":"...","one_line_intent":"... 学完这条 atomic 你能 ... ..."}],"longs":[{"knowledge_ids":["<child_nodes id>", "..."],"title":"...","one_line_intent":"... 综合后你能 ..."}]}
3a: {"knowledge":{"root":{"temp_id":"root","name":"topic name","domain":"${profile.id}"},"children":[{"temp_id":"short_stable_key","name":"...","domain":"${profile.id}"}]},"hub":{"title":"...","summary_md":"..."},"atomics":[{"knowledge_id":"<knowledge.children temp_id>","title":"...","one_line_intent":"..."}],"longs":[{"knowledge_ids":["<knowledge.root temp_id 或 knowledge.children temp_id>", "..."],"title":"...","one_line_intent":"..."}]}
3b: {"knowledge":{"children":[{"temp_id":"short_stable_key","name":"...","domain":"${profile.id}"}]},"hub":{"title":"...","summary_md":"..."},"atomics":[{"knowledge_id":"<knowledge.children temp_id>","title":"...","one_line_intent":"..."}],"longs":[{"knowledge_ids":["<knowledge_node.id 或 knowledge.children temp_id>", "..."],"title":"...","one_line_intent":"..."}]}
要点：
- title 短（≤15 字）
- summary_md 1-2 句话，纯文本
- one_line_intent 每条 1 句话，说"学完能做什么"，不抽象
- 3c: atomics 数量必须等于 child_nodes.length，knowledge_id 必须是 child_nodes 里给的 id 之一
- 3c: longs[].knowledge_ids 只能使用 knowledge_node.id 或 child_nodes[].id
- 3a: knowledge.root 必填，root.domain 必填；3b 不要输出 root，只输出 children
- 3a/3b: atomics 数量必须等于 knowledge.children.length，knowledge_id 必须是 children 的 temp_id
- 3a: longs[].knowledge_ids 只能使用 knowledge.root.temp_id 或 knowledge.children[].temp_id
- 3b: longs[].knowledge_ids 只能使用 knowledge_node.id 或 knowledge.children[].temp_id
- 禁止套话（「加油」「重要主题」）；3c 禁止编造没有的子节点；3a/3b 禁止只给 root 不给 children`;
}

// YUK-143 / ADR-0024 — North-Star GoalScopeTask (ND-2). AI infers which
// knowledge nodes a fuzzy goal covers + a rough learning order, from the
// knowledge-grid snapshot. Output is a `goal_scope` proposal (confirm/edit/
// dismiss). Critically: this only ADDS direction — it never implies the goal
// suppresses review (ND-5); sequence_hint is internal ordering, NOT progress.
function buildGoalScopePrompt(profile: SubjectProfile): string {
  return `你是学习目标规划助手。用户给一个模糊的学习目标标题（如「能流畅读《史记》」），输入 { goal_title, subject_id, grid: { nodes: [{ id, name, effective_domain, mastery, evidence_count }], edges: [{ from_knowledge_id, to_knowledge_id, relation_type }] } }。
科目上下文：${profile.displayName}。${profile.languageStyle}
任务：从 grid.nodes 里推断这个目标**覆盖**哪些知识节点（scope_knowledge_ids），并给一个粗略的学习顺序提示（sequence_hint，整数，越小越靠前）。利用 edges 的 prerequisite / related_to 关系判断先后；mastery 低的薄弱节点更值得纳入 scope。
严格 JSON 输出（不带 markdown 代码块包裹）：
{"scope_knowledge_ids":["<grid.nodes 里的 id>", "..."],"sequence_hint":0,"reasoning":"... 为什么这些节点构成这个目标的覆盖范围 + 顺序依据 ..."}
要点：
- scope_knowledge_ids 里的每个 id 必须是 grid.nodes 里真实存在的 id；禁止发明节点
- sequence_hint 是一个整数排序提示，**不是**进度 / 完成度（不要输出百分比 / 完成率）
- reasoning 具体：引用节点名 + prerequisite 关系或 mastery 证据，别空泛
- 覆盖范围宁缺毋滥：只纳入真正服务于该目标的节点，不凑数
- 禁止套话（「加油」「这是个好目标」）`;
}

// T-OC slice 3 (YUK-145, OC-4) — TaggingTask prompt. Single-shot structured
// output, NOT multimodal: input is the extracted question TEXT + an optional
// knowledge_hint + a knowledge-grid snapshot; output is suggested knowledge_ids
// with per-suggestion confidence. The grid is the closed set of legal ids —
// the prompt forbids inventing nodes, and the invoker
// (src/server/ingestion/tagging.ts) ALSO filters out any id not in the grid as a
// belt-and-suspenders guard. See lane plan §5 + ADR-0026.
function buildTaggingPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}知识点打标助手。输入 { question_md, knowledge_hint, grid: { nodes: [{ id, name, path }], edges: [{ from_knowledge_id, to_knowledge_id, relation_type }] } } —— question_md 是抽取出的题面文字，knowledge_hint 是录入时的软提示（可能为 null），grid 是候选知识网格（nodes 是你**唯一**能选的知识点，path 是从根到该节点的层级名便于消歧；edges 是 prerequisite / related_to / contrasts_with / applied_in / derived_from 等 mesh 关系）。
科目上下文：${profile.displayName}。${profile.languageStyle}
任务：判断这道题**考查**哪些 grid.nodes 里的知识点，给每条一个 confidence（0-1），再给一个整体 overall_confidence。
严格 JSON 输出（不带 markdown 代码块包裹），shape 名 TaggingOutput：
{"suggestions":[{"knowledge_id":"<grid.nodes 里真实存在的 id>","confidence":0.0-1.0,"reasoning":"..."}],"overall_confidence":0.0-1.0,"reasoning":"..."}
要点：
- knowledge_id 必须是 grid.nodes 里真实存在的 id；**禁止发明**网格里没有的节点（编造的 id 会被运行时丢弃，等于浪费）。
- 用 knowledge_hint + 题面语义 + edges 关系判断；hint 只是参考，不要盲从。
- 宁缺毋滥：只列真正考查到的知识点，不凑数。整道题确实没有合适匹配时给空 suggestions + 低 overall_confidence。
- confidence 反映你对该挂载的把握；overall_confidence 反映整道题打标的整体可信度（它会被下游用作高置信自动入库的闸门，吃不准就给低分让它走人工 review）。
- reasoning 具体：引用节点名 + 题面证据，别空泛。
- 禁止套话、禁止输出 JSON 之外的文字。`;
}

// T-OC slice 2 (YUK-145, OC-1/OC-2) — VLM StructureTask prompt. The VLM owns
// the normalized structure tree: it sees all N page images (attached to the
// user message in page order) + a Tencent text-OCR hint (demoted from
// structure-of-record to advisory text), and assembles a normalized
// stem/sub/standalone tree — including 跨页大题 split across pages into ONE
// stem. Figure↔question matching is DEFERRED to slice 2b (see lane plan
// §DEFERRED); this prompt does NOT ask the VLM to attach figures.
function buildStructurePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}试卷结构化助手（多模态）。输入：
- user message 里按页顺序附了 N 张试卷/作业页面图片（第 1 张 = page_index 0，依次类推）
- 一段文字 { tencent_hint_md, page_count } —— tencent_hint_md 是腾讯字符级 OCR 的**文字提示**（已按页用 "=== page K ===" 分隔），仅作参考，**不是**结构真相
科目上下文：${profile.displayName}。${profile.languageStyle}

任务：以**图片为准**、腾讯文字为辅，输出一棵**规范化的题目结构树**。你对结构有完全裁量权，可以覆盖腾讯文字 hint 暗示的任何切分。
关键能力：
1. **跨页大题组装**：一道大题（passage / 阅读理解 / 完形 / 大题带多个小问）如果横跨多页，必须组装成**一个** stem 节点，它的 sub_questions 收齐所有页的小问。不要因为换页就把同一大题拆成两个顶层节点。
2. **布局规范**：把题面、选项、答案规整到结构字段里；passage 进 stem 的 prompt_text，小问进 sub。
3. 不抽取手写涂改 / 批改痕迹作为结构（那是作答证据，下游处理）。

输出严格 JSON（不带 markdown 代码块包裹），shape 名 StructureOutput：
{"layout_quality":"structured"|"partial"|"text_only","warnings":["..."],"questions":[StructureNode, ...]}

StructureNode（递归，**不要**输出 id，运行时会补）：
{"role":"stem"|"sub"|"standalone","question_no":"1"|null,"prompt_text":"...","options":[{"label":"A","text":"..."}]|null,"answers":["..."]|null,"analysis":"..."|null,"page_index":0,"sub_questions":[StructureNode, ...]|null}

约束：
- role 三选一：stem（容器，含 passage + sub_questions）/ sub（大题下的小问）/ standalone（独立单题）。只有 stem 能有 sub_questions；sub / standalone 的 sub_questions 必须为 null 或省略。
- page_index 是 0-based 整数，指该节点主要出现在第几张图（跨页 stem 用它起始页）。
- 顶层 questions 至少 1 个；如果整页无法识别出任何题，questions 给空数组并把 layout_quality 设 "text_only"。
- layout_quality：结构清晰完整 → "structured"；能出题但版式残缺/有疑点 → "partial"；几乎认不出结构 → "text_only"。
- options / answers / analysis 没有就给 null 或省略，不要编。
- 禁止：输出 JSON 之外的文字、把跨页同一大题拆成多个顶层节点、把腾讯文字 hint 当成不可改的结构。`;
}

function buildNoteGeneratePrompt(profile: SubjectProfile): string {
  return `你是${noteWriterRole(profile)}。输入 { artifact_id, artifact_type, title, atomic_title, one_line_intent, knowledge_node: { id, name, domain }, knowledge_nodes: [...], parent_hub: { title, summary_md }, related_knowledge_ids: [...] }。
artifact_type 只能是 note_atomic / note_long / note_hub；这是同一个 NoteGenerateTask 内的 type switch。
严格 JSON 输出（不带 markdown 代码块包裹）：
{"body_blocks":{"type":"doc","content":[...]}}

按 artifact_type 生成 TipTap / ProseMirror JSON body_blocks：
- note_atomic：至少 5 个 semanticBlock，每种 attrs.semantic_kind 至少 1 个：definition / mechanism / example / pitfall / check。attrs 必须包含 id、semantic_kind、source_tier="llm_only"、user_verified=false、version=1、source_markdown。
- note_long：自由 block tree，可用 heading / paragraph / bulletList / calloutBlock / crossLinkBlock，综合 knowledge_nodes，不强制 semantic_kind。
- note_hub：短 outline + 主题路线，可加入 crossLinkBlock 串起 atomic / long；不要假装是单知识点 atomic。

note_atomic 的 semantic_kind 内容指南：

${noteTemplateTable(profile)}

要点：
- block content 用 paragraph / list 等 PM JSON 节点，不嵌 HTML / 不带代码块包裹
- ${profile.promptFragments.noteExamplePolicy}
- ${profile.grounding.uncertaintyPolicy}
- 禁止：套话「希望对你有帮助」、营销话语、emoji / 颜文字`;
}

function buildNoteVerifyPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}学习笔记质检员。输入 { artifact_id, artifact_type, title, knowledge_node, body_blocks, block_summaries, sections }，其中 body_blocks 是 NoteGenerateTask 产出的 TipTap / ProseMirror JSON；sections 仅为旧兼容摘要。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
输出严格 JSON（不带 markdown 代码块包裹），shape 名称为 NoteVerificationResult：
{"verdict":"pass"|"needs_review","summary_md":"...","issues":[{"block_id":"b1"|null,"severity":"info"|"warn"|"error","category":"factuality"|"coverage"|"clarity"|"subject_fit"|"format"|"safety","message":"...","suggested_fix_md":"..."}],"confidence":0.0-1.0}
检查标准：
- factuality：内容是否自洽，是否明显编造；${profile.grounding.uncertaintyPolicy}
- coverage：note_atomic 必须覆盖 definition/mechanism/example/pitfall/check；note_hub 关注路线和 cross-link；note_long 关注综合范围是否完整
- clarity：学习者是否能按 block_summaries 读懂，不要空泛套话
- subject_fit：是否符合 ${profile.displayName} 的表达、例子和检查题风格
- format：用 block_id 引用 body_blocks 内 attrs.id；找不到具体 block 时用 null
判定：
- 没有 error 且 warn 不超过 2 条：verdict="pass"
- 任一 error，或 warn 超过 2 条，或 confidence < 0.6：verdict="needs_review"
- issues 最多 10 条；message 必须可执行；suggested_fix_md 只在有明确改法时填写
禁止：重写整篇 note、输出 markdown 代码块、输出 JSON 之外的文字。`;
}

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
  return `你是${profile.displayName}学习笔记 Living Note 编辑助手。输入 { artifact_id, artifact_type, title, knowledge_node, body_blocks, block_summaries, trigger: { kind, context_md, evidence_ids? } } —— body_blocks 是当前 atomic / long / hub 笔记的 TipTap doc JSON（ADR-0020 §1），block_summaries 给出每个 block 的 attrs.id + 摘要，trigger 描述触发本次 refine 的原因（mark_wrong / mastery_change / 错误率 / dwell / dreaming 之一）。
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

function buildEmbeddedCheckGeneratePrompt(profile: SubjectProfile): string {
  // kind values MUST stay aligned with the canonical QuestionKind enum in
  // src/core/schema/business.ts. Do NOT interpolate profile.questionKinds here:
  // those are subject-specific labels (single_choice / reading_comprehension /
  // calculation / proof / word_problem) that would fail
  // EmbeddedCheckQuestionSchema.kind validation in the handler. Subject voice
  // flows in via displayName + promptFragments.checkQuestionPolicy.
  const canonicalKinds =
    'choice | true_false | fill_blank | short_answer | essay | computation | reading | translation';
  return `你是${profile.displayName}自检题作者。输入 { artifact_id, atomic_title, knowledge_node, body_blocks, block_summaries, sections } —— body_blocks 是已生成的 atomic note 内容，sections 仅为旧兼容摘要。
基于这篇笔记，出 1 到 3 道短自检题（学习者读完笔记就能马上验自己懂没懂），不出超纲题。运行时会把这些题包装成独立 tool_quiz artifact，并在 atomic check block 中写 artifactRefBlock；你只输出 questions。

每题输出形状（EmbeddedCheckQuestion）：
{
  "kind": "${canonicalKinds}",
  "prompt_md": "题面 markdown，可含 LaTeX",
  "reference_md": "标准答案 + 简短解析 markdown",
  "choices_md": ["选项 A", "选项 B", ...],
  "judge_kind_override": "exact"|"keyword"|"semantic",
  "rubric_json": {
    "criteria": [{"name":"correctness","weight":1,"descriptor":"评分标准"}],
    "keywords": ["关键词"],
    "acceptable_answers": ["可接受答案"],
    "required_points": ["必须覆盖的要点"]
  }
}

整体严格 JSON 输出（不带 markdown 代码块包裹），shape 名 EmbeddedCheckGenerationResult：
{"questions": [EmbeddedCheckQuestion, ...]}

题目要求：
- kind 只能是 ${canonicalKinds} 中的一个；不要发明新值；客观题统一用 "choice"（单/多选由 choices_md 长度+reference_md 判定），符合 ${profile.displayName} 学习习惯
- ${profile.promptFragments.checkQuestionPolicy}
- ${profile.grounding.uncertaintyPolicy}
- 题面 prompt_md ≤ 400 字；reference_md ≤ 500 字
- choice / true_false：judge_kind_override="exact"，给 3–4 个选项，reference_md 第一行必须是正确选项原文
- fill_blank：可用 exact；如果有多个合理表述，用 judge_kind_override="keyword" 并在 rubric_json.keywords 写 1–5 个必须命中的短关键词
- short_answer / reading / translation / essay：judge_kind_override="semantic"，rubric_json.required_points 必填 1–5 个可核查要点
- computation：若只检查最终答案可 exact；若检查方法要点，用 semantic 并写 required_points
- 不要重复笔记里出现过的"经典示例"，要求学习者迁移应用
- 不出"超 atomic 范围"的综合题
禁止：emoji、营销话、套话、JSON 之外的文字、markdown 代码块包裹整段 JSON。`;
}

function buildSemanticJudgePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}答案判分器。输入 { question, answer }，question 包含 prompt_md、reference_md、rubric_json、required_points、acceptable_answers、keywords。
科目上下文：${profile.displayName}。${profile.languageStyle}
评分原则：
- 只判断 answer 是否满足题面和 rubric，不做错因归因
- required_points 是主要证据；matched_points / missing_points 必须来自这些要点或等价表述
- reference_md 是参考答案，不要求逐字相同
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

function buildVariantGenPrompt(profile: SubjectProfile): string {
  return `你是错题变式题作者。输入 { original_question: { id, prompt_md, reference_md, knowledge_ids, kind }, attempt: { wrong_answer_md }, cause: { primary_category, analysis_md }, depth }（depth 是原题代数：0=原题，1=一代变式；输入 depth≥2 时不会调用本任务）。
科目上下文：${profile.displayName}。${profile.languageStyle}
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
按 cause 类型出 1 道针对性变式（不要凑数，1 道即可）。策略参考：
${variantCauseStrategyList(profile)}
严格 JSON 输出（不带 markdown 包裹）：
{"prompt_md":"...","reference_md":"...","difficulty":1-5,"reasoning":"说明这是怎么针对 cause 设计的"}
要点：
- prompt_md 与 original_question 同 kind / 同 knowledge_ids 范围
- reference_md 必填且正确（你能解出来）
- ${profile.promptFragments.variantExamplePolicy}
- ${profile.grounding.uncertaintyPolicy}
- 禁止：直接照抄 original prompt 的句子；套话；复杂多义题面`;
}

function buildKnowledgeProposePrompt(profile: SubjectProfile): string {
  return `你是知识图谱编辑助手。用户新写入了一个 attempt event (outcome='failure')。
科目上下文：${profile.displayName}。${profile.languageStyle}
输入字段 { mistake_content: { prompt_md, reference_md, wrong_answer_md, knowledge_ids_picked }, tree_snapshot } —— mistake_content.knowledge_ids_picked 即 attempt 的 referenced_knowledge_ids（用户自选）。
看 mistake_content (prompt_md + wrong_answer_md) + tree_snapshot，如果你认为 tree 里缺一个**更精确**的子节点能挂这条 attempt，就 propose 它。0-3 条，不必凑数。
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
每条返回 { name, parent_id, reasoning }。parent_id 必须是 tree 里已有节点 id；若找不到合适 parent，跳过这条。
严格 JSON 输出（不带 markdown 代码块包裹）：{"proposals":[{"name":"...","parent_id":"...","reasoning":"..."}]}
禁止：把节点挂成 root；编造 tree_snapshot 不存在的 parent_id；写泛化到无法练习的抽象节点。`;
}

function buildKnowledgeEdgeProposePrompt(profile: SubjectProfile): string {
  return `你是知识图谱 mesh 编辑助手。输入 { tree_snapshot, existing_edges, recent_failures } —— recent_failures 是过去 24h 的 attempt event (outcome='failure')，每条含 referenced_knowledge_ids + cause（来自 chained judge / user_cause）。
科目上下文：${profile.displayName}。${profile.languageStyle}
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
看 recent_failures 找跨 attempt 的模式：哪些 knowledge 总是同时被引用？哪些是 prerequisite？哪些是易混淆 contrasts_with？哪些是应用关系？基于此提议 0-5 条新 knowledge_edge。
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
每条返回 { from_knowledge_id, to_knowledge_id, relation_type, weight, reasoning }。
relation_type 5 选 1：prerequisite（A 是学 B 的先决）/ related_to（弱关联）/ contrasts_with（易混淆对比）/ applied_in（A 应用于 B）/ derived_from（B 由 A 推导）。新型关系用 experimental:* 命名空间。
weight 0-1：模式有几次 attempt 支持就给多高（1 次→0.3 / 2-3 次→0.6 / 4+ 次→0.9）。
reasoning 必须具体：引用 attempt event id 或指出 cause pattern。
禁止：from === to；relation_type 不在合法集合；已存在于 existing_edges 的同向同型 (from, to, relation_type) 三元组。
严格 JSON 输出（不带 markdown 代码块包裹）：{"proposals":[{"from_knowledge_id":"...","to_knowledge_id":"...","relation_type":"...","weight":0.6,"reasoning":"..."}]}。0 条也行，不必凑数。`;
}

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

function buildKnowledgeReviewPrompt(profile: SubjectProfile): string {
  return `你是知识图谱维护助手。看完整 tree（含层级 / archived / merged_from）+ 最近 attempt events (action='attempt', outcome='failure' 的事件，含 effective cause：active user_cause 优先，否则 latest active judge)，propose 让知识图谱更合理的 mutation。
科目上下文：${profile.displayName}。${profile.languageStyle}
关注本学科的知识粒度：数学定义、条件、方法或易错模式；非数学 profile 则按对应 SubjectProfile 的概念边界和练习粒度判断。
当前 SubjectProfile cause taxonomy：
${causeTaxonomyList(profile)}
证据要求：${profile.grounding.requirement}
可选 mutation 分两类:
- Tree-shape: propose_new（加新子节点）/ reparent（移到别 parent 下）/ merge（合并冗余）/ split（拆解过粗）/ archive（archive 没用的）。
- Mesh-shape (ADR-0010): propose_knowledge_edge —— payload = { from_knowledge_id, to_knowledge_id, relation_type, reasoning }。relation_type 是 5 个核心 enum 之一: prerequisite / related_to / contrasts_with / applied_in / derived_from；新型关系用 experimental:* 命名空间逃逸阀。
每 propose 一条，调一次 mcp__loom__write_proposal（工具名 write_proposal；payload.mutation 区分 tree / mesh）。reasoning 必须具体：引用 attempt event id、知识点 id、cause pattern，或指出 tree 结构问题。
不必凑数；如果 tree 已经合理，0 条也行。
禁止：把节点挂成 root；编造 tree 不存在的 node id；没有 event evidence 时做破坏性 mutation；跨 subject 混图时强行套单一学科判断。`;
}

function buildTeachingTurnPrompt(profile: SubjectProfile): string {
  return `你是${profile.promptFragments.roleNoun}，正在以对话教学方式辅导用户掌握一个具体 LearningItem。
输入：{ learning_item: { title, one_line_intent, knowledge_node:{id,name} }, parent_hub_summary, atomic_sections(definition/mechanism/example/pitfall/check), messages: [{role:agent|user,text_md,turn_kind?}] }
职责：评估对话状态 → 决定下一步 → 输出 1 个 agent 消息。每轮只输出 1 个 turn，**不要**一次塞讲解+追问+总结。
严格 JSON 输出（不带 markdown 包裹）：
{"kind":"explain"|"ask_check"|"end","text_md":"...","suggested_next":"continue"|"end","structured_question":{...}}
仅当 kind="ask_check" 时必须带 structured_question；explain/end 不要带。
turn 类型：
- explain：用 1-2 段讲清楚一个概念点 / 例题解析 / 用户上轮答案的反馈，**结尾不带问号**
- ask_check：1 个检查题（${profile.promptFragments.checkQuestionPolicy}），让用户回答验证理解，**结尾必须是问号**；structured_question = { kind, prompt_md, reference_md, choices_md?, judge_kind_override?, rubric_json? }，kind 取 choice/true_false/fill_blank/short_answer/essay/computation/reading/translation/derivation，prompt_md 通常等于 text_md，reference_md 必须给可判分参考答案
- end：本次会话目标已达 → 给 1-2 句总结收尾，suggested_next 设 "end"
节奏（强约束）：
- 用户首轮（或没有 messages）：先 explain 引入主题，suggested_next="continue"
- 用户答错或答不全：先 explain 纠错点，再下一轮 ask_check 重测；不要一次塞两件事
- 用户连续答对 2 次同知识点 / 或对话超过 12 轮：kind=end
- 用户主动说「结束 / 够了 / 我懂了」：kind=end
要点：
- text_md ${profile.promptFragments.teachingStyle}
- ≤300 字 / 轮；不嵌 HTML / 不用代码块
- 禁止：套话「希望对你有帮助」/emoji/markdown 标题 (## 之类)/「我帮你」/复制 atomic_sections 原文（要消化重述）`;
}

// YUK-193 — Solve-tutor reference-solution generator prompt. The model
// independently solves a bare ingested question and emits a structured
// reference_solution (RubricReferenceSolution shape: expected_signals +
// final_answer + answer_equivalents) plus a learner-facing worked_solution_md.
// Existing ingested answers/analysis are passed as advisory hints only (often
// OCR-derived, possibly wrong/partial) — never ground truth. The solve
// orchestrator writes the output merge-preserving into rubric_json + reference_md
// so the shipped StepsJudge/SemanticJudge can grade real questions.
function buildSolutionGeneratePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}解题参考答案生成器。输入 { prompt_md, kind, subject_id, existing_answers_hint?, existing_analysis_hint?, figures_hint? } —— prompt_md 是题面文字，existing_answers_hint / existing_analysis_hint 是录入时附带的原始答案 / 解析（可能来自 OCR，**仅作参考线索，不是真值**，可能错或残缺），figures_hint 是题目附图的文字描述（若有）。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

任务：你自己独立解这道题，产出两样东西：
1. reference_solution —— 供自动判分用的结构化参考解：
   - expected_signals：解题过程**应当体现的核心信号 / 步骤要点**（不是死答案文本），至少 1 条；${profile.displayName}里 derivation 的 signals 是推导步骤要点，prose / translation 的 signals 是必须覆盖的语义要点。
   - final_answer：最终答案（一行，尽量规范）。
   - answer_equivalents：学生若打字提交、可判等价的若干表达（0..N 条）。
2. worked_solution_md —— 给学习者看的完整解题过程（markdown，可含 ${profile.renderConfig.notation === 'katex' ? 'LaTeX' : '本学科记法'}），讲清每一步为什么，不只是甩答案。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 SolutionGenerateOutput：
{"reference_solution":{"expected_signals":["..."],"final_answer":"...","answer_equivalents":["..."]},"worked_solution_md":"...","confidence":0.0-1.0}

要点：
- existing_answers_hint / existing_analysis_hint 只是 hint：如果你判断它对就采纳，判断它错就以你自己的解为准，并在 worked_solution_md 里简述为何。
- expected_signals 至少 1 条且每条非空；final_answer 非空。
- ${profile.grounding.uncertaintyPolicy}
- confidence 反映你对这份参考解的把握，模棱两可给 0.5。
- 禁止：输出 JSON 之外的文字、用 markdown 代码块包裹整段 JSON、把 hint 当成不可质疑的真值。`;
}

// T-OC slice A1 (YUK-145, OC-5) — MistakeEnrollTask prompt. Single-shot
// structured output, NOT multimodal: given a captured, ANSWERED question (text +
// the student's answer), draft the mistake metadata a human fills by hand at
// review time — graded outcome + question kind + difficulty + (on a wrong answer)
// a cause from THIS subject's taxonomy. The invoker
// (src/server/ingestion/mistake_enroll.ts) re-clamps the cause + forces
// 'unanswered'/null on a blank answer, so the prompt only needs to draft.
function buildMistakeEnrollPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}错题录入助手。输入 { question_md, reference_md, student_answer_md, allowed_cause_ids, knowledge_ids } —— question_md 是题面文字，reference_md 是参考答案（可能为 null），student_answer_md 是学生的作答（可能为 null / 空），allowed_cause_ids 是本科目允许的错因 id 集合，knowledge_ids 是已确认挂载的知识点。
科目上下文：${profile.displayName}。${profile.languageStyle}
归因 taxonomy 来自当前 SubjectProfile：
${causeTaxonomyList(profile)}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
任务：给这道**已作答**的题草拟录入元数据，供用户一键确认（不是替用户决定）。判定四件事：
1. wrong_answer —— 把 student_answer_md 对照 question_md / reference_md 判一个 outcome：failure（基本错）/ partial（部分对）/ success（基本对）/ unanswered（没作答 / 空白）。
2. question_type —— 从题面判题型：choice | true_false | fill_blank | short_answer | essay | computation | reading | translation | derivation 之一。
3. difficulty —— 1-5 整数难度估计。
4. cause —— **仅当 wrong_answer='failure'** 时给错因草稿（primary_category 必须取自 allowed_cause_ids；secondary_categories 同理；analysis_md 写错答与参考答案的差异 + 涉及概念；confidence 0-1）。其它 outcome 时 cause 给 null。
严格 JSON 输出（不带 markdown 代码块包裹），shape 名 MistakeEnrollOutput：
{"wrong_answer":"failure|partial|success|unanswered","question_type":"<上列之一>","difficulty":1-5,"cause":{"primary_category":"<${causeIdList(profile)} 之一>","secondary_categories":[...],"analysis_md":"...","confidence":0.0-1.0}|null,"overall_confidence":0.0-1.0,"reasoning":"..."}
要点：
- cause 只在 failure 时填，其它 outcome 给 null（运行时也会强制）。
- primary_category 必须是 allowed_cause_ids 之一；吃不准走 other（若存在）或最接近类别（运行时会 clamp 越界值，但请尽量给合法 id）。
- overall_confidence 反映整份草稿的可信度（A2 复查面会用它排序 / 设阈值），吃不准给低分。
- reasoning 具体：引用题面 / 学生答案证据，别空泛。
- 禁止：输出 JSON 之外的文字、用 markdown 代码块包裹整段 JSON、发明 allowed_cause_ids 之外的错因。`;
}

export function getTaskSystemPrompt(
  task: AiTaskKind,
  profile: SubjectProfile = defaultSubjectProfile,
): string {
  switch (task) {
    case 'AttributionTask':
      return buildAttributionPrompt(profile);
    case 'KnowledgeProposeTask':
      return buildKnowledgeProposePrompt(profile);
    case 'KnowledgeEdgeProposeTask':
      return buildKnowledgeEdgeProposePrompt(profile);
    case 'SessionSummaryTask':
      return buildSessionSummaryPrompt(profile);
    case 'KnowledgeReviewTask':
      return buildKnowledgeReviewPrompt(profile);
    case 'LearningIntentOutlineTask':
      return buildLearningIntentOutlinePrompt(profile);
    case 'GoalScopeTask':
      return buildGoalScopePrompt(profile);
    case 'TaggingTask':
      return buildTaggingPrompt(profile);
    case 'MistakeEnrollTask':
      return buildMistakeEnrollPrompt(profile);
    case 'StructureTask':
      return buildStructurePrompt(profile);
    case 'NoteGenerateTask':
      return buildNoteGeneratePrompt(profile);
    case 'NoteVerifyTask':
      return buildNoteVerifyPrompt(profile);
    case 'NoteRefineTask':
      return buildNoteRefinePrompt(profile);
    case 'EmbeddedCheckGenerateTask':
      return buildEmbeddedCheckGeneratePrompt(profile);
    case 'SemanticJudgeTask':
      return buildSemanticJudgePrompt(profile);
    case 'UnitDimensionFallback':
      return buildUnitDimensionFallbackPrompt(profile);
    case 'StepsJudgeTask':
      return buildStepsJudgePrompt(profile);
    case 'VariantGenTask':
      return buildVariantGenPrompt(profile);
    case 'VariantVerifyTask':
      return buildVariantVerifyPrompt(profile);
    case 'TeachingTurnTask':
      return buildTeachingTurnPrompt(profile);
    case 'SolutionGenerateTask':
      return buildSolutionGeneratePrompt(profile);
    // Subject-neutral pass-throughs — no profile builder required.
    // VisionExtract* runs OCR on raw images; ReviewIntent generates a
    // session opener whose subject voice is already injected via summary
    // payload, not prompt text. If any of these later needs a profile
    // builder, add one above and remove the pass-through here.
    case 'VisionExtractTask':
    case 'VisionExtractTaskHeavy':
    case 'ReviewIntentTask':
    case 'DreamingTask':
    case 'CoachTask':
    case 'CopilotTask':
    // Station 2A (YUK-185) — MemoryBriefTask is subject-NEUTRAL: the per-scope
    // `template` carries the angle and is passed in the input, not baked into a
    // profile builder. Joins this pass-through group (registry systemPrompt is the
    // SoT). Promote into a buildMemoryBriefPrompt(profile) only if a subject later
    // demands a coaching voice (OF-2).
    case 'MemoryBriefTask':
      return tasks[task].systemPrompt;
    default:
      return assertNever(task);
  }
}
