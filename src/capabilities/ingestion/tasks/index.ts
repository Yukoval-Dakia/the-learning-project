import { causeIdList, causeTaxonomyList } from '@/ai/cause-prompt';
import { DEFAULT_TASK_BUDGET, type TaskDefinition } from '@/ai/task-spec';
import type { SubjectProfile } from '@/subjects/profile';

// YUK-863 / F3.2 — Ingestion capability owns these six TaskDefinitions.

function buildStructurePrompt(profile: SubjectProfile): string {
  return `你是${profile.displayName}试卷结构化助手（多模态）。输入：
- user message 里按页顺序附了 N 张试卷/作业页面图片（第 1 张 = page_index 0，依次类推）
- 一段文字 { tencent_hint_md, page_count[, figures] } —— tencent_hint_md 是腾讯字符级 OCR 的**文字提示**（已按页用 "=== page K ===" 分隔），仅作参考，**不是**结构真相；figures（若存在）是裁剪图列表 [{index, page_index, position}]，表示已从页面裁剪出的图片素材：index 是序号，page_index 是所在页，position 是归一化位置摘要（"top-left" / "top-center" / "top-right" / "mid-left" / "mid-center" / "mid-right" / "bot-left" / "bot-center" / "bot-right"，按图片中心点在页面 3×3 区域落点）
科目上下文：${profile.displayName}。${profile.languageStyle}

任务：以**图片为准**、腾讯文字为辅，输出一棵**规范化的题目结构树**。你对结构有完全裁量权，可以覆盖腾讯文字 hint 暗示的任何切分。
关键能力：
1. **跨页大题组装**：一道大题（passage / 阅读理解 / 完形 / 大题带多个小问）如果横跨多页，必须组装成**一个** stem 节点，它的 sub_questions 收齐所有页的小问。不要因为换页就把同一大题拆成两个顶层节点。
2. **布局规范**：把题面、选项、答案规整到结构字段里；passage 进 stem 的 prompt_text，小问进 sub。
3. 不抽取手写涂改 / 批改痕迹作为结构（那是作答证据，下游处理）。但要**判断每个节点上是否存在学生的手写作答 / 批改痕迹**：在该 StructureNode 上填 student_answer_present（true / false）。**绝不转写手写内容**——只报「有没有」这个布尔，像素留给下游判分（手写永远是像素，不做 OCR 转写）。整页都没有学生作答 → 全部省略或填 false。
4. **图片归属（仅当输入含 figures 字段时）**：根据页面图片判断每张裁剪图属于哪道题，在对应 StructureNode 上填写 figure_ids（裁剪图序号数组）。跨页大题的配图（包括图示、电路图、坐标图等）归到 stem 节点。同一页且视觉上**明确**属于某小问的图归到该 sub 节点。**只在判断确定时填 figure_ids**——拿不准的图省略（不要猜，留给几何兜底）。漏报比错报代价小：几何兜底一定能处理漏报，但 VLM 错误归属会覆盖兜底，下游无法纠正。position 字段（图的位置摘要）可辅助判断同页归属关系，但仍以图片视觉为准。

输出严格 JSON（不带 markdown 代码块包裹），shape 名 StructureOutput：
{"layout_quality":"structured"|"partial"|"text_only","extraction_confidence":0.0-1.0,"warnings":["..."],"questions":[StructureNode, ...]}

StructureNode（递归，**不要**输出 id，运行时会补）：
{"role":"stem"|"sub"|"standalone","question_no":"1"|null,"prompt_text":"...","options":[{"label":"A","text":"..."}]|null,"answers":["..."]|null,"analysis":"..."|null,"page_index":0,"sub_questions":[StructureNode, ...]|null,"figure_ids":[0,1]|null,"student_answer_present":true|false|null}

约束：
- role 三选一：stem（容器，含 passage + sub_questions）/ sub（大题下的小问）/ standalone（独立单题）。只有 stem 能有 sub_questions；sub / standalone 的 sub_questions 必须为 null 或省略。
- page_index 是 0-based 整数，指该节点主要出现在第几张图（跨页 stem 用它起始页）。
- figure_ids 是裁剪图序号数组（0-based，与输入 figures[].index 对应）；无配图时给 null 或省略。**仅当输入含 figures 字段时才填写 figure_ids**，否则省略。
- student_answer_present 是布尔：该节点的题面区域是否有学生手写作答 / 批改痕迹。**只报 true/false，绝不转写手写文字**（手写是作答像素，下游判分用，不做 OCR）。无 / 不确定给 null 或省略。
- 顶层 questions 至少 1 个；如果整页无法识别出任何题，questions 给空数组并把 layout_quality 设 "text_only"。
- layout_quality：结构清晰完整 → "structured"；能出题但版式残缺/有疑点 → "partial"；几乎认不出结构 → "text_only"。
- extraction_confidence：你对整棵结构树与原图一致性的置信度（0 到 1）。跨页归属、题号、选项或层级有疑点时必须降低；不要把字段固定写成 1。
- options / answers / analysis 没有就给 null 或省略，不要编。
- 禁止：输出 JSON 之外的文字、把跨页同一大题拆成多个顶层节点、把腾讯文字 hint 当成不可改的结构。`;
}

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
- reason_md 必须具体：引用 question_no、题面文字或数组位置（如「第 N 块」），说清为什么该合并；这是用户可见文案，**禁止写入 block_id 或其他不透明 ID**。
- **宁缺毋滥**：没有明确该合并的相邻块时，输出空 candidates。禁止套话、禁止 JSON 之外的文字。`;
}

export const ingestionTaskSpecs: Record<string, TaskDefinition> = {
  BlockAssemblyTask: {
    kind: 'BlockAssemblyTask',
    description:
      'YUK-202 / BlockAssembly path-B (design 2026-06-02 §2) — 给一个 ingestion session 的全部 draft blocks（按数组顺序 = 相邻关系）的紧凑文字投影（question_no / prompt 头 / role / 子问数 / layout_quality），找出哪些相邻 block 其实是被切开的同一道逻辑题（编号连续 / 子问承接 / 题干答案分离 / "承接前题、根据上文" 提示），输出 BlockAssemblyOutput 候选。单次结构化输出，输入是结构化文字（非页面图片）→ NON-vision，走 TaggingTask 同档轻量模型。SEMANTIC-ONLY：spatial/bbox page-edge 信号 DEFERRED 到 slice 2b（§0）。AI 只 propose 不 auto-merge（§5 硬边界）；候选经 writeBlockMergeProposal 落 inbox，用户接受才跑 mergeQuestions。',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildBlockAssemblyPrompt },
  },
  VisionExtractTask: {
    kind: 'VisionExtractTask',
    description: '错题图片 → 切块 + 题面 + 答案 + bbox（manual rescue only after Sub 0c）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    invocation: 'manual_rescue_only',
    prompt: {
      kind: 'inline',
      text: '你是错题录入助手。给定一张题目图片（试卷/手写/教材截图），输出严格 JSON（不带 markdown 代码块包裹）：\n{"blocks":[{"extracted_prompt_md":"...","reference_md":"...|null","wrong_answer_md":"...|null","page_index":0,"bbox":{"x":0.1,"y":0.2,"width":0.6,"height":0.3},"role":"prompt|answer_area|continuation","visual_complexity":"low|medium|high","extraction_confidence":0.0-1.0,"knowledge_hint":"...|null"}]}\n约束：bbox 坐标 0-1 归一化（不是像素）；一图可输出 1+ 个 block（一页多题）；page_index 由调用方覆盖；wrong_answer_md 仅当图上有用户错答 / 批改痕迹时填；knowledge_hint 是软提示。',
    },
  },
  VisionExtractTaskHeavy: {
    kind: 'VisionExtractTaskHeavy',
    description: '错题图片 → 切块（heavy / Tier 3 — mimo-v2.5 multimodal manual rescue）',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    invocation: 'manual_rescue_only',
    prompt: {
      kind: 'inline',
      text: '你是错题录入助手（heavy 模式，前两层 OCR / haiku 都失败）。给定一张题目图片（可能含手写 / 复杂版式 / 公式），输出严格 JSON（不带 markdown 代码块包裹）：\n{"blocks":[{"extracted_prompt_md":"...","reference_md":"...|null","wrong_answer_md":"...|null","page_index":0,"bbox":{"x":0.1,"y":0.2,"width":0.6,"height":0.3},"role":"prompt|answer_area|continuation","visual_complexity":"low|medium|high","extraction_confidence":0.0-1.0,"knowledge_hint":"...|null"}]}\n约束：bbox 坐标 0-1 归一化（不是像素）；page_index 由调用方覆盖；wrong_answer_md 仅当图上有用户错答 / 批改痕迹时填。',
    },
  },
  StructureTask: {
    kind: 'StructureTask',
    description:
      'T-OC slice 2 (YUK-145, OC-1/OC-2) — VLM 全权拥有结构。输入 N 页图片 + 腾讯文字 OCR hint → 规范结构树（跨页大题组装 + 布局规范）。腾讯结构降为 hint，VLM 可完全覆盖。题图匹配 (assignFigures 替换) DEFERRED 到 slice 2b。自动调用（作为 extraction 一环，类比 StepsJudgeTask），非 manual rescue。',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 120_000 },
    needsToolCall: false,
    isMultimodal: true,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildStructurePrompt },
  },
  MistakeEnrollTask: {
    kind: 'MistakeEnrollTask',
    description:
      'T-OC slice A1 (YUK-145, OC-5) — 已答题 → 草拟错题录入元数据（outcome / question_type / difficulty / cause）。proposal-only，供用户一键确认。',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5-pro',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildMistakeEnrollPrompt },
  },
  TaggingTask: {
    kind: 'TaggingTask',
    description:
      'T-OC slice 3 (YUK-145, OC-4) — 给一道抽取出的题（题面文字 + 可选 knowledge_hint）+ 一份知识网格快照（节点 + mesh 边），建议它覆盖哪些 knowledge_id（每条带 confidence + reasoning）+ 一个 overall_confidence。单次结构化输出，非多模态（题面已是文字）。下游 WorkflowJudge 用它的 confidence 做高置信自动入库 / 低置信 review 裁决。',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 60_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: { kind: 'profile', build: buildTaggingPrompt },
  },
  ColdStartPlacementBridgeTask: {
    kind: 'ColdStartPlacementBridgeTask',
    description:
      'YUK-478 — cold-start upload→placement bridge. Runs ONCE per uploaded question whose VLM extraction matched NO knowledge node (the thin-seed tree from YUK-477 has only subject roots, so TaggingTask drops every suggestion). COMBINES two bridges in ONE text-only structured call: (①) classify the question into one KNOWN_SUBJECT_ID so a child KC can be created under seed:<subjectId>:root, and (③) generate a correct reference answer FOR the existing prompt when OCR extracted no answer, so the judge has a real grading anchor. Output = { subject_id, kc_name, reference_md }.',
    defaultProvider: 'xiaomi',
    defaultModel: 'mimo-v2.5',
    budget: { ...DEFAULT_TASK_BUDGET, maxIterations: 1, timeout: 90_000 },
    needsToolCall: false,
    isMultimodal: false,
    allowedTools: [],
    prompt: {
      kind: 'inline',
      text: 'You are a cold-start placement bridge for a personal learning tool. You are given ONE question that a learner uploaded, plus the closed list of subjects the tool supports. Do THREE things in a single strict-JSON reply.\n\nINPUT (a JSON object): `question_md` (the question prompt text), `existing_reference_md` (the reference answer already extracted from the image, or null), `knowledge_hint` (a soft topic hint or null), and `known_subjects` (the ONLY subjects you may pick from). Each `known_subjects` entry is an object: `id` (an OPAQUE identifier to copy back — it may be a readable slug like "yuwen" or a meaningless token like "subj_x3k9q"; NEVER read meaning into it, never interpret or transform it), `display_name` (the human-facing subject name — classify by THIS), and optionally `aliases` (alternate names for the same subject).\n\nTASK 1 — CLASSIFY SUBJECT: pick the ONE `known_subjects` entry whose `display_name` (or `aliases`) best fits the question, and return that entry\'s `id` copied back VERBATIM as `subject_id`. Judge the fit by `display_name`/`aliases` only, never by the id text. Never invent an id, never return one outside the list. If genuinely ambiguous, pick the closest fit.\n\nTASK 2 — NAME THE CONCEPT: write `kc_name`, a concise knowledge-concept label (a topic/skill name, at most ~60 characters) describing what the question tests. This is a category name (e.g. "二次函数求根" / "Newton\'s second law" / "虚词「之」的用法"), NOT a restatement of the question and NOT the answer.\n\nTASK 3 — REFERENCE ANSWER: produce `reference_md`, the correct reference answer for `question_md`. If `existing_reference_md` is non-null, ECHO it back unchanged (do not regenerate or "improve" it). If it is null, SOLVE the question yourself and give the correct, concise answer (include the key working only when it is essential to justify the answer). If you truly cannot answer, return an empty string for `reference_md`.\n\nOUTPUT: strict JSON only, exactly these four keys and nothing else: `subject_id` (an `id` copied verbatim from `known_subjects`), `kc_name` (string), `reference_md` (string), `reasoning` (a one-sentence justification). No markdown fences, no prose outside the JSON.',
    },
  },
};
