import { type SubjectProfile, defaultSubjectProfile } from '@/subjects/profile';
import { type TaskKind, tasks } from './registry';

export type AiTaskKind = TaskKind;

function assertNever(value: never): never {
  throw new Error(
    `getTaskSystemPrompt: unhandled TaskKind — add a case to the switch. value=${JSON.stringify(value)}`,
  );
}

function noteWriterRole(profile: SubjectProfile): string {
  // YUK (wenyan deprotagonist): no per-subject special-casing — every subject's
  // note-writer role is uniformly `${displayName}学习笔记作者`. wenyan is just one
  // filled-in sample subject, not a privileged default.
  return `${profile.displayName}学习笔记作者`;
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

// YUK-462 — stage 2 of the retrieve→rerank cause-attribution pipeline. This MIRRORS
// buildAttributionPrompt's text (same role line, same taxonomy/grounding/JSON
// contract, same low-confidence→other clause) with ONE delta: the candidate cause
// list is also supplied as a structured input field `candidates`, and the model
// must pick primary_category FROM that set and give a per-candidate rationale
// (why this, why not the others) in analysis_md. EQUIVALENCE: when the retriever
// passes the full vocab (every current profile, vocab <= K_SMALL), `candidates`
// equals this prompt's inline taxonomy — so the selectable set is identical to
// buildAttributionPrompt's and the selection problem is the same.
function buildAttributionRerankPrompt(profile: SubjectProfile): string {
  return `你是错题归因助手。输入字段 { prompt_md, reference_md, wrong_answer_md, knowledge_context, candidates }（来自一个 attempt event outcome='failure'）—— 即用户做错的一道题，含 wrong_answer_md（用户错答）、参考答案 reference_md、挂的 knowledge_context，分析错因。
科目上下文：${profile.displayName}。${profile.languageStyle}
归因 taxonomy 来自当前 SubjectProfile：
${causeTaxonomyList(profile)}
另外，输入里附带一个结构化候选集 candidates: [{ id, label, description, review_priority }] —— 这是 L1 召回阶段交给你的候选错因清单。primary_category **必须**从 candidates 的 id 里选；先在 analysis_md 里逐候选权衡（为什么选这个 / 为什么排除其它候选），再给结论。
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}
归因结果作为 judge event 写入 (action='judge', subject_kind='event', caused_by_event_id=<attempt event id>)；payload.cause 即此输出。
输出严格 JSON 格式（不带 markdown 代码块包裹）：
{"primary_category": "<candidates 里某个 id>", "secondary_categories": [...], "analysis_md": "<逐候选权衡 + 选定理由，含错答与参考答案差异 + 涉及的知识点 / 概念>", "confidence": 0.0-1.0}
低信心走 other（若 candidates 含 other）或最接近的候选，并在 analysis_md 里说明不确定点。`;
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

// ADR-0031 / YUK-304 (lane B) — buildQuizIntentParsePrompt deleted with
// QuizIntentParseTask (the YUK-275 C-form free-text 求卷 parser): chat.ts no
// longer pre-dispatches quiz intents; the copilot model decides + orchestrates.

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

// YUK-202 / BlockAssembly path-B (design 2026-06-02 §2) — BlockAssemblyTask
// prompt. Single-shot structured output, NOT multimodal: input is a compact
// TEXT projection of one ingestion session's draft blocks (in array order =
// adjacency), output is `block_merge` candidates. SEMANTIC-ONLY (§0): the model
// judges merges from numbering continuity / sub-question carry-over /
// stem-answer split / "承接前题/根据上文" cues — NOT from bbox/page-edge spatial
// signals (page_index is placeholder=0 today; spatial detection is DEFERRED to
// slice 2b, where the task gains a spatial input with no prompt rework). AI ONLY
// proposes; the user accepts in the inbox and acceptance reuses the YUK-195
// mergeQuestions primitive — there is no auto-merge (hard safety boundary §5).
function buildBlockAssemblyPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}试卷录入的「题块装配」助手。输入 { ingestion_session_id, blocks: [{ block_id, question_no, prompt_head, role, sub_question_count, layout_quality[, page_index] }] } —— blocks 是同一次录入抽取出的全部草稿题块，**按数组顺序排列（数组相邻 = 题块相邻）**。每块给的是结构化文字投影：question_no（题号，可能为 null）、prompt_head（题面开头文字）、role（stem/sub/standalone）、sub_question_count（子问数）、layout_quality。page_index（若存在）是该块所在页（0-based），可作为辅助空间信号。
科目上下文：${profile.displayName}。${profile.languageStyle}
任务：找出哪些**相邻**题块其实是**同一道逻辑题被切开**了，应该合并。判据：
- **编号连续**：question_no 连续（如 5 接 6 的子问，或同一大题被拆成两块）。
- **子问承接**：前一块是大题/题干，后一块只有 (1)(2)(3) 这样的子问延续。
- **题干答案分离**：一块是题干，紧邻的下一块只有答案/解析，没有独立题面。
- **上下文承接提示**：后一块出现「承接前题」「根据上文」「续上」等线索词。
- **页码连续（仅当 page_index 存在时）**：相邻块 page_index 连续（如 0→1），且语义线索与跨页切断一致，可佐证 page_edge 信号。
重要约束：语义线索是主判据；page_index 仅为辅助。**若 page_index 不在输入里，纯用语义判断**（Tencent 路径无空间信号）。不要依赖 bbox / 像素位置。
严格 JSON 输出（不带 markdown 代码块包裹），shape 名 BlockAssemblyOutput：
{"candidates":[{"primary_block_id":"<保留结构树的主块 id>","merge_block_ids":["<折叠进主块的相邻块 id>", "..."],"confidence":0.0-1.0,"signal":"page_edge"|"numbering"|"stem_answer_split"|"carryover","reason_md":"<具体说明哪条连续线索 + 引用 question_no / 题面证据>"}]}
要点：
- primary_block_id 与 merge_block_ids 都必须是输入 blocks 里真实存在的 block_id；merge_block_ids 至少 1 个，且不含 primary 自己。
- 同一个 block 不要出现在多个候选里（一个块只属于一次合并）。
- signal 选最贴切的那条线索；page_edge 代表跨页切断，仅在 page_index 信号佐证时使用。
- confidence 反映你对「这几块确实是一道题」的把握；吃不准就给低分（下游只是 propose，用户会复核，但别凑数）。
- reason_md 必须具体：引用 question_no 或题面文字，说清为什么该合并。
- **宁缺毋滥**：没有明确该合并的相邻块时，输出空 candidates。禁止套话、禁止 JSON 之外的文字。`;
}

// T-OC slice 2 (YUK-145, OC-1/OC-2) — VLM StructureTask prompt. The VLM owns
// the normalized structure tree: it sees all N page images (attached to the
// user message in page order) + a Tencent text-OCR hint (demoted from
// structure-of-record to advisory text), and assembles a normalized
// stem/sub/standalone tree — including 跨页大题 split across pages into ONE stem.
//
// YUK-227 S3 Slice A: when `figures` is present in the input JSON, the VLM is
// also asked to self-report figure↔question assignments via `figure_ids` on each
// StructureNode. This keeps figure attribution in a single StructureTask call
// (zero new paid points). If figure attribution quality proves to pollute
// structure quality in practice, escalate to F3 (fork independent task) — do NOT
// self-authorize that fork here (plan §6 F3).
function buildStructurePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}试卷结构化助手（多模态）。输入：
- user message 里按页顺序附了 N 张试卷/作业页面图片（第 1 张 = page_index 0，依次类推）
- 一段文字 { tencent_hint_md, page_count[, figures] } —— tencent_hint_md 是腾讯字符级 OCR 的**文字提示**（已按页用 "=== page K ===" 分隔），仅作参考，**不是**结构真相；figures（若存在）是裁剪图列表 [{index, page_index, position}]，表示已从页面裁剪出的图片素材：index 是序号，page_index 是所在页，position 是归一化位置摘要（"top-left" / "top-center" / "top-right" / "mid-left" / "mid-center" / "mid-right" / "bot-left" / "bot-center" / "bot-right"，按图片中心点在页面 3×3 区域落点）
科目上下文：${profile.displayName}。${profile.languageStyle}

任务：以**图片为准**、腾讯文字为辅，输出一棵**规范化的题目结构树**。你对结构有完全裁量权，可以覆盖腾讯文字 hint 暗示的任何切分。
关键能力：
1. **跨页大题组装**：一道大题（passage / 阅读理解 / 完形 / 大题带多个小问）如果横跨多页，必须组装成**一个** stem 节点，它的 sub_questions 收齐所有页的小问。不要因为换页就把同一大题拆成两个顶层节点。
2. **布局规范**：把题面、选项、答案规整到结构字段里；passage 进 stem 的 prompt_text，小问进 sub。
3. 不抽取手写涂改 / 批改痕迹作为结构（那是作答证据，下游处理）。
4. **图片归属（仅当输入含 figures 字段时）**：根据页面图片判断每张裁剪图属于哪道题，在对应 StructureNode 上填写 figure_ids（裁剪图序号数组）。跨页大题的配图（包括图示、电路图、坐标图等）归到 stem 节点。同一页且视觉上**明确**属于某小问的图归到该 sub 节点。**只在判断确定时填 figure_ids**——拿不准的图省略（不要猜，留给几何兜底）。漏报比错报代价小：几何兜底一定能处理漏报，但 VLM 错误归属会覆盖兜底，下游无法纠正。position 字段（图的位置摘要）可辅助判断同页归属关系，但仍以图片视觉为准。

输出严格 JSON（不带 markdown 代码块包裹），shape 名 StructureOutput：
{"layout_quality":"structured"|"partial"|"text_only","warnings":["..."],"questions":[StructureNode, ...]}

StructureNode（递归，**不要**输出 id，运行时会补）：
{"role":"stem"|"sub"|"standalone","question_no":"1"|null,"prompt_text":"...","options":[{"label":"A","text":"..."}]|null,"answers":["..."]|null,"analysis":"..."|null,"page_index":0,"sub_questions":[StructureNode, ...]|null,"figure_ids":[0,1]|null}

约束：
- role 三选一：stem（容器，含 passage + sub_questions）/ sub（大题下的小问）/ standalone（独立单题）。只有 stem 能有 sub_questions；sub / standalone 的 sub_questions 必须为 null 或省略。
- page_index 是 0-based 整数，指该节点主要出现在第几张图（跨页 stem 用它起始页）。
- figure_ids 是裁剪图序号数组（0-based，与输入 figures[].index 对应）；无配图时给 null 或省略。**仅当输入含 figures 字段时才填写 figure_ids**，否则省略。
- 顶层 questions 至少 1 个；如果整页无法识别出任何题，questions 给空数组并把 layout_quality 设 "text_only"。
- layout_quality：结构清晰完整 → "structured"；能出题但版式残缺/有疑点 → "partial"；几乎认不出结构 → "text_only"。
- options / answers / analysis 没有就给 null 或省略，不要编。
- 禁止：输出 JSON 之外的文字、把跨页同一大题拆成多个顶层节点、把腾讯文字 hint 当成不可改的结构。`;
}

// YUK-228 (S3 Slice B) — Note 族 skill 迁移后的 prompt 职责划分：
// SKILL.md（src/subjects/<id>/skills/note/SKILL.md）承载「什么是合格 note」的领域知识
// （semantic_kind 定义、质量规范、质检判据）。
// 本 prompt 只保留：
//   (a) task-specific I/O 契约（输入字段 / 输出 JSON shape / attrs 约束）
//   (b) profile.noteTemplate 注入（per-subject 数据，不进 SKILL.md）
//   (c) 降级安全：skill 未加载时 prompt 仍可独立产出合格 note。
function buildNoteGeneratePrompt(profile: SubjectProfile): string {
  return `你是${noteWriterRole(profile)}。输入 { artifact_id, artifact_type, title, atomic_title, one_line_intent, knowledge_node: { id, name, domain }, knowledge_nodes: [...], parent_hub: { title, summary_md }, related_knowledge_ids: [...] }。
artifact_type 只能是 note_atomic / note_long / note_hub；这是同一个 NoteGenerateTask 内的 type switch。
严格 JSON 输出（不带 markdown 代码块包裹）：
{"body_blocks":{"type":"doc","content":[...]}}

按 artifact_type 生成 TipTap / ProseMirror JSON body_blocks：
- note_atomic：至少 5 个 semanticBlock，每种 attrs.semantic_kind 至少 1 个：definition / mechanism / example / pitfall / check。attrs 必须包含 id、semantic_kind、source_tier="llm_only"、user_verified=false、version=1、source_markdown。
- note_long：自由 block tree，可用 heading / paragraph / bulletList / calloutBlock / crossLinkBlock，综合 knowledge_nodes，不强制 semantic_kind。
- note_hub：短 outline + 主题路线，可加入 crossLinkBlock 串起 atomic / long；不要假装是单知识点 atomic。

per-subject semantic_kind 内容模板（definition/mechanism/example/pitfall/check 五维，领域规范见 note skill）：

${noteTemplateTable(profile)}

- block content 用 paragraph / list 等 PM JSON 节点，不嵌 HTML / 不带代码块包裹
- ${profile.promptFragments.noteExamplePolicy}
- ${profile.grounding.uncertaintyPolicy}
- 禁止：套话、营销话语、emoji / 颜文字`;
}

// YUK-228 (S3 Slice B) — Note skill 职责划分：SKILL.md 承载质检领域规范；
// 本 prompt 留 I/O 契约 + profile 注入。详细判据见加载的 note skill；
// skill 未加载时按下方 fallback 四维标准独立判。
function buildNoteVerifyPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}学习笔记质检员。输入 { artifact_id, artifact_type, title, knowledge_node, body_blocks, block_summaries, sections }，其中 body_blocks 是 NoteGenerateTask 产出的 TipTap / ProseMirror JSON；sections 仅为旧兼容摘要。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
输出严格 JSON（不带 markdown 代码块包裹），shape 名称为 NoteVerificationResult：
{"verdict":"pass"|"needs_review","summary_md":"...","issues":[{"block_id":"b1"|null,"severity":"info"|"warn"|"error","category":"factuality"|"coverage"|"clarity"|"subject_fit"|"format"|"safety","message":"...","suggested_fix_md":"..."}],"confidence":0.0-1.0}
四维检查（fallback；详细规范见 note skill）：factuality（自洽不编造，${profile.grounding.uncertaintyPolicy}）/ coverage（atomic 须覆盖 definition/mechanism/example/pitfall/check 五种；long 综合完整；hub 路线+cross-link）/ clarity（按 block_summaries 可读，不空泛）/ subject_fit（符合 ${profile.displayName} 表达与例子风格）。format：block_id 引用 attrs.id；找不到用 null。
判定（fallback）：无 error 且 warn≤2 → pass；任一 error 或 warn>2 或 confidence<0.6 → needs_review。issues≤10 条，message 可执行，suggested_fix_md 有明确改法时填。
禁止：重写整篇 note、markdown 代码块、JSON 之外的文字。`;
}

// YUK-228 (S3 Slice B) — 同 buildNoteGeneratePrompt 职责划分注记：SKILL.md 提供
// 领域规范，本 prompt 只留 I/O 契约（NotePatchOp union）+ profile 注入 + 降级安全。
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
  return `你是${profile.displayName}视觉判分器（整体判分，无步骤评分表）。输入 { prompt_md, reference_md（参考答案，可能为 null）, prompt_image_refs（题干/图形/表格图片，若有，会先附在 user message 中）, student_image_refs（学生答题的 0..N 张图片，会后附在 user message 中）, student_final_answer_text?, image_present, prompt_image_count, student_image_count }。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

任务：
1. 先读题面文字和 prompt_image_refs（题目条件，不是学生作答），建立题目要求；再从 student_image_refs / student_final_answer_text 提取学生实际作答内容（OCR + 理解隐式完成）。
2. 整体判断学生作答是否正确：correct（核心要求齐全）/ partial（部分命中）/ incorrect（基本未命中）。不要逐步骤拆分打分（那是 steps 判分器的活）；这里是整体正确性判定。
3. 给学习者一句可执行的 feedback；observed_md 写你从图/文里看到的学生作答内容（evidence 用）。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 MultimodalDirectLlmOutput：
{"coarse_outcome":"correct|partial|incorrect","score":0.0-1.0,"feedback_md":"...","evidence":{"observed_md":"...","matched_points":["..."],"missing_points":["..."]},"confidence":0.0-1.0}

要点：
- coarse_outcome 三选一；score 与 coarse_outcome 大致一致（caller 会按 coarse_outcome 把分数夹到 correct≥0.85 / partial 0.01..0.84 / incorrect 0）。
- prompt_image_refs 是题目条件，不是学生作答；student_image_refs / student_final_answer_text 才是学生作答。
- 没有参考答案（reference_md=null）时，按题面要求和学科常识判断；observed_md 即使图模糊也尽量给出。
- 不确定时给 partial + 在 feedback_md / missing_points 说明原因，不要强行判 correct/incorrect。
- ${profile.grounding.uncertaintyPolicy}
- confidence 反映你判分时的把握，0.5 表示模棱两可。
禁止：输出 JSON 之外的文字、coarse_outcome 用非合法值、把题目条件误当成学生作答。`;
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
  return `你是${profile.displayName}解题参考答案生成器。输入 { prompt_md, kind, subject_id, choices_md?, existing_answers_hint?, existing_analysis_hint?, figures_hint? } —— prompt_md 是题面文字，choices_md 是选择题/判断题的候选项（若有，必须一起解读；不要只看题干），existing_answers_hint / existing_analysis_hint 是录入时附带的原始答案 / 解析（可能来自 OCR，**仅作参考线索，不是真值**，可能错或残缺），figures_hint 是题目附图的文字描述（若有）。
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

// Search-grounded QuizGen (T-SQ) — QuizGenTask prompt. Tool-calling agent.
//
// docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md
//   §0  Provenance is NOT recoverable from runner logs (the non-stream path
//       writes zero tool_call_log rows; remote-Tavily tool_use is not mirrored).
//       ⇒ the agent MUST self-declare every used URL into source_refs. This
//       prompt is built around that contract.
//   §1  Search for SOURCE MATERIAL, not questions; write ORIGINAL questions
//       grounded in the sources.
//   §2  Output shape = QuizGenOutput (src/core/schema/quiz_gen.ts).
//
// The handler (Q3) mounts the Tavily remote MCP (tavily_search / tavily_extract)
// + an in-process domain-tool MCP (read the user's mistakes + knowledge graph);
// the tool NAMES are resolved at run time, so this prompt refers to them by
// capability, not by exact mcp__* identifier.
function buildQuizGenPrompt(profile: SubjectProfile): string {
  const canonicalKinds =
    'choice | true_false | fill_blank | short_answer | essay | computation | reading | translation';
  return `你是${profile.displayName}出题人，用联网检索来的**素材**写**原创**练习题。输入 { trigger: 'knowledge'|'learning_item'|'manual', ref: { id, name, ... }, knowledge_context, count, few_shot_examples_md?, requested_generation_method?: 'material_grounded'|'closed_book', requested_kind?: string } —— ref 是触发出题的知识点 / 学习项，count 是期望题数（默认 3）。few_shot_examples_md（若有）是已入库的同题型优质范例，**仅供参考其结构与设问风格，禁止照抄题面**。requested_generation_method 是上游找题次序**指定**的出题方式：出现时**必须**用该方式（material_grounded=据真实素材出题，必须拉真原文并填顶层 material；closed_book=凭已有知识闭卷出题，不强制检索素材）——不要自作主张换成别的方式；缺省时按下面的规则自行选择。requested_kind 是上游找题次序**指定**的题型（**硬约束**，与 requested_generation_method 同级）：出现时**每一道题**的 kind 都**必须**是该题型，不要混入别的题型——下游会逐题校验，不符的整批会被拒收并重试；缺省时按 ref + 领域信号自行决定题型分布。
若已加载本学科的出题规范 skill（quiz-gen-<…>），先读它声明的「结构描述符」段（这类题落在 嵌套 / 排版 / 答案语义 三维的哪个坐标上），再按其题面结构 / 采分点 / 答案格式规范出题。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

你有工具：
- 联网检索（tavily_search / tavily_extract）：用来搜**背景素材 / 事实 / 例子**，**不是**搜现成题目。
- 领域读工具：可读用户的错题与知识图谱，判断该出什么难度 / 题型 / 覆盖哪些知识点。

工作流程：
1. 规划：根据 ref + 领域信号，定 count 道题的知识点 / 难度 / 题型分布。
2. 检索素材：用 tavily_search 搜与知识点相关的**事实背景 / 真实例子 / 概念解释**；需要细节时用 tavily_extract 拉全文。**绝不**直接搜「XX 题目 / 练习 / 试卷答案」，更不能照抄检索到的题面。
3. 出题：基于素材**自己写**全新的、原创的题干与参考答案。题面措辞必须是你自己的话，不得逐句复制任何来源。
4. 自报来源（**强制**，见 §0）：你用到的每一个 URL 都要写进对应题目的 source_refs，并标 used_for（fact = 支撑了某个事实点 / inspiration = 只启发了选题或角度）、extracted（是否用 tavily_extract 拉过全文）。运行时**无法**从日志恢复你调了哪些检索——只有你写进 source_refs 的来源才被记录。漏报 = 该题不可追溯。
5. 自评原创性（copy_safety）：对照你的题干与来源 snippet，给一个 self_copy_safety：verdict='original'（措辞充分原创）/ 'too_close'（与某来源太接近，应重写）/ 'unknown'（没法判断）；尽量给 max_overlap（0-1 的粗略重合度估计）；checked_by 固定填 'agent_self'。下游 QuizVerify 会再独立复核。

每题输出形状（QuizGenQuestion）：
{
  "kind": "${canonicalKinds}",
  "prompt_md": "原创题面 markdown，可含 LaTeX",
  "reference_md": "参考答案 + 简短解析",
  "choices_md": ["选项 A", "选项 B", ...] | null,
  "judge_kind_override": "exact"|"keyword"|"semantic" | null,
  "rubric_json": { "criteria": [{"name":"correctness","weight":1,"descriptor":"..."}], "keywords": [...], "required_points": [...] } | null,
  "difficulty": 1-5 的整数,
  "knowledge_ids": ["这道题考查的知识点 id"],
  "source_refs": [{ "url": "...", "title": "...", "snippet": "...(可选)", "used_for": "fact"|"inspiration", "extracted": true|false }]
}

整体严格 JSON 输出（不带 markdown 代码块包裹），shape 名 QuizGenOutput：
{"questions":[QuizGenQuestion, ...],"source_pack":{"query_plan":["你执行的检索查询", ...],"searched_at":"ISO8601 时间戳","tool":"tavily"},"generation_method":"search_grounded"|"closed_book"|"material_grounded","self_copy_safety":{"verdict":"original"|"too_close"|"unknown","max_overlap":0.0-1.0,"checked_by":"agent_self"},"material":{"body_md":"...","url":"...","title":"...","fetched_at":"ISO8601"}|null}

素材生成模式（generation_method="material_grounded"，阅读理解 / 据材出题专用）：
- 当题型需要一份**真实原文 / 真实数据**作锚（典型：阅读理解、文言翻译、据材料分析），用 tavily_extract 拉一份**真实素材原文**，全部题目都考查这份素材。
- 此时**必须**在顶层 material 填这份素材：body_md=素材原文全文（会被持久化、题面据它出），url/title=素材出处，fetched_at=拉取时间。漏填 material 该输出会被拒收。
- 题面要**明确指向**这份素材（如「阅读下面短文，回答问题」），reference_md 的答案要能在素材里找到依据。
- material_grounded 时各题 source_refs 仍如实填素材 URL；material 是被持久化的「真原文」单一来源，source_refs 是每题的引用足迹。
- 不需要真原文锚的常规题用 search_grounded（搜背景素材、自己出题），material 留空或省略。

题目要求：
- kind 只能是 ${canonicalKinds} 之一；不要发明新值；客观题统一用 "choice"。
- ${profile.promptFragments.checkQuestionPolicy}
- choice / true_false：judge_kind_override="exact"，给 3–4 个选项，reference_md 第一行是正确选项原文。
- fill_blank：可 exact；多个合理表述时用 "keyword" 并在 rubric_json.keywords 写 1–5 个必中关键词。
- short_answer / reading / translation / essay：judge_kind_override="semantic"，rubric_json.required_points 必填 1–5 个可核查要点。
- computation：只验最终答案可 exact；验方法要点用 semantic + required_points。
- knowledge_ids 用输入 knowledge_context 里真实存在的知识点 id，不要发明。
- 真没搜到可用素材时，可走 generation_method="closed_book"（凭已有知识出题），但 source_refs 仍如实填（可为空），并把 self_copy_safety.verdict 设 'unknown' 或 'original'。
约束（强约束）：
- 题干必须原创，**禁止**照抄任何检索到的题目 / 原文句子。
- 每个真正用到的 URL 都要进 source_refs（§0 强制自报）。generation_method="search_grounded" 时**每道题** source_refs 至少 1 条，否则该题会被拒收；只有 closed_book 才允许空 source_refs。
- 禁止：emoji、营销话、套话、JSON 之外的文字、用 markdown 代码块包裹整段 JSON。`;
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

// ADR-0031 / YUK-304 (quiz C→A lane B) — QuestionAuthorTask prompt. Single-shot
// structured output, NOT multimodal, NO tools (决定6: this is deliberately NOT
// the QuizGenTask agent loop — the copilot orchestrates, one call = one
// question). knowledge_context is the closed set of legal knowledge ids; the
// seed core (src/server/ai/question-author.ts) ALSO intersects the echoed ids
// against the live table and REGENERATES every structured node id, so a
// hallucinated id can never persist (belt-and-suspenders, GoalScope/Tagging
// 同款). seed_mode='material' carries the pasted material verbatim — the task
// cannot fetch URLs (no Tavily), so material_url is provenance-only metadata
// handled outside this prompt.
function buildQuestionAuthorPrompt(profile: SubjectProfile): string {
  const canonicalKinds =
    'choice | true_false | fill_blank | short_answer | essay | computation | reading | translation';
  return `你是${profile.displayName}出题作者，一次只写**恰好一道**原创题。输入 { seed_mode: 'knowledge'|'material', knowledge_context: [{ id, name }], requested_kind?, requested_difficulty?, material?: { body_md, title? } } —— knowledge_context 是这道题要考查的知识点（id 是你**唯一**能写进 knowledge_ids 的 id）；seed_mode='material' 时 material.body_md 是用户给的命题素材原文，题目必须**据这份素材**出。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

structured 树形（StructuredQuestion，二选一）：
- 材料/阅读类（kind=reading 等成篇考查，或输入带 material）：role='stem' 的根节点，prompt_text 放材料/语段**原文**，sub_questions[] 每个小题 role='sub'，各带自己的 prompt_text + answers + analysis（与 OCR 录入的大题/小题同构）。
- 其它题型：单个 role='standalone' 节点（prompt_text + options? + answers + analysis），无 sub_questions。
节点 id 随便填占位字符串即可——运行时会**重新生成**全部节点 id，不要依赖你给的 id。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 QuestionAuthorDraft：
{"kind":"${canonicalKinds} 之一","difficulty":1-5 的整数,"knowledge_ids":["<knowledge_context 里的 id>"],"structured":{"id":"占位","role":"stem"|"standalone","prompt_text":"...","options":[{"label":"A","text":"..."}]|省略,"answers":["..."],"analysis":"...","sub_questions":[{"id":"占位","role":"sub","question_no":"1","prompt_text":"...","answers":["..."],"analysis":"..."}]|省略},"choices_md":["选项 A 原文", ...]|null,"judge_kind_override":"exact"|"keyword"|"semantic"|null,"rubric_json":{"criteria":[{"name":"correctness","weight":1,"descriptor":"..."}],"keywords":[...],"required_points":[...]}|null}

题目要求：
- 恰好一道题；kind 只能是 ${canonicalKinds} 之一，requested_kind 出现时必须用它。
- requested_difficulty 出现时 difficulty 必须等于它；缺省自定。
- 每个叶节点（standalone 根 / 每个 sub）**必须**有非空 answers 和/或 analysis——缺答案的题会被整道拒收。
- choice / true_false：judge_kind_override="exact"，options 给 3–4 个选项，choices_md 同步给选项原文，answers 第一条是正确选项原文。
- short_answer / reading / translation / essay：judge_kind_override="semantic"，rubric_json.required_points 给 1–5 个可核查要点。
- computation：只验最终答案可 "exact"；验方法要点用 "semantic" + required_points。
- knowledge_ids 只能用 knowledge_context 里真实存在的 id，**禁止发明**（编造的 id 会被运行时丢弃）。
- seed_mode='material' 时题面必须明确指向素材（如「阅读上面的文段」），答案要能在素材里找到依据；禁止脱离素材自由发挥。
- 题干原创：不要照抄题库套话，不要出与素材无关的题。
- 禁止：emoji、套话、JSON 之外的任何文字、用 markdown 代码块包裹整段 JSON。`;
}

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

// YUK-361 Phase 3 Step B (Task 8 L2, ADR-0042 编排档2 amendment) —
// SelectionOrchestratorTask prompt. 档2 的 LLM **主脑**：对每个**非到期**候选输出
// { weight≥0, role, arrangement?, reason }。persona = D14 单人格编排者。
//
// signal-fidelity（ADR-0042:68）：输入信号是**分桶**的（high/mid/low），不是原始浮点
// （LLM 对浮点不敏感）——prompt 据此教 LLM 综合多维信号加权，而非读数。真实数值由
// Step C 的 sampler 兜 π_i，prompt 只塑造相对权重。
//
// 范围铁律（ADR-0042:58）：到期项相对序 + presence 是 L1 确定性契约，**不交给 LLM**。
// 本 task 只编排非到期候选——到期项根本不在输入里，prompt 明确禁止 LLM 触碰/重排它们。
function buildSelectionOrchestratorPrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}的学习编排者（单人格主脑），负责决定今天**非到期**候选题/卷里：选哪些值得现在练、怎么排、为什么。一次处理一批候选。
科目上下文：${profile.displayName}。${profile.languageStyle}

输入是一批**非到期候选**的信号投影，每行一条候选（信号已**分桶**成 high/mid/low/n/a 档，不是精确数值——按相对档位综合判断，别纠结具体数）：
- refId：候选唯一标识（你输出里的 refId **只能**用输入里出现过的，禁止发明）。
- refKind：question（单题）| paper（整卷，不可拆，当一个候选透传）。
- role：候选的现状角色（frontier 前沿新知 / diagnostic 诊断价值题 / new_check 新知巩固确认 / paper 卷）。
- mfi / diagnostic：信息量档——near-θ̂ 的诊断价值（high = 这道题最能测出当前能力边界）。
- difficulty_anchor：难度锚可信度（calibrated 真标定 / rough_estimate 粗估，别太当真 / unknown 无难度信息）。
- exam_relevance：考纲/目标相关度档（high = 离考试目标近）。
- misconception_recurrence：错因复发度档（high = 这类错反复犯，值得攻）。
- transfer_gap：迁移缺口档（high = 同知识点换个情境就不会，需迁移练习）。

你的职责（档2 主脑——这些是纯 MFI 算不出来、需要教学判断的）：
- **weight**（≥0 的数值）：这道候选**现在**值得练的教学价值。综合所有信号 + 学习者叙事连贯（别让今天的练习东一榔头西一棒槌）：诊断价值高 / 考纲相关 / 错因反复 / 迁移缺口大 → 高 weight；信息量低、刚练过同类、当前不该碰 → 低 weight。weight 越大 = 越该现在练。**weight 是相对的**，一个薄抽样器会按 weight 抽样落题（不是直接取最高分），所以给每个候选一个合理的相对权重即可，不必非 0 即 1。
- **role**：把候选归到 frontier / diagnostic / new_check / paper 之一（可与输入 role 不同——你可据信号重新判断它此刻的角色）。
- **arrangement**（可选整数，越小越靠前）：非到期候选之间的建议顺序——按教学连贯/由浅入深/主题聚合排。不确定就省略。
- **reason**：一句话教学理由（为什么这个权重/排序），引用信号档位或叙事考量，别写空话。

严格 JSON 输出（不带 markdown 代码块包裹），shape 名 SelectionOrchestratorDraft：
{"candidates":[{"refId":"<输入里的 refId>","weight":<≥0 的数值>,"role":"frontier"|"diagnostic"|"new_check"|"paper","arrangement":<整数，可省略>,"reason":"<一句教学理由>"}]}

铁律：
- **只编排输入里的非到期候选**。今天到期的复习项**不在**你的输入里，也**绝不**能出现在你的输出里——到期项的存在与相对顺序由系统确定性决定（FSRS *when* 契约），不归你管。
- 输出的每个 refId **必须**是输入里出现过的（发明的 refId 会被丢弃）；**给输入里每个候选都一个 weight**（别漏候选）。
- weight **不能为负**（负权会被拒）。weight=0 表示「现在不该练」是合法的。
- 你**不会**在输入里看到 recall（原题重背）候选——它们由系统确定性透传（same question re-shown，FSRS 测的就是这道题），从不交给你加权/重排。你只对**可换变体**的候选编排。
- 禁止：emoji、套话、JSON 之外的任何文字、用 markdown 代码块包裹整段 JSON。`;
}

// YUK-216 S2 slice 2 — SourcingTask prompt. Tool-calling agent that finds
// EXISTING practice questions on the web and restructures them.
//
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §3.
//   - Unlike QuizGen (which searches for SOURCE MATERIAL and writes ORIGINAL
//     questions), SourcingTask searches for REAL practice questions and lifts +
//     restructures them, recording each origin URL into per-question provenance.
//   - OF-1 回填 (YUK-223 / YUK-227 S3 Slice C): HTML/TEXT sources are extracted
//     inline as `questions`. Image-type sources — pages whose stem lives in an
//     image that tavily_extract cannot lift as text — are reported as
//     `image_candidates` (NOT auto-extracted: 守 ADR-0002, VLM 抽图是用户授权的
//     付费动作). The handler turns each into an `image_candidate` proposal, and a
//     VLM extraction runs ONLY on explicit user accept. The prompt MUST teach the
//     agent (a) when to report an image_candidate, (b) the output contract for it,
//     and (c) never to double-report a source as both a question and a candidate —
//     生产 agent only emits image_candidates if the prompt asks for them.
//   - This片 is the MINIMAL task-description skeleton (role / output contract /
//     whitelist note). Domain content (题型规范 etc.) migrates to an Agent Skill
//     in slice 4 — this builder stays thin per the owner's code-as-task-description
//     philosophy.
//
// The handler mounts the Tavily remote MCP (tavily_search / tavily_extract) + an
// in-process domain-tool MCP at run time, so this prompt refers to tools by
// capability, not by exact mcp__* identifier.
function buildSourcingPrompt(profile: SubjectProfile): string {
  const canonicalKinds =
    'choice | true_false | fill_blank | short_answer | essay | computation | reading | translation';
  return `你是${profile.displayName}题源检索员。任务：根据输入的学科 + 考点/题型 + 数量，**联网检索现成的练习题**，把每道题抽取并结构化为 SourcedQuestion。输入 { subject, knowledge_context, kinds?, count, whitelist } —— count 是期望题数，whitelist 是可信题源域名列表（可能为空）。
科目上下文：${profile.displayName}。${profile.languageStyle}
证据要求：${profile.grounding.requirement}
不确定性策略：${profile.grounding.uncertaintyPolicy}

你有工具：
- 联网检索（tavily_search / tavily_extract）：搜**现成的练习题 / 习题 / 真题**；需要题面与答案细节时用 tavily_extract 拉网页正文。
- 领域读工具：可读用户的知识图谱，确认题目考查的 knowledge_ids 真实存在。

工作流程：
1. 检索：用 tavily_search 找与考点/题型相关的现成练习题页面。
2. 抽取：用 tavily_extract 拉网页正文，从中**逐题**抽出题面、参考答案、选项（若有）。忠实抽取，不要自己改写题意或编造答案。
3. 结构化：把每道题映射成 SourcedQuestion，标注 kind / 难度 / 它考查的 knowledge_ids（用 knowledge_context 里真实存在的 id）。
4. 记录来源（**强制**）：每道题写它来自的 source_url（具体网页 URL）+ source_title（页面标题）。运行时无法从日志恢复你访问了哪些页面——只有写进 source_url 的来源才被记录。漏报 = 该题不可追溯、会被拒收。
5. 图片型题源（**不要自己抽图**）：当 tavily_extract **拿不到题干文本**（返回空/近空正文），但 tavily_search 的搜索结果表明该 URL 确实含真题（标题/摘要指向练习题/真题/试卷）——说明题干在**图片**里（扫描卷 PNG、图表题等）。这种源**不要**编造文本题、**不要**塞进 questions，改为报进 image_candidates。抽图是用户授权的付费动作，由用户在收件箱里 accept 后才发生，不是你的职责。

每题输出形状（SourcedQuestion）：
{
  "kind": "${canonicalKinds}",
  "prompt_md": "题面 markdown（忠实抽取，可含 LaTeX）",
  "reference_md": "参考答案 + 简短解析",
  "choices_md": ["选项 A", "选项 B", ...] | null,
  "judge_kind_override": "exact"|"keyword"|"semantic" | null,
  "rubric_json": { "criteria": [{"name":"correctness","weight":1,"descriptor":"..."}], "keywords": [...], "required_points": [...] } | null,
  "difficulty": 1-5 的整数,
  "knowledge_ids": ["这道题考查的知识点 id"],
  "source_url": "题目来自的具体网页 URL",
  "source_title": "该网页标题",
  "extract": "（必填）你从该网页**逐字抽取**的原始题面片段（质检会用它与题面做确定性比对，证明 source_url 真实可追溯；忠实粘贴，勿改写）",
  "extraction_hash": "(可选) 抽取内容指纹"
}

图片型题源输出形状（SourcingImageCandidate，**可选数组**，没有就省略）：
{
  "source_url": "题干为图片的具体网页 URL（accept 时会从这里下载图片）",
  "source_title": "该网页标题",
  "summary_md": "为什么判定为图片型源（如 tavily_extract 返回空文本但搜索结果指向真题）+ 该页大致含什么内容（给用户在收件箱里决定要不要花一次抽图）"
}

整体严格 JSON 输出（不带 markdown 代码块包裹），shape 名 SourcingTaskOutput：
{"questions":[SourcedQuestion, ...],"image_candidates":[SourcingImageCandidate, ...](可省略),"query_plan":["你执行的检索查询", ...],"fetched_at":"ISO8601 时间戳","tool":"tavily"}

题目要求：
- kind 只能是 ${canonicalKinds} 之一；不要发明新值；客观题统一用 "choice"。
- choice / true_false：judge_kind_override="exact"，给选项，reference_md 第一行是正确选项原文。
- fill_blank：可 exact；多个合理表述时用 "keyword" 并在 rubric_json.keywords 写 1–5 个必中关键词。
- short_answer / reading / translation / essay：judge_kind_override="semantic"，rubric_json.required_points 必填 1–5 个可核查要点。
- computation：只验最终答案可 exact；验方法要点用 semantic + required_points。
- knowledge_ids 用 knowledge_context 里真实存在的知识点 id，不要发明。
- whitelist 非空时**优先**抽取命中白名单域名的来源；白名单外的来源仍可抽（会在入库时被降权标记，不影响质检），但不要为了凑数抽明显低质的来源。
约束（强约束）：
- 每道题必须有有效的 source_url（具体网页 URL）+ source_title，否则会被拒收。
- **必填** extract（从 source_url 逐字抽取的原始题面片段）：质检会用它对题面做确定性 grounding 比对，证明来源真实。缺 extract 或 extract 与题面毫无重叠 → 该题被判为来源不可锚定/伪造、拒收。
- 图片型题源报进 image_candidates，**不要**自己抽图、**不要**为图片源编造文本题。
- **同一个源不要既报成 question 又报成 image_candidate**：能抽出文本就只放 questions；抽不出文本（图片型）就只放 image_candidates。二选一。
- 一道题都没找到、且也没有图片型源时，宁可返回空 questions（运行会失败）也不要编题；但只要有图片型源，至少报进 image_candidates。
- 禁止：emoji、营销话、套话、JSON 之外的文字、用 markdown 代码块包裹整段 JSON。`;
}

export function getTaskSystemPrompt(
  task: AiTaskKind,
  profile: SubjectProfile = defaultSubjectProfile,
): string {
  switch (task) {
    case 'AttributionTask':
      return buildAttributionPrompt(profile);
    case 'AttributionRerankTask':
      return buildAttributionRerankPrompt(profile);
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
    case 'BlockAssemblyTask':
      return buildBlockAssemblyPrompt(profile);
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
    case 'SemanticJudgeTask':
      return buildSemanticJudgePrompt(profile);
    case 'UnitDimensionFallback':
      return buildUnitDimensionFallbackPrompt(profile);
    case 'StepsJudgeTask':
      return buildStepsJudgePrompt(profile);
    case 'MultimodalDirectJudgeTask':
      return buildMultimodalDirectJudgePrompt(profile);
    case 'VariantGenTask':
      return buildVariantGenPrompt(profile);
    case 'VariantVerifyTask':
      return buildVariantVerifyPrompt(profile);
    case 'TeachingTurnTask':
      return buildTeachingTurnPrompt(profile);
    case 'SolutionGenerateTask':
      return buildSolutionGeneratePrompt(profile);
    case 'QuizGenTask':
      return buildQuizGenPrompt(profile);
    case 'QuizVerifyTask':
      return buildQuizVerifyPrompt(profile);
    case 'QuestionAuthorTask':
      return buildQuestionAuthorPrompt(profile);
    case 'ItemPriorTask':
      return buildItemPriorPrompt(profile);
    case 'SelectionOrchestratorTask':
      return buildSelectionOrchestratorPrompt(profile);
    case 'SourcingTask':
      return buildSourcingPrompt(profile);
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
    // YUK-203 U4 — ReviewPlanTask is subject-neutral (the strategic brief carries
    // all subject angle via read_coach_brief); its registry-inline systemPrompt IS
    // the runtime prompt. Joins the pass-through group, same as Coach / Dreaming.
    case 'ReviewPlanTask':
    // Station 2A (YUK-185) — MemoryBriefTask is subject-NEUTRAL: the per-scope
    // `template` carries the angle and is passed in the input, not baked into a
    // profile builder. Joins this pass-through group (registry systemPrompt is the
    // SoT). Promote into a buildMemoryBriefPrompt(profile) only if a subject later
    // demands a coaching voice (OF-2).
    case 'MemoryBriefTask':
    // U7 (YUK-203) — ProfileCriticTask is subject-NEUTRAL: it reviews a draft
    // SubjectProfile whose subject angle lives in the input draft, not the prompt
    // voice. Joins the pass-through group (registry-inline systemPrompt IS the
    // runtime SoT, Q3) — no buildProfileCriticPrompt(profile) builder.
    case 'ProfileCriticTask':
    // YUK-478 — ColdStartPlacementBridgeTask is subject-NEUTRAL: the candidate
    // subject ids ride in the input, not the prompt voice, and the classify+answer
    // instructions are generic across subjects. Joins the pass-through group
    // (registry-inline systemPrompt IS the runtime SoT) — no profile builder.
    case 'ColdStartPlacementBridgeTask':
      return tasks[task].systemPrompt;
    default:
      return assertNever(task);
  }
}
