// Loom · mock data (round-2a). Shapes consume fixed backend fields per handoff §3-4.
// Classical-Chinese (文言文) learning domain.
const DATA = {
  user: { name: "知微", initial: "知", plan: "Studio" },
  build: "phase 1c · 2026-06-02",

  // ── Today · 4 contract KPIs (each clickable → route) ──────────────
  kpis: [
    { key: "due",  label: "FSRS · 到期",   icon: "review",    value: 12, sub: "今日待复习队列",                          route: "review" },
    { key: "attr", label: "错题 · 待归因", icon: "mistakes",  value: 3,  sub: "attempt:failure 无 judge",                route: "mistakes" },
    { key: "prop", label: "AI 提议 · 待审", icon: "inbox",     value: 9,  sub: "block_merge 2 · knowledge_edge 3 · note_update 4", route: "inbox" },
    { key: "know", label: "知识点",        icon: "knowledge", value: 48, sub: "tree + mesh",                            route: "knowledge" },
  ],

  // ── Today · three lanes ───────────────────────────────────────────
  threads: [
    { id: "review", label: "复习队列 · FSRS", title: "12 张卡片到期", sub: "again 1 · hard 2 · good 9 · 逾期 12", icon: "review", tone: "coral", badge: "12 到期", cta: "开始 review_session", route: "review" },
    { id: "intent", label: "学习意图",       title: "5 个意图在途",   sub: "hub 2 · atomic 3 · 待拆解 1",        icon: "items",  tone: "info",  badge: "5 在途", cta: "打开",            route: "items" },
    { id: "coach",  label: "Coach · 周度报表", title: "本周报表已生成", sub: "近 7 天 · 84 reviews · 71% 正确",   icon: "target", tone: "good",  badge: "7d",     cta: "查看",            route: "coach" },
  ],

  // ── Today · active/abandoned review sessions ──────────────────────
  sessions: [
    { id: "rs_41", type: "review", status: "in_progress", reviewed: 7, dist: "again 1 · hard 2 · good 4", dur: "14m", subject: "文言 · 虚词",  action: "resume" },
    { id: "rs_39", type: "review", status: "abandoned",   reviewed: 3, dist: "again 1 · good 2",          dur: "6m",  subject: "史记选读",   action: "restore" },
  ],

  // ── Today · AI changes in last 24h (reversible) ───────────────────
  aiChanges: [
    { id: "ch_88", agent: "dreaming",    target: "artifact", ops: 3, delta: "+1 block", ver: "v4→v5", when: "2h 前" },
    { id: "ch_86", agent: "maintenance", target: "note",     ops: 1, delta: "~1 block", ver: "v2→v3", when: "昨 23:40" },
  ],

  // ── Today · proposal inbox summary ────────────────────────────────
  inboxSummary: { total: 9, breakdown: [["block_merge", 2], ["knowledge_edge", 3], ["note_update", 4]] },

  // ── Today · "AI 观察" — agent-to-agent notes (read-only spectator) ──
  // Signals AI tasks leave for each other. NO user write/approve — distinct
  // from inboxSummary proposals (those await human adjudication). Newest first.
  // `fresh` seeds local unread state; `ttl.soon` flags 临期 (expiring soon).
  agentNotes: [
    { id: "an_31", from: "qverify", to: ["dreaming", "planning"], signal: "pool_gap", confidence: 0.86, fresh: true,
      body: "知识点 `k_xuci_zhi` 的「主谓取独」题池只剩 **2 题**，且都已 verified；建议补 3–4 道变体。",
      evidence: { id: "evt_3120", label: "attempt:failure · 之" }, when: "12 分钟前", ttl: { text: "3 天后过期", soon: false } },
    { id: "an_30", from: "chat", to: ["dreaming"], signal: "misconception", confidence: 0.79, fresh: true,
      body: "近 5 次对话里你把 **「之」定语助词** 与 **主谓取独** 反复混淆，疑似系统性误解。",
      evidence: { id: "evt_3104", label: "对话 · s_chat_88" }, when: "40 分钟前", ttl: null },
    { id: "an_29", from: "annotate", to: ["planning"], signal: "quality", confidence: 0.93, fresh: false,
      body: "笔记 `note_judge`「固…所…也」标志词标注质量高，可作判断句式讲解范例。",
      evidence: { id: "note_judge", label: "note · 判断句式" }, when: "2 小时前", ttl: null },
    { id: "an_28", from: "ingest", to: ["dreaming", "chat"], signal: "offtopic", confidence: 0.68, fresh: false,
      body: "「报任安书」录入反复出现切题偏差：抽出的 3 块里有 1 块其实是上一题的解析。",
      evidence: { id: "rec_88", label: "ingestion · 报任安书" }, when: "昨天 23:10", ttl: { text: "明天过期", soon: true } },
    { id: "an_27", from: "qverify", to: ["planning"], signal: "quality", confidence: 0.71, fresh: false,
      body: "`k_shiji` 近 7 天正确率回到 **84%**，质量信号转好，可下调复习权重。",
      evidence: { id: "evt_2990", label: "review_session rs_39" }, when: "昨天 20:02", ttl: null },
  ],

  // ── Today · cost ribbon ───────────────────────────────────────────
  cost: {
    today: 1.84, budget: 5.0,
    tasks: [["dreaming", 0.71], ["vision_extract", 0.52], ["judge", 0.39], ["coach", 0.22]],
    tokensIn: 128400, tokensOut: 24100, toolCalls: 37,
  },

  // ── Review · single card, two-phase ───────────────────────────────
  reviewCard: {
    deck: "文言虚词", tag: "k_xuci_zhi", index: 7, total: 38, overdue: 12,
    q: "下列句中「之」的用法：\n\n　　师道之不传也久矣。",
    reference: "用于主谓之间，取消句子独立性，使「师道不传」由句子降为偏正短语作主语。\n\n对比「古之学者」中「之」为结构助词「的」。",
    sampleUserAnswer: "结构助词，相当于「的」。",
    fsrs: { stability: "12.4d", difficulty: "0.31", retr: "0.94", due: "明日" },
    attempts: [
      { n: 1, when: "14 天前", outcome: "failure", note: "答成「代词」" },
      { n: 2, when: "3 天前",  outcome: "partial", note: "方向对、表述不全" },
    ],
    judge: { verdict: "部分正确", cause: "混淆『之 · 定语助词』与『之 · 主谓取独』", advice: "hard" },
    // FSRS — three tiers only (again / hard / good)
    grades: [
      { g: "again", label: "不会", when: "<1 分", cls: "g-again", num: 1 },
      { g: "hard",  label: "模糊", when: "2 天",  cls: "g-hard",  num: 2 },
      { g: "good",  label: "会了", when: "12 天", cls: "g-good",  num: 3 },
    ],
  },

  // ── Record · modes + form vocab ───────────────────────────────────
  recordModes: [
    { id: "context",       label: "学习记录", icon: "pencil",   sub: "疑问 / 顿悟 / 反思 / 资料" },
    { id: "manual",        label: "错题录入", icon: "mistakes", sub: "手动录一道错题" },
    { id: "vision_single", label: "拍照单题", icon: "image",    sub: "单题拍照 → 抽取" },
    { id: "vision_paper",  label: "整页文档", icon: "doc",      sub: "多题 / 整页 → 抽取" },
  ],
  contextKinds: ["疑问", "顿悟", "反思", "资料"],
  mistakeTypes: ["选择", "填空", "简答", "默写", "翻译"],
  causes: ["概念混淆", "审题偏差", "记忆遗忘", "方法不熟", "表述不全", "计算失误"],
  kpoints: [
    { tag: "k_xuci_zhi", label: "之 · 用法" },
    { tag: "k_xuci_yu",  label: "于 · 用法" },
    { tag: "k_judge",    label: "判断句式" },
    { tag: "k_zhi_subj", label: "主谓取独" },
    { tag: "k_shiji",    label: "史记选读" },
  ],
  // auto-enroll review surface — production is observe-only (flag OFF), so empty
  // is the common state; populated list + revert is designed here.
  autoEnrolled: [
    { id: "ae_1", route: "mistake", confidence: 0.88, knowledge: "k_xuci_zhi", title: "「之」定语助词 误判 → 错题", state: "enrolled" },
    { id: "ae_2", route: "record",  confidence: 0.72, knowledge: "k_judge",    title: "判断句式 资料 → 学习记录", state: "draft" },
    { id: "ae_3", route: "mistake", confidence: 0.64, knowledge: "k_zhi_subj", title: "主谓取独 漏判 → 错题",      state: "draft" },
  ],
  ingestDraft: {
    title: "报任安书 · 节选", chars: 642,
    text: "仆之先非有剖符丹书之功，文史星历近乎卜祝之间，固主上所戏弄，倡优所畜，流俗之所轻也。",
    extracted: [
      { type: "字词", text: "剖符丹书", note: "古代帝王分封功臣的凭证", k: "k_typo_pofu" },
      { type: "句式", text: "固…所…也", note: "判断句式，强调身份",     k: "k_judge" },
      { type: "虚词", text: "之",       note: "结构助词，定中之间",     k: "k_xuci_zhi" },
    ],
  },

  // ── Inbox · proposals across real kinds, with evidence backlinks ──
  proposals: [
    { id: "e_04", kind: "knowledge_edge", title: "建立 derived_from 关系", body: "若 k_xuci_zhi_attr 被接受，自动建一条 derived_from 边回父节点。",
      from: "maintenance", cost: "$0.0012", confidence: 0.88,
      evidence: { type: "event", id: "evt_3120", label: "attempt:failure · 之" },
      edge: { rel: "derived_from", a: "k_xuci_zhi_attr", b: "k_xuci_zhi" } },
    { id: "e_05", kind: "knowledge_edge", title: "标注 contrasts_with：之 ↔ 其", body: "两虚词在代词用法上常被混淆，建议建立对比关系边。",
      from: "dreaming", cost: "$0.0009", confidence: 0.79,
      evidence: { type: "event", id: "evt_3104", label: "attempt:failure · 其" },
      edge: { rel: "contrasts_with", a: "k_xuci_zhi", b: "k_xuci_qi" } },
    { id: "e_06", kind: "knowledge_edge", title: "标注 prerequisite：判断句 → 固…所…也", body: "掌握判断句式是理解该固定结构的前提。",
      from: "analysis", cost: "$0.0011", confidence: 0.83,
      evidence: { type: "record", id: "rec_77", label: "ingestion · 报任安书" },
      edge: { rel: "prerequisite", a: "k_judge", b: "k_gusuoye" } },

    { id: "bm_1", kind: "block_merge", title: "合并录入块：题干 + 解析", body: "两块应为同一道题被拆开录入。",
      from: "dreaming", cost: "$0.0031", confidence: 0.81,
      evidence: { type: "record", id: "rec_88", label: "ingestion · 报任安书" },
      merge: { primary: { id: "blk_12", text: "仆之先非有剖符丹书之功……固主上所戏弄。" },
               into:    { id: "blk_13", text: "（解析）言家世微贱、无功可恃，自陈身份卑下。" },
               reason: "题干在 A 块、解析在 B 块" } },
    { id: "bm_2", kind: "block_merge", title: "合并录入块：(1)(2) 跨块续写", body: "第 (2) 小问被分到下一块，应与第 (1) 问合并。",
      from: "dreaming", cost: "$0.0028", confidence: 0.74,
      evidence: { type: "record", id: "rec_90", label: "ingestion · 史记选读" },
      merge: { primary: { id: "blk_31", text: "(1) 翻译「卒相与欢，为刎颈之交」。" },
               into:    { id: "blk_32", text: "(2) 分析廉颇态度转变的原因。" },
               reason: "(1)(2) 跨块续写" } },

    { id: "nu_1", kind: "note_update", title: "更新笔记：补「之」主谓取独例句", body: "为 k_xuci_zhi 的主笔记追加 1 个例句块。",
      from: "dreaming", cost: "$0.0007", confidence: 0.86,
      evidence: { type: "event", id: "evt_3120", label: "attempt:failure · 之" } },
    { id: "nu_2", kind: "note_update", title: "更新笔记：修正「于」释义", body: "将「于」表被动的释义补全为含「介词引进对象」。",
      from: "maintenance", cost: "$0.0006", confidence: 0.77,
      evidence: { type: "record", id: "rec_61", label: "note · 文言虚词系统" } },
    { id: "nu_3", kind: "note_update", title: "更新笔记：合并重复释义", body: "k_judge 笔记内两个块释义重复，建议合并。",
      from: "maintenance", cost: "$0.0005", confidence: 0.69,
      evidence: { type: "record", id: "rec_61", label: "note · 文言虚词系统" } },
    { id: "nu_4", kind: "note_update", title: "更新笔记：补判断句标志词表", body: "为 k_judge 追加「者…也 / …也 / 乃 / 即」标志词表。",
      from: "dreaming", cost: "$0.0008", confidence: 0.82, subject: "yuwen",
      evidence: { type: "record", id: "rec_77", label: "ingestion · 报任安书" } },

    { id: "e_07", kind: "knowledge_edge", title: "标注 prerequisite：导数 → 单调性", body: "求单调区间需先掌握导数符号判别，建议建一条前置边。",
      from: "analysis", cost: "$0.0013", confidence: 0.85, subject: "math",
      evidence: { type: "event", id: "evt_3210", label: "attempt:failure · 导数大题" },
      edge: { rel: "prerequisite", a: "k_math_deriv", b: "k_math_mono" } },
    { id: "bm_3", kind: "block_merge", title: "合并录入块：完形短文 + 选项", body: "完形短文与其编号选项被拆成两块，应合并为一道大题。",
      from: "dreaming", cost: "$0.0029", confidence: 0.76, subject: "eng",
      evidence: { type: "record", id: "rec_103", label: "ingestion · 英语周测卷" },
      merge: { primary: { id: "blk_55", text: "Last summer I __1__ a small village in the mountains…" },
               into:    { id: "blk_56", text: "1. A. visited  B. visit  C. visiting  D. to visit" },
               reason: "短文在 A 块、选项在 B 块" } },
    { id: "nu_5", kind: "note_update", title: "更新笔记：补完形「并列时态一致」要点", body: "为英语完形笔记追加 woke / breathed 并列结构的时态一致说明。",
      from: "dreaming", cost: "$0.0007", confidence: 0.81, subject: "eng",
      evidence: { type: "event", id: "evt_3188", label: "attempt:failure · 完形时态" } },
  ],

  // ── Mistakes · single-record cards (event-sourced) ────────────────
  mistakes: [
    { id: "m1", q: "句中「之」的用法：师道之不传也久矣。", wrong: "结构助词「的」", right: "用于主谓之间，取消句子独立性",
      knowledge: [{ label: "之 · 用法", tag: "k_xuci_zhi" }, { label: "主谓取独", tag: "k_zhi_subj" }],
      attribution: { by: "ai", cause: "概念混淆", confidence: 0.84 }, state: "已纠正", eventId: "evt_3120",
      events: [
        { t: "14 天前", label: "attempt · failure", note: "答成「代词」" },
        { t: "3 天前",  label: "attempt · partial", note: "方向对、表述不全" },
        { t: "昨日",    label: "judge · attribute", note: "AI 归因：概念混淆 (0.84)" },
        { t: "今日",    label: "correction · done",  note: "重做正确，纳入复习" },
      ] },
    { id: "m2", q: "「使快弹数曲」的「快」义", wrong: "快速", right: "畅快、尽情",
      knowledge: [{ label: "古今异义", tag: "k_gujin" }],
      attribution: { by: "user", cause: "审题偏差" }, state: "待重学", eventId: "evt_3098",
      events: [
        { t: "5 天前", label: "attempt · failure",  note: "以今义释古义" },
        { t: "5 天前", label: "cause · user",       note: "用户标注：审题偏差" },
      ] },
    { id: "m3", q: "「卒相与欢」的「卒」音义", wrong: "士卒 zú", right: "终于 cù",
      knowledge: [{ label: "通假 / 多音", tag: "k_duoyin" }, { label: "史记选读", tag: "k_shiji" }],
      attribution: { by: "ai", pending: true }, state: "归因中…", eventId: "evt_3131",
      events: [
        { t: "昨日", label: "attempt · failure", note: "误读为 zú" },
        { t: "处理中", label: "judge · pending", note: "AI 归因中…" },
      ] },
    { id: "m4", q: "导数大题 (2)：f(x)=x³−3ax+1 在 x=1 取极值，求 a", wrong: "a = −1", right: "a = 1（由 f'(1)=0）",
      knowledge: [{ label: "导数·单调极值", tag: "k_math_deriv" }], subject: "math",
      attribution: { by: "ai", cause: "计算失误", confidence: 0.80 }, state: "待重学", eventId: "evt_3210",
      events: [
        { t: "前日", label: "attempt · failure", note: "f'(1)=3−3a 解错符号" },
        { t: "昨日", label: "judge · attribute", note: "AI 归因：计算失误 (0.80)" },
      ] },
    { id: "m5", q: "完形：woke up … and ___ the fresh air", wrong: "breathing", right: "breathed",
      knowledge: [{ label: "英语·完形填空", tag: "k_eng_cloze" }], subject: "eng",
      attribution: { by: "ai", cause: "方法不熟", confidence: 0.78 }, state: "已纠正", eventId: "evt_3188",
      events: [
        { t: "3 天前", label: "attempt · failure", note: "未察并列结构，误选 -ing" },
        { t: "昨日", label: "judge · attribute", note: "AI 归因：并列时态一致" },
        { t: "今日", label: "correction · done", note: "重做正确，纳入复习" },
      ] },
    { id: "m6", q: "语法填空：The paintings were ___ (amaze)", wrong: "amazed", right: "amazing",
      knowledge: [{ label: "英语·语法填空", tag: "k_eng_grammar" }], subject: "eng",
      attribution: { by: "user", cause: "概念混淆" }, state: "待重学", eventId: "evt_3175",
      events: [
        { t: "4 天前", label: "attempt · failure", note: "-ed / -ing 形容词混淆" },
        { t: "4 天前", label: "cause · user", note: "用户标注：概念混淆" },
      ] },
  ],

  // ── Copilot thread ────────────────────────────────────────────────
  chat: [
    { role: "user", text: "「之」字今天又错了，帮我理一下用法。" },
    { role: "ai", tool: { name: "search_knowledge", status: "done", rows: [["query", "之 用法"], ["matched", "k_xuci_zhi · 3 mesh"], ["mistakes", "近7天 3 条"]] },
      text: "为你聚合了「之」的 4 类核心用法，并把 3 条相关错题提了优先级。要不要我生成 2 张针对「主谓之间」的卡片？" },
  ],
};

// Proposal-kind metadata — all 12 contract kinds (lane label · icon · tone).
const KIND_META = {
  knowledge_node:     { label: "知识节点", icon: "knowledge", tone: "info" },
  knowledge_edge:     { label: "知识关系", icon: "link",      tone: "info" },
  knowledge_mutation: { label: "知识变更", icon: "refresh",   tone: "info" },
  learning_item:      { label: "学习项",   icon: "items",     tone: "coral" },
  note_update:        { label: "笔记更新", icon: "pencil",    tone: "coral" },
  variant_question:   { label: "变体题",   icon: "layers",    tone: "coral" },
  record_promotion:   { label: "记录升格", icon: "record",    tone: "good" },
  record_links:       { label: "记录关联", icon: "link",      tone: "good" },
  completion:         { label: "完成判定", icon: "checkCircle", tone: "good" },
  relearn:            { label: "重学建议", icon: "review",    tone: "hard" },
  goal_scope:         { label: "目标范围", icon: "target",    tone: "hard" },
  block_merge:        { label: "块合并",   icon: "merge",     tone: "hard" },
};
// edge relation labels (5 typed)
const REL_LABEL = { prerequisite: "前置 prerequisite", related_to: "相关 related_to", contrasts_with: "对比 contrasts_with", applied_in: "应用 applied_in", derived_from: "派生 derived_from" };
// per-relation non-color cues: short label · icon · svg dash · directed?
const REL_META = {
  prerequisite:   { short: "前置", icon: "arrow",   dash: "0",      directed: true,  tone: "info" },
  related_to:     { short: "相关", icon: "link",    dash: "1 6",    directed: false, tone: "neutral" },
  contrasts_with: { short: "对比", icon: "reverse", dash: "6 4",    directed: false, tone: "hard" },
  applied_in:     { short: "应用", icon: "bolt",    dash: "10 3 2 3", directed: true, tone: "good" },
  derived_from:   { short: "派生", icon: "merge",   dash: "2 4",    directed: true,  tone: "coral" },
};
window.REL_META = REL_META;

// "AI 观察" — agent identity (source/target) + signal taxonomy (open vocab).
// Agents are all actor_kind=agent; each maps to a Lucide glyph for at-a-glance ID.
const AGENT_META = {
  qverify:  { label: "出题校验", icon: "quiz" },
  dreaming: { label: "夜间推理", icon: "moon" },
  planning: { label: "每日规划", icon: "target" },
  chat:     { label: "对话助手", icon: "copilot" },
  annotate: { label: "标注",     icon: "tag" },
  ingest:   { label: "录入校验", icon: "record" },
};
// signal_kind is an open vocabulary; tone reuses the FSRS/attribution palette.
const SIGNAL_META = {
  pool_gap:      { label: "题池缺口", tone: "hard" },
  misconception: { label: "误解模式", tone: "info" },
  quality:       { label: "质量信号", tone: "good" },
  offtopic:      { label: "切题反复", tone: "coral" },
};
window.AGENT_META = AGENT_META; window.SIGNAL_META = SIGNAL_META;

window.DATA = DATA; window.KIND_META = KIND_META; window.REL_LABEL = REL_LABEL;

// ════════════════════════════════════════════════════════════════════
// Round-2b data — rebuilds DATA.knowledge / DATA.items (dropped in 2a)
// + adds detail/coach/sessions/events/admin shapes. (§3 flags noted inline)
// ════════════════════════════════════════════════════════════════════
Object.assign(DATA, {
  // ── Knowledge nodes (tree via `parent`) + per-node mastery/evidence/decay ──
  knowledge: [
    { id: "k_wenyan",       title: "文言文",     tag: "k_wenyan",       parent: null,        mastery: 78, evidence: 21, decay: "低",   mistakes: 0 },
    { id: "k_xuci",         title: "文言虚词",   tag: "k_xuci",         parent: "k_wenyan",  mastery: 64, evidence: 14, decay: "中",   mistakes: 1 },
    { id: "k_xuci_zhi",     title: "之 · 用法",  tag: "k_xuci_zhi",     parent: "k_xuci",    mastery: 62, evidence: 9,  decay: "衰减中", mistakes: 1, hot: true },
    { id: "k_xuci_qi",      title: "其 · 用法",  tag: "k_xuci_qi",      parent: "k_xuci",    mastery: 55, evidence: 6,  decay: "中",   mistakes: 0 },
    { id: "k_xuci_yu",      title: "于 · 用法",  tag: "k_xuci_yu",      parent: "k_xuci",    mastery: 71, evidence: 8,  decay: "低",   mistakes: 1 },
    { id: "k_zhi_subj",     title: "主谓取独",   tag: "k_zhi_subj",     parent: "k_xuci_zhi", mastery: 48, evidence: 4, decay: "高",   mistakes: 1 },
    { id: "k_xuci_zhi_attr", title: "之 · attr 派生", tag: "k_xuci_zhi_attr", parent: "k_xuci_zhi", mastery: 40, evidence: 3, decay: "高", mistakes: 0 },
    { id: "k_jushi",        title: "文言句式",   tag: "k_jushi",        parent: "k_wenyan",  mastery: 60, evidence: 11, decay: "中",   mistakes: 0 },
    { id: "k_judge",        title: "判断句",     tag: "k_judge",        parent: "k_jushi",   mastery: 66, evidence: 7,  decay: "低",   mistakes: 0 },
  ],
  // typed edges — direction a→b (source→target); 5 relation types
  kedges: [
    { a: "k_xuci",          b: "k_xuci_zhi",      rel: "prerequisite" },
    { a: "k_xuci_zhi_attr", b: "k_xuci_zhi",      rel: "derived_from" },
    { a: "k_xuci_zhi",      b: "k_zhi_subj",      rel: "contrasts_with" },
    { a: "k_xuci_zhi",      b: "k_xuci_qi",       rel: "related_to" },
    { a: "k_judge",         b: "k_xuci_yu",       rel: "applied_in" },
    { a: "k_xuci",          b: "k_judge",         rel: "related_to" },
  ],
  // edge proposals (decision controls reuse inbox edge actions)
  kedgeProposals: [
    { id: "kp_1", a: "k_xuci_zhi_attr", b: "k_xuci_zhi", rel: "derived_from", confidence: 0.88, from: "maintenance" },
    { id: "kp_2", a: "k_xuci_zhi", b: "k_xuci_qi", rel: "contrasts_with", confidence: 0.79, from: "dreaming" },
  ],
  // §3.1/3.2/3.7 — per-node detail: primary note (block-tree) + typed backlinks + activity
  knowledgeDetail: {
    k_xuci_zhi: {
      note: [
        { type: "heading", text: "之 · 四类核心用法" },
        { type: "text", text: "「之」是文言中最高频的虚词，需按语境分辨结构助词、代词、动词与主谓之间四类。" },
        { type: "wenyan", text: "古之学者必有师 —— 结构助词「的」。\n师道之不传也久矣 —— 主谓之间，取消句子独立性。" },
        { type: "quiz", q: "「蚓无爪牙之利」中「之」的用法？", a: "定语后置的标志，结构助词。" },
        { type: "latex", text: "R(t)=e^{-t/S}\\quad\\text{(FSRS 可提取性)}" },
        { type: "code", text: "classify(zhi, ctx) // → 'particle' | 'pronoun' | 'verb' | 'subj'" },
      ],
      backlinks: [
        { type: "atomic", title: "之 · 定语助词", id: "li_1a" },
        { type: "hub",    title: "文言虚词系统", id: "li_1" },
        { type: "long",   title: "报任安书 精读笔记", id: "rec_77" },
        { type: "quiz",   title: "虚词辨析 · 小测 12", id: "quiz_12" },
      ],
      activity: [
        { t: "14 天前", label: "attempt · failure", note: "答成「代词」" },
        { t: "昨日",    label: "judge · attribute", note: "AI 归因：概念混淆 (0.84)" },
        { t: "今日",    label: "correction · done",  note: "重做正确，纳入复习" },
      ],
    },
  },

  // ── Learning items (hub / atomic · 6 statuses · children · origin) ──
  items: [
    { id: "li_1", title: "文言虚词系统", kind: "hub", status: "in_progress", mastery: 0.71, cards: 86, mastered: 71, icon: "book", color: "coral",
      knowledge: ["k_xuci"], children: ["li_1a", "li_1b", "li_1c"], parent: null,
      origin: { by: "ai", source: "intent", text: "由学习意图「系统掌握文言虚词」AI 拆解而来", confidence: 0.9, when: "12 天前" } },
    { id: "li_1a", title: "之 的四类用法", kind: "atomic", status: "in_progress", mastery: 0.62, cards: 14, mastered: 9, icon: "tag", color: "coral", knowledge: ["k_xuci_zhi"], parent: "li_1", children: [] },
    { id: "li_1b", title: "其 的用法",     kind: "atomic", status: "pending",     mastery: 0.30, cards: 12, mastered: 4,  icon: "tag", color: "coral", knowledge: ["k_xuci_qi"], parent: "li_1", children: [] },
    { id: "li_1c", title: "于 的用法",     kind: "atomic", status: "done",        mastery: 0.92, cards: 12, mastered: 11, icon: "tag", color: "coral", knowledge: ["k_xuci_yu"], parent: "li_1", children: [] },
    { id: "li_2", title: "史记选读",       kind: "hub", status: "in_progress", mastery: 0.56, cards: 54, mastered: 30, icon: "doc",   color: "info",  knowledge: ["k_shiji"], children: ["li_2a"], parent: null },
    { id: "li_2a", title: "廉颇蔺相如列传", kind: "atomic", status: "in_progress", mastery: 0.5, cards: 22, mastered: 11, icon: "tag", color: "info", knowledge: ["k_shiji"], parent: "li_2", children: [] },
    { id: "li_3", title: "判断句式专题",   kind: "hub", status: "resting",  mastery: 0.40, cards: 28, mastered: 11, icon: "layers", color: "good",  knowledge: ["k_judge"], children: [], parent: null },
    { id: "li_4", title: "通假与多音",     kind: "atomic", status: "pending",  mastery: 0.20, cards: 18, mastered: 4,  icon: "spark2", color: "hard",  knowledge: ["k_duoyin"], children: [], parent: null },
    { id: "li_5", title: "诗词格律",       kind: "hub", status: "archived", mastery: 0.85, cards: 42, mastered: 36, icon: "target", color: "info",  knowledge: [], children: [], parent: null },
    { id: "li_6", title: "骈文鉴赏（暂停）", kind: "hub", status: "dismissed", mastery: 0.1, cards: 8, mastered: 1, icon: "book", color: "good", knowledge: [], children: [], parent: null },
  ],
  itemStatuses: ["pending", "in_progress", "done", "resting", "dismissed", "archived"],
  // §3.3 — intent → hub+atomic decomposition proposal (learning_item kind)
  intentDecomp: {
    intent: "系统掌握《报任安书》的文言知识",
    hub: { title: "报任安书 · 专题", knowledge: ["k_shiji"] },
    atomic: [
      { title: "剖符丹书 等字词", knowledge: ["k_typo_pofu"] },
      { title: "固…所…也 判断句式", knowledge: ["k_judge"] },
      { title: "之 在文中的用法",   knowledge: ["k_xuci_zhi"] },
    ],
    confidence: 0.87, cost: "$0.0042", from: "dreaming",
  },

  // ── Review-session history + detail (§3.4) ──
  sessionHistory: [
    { id: "rs_41", status: "in_progress", reviewed: 7,  dist: { again: 1, hard: 2, good: 4 },  dur: "14m", knowledge: ["k_xuci"],           when: "今日" },
    { id: "rs_39", status: "resting",     reviewed: 3,  dist: { again: 1, hard: 0, good: 2 },  dur: "6m",  knowledge: ["k_shiji"],          when: "今日" },
    { id: "rs_38", status: "done",        reviewed: 24, dist: { again: 3, hard: 6, good: 15 }, dur: "22m", knowledge: ["k_xuci", "k_judge"], when: "昨日", cost: "$0.18" },
    { id: "rs_35", status: "done",        reviewed: 18, dist: { again: 2, hard: 4, good: 12 }, dur: "17m", knowledge: ["k_jushi"],          when: "3 天前", cost: "$0.12" },
    { id: "rs_31", status: "failed",      reviewed: 0,  dist: { again: 0, hard: 0, good: 0 },  dur: "—",   knowledge: [],                   when: "5 天前", note: "queue 超时 · extracting 中断" },
  ],
  sessionDetail: {
    rs_38: { type: "review", status: "done", dur: "22m", reviewed: 24, dist: { again: 3, hard: 6, good: 15 }, cost: "$0.18", knowledge: ["k_xuci", "k_judge"],
      summary: "本次以文言虚词为主。「之」的主谓取独仍是薄弱点（2 次 hard、1 次 again）；判断句掌握稳固。建议明日重排 3 张「之」卡，并补一道主谓取独变体题。",
      events: [
        { id: "evt_3120", t: "08:12", label: "attempt · failure", note: "之 · 答成代词" },
        { id: "evt_3122", t: "08:13", label: "judge · attribute", note: "概念混淆 (0.84)" },
        { id: "evt_3140", t: "08:25", label: "attempt · good",     note: "判断句 · 正确" },
        { id: "evt_3151", t: "08:31", label: "session · done",     note: "24 张完成，写入 FSRS" },
      ] },
  },

  // ── Events (§3.5) — focal + caused_by + downstream + corrections + raw ──
  events: {
    evt_3120: {
      focal: { label: "attempt:failure · 之", t: "14 天前", kind: "attempt", outcome: "failure" },
      causedBy: [{ id: "rs_41", label: "review_session · rs_41", t: "14 天前", route: "session" }],
      caused: [
        { id: "evt_3122", label: "judge:attribute（概念混淆）", t: "昨日", route: "events" },
        { id: "m1",       label: "mistake · m1 生成",          t: "昨日", route: "mistakes" },
      ],
      corrections: [{ t: "今日", note: "重做正确，纳入复习队列" }],
      raw: { type: "attempt", outcome: "failure", card: "k_xuci_zhi", answer: "代词", caused_by: "rs_41", ts: "2026-05-19T08:12:03Z", cost: 0 },
    },
  },

  // ── Coach analytics (§3.8) — windows 7/30/90 ──
  coach: {
    "7":  { kpis: { reviews: 84, correct: 71, newMistakes: 6, cost: 4.1 },
            dist: { again: 14, hard: 22, good: 48 },
            perDay: [["一", 2, 3, 7], ["二", 3, 4, 9], ["三", 1, 2, 6], ["四", 2, 5, 8], ["五", 3, 3, 7], ["六", 2, 3, 6], ["日", 1, 2, 5]],
            topFail: [["之 · 用法", 5], ["判断句", 4], ["主谓取独", 3], ["其 · 用法", 2]],
            causes: [["概念混淆", 42], ["审题偏差", 23], ["记忆遗忘", 18], ["表述不全", 11], ["其它", 6]] },
    "30": { kpis: { reviews: 342, correct: 74, newMistakes: 21, cost: 16.8 },
            dist: { again: 51, hard: 88, good: 203 },
            perDay: [["W1", 9, 14, 38], ["W2", 11, 16, 41], ["W3", 8, 12, 35], ["W4", 10, 15, 44]],
            topFail: [["之 · 用法", 18], ["判断句", 13], ["通假 / 多音", 9], ["主谓取独", 7]],
            causes: [["概念混淆", 38], ["记忆遗忘", 26], ["审题偏差", 20], ["表述不全", 10], ["其它", 6]] },
    "90": { kpis: { reviews: 1024, correct: 77, newMistakes: 58, cost: 49.2 },
            dist: { again: 142, hard: 251, good: 631 },
            perDay: [["5月", 38, 62, 150], ["4月", 41, 70, 168], ["3月", 35, 58, 140]],
            topFail: [["之 · 用法", 46], ["判断句", 33], ["通假 / 多音", 25], ["古今异义", 19]],
            causes: [["概念混淆", 35], ["记忆遗忘", 28], ["审题偏差", 19], ["表述不全", 12], ["其它", 6]] },
  },

  // ── Admin observability (§3.6) ──
  admin: {
    runs: [
      { task: "dreaming",       status: "done",       cost: "$0.71", latency: "12.4s", t: "昨 23:40" },
      { task: "vision_extract", status: "done",       cost: "$0.52", latency: "8.1s",  t: "昨 21:05" },
      { task: "judge",          status: "done",       cost: "$0.39", latency: "3.2s",  t: "今 08:13" },
      { task: "coach",          status: "done",       cost: "$0.22", latency: "5.6s",  t: "今 07:00" },
      { task: "maintenance",    status: "queued",     cost: "—",     latency: "—",     t: "今 09:30" },
      { task: "auto_enroll",    status: "extracting", cost: "—",     latency: "—",     t: "今 09:31" },
      { task: "embed_sync",     status: "failed",     cost: "$0.04", latency: "30.0s", t: "今 06:12" },
    ],
    cost: [
      { task: "dreaming",       today: "$0.71", d7: "$4.10", d30: "$16.80" },
      { task: "vision_extract", today: "$0.52", d7: "$3.02", d30: "$11.40" },
      { task: "judge",          today: "$0.39", d7: "$2.88", d30: "$10.20" },
      { task: "coach",          today: "$0.22", d7: "$1.54", d30: "$5.60" },
    ],
    failures: [
      { job: "embed_sync #4821",  error: "D1 timeout (30s)",        retries: 2 },
      { job: "vision_extract #771", error: "image decode failed",   retries: 1 },
      { job: "judge #9043",       error: "rate_limited (429)",      retries: 3 },
    ],
  },
});

// status enum metadata — 11 values, each with a non-color cue (icon + label)
const STATUS_META = {
  pending:     { label: "待开始", icon: "clock" },
  in_progress: { label: "进行中", icon: "review" },
  done:        { label: "已完成", icon: "checkCircle" },
  resting:     { label: "搁置",   icon: "moon" },
  dismissed:   { label: "已弃",   icon: "close" },
  archived:    { label: "归档",   icon: "layers" },
  extracted:   { label: "已抽取", icon: "sparkle" },
  partial:     { label: "部分",   icon: "alert" },
  failed:      { label: "失败",   icon: "alert" },
  queued:      { label: "排队中", icon: "clock" },
  extracting:  { label: "抽取中", icon: "refresh" },
};
const STATUS_TONE = {
  pending: "neutral", in_progress: "info", done: "good", resting: "hard",
  dismissed: "neutral", archived: "neutral", extracted: "info", partial: "hard",
  failed: "again", queued: "neutral", extracting: "info",
};
window.STATUS_META = STATUS_META; window.STATUS_TONE = STATUS_TONE;
