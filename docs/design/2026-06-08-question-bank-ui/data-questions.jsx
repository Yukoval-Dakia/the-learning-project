// Loom · 题库 (Question bank) data model — overrides the P5 question stub.
// Richer shape per spec: 5 题型, markdown+latex stems, options/answer, 1-5 难度,
// multi knowledge labels, 4 来源, composite (大题-小题), variant family (root→变体),
// association state (attempt / 复习卡 / 卷引用 / 错题) → delete constraints.

// ── metadata maps (override window.Q_* from data-p5) ──────────
const QKIND = {
  mcq:     { label: "单选",     icon: "list",   short: "单选" },
  short:   { label: "简答",     icon: "pencil", short: "简答" },
  trans:   { label: "翻译",     icon: "book",   short: "翻译" },
  cloze:   { label: "填空",     icon: "hash",   short: "填空" },
  reading: { label: "阅读理解", icon: "doc",    short: "阅读" },
};
const QSOURCE = {
  seed:    { label: "种子数据",   icon: "layers",  tone: "neutral" },
  quiz:    { label: "教学小测",   icon: "teach",   tone: "info" },
  exam:    { label: "试卷录入",   icon: "camera",  tone: "info" },
  variant: { label: "AI 变体", icon: "sparkle", tone: "coral" },
};
const QSTATUS = {
  active: { label: "正式", tone: "good" },
  draft:  { label: "草稿", tone: "hard" },
};
// difficulty 1-5 → tone + word
const QDIFF = {
  1: { tone: "good", word: "易" }, 2: { tone: "good", word: "较易" },
  3: { tone: "hard", word: "中等" }, 4: { tone: "again", word: "较难" }, 5: { tone: "again", word: "难" },
};

// knowledge id → 中文 label (merge graph titles + local fallbacks)
const QKLABEL = {
  k_xuci_zhi: "之·用法", k_xuci_qi: "其·用法", k_xuci_yu: "于·用法",
  k_zhi_subj: "主谓取独", k_judge: "判断句", k_gusuoye: "固…所…也",
  k_shiji: "史记选读", k_gujin: "古今异义", k_duoyin: "通假·多音",
  k_juedu: "断句", k_suanxue: "古算·术文",
  k_math_deriv: "导数·单调极值", k_yuwen_read: "现代文阅读",
  k_eng_cloze: "英语·完形填空", k_eng_read: "英语·阅读理解", k_eng_grammar: "英语·语法填空",
};
function qkLabel(id) {
  const node = (DATA.knowledge || []).find((k) => k.id === id);
  return (node && node.title) || QKLABEL[id] || id;
}
Object.assign(window, { QKIND, QSOURCE, QSTATUS, QDIFF, QKLABEL, qkLabel });

// ── the bank ──────────────────────────────────────────────────
DATA.questions = [
  // ── family A: 之·用法 — root + 2 变体 (variant chain, depth) ──
  {
    id: "q_zhi_root", kind: "mcq", status: "active", source: "exam", created: "2025-09-12",
    stem: "下列各句中「**之**」的用法与其他三项**不同**的一项是：",
    options: [
      { key: "A", text: "水陆草木**之**花，可爱者甚蕃。" },
      { key: "B", text: "古**之**学者必有师。" },
      { key: "C", text: "师道**之**不传也久矣。" },
      { key: "D", text: "予独爱莲**之**出淤泥而不染。" },
    ],
    answer: "B", answerNote: "A、C、D 均为「主谓之间，取消句子独立性」；B 为结构助词「的」（定中之间）。",
    difficulty: 3, knowledge: ["k_xuci_zhi", "k_zhi_subj"],
    lineage: "root", root: null, depth: 0, variants: ["q_zhi_v1", "q_zhi_v2"],
    attempts: 14, inReview: true, papers: [{ id: "p_2509", name: "2025 秋·月考一" }], mistakes: 2,
  },
  {
    id: "q_zhi_v1", kind: "mcq", status: "active", source: "variant", created: "2025-11-03",
    stem: "「臣**之**壮也，犹不如人」一句中，「之」的语法功能是：",
    options: [
      { key: "A", text: "结构助词，译为「的」" },
      { key: "B", text: "用于主谓之间，取消句子独立性" },
      { key: "C", text: "代词，指代「臣」" },
      { key: "D", text: "动词，往、到" },
    ],
    answer: "B", answerNote: "「臣之壮也」为主谓短语，「之」取消其独立性，使之充当时间状语。",
    difficulty: 3, knowledge: ["k_xuci_zhi", "k_zhi_subj"],
    lineage: "variant", root: "q_zhi_root", depth: 1, variants: [],
    attempts: 3, inReview: true, papers: [], mistakes: 1,
    origin: { confidence: 0.86, when: "11 月 3 日", reason: "由 q_zhi_root 错因「主谓取独」生成的同类变体" },
  },
  {
    id: "q_zhi_v2", kind: "cloze", status: "draft", source: "variant", created: "2025-11-21",
    stem: "填空：「师道**之**不传也久矣」中，「之」用于 ＿＿＿ 之间，作用是 ＿＿＿。",
    options: [], answer: "主谓 / 取消句子独立性",
    difficulty: 2, knowledge: ["k_xuci_zhi"],
    lineage: "variant", root: "q_zhi_root", depth: 1, variants: [],
    attempts: 0, inReview: false, papers: [], mistakes: 0,
    origin: { confidence: 0.79, when: "11 月 21 日", reason: "把单选改写为填空，强化主动回忆" },
  },

  // ── composite 大题：阅读理解（材料 + 4 小题） ──
  {
    id: "q_read_lian", kind: "reading", status: "active", source: "exam", created: "2025-10-08",
    composite: true,
    stem: "阅读下面文言文，完成 4 小题。",
    passage: "廉颇者，赵之良将也。赵惠文王十六年，廉颇为赵将，伐齐，大破之，取阳晋，拜为上卿，以勇气闻于诸侯。蔺相如者，赵人也，为赵宦者令缪贤舍人。",
    difficulty: 3, knowledge: ["k_judge", "k_shiji"],
    lineage: "root", root: null, depth: 0, variants: [],
    children: ["q_read_lian_1", "q_read_lian_2", "q_read_lian_3", "q_read_lian_4"],
    attempts: 6, inReview: false, papers: [{ id: "p_2510", name: "2025 期中卷" }], mistakes: 1,
  },
  {
    id: "q_read_lian_1", kind: "mcq", status: "active", source: "exam", created: "2025-10-08",
    parentId: "q_read_lian", subIndex: 1,
    stem: "「廉颇者，赵**之**良将也」一句的句式是：",
    options: [
      { key: "A", text: "判断句" }, { key: "B", text: "被动句" },
      { key: "C", text: "省略句" }, { key: "D", text: "宾语前置" },
    ],
    answer: "A", answerNote: "「……者，……也」是文言判断句的典型标志。",
    difficulty: 2, knowledge: ["k_judge"], lineage: "part", variants: [],
    attempts: 6, inReview: true, papers: [], mistakes: 1,
  },
  {
    id: "q_read_lian_2", kind: "short", status: "active", source: "exam", created: "2025-10-08",
    parentId: "q_read_lian", subIndex: 2,
    stem: "「以勇气闻于诸侯」中「**于**」的用法和意义是什么？",
    options: [], answer: "介词，引进对象，译为「在……（之间）」「向」，此处表「在诸侯之间（闻名）」。",
    difficulty: 3, knowledge: ["k_xuci_yu"], lineage: "part", variants: [],
    attempts: 5, inReview: false, papers: [], mistakes: 0,
  },
  {
    id: "q_read_lian_3", kind: "trans", status: "active", source: "exam", created: "2025-10-08",
    parentId: "q_read_lian", subIndex: 3,
    stem: "把文中画线句译成现代汉语：「伐齐，大破**之**，取阳晋。」",
    options: [], answer: "（廉颇率军）攻打齐国，大败齐军，夺取了阳晋。",
    answerNote: "「之」为代词，指代齐军；「破」为使动/及物，译「打败」。",
    difficulty: 3, knowledge: ["k_shiji", "k_xuci_zhi"], lineage: "part", variants: [],
    attempts: 4, inReview: true, papers: [], mistakes: 0,
  },
  {
    id: "q_read_lian_4", kind: "cloze", status: "draft", source: "variant", created: "2025-11-15",
    parentId: "q_read_lian", subIndex: 4,
    stem: "填空：蔺相如「为赵宦者令缪贤**舍人**」，「舍人」指 ＿＿＿。",
    options: [], answer: "门客、家臣",
    difficulty: 2, knowledge: ["k_shiji", "k_gujin"], lineage: "part", variants: [],
    attempts: 0, inReview: false, papers: [], mistakes: 0,
    origin: { confidence: 0.74, when: "11 月 15 日", reason: "补充材料中的古今异义词考点" },
  },

  // ── 古算·术文 — 文言 + LaTeX 公式 + 配图 ──
  {
    id: "q_guitian", kind: "short", status: "active", source: "seed", created: "2025-08-30",
    stem: "《九章算术·方田》：「今有**圭田**，广十二步，正从二十一步。问为田几何？」\n\n请依术文写出求积公式并计算（一亩 = 240 平方步）。",
    image: { caption: "圭田示意：等腰三角形田块，底为「广」，高为「正从」" },
    options: [],
    answer: "术曰：半广以乘正从。$S=\\dfrac{1}{2}\\times 广 \\times 正从=\\dfrac{1}{2}\\times 12 \\times 21=126$（平方步）。\n\n$126 \\div 240 = \\dfrac{21}{40}$ 亩。",
    answerNote: "圭田即三角形田，「半广乘正从」与 $S=\\frac{1}{2}bh$ 一致。",
    difficulty: 3, knowledge: ["k_suanxue"],
    lineage: "root", root: null, depth: 0, variants: ["q_guitian_v1"],
    attempts: 2, inReview: false, papers: [], mistakes: 0,
  },
  {
    id: "q_guitian_v1", kind: "mcq", status: "draft", source: "variant", created: "2025-11-28",
    stem: "今有圭田，广 $8$ 步，正从 $15$ 步，则其积为：",
    options: [
      { key: "A", text: "$60$ 平方步" }, { key: "B", text: "$120$ 平方步" },
      { key: "C", text: "$23$ 平方步" }, { key: "D", text: "$\\dfrac{1}{2}$ 亩" },
    ],
    answer: "A", answerNote: "$\\frac{1}{2}\\times 8 \\times 15 = 60$。",
    difficulty: 2, knowledge: ["k_suanxue"],
    lineage: "variant", root: "q_guitian", depth: 1, variants: [],
    attempts: 0, inReview: false, papers: [], mistakes: 0,
    origin: { confidence: 0.81, when: "11 月 28 日", reason: "换数生成的同型练习" },
  },

  // ── 其他单题 ──
  {
    id: "q_qi_1", kind: "mcq", status: "active", source: "quiz", created: "2025-09-25",
    stem: "「**其**皆出于此乎」中「其」所表达的语气是：",
    options: [
      { key: "A", text: "反问" }, { key: "B", text: "揣测、推断" },
      { key: "C", text: "祈使、命令" }, { key: "D", text: "称代第三人称" },
    ],
    answer: "B", answerNote: "「其……乎」表委婉揣测，译「大概……吧」。",
    difficulty: 3, knowledge: ["k_xuci_qi"],
    lineage: "root", root: null, depth: 0, variants: [],
    attempts: 5, inReview: true, papers: [], mistakes: 0,
  },
  {
    id: "q_yu_trans", kind: "trans", status: "active", source: "seed", created: "2025-08-18",
    stem: "翻译：「青，取之**于**蓝，而青**于**蓝。」",
    options: [], answer: "靛青是从蓝草中提取的，但（颜色）比蓝草更深。",
    answerNote: "前「于」表来源（从），后「于」表比较（比）。",
    difficulty: 2, knowledge: ["k_xuci_yu", "k_gujin"],
    lineage: "root", root: null, depth: 0, variants: [],
    attempts: 8, inReview: false, papers: [{ id: "p_2509", name: "2025 秋·月考一" }], mistakes: 0,
  },
  {
    id: "q_juedu_1", kind: "cloze", status: "active", source: "exam", created: "2025-10-22",
    stem: "用「/」给下句断句（限 3 处）：\n\n　　师者所以传道受业解惑也",
    options: [], answer: "师者 / 所以传道 / 受业 / 解惑也",
    difficulty: 4, knowledge: ["k_juedu", "k_judge"],
    lineage: "root", root: null, depth: 0, variants: [],
    attempts: 3, inReview: true, papers: [], mistakes: 1,
  },
  // 无任何关联 → 可直接删除（演示无约束删除）
  {
    id: "q_draft_orphan", kind: "short", status: "draft", source: "variant", created: "2025-12-01",
    stem: "简述「使动用法」与「意动用法」的区别，各举一例。",
    options: [], answer: "使动：主语使宾语「怎么样」（如「项伯杀人，臣活之」）；意动：主语「认为」宾语怎么样（如「渔人甚异之」）。",
    difficulty: 4, knowledge: ["k_gujin"],
    lineage: "root", root: null, depth: 0, variants: [],
    attempts: 0, inReview: false, papers: [], mistakes: 0,
    origin: { confidence: 0.7, when: "今日", reason: "Dreaming agent 夜间生成的待审草稿" },
  },
];

// ── cross-subject 大题样例：每个学科题型各一例（均为 composite 大题）──
DATA.questions.push(
  // 1) 数学大题（导数）— 简答型小题，重 LaTeX
  {
    id: "q_math_deriv", kind: "short", status: "active", source: "exam", created: "2025-11-06",
    composite: true,
    stem: "（本题满分 12 分）已知函数，完成下列各题。",
    passage: "已知函数 $f(x)=x^{3}-3ax+1\\;(a\\in\\mathbb{R})$。",
    difficulty: 4, knowledge: ["k_math_deriv"],
    lineage: "root", root: null, depth: 0, variants: [],
    children: ["q_math_deriv_1", "q_math_deriv_2", "q_math_deriv_3"],
    attempts: 7, inReview: true, papers: [{ id: "p_math_mid", name: "高二理科数学·期中" }], mistakes: 1,
  },
  { id: "q_math_deriv_1", kind: "short", status: "active", source: "exam", created: "2025-11-06",
    parentId: "q_math_deriv", subIndex: 1,
    stem: "当 $a=1$ 时，求 $f(x)$ 的单调递增区间。",
    options: [], answer: "$f'(x)=3x^{2}-3$。令 $f'(x)>0$ 得 $x<-1$ 或 $x>1$。\n\n故单调递增区间为 $(-\\infty,-1)$ 与 $(1,+\\infty)$。",
    answerNote: "先求导，再解 $f'(x)>0$；区间不取并集符号「∪」，文言/规范均写「与」。",
    difficulty: 3, knowledge: ["k_math_deriv"], lineage: "part", variants: [],
    attempts: 7, inReview: true, papers: [], mistakes: 0 },
  { id: "q_math_deriv_2", kind: "short", status: "active", source: "exam", created: "2025-11-06",
    parentId: "q_math_deriv", subIndex: 2,
    stem: "若 $f(x)$ 在 $x=1$ 处取得极值，求实数 $a$ 的值，并判断该极值是极大还是极小。",
    options: [], answer: "$f'(x)=3x^{2}-3a$，由 $f'(1)=0$ 得 $a=1$。\n\n此时 $f'(x)=3(x^2-1)$，$x=1$ 左减右增，为**极小值**。",
    difficulty: 4, knowledge: ["k_math_deriv"], lineage: "part", variants: [],
    attempts: 6, inReview: false, papers: [], mistakes: 1 },
  { id: "q_math_deriv_3", kind: "short", status: "draft", source: "variant", created: "2025-11-29",
    parentId: "q_math_deriv", subIndex: 3,
    stem: "在 (2) 的条件下，求 $f(x)$ 在 $[-2,2]$ 上的最大值。",
    options: [], answer: "$f(x)=x^{3}-3x+1$。比较极值与端点：$f(-1)=3,\\;f(2)=3,\\;f(-2)=-1,\\;f(1)=-1$。\n\n最大值为 $3$。",
    difficulty: 4, knowledge: ["k_math_deriv"], lineage: "part", variants: [],
    attempts: 0, inReview: false, papers: [], mistakes: 0,
    origin: { confidence: 0.77, when: "11 月 29 日", reason: "在原大题上追加闭区间最值小问" } },

  // 2) 语文·现代文阅读 — 单选 + 简答
  {
    id: "q_yuwen_read", kind: "reading", status: "active", source: "exam", created: "2025-10-30",
    composite: true,
    stem: "阅读下面的文字，完成 3 小题。",
    passage: "故乡的那条河，春天涨水时是浑黄的，夏夜却映着满天星子。我离家多年，记忆里它始终是清的——大约人对故土的偏爱，总会替它滤去泥沙。",
    difficulty: 3, knowledge: ["k_yuwen_read"],
    lineage: "root", root: null, depth: 0, variants: [],
    children: ["q_yuwen_read_1", "q_yuwen_read_2"],
    attempts: 9, inReview: false, papers: [{ id: "p_yuwen_mid", name: "高一语文·期中" }], mistakes: 1,
  },
  { id: "q_yuwen_read_1", kind: "mcq", status: "active", source: "exam", created: "2025-10-30",
    parentId: "q_yuwen_read", subIndex: 1,
    stem: "下列对文段的理解，最恰当的一项是：",
    options: [
      { key: "A", text: "作者认为故乡的河水实际上一直是清澈的。" },
      { key: "B", text: "作者借河水的浑与清，写记忆对故土的美化。" },
      { key: "C", text: "文段重在描写季节变化对河水的影响。" },
      { key: "D", text: "作者对故乡的感情随离家时间而淡漠。" },
    ],
    answer: "B", answerNote: "「替它滤去泥沙」点明是记忆/情感的美化，而非河水真清。",
    difficulty: 3, knowledge: ["k_yuwen_read"], lineage: "part", variants: [],
    attempts: 9, inReview: false, papers: [], mistakes: 1 },
  { id: "q_yuwen_read_2", kind: "short", status: "active", source: "exam", created: "2025-10-30",
    parentId: "q_yuwen_read", subIndex: 2,
    stem: "结合上下文，分析结尾「替它滤去泥沙」一句的含义与作用。",
    options: [], answer: "「滤去泥沙」表面写河水变清，实指记忆与情感对故乡的美化；以景结情，含蓄收束，强化了对故土的眷恋。",
    difficulty: 3, knowledge: ["k_yuwen_read"], lineage: "part", variants: [],
    attempts: 6, inReview: true, papers: [], mistakes: 0 },

  // 3) 英语·完形填空 — 短文带编号空，小题为单选
  {
    id: "q_eng_cloze", kind: "cloze", status: "active", source: "quiz", created: "2025-11-12",
    composite: true,
    stem: "阅读下面短文，从每题 A、B、C、D 中选出可以填入空白处的最佳选项。",
    passage: "Last summer I __1__ a small village in the mountains. The people there were poor but very __2__. Every morning I woke up to the songs of birds and __3__ the fresh, cool air.",
    difficulty: 2, knowledge: ["k_eng_cloze"],
    lineage: "root", root: null, depth: 0, variants: [],
    children: ["q_eng_cloze_1", "q_eng_cloze_2", "q_eng_cloze_3"],
    attempts: 11, inReview: true, papers: [], mistakes: 2,
  },
  { id: "q_eng_cloze_1", kind: "mcq", status: "active", source: "quiz", created: "2025-11-12",
    parentId: "q_eng_cloze", subIndex: 1, stem: "**1.** ______",
    options: [{ key: "A", text: "visited" }, { key: "B", text: "visit" }, { key: "C", text: "visiting" }, { key: "D", text: "to visit" }],
    answer: "A", answerNote: "记叙过去经历，用一般过去时 visited。",
    difficulty: 2, knowledge: ["k_eng_cloze"], lineage: "part", variants: [],
    attempts: 11, inReview: true, papers: [], mistakes: 1 },
  { id: "q_eng_cloze_2", kind: "mcq", status: "active", source: "quiz", created: "2025-11-12",
    parentId: "q_eng_cloze", subIndex: 2, stem: "**2.** ______",
    options: [{ key: "A", text: "lazy" }, { key: "B", text: "friendly" }, { key: "C", text: "angry" }, { key: "D", text: "busy" }],
    answer: "B", answerNote: "but 表转折，与 poor 对照，褒义 friendly。",
    difficulty: 2, knowledge: ["k_eng_cloze"], lineage: "part", variants: [],
    attempts: 11, inReview: false, papers: [], mistakes: 1 },
  { id: "q_eng_cloze_3", kind: "mcq", status: "draft", source: "variant", created: "2025-11-30",
    parentId: "q_eng_cloze", subIndex: 3, stem: "**3.** ______",
    options: [{ key: "A", text: "breathed" }, { key: "B", text: "breathing" }, { key: "C", text: "to breathe" }, { key: "D", text: "breath" }],
    answer: "A", answerNote: "与 woke 并列，承前用过去式 breathed。",
    difficulty: 3, knowledge: ["k_eng_cloze"], lineage: "part", variants: [],
    attempts: 0, inReview: false, papers: [], mistakes: 0,
    origin: { confidence: 0.72, when: "11 月 30 日", reason: "补充一处并列时态考点" } },

  // 4) 英语·阅读理解 — passage + 单选
  {
    id: "q_eng_read", kind: "reading", status: "active", source: "exam", created: "2025-10-18",
    composite: true,
    stem: "Read the passage and answer the questions below.",
    passage: "The public library is more than a place for books. In many towns it has quietly become a community center, where people attend free lectures, borrow tools, print documents, and even take coding classes — all at no cost.",
    difficulty: 3, knowledge: ["k_eng_read"],
    lineage: "root", root: null, depth: 0, variants: [],
    children: ["q_eng_read_1", "q_eng_read_2"],
    attempts: 8, inReview: false, papers: [{ id: "p_eng_final", name: "英语·期末卷" }], mistakes: 0,
  },
  { id: "q_eng_read_1", kind: "mcq", status: "active", source: "exam", created: "2025-10-18",
    parentId: "q_eng_read", subIndex: 1, stem: "What is the main idea of the passage?",
    options: [
      { key: "A", text: "Libraries are losing readers to the internet." },
      { key: "B", text: "Modern libraries serve as community centers." },
      { key: "C", text: "Coding classes should be paid for." },
      { key: "D", text: "Books are no longer important in towns." },
    ],
    answer: "B", answerNote: "首句主旨句：「more than a place for books … community center」。",
    difficulty: 3, knowledge: ["k_eng_read"], lineage: "part", variants: [],
    attempts: 8, inReview: false, papers: [], mistakes: 0 },
  { id: "q_eng_read_2", kind: "mcq", status: "active", source: "exam", created: "2025-10-18",
    parentId: "q_eng_read", subIndex: 2, stem: "According to the passage, people at the library can do all of the following EXCEPT ______.",
    options: [
      { key: "A", text: "attend free lectures" }, { key: "B", text: "borrow tools" },
      { key: "C", text: "buy coffee" }, { key: "D", text: "take coding classes" },
    ],
    answer: "C", answerNote: "文中未提及 buy coffee；其余三项均有列举。",
    difficulty: 2, knowledge: ["k_eng_read"], lineage: "part", variants: [],
    attempts: 7, inReview: true, papers: [], mistakes: 0 },

  // 5) 英语·语法填空（填词）— passage + 填空小题
  {
    id: "q_eng_grammar", kind: "cloze", status: "active", source: "seed", created: "2025-09-08",
    composite: true,
    stem: "用括号中所给词的正确形式填空（每空一词）。",
    passage: "Yesterday I __1__ (go) to the science museum with my friends. We __2__ (be) very excited because it was our first visit. The robots there were really __3__ (amaze).",
    difficulty: 2, knowledge: ["k_eng_grammar"],
    lineage: "root", root: null, depth: 0, variants: [],
    children: ["q_eng_grammar_1", "q_eng_grammar_2", "q_eng_grammar_3"],
    attempts: 4, inReview: false, papers: [], mistakes: 0,
  },
  { id: "q_eng_grammar_1", kind: "cloze", status: "active", source: "seed", created: "2025-09-08",
    parentId: "q_eng_grammar", subIndex: 1, stem: "**1.** ______ `(go)`",
    options: [], answer: "went", answerNote: "Yesterday 提示一般过去时。",
    difficulty: 1, knowledge: ["k_eng_grammar"], lineage: "part", variants: [],
    attempts: 4, inReview: false, papers: [], mistakes: 0 },
  { id: "q_eng_grammar_2", kind: "cloze", status: "active", source: "seed", created: "2025-09-08",
    parentId: "q_eng_grammar", subIndex: 2, stem: "**2.** ______ `(be)`",
    options: [], answer: "were", answerNote: "主语 We，过去时用 were。",
    difficulty: 2, knowledge: ["k_eng_grammar"], lineage: "part", variants: [],
    attempts: 4, inReview: false, papers: [], mistakes: 0 },
  { id: "q_eng_grammar_3", kind: "cloze", status: "active", source: "seed", created: "2025-09-08",
    parentId: "q_eng_grammar", subIndex: 3, stem: "**3.** ______ `(amaze)`",
    options: [], answer: "amazing", answerNote: "修饰物、表「令人惊叹的」用 -ing 形容词 amazing。",
    difficulty: 2, knowledge: ["k_eng_grammar"], lineage: "part", variants: [],
    attempts: 3, inReview: false, papers: [], mistakes: 0 },
);
function qById(id) { return DATA.questions.find((q) => q.id === id); }
// only top-level rows (exclude composite children) for the main list
function qTopLevel() { return DATA.questions.filter((q) => !q.parentId); }
function qChildren(q) { return (q.children || []).map(qById).filter(Boolean); }
// association count → drives delete-constraint warning
function qAssoc(q) {
  const kids = qChildren(q);
  const sum = (sel) => sel(q) + kids.reduce((a, c) => a + sel(c), 0);
  return {
    attempts: sum((x) => x.attempts || 0),
    review: (q.inReview ? 1 : 0) + kids.filter((c) => c.inReview).length,
    papers: new Set([...(q.papers || []), ...kids.flatMap((c) => c.papers || [])].map((p) => p.id)).size,
    mistakes: sum((x) => x.mistakes || 0),
    children: kids.length,
  };
}
function qDeletable(q) {
  const a = qAssoc(q);
  return a.attempts === 0 && a.review === 0 && a.papers === 0 && a.mistakes === 0 && a.children === 0;
}
// variant family: root + all variants (flat)
function qFamily(q) {
  const rootId = q.lineage === "variant" ? q.root : q.id;
  const root = qById(rootId);
  if (!root) return null;
  return { root, variants: (root.variants || []).map(qById).filter(Boolean) };
}
Object.assign(window, { qById, qTopLevel, qChildren, qAssoc, qDeletable, qFamily });
