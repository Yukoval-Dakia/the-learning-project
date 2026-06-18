// Loom · 草稿审核 (draft-pool review) data.
// The draft pool = question 草稿 awaiting owner审核 before going active.
// Each draft carries: prompt (题面/材料/选项/答案), kind, source, verify
// status (+rejection reason), AI origin (confidence/cost) where machine-made,
// and a creation time. Shape is decoupled from the live 题库 (data-questions).

// ── source: web 采集 / AI 生成 / 手动录入 ────────────────────────
const DR_SOURCE = {
  web:    { label: "web 采集", short: "采集", icon: "download", tone: "info" },
  gen:    { label: "AI 生成",  short: "生成", icon: "sparkle",  tone: "coral" },
  manual: { label: "录入",     short: "录入", icon: "pencil",   tone: "neutral" },
};

// ── verify status: 未验过 / 待复核 / 验证未过 ─────────────────────
const DR_VERIFY = {
  unverified:   { label: "未验证", short: "未验", icon: "clock", tone: "neutral" },
  needs_review: { label: "待复核", short: "复核", icon: "alert", tone: "hard" },
  failed:       { label: "验证未过", short: "未过", icon: "close", tone: "again" },
};

// difficulty 1-5 → tone + word (local copy; QDIFF in data-questions isn't exported)
const DR_DIFF = {
  1: { tone: "good", word: "易" }, 2: { tone: "good", word: "较易" },
  3: { tone: "hard", word: "中等" }, 4: { tone: "again", word: "较难" }, 5: { tone: "again", word: "难" },
};

// knowledge id → label, falling back to the bank's map
function drkLabel(id) {
  if (window.qkLabel) return window.qkLabel(id);
  return id;
}

Object.assign(window, { DR_SOURCE, DR_VERIFY, DR_DIFF, drkLabel });

// ── the draft pool ───────────────────────────────────────────────
// ts: larger = newer (used for sort). when: human label.
// origin (gen/web only): { agent, confidence 0-1, cost (USD), reason }
// verify.reason present iff state ≠ unverified.
const DRAFTS = [
  {
    id: "d_001", kind: "mcq", source: "gen", ts: 980, when: "今晨 02:14",
    stem: "下列各句中「**之**」用法与其余三项**不同**的一项是：",
    options: [
      { key: "A", text: "臣**之**壮也，犹不如人。" },
      { key: "B", text: "邻**之**厚，君**之**薄也。" },
      { key: "C", text: "行李**之**往来，共其乏困。" },
      { key: "D", text: "марш — 蚓无爪牙**之**利。" },
    ],
    answer: "D", difficulty: 3, knowledge: ["k_xuci_zhi", "k_zhi_subj"],
    origin: { agent: "Sonnet", confidence: 0.62, cost: 0.0184, reason: "由 q_zhi_root 错因「主谓取独」夜间增补的同类变体" },
    verify: { state: "failed", reason: "选项 D 文本含乱码「марш」，疑 OCR/生成噪声混入；且 A、C 均可判为「主谓取独」，无唯一答案" },
  },
  {
    id: "d_002", kind: "cloze", source: "gen", ts: 978, when: "今晨 02:14",
    stem: "填空：「师道**之**不传也久矣」中，「之」用于 ＿＿＿ 之间，作用是 ＿＿＿。",
    answer: "主谓 / 取消句子独立性", difficulty: 2, knowledge: ["k_xuci_zhi"],
    origin: { agent: "Haiku", confidence: 0.79, cost: 0.0049, reason: "把单选改写为填空，强化主动回忆" },
    verify: { state: "unverified" },
  },
  {
    id: "d_003", kind: "trans", source: "web", ts: 975, when: "今晨 01:58",
    stem: "翻译：「**蚓无爪牙之利，筋骨之强**，上食埃土，下饮黄泉，用心一也。」",
    answer: "蚯蚓没有锋利的爪牙、强健的筋骨，（却能）向上吃到泥土，向下喝到地下水，是因为用心专一。",
    difficulty: 3, knowledge: ["k_xuci_zhi"],
    origin: { agent: "Haiku", confidence: 0.71, cost: 0.0052, reason: "采集自《劝学》公开题库，已去重比对" },
    verify: { state: "needs_review", reason: "「爪牙之利」为定语后置，answerNote 缺该语法点提示，建议人工补注后启用" },
  },
  {
    id: "d_004", kind: "mcq", source: "gen", ts: 972, when: "今晨 01:40",
    stem: "「**其**皆出于此乎」中「其」表达的语气是：",
    options: [
      { key: "A", text: "反问" }, { key: "B", text: "揣测、推断" },
      { key: "C", text: "祈使" }, { key: "D", text: "第三人称称代" },
    ],
    answer: "B", difficulty: 3, knowledge: ["k_xuci_qi"],
    origin: { agent: "Sonnet", confidence: 0.88, cost: 0.0162, reason: "覆盖「其」表语气考点的高置信变体" },
    verify: { state: "unverified" },
  },
  {
    id: "d_005", kind: "short", source: "manual", ts: 968, when: "昨天 22:10",
    stem: "「以勇气闻**于**诸侯」中「于」的用法和意义是什么？",
    answer: "介词，引进处所/对象，译「在……（之间）」，此处指「在诸侯之间（闻名）」。",
    difficulty: 3, knowledge: ["k_xuci_yu"],
    verify: { state: "unverified" },
  },
  {
    id: "d_006", kind: "cloze", source: "gen", ts: 965, when: "昨天 21:55",
    stem: "断句（限 2 处）：　　臣闻求木之长者必固其根本",
    answer: "臣闻求木之长者 / 必固其根本", difficulty: 4, knowledge: ["k_juedu"],
    origin: { agent: "Sonnet", confidence: 0.41, cost: 0.0203, reason: "由《谏太宗十思疏》生成的断句练习" },
    verify: { state: "failed", reason: "限 2 处但参考答案仅切 1 处，空数与题面约束冲突" },
  },
  {
    id: "d_007", kind: "mcq", source: "gen", ts: 961, when: "昨天 21:40",
    stem: "今有圭田，广 $8$ 步，正从 $15$ 步，则其积为：",
    options: [
      { key: "A", text: "$60$ 平方步" }, { key: "B", text: "$120$ 平方步" },
      { key: "C", text: "$23$ 平方步" }, { key: "D", text: "$\\dfrac12$ 亩" },
    ],
    answer: "A", difficulty: 2, knowledge: ["k_suanxue"],
    origin: { agent: "Haiku", confidence: 0.81, cost: 0.0047, reason: "《九章算术·方田》换数生成的同型练习" },
    verify: { state: "unverified" },
  },
  {
    id: "d_008", kind: "short", source: "manual", ts: 957, when: "昨天 20:18",
    stem: "简述「使动用法」与「意动用法」的区别，各举一例。",
    difficulty: 4, knowledge: ["k_gujin"],
    verify: { state: "needs_review", reason: "缺少 answer 字段，judge 无法校对；建议补参考答案或标记为开放题" },
  },
  {
    id: "d_009", kind: "reading", source: "web", ts: 953, when: "昨天 19:50",
    stem: "阅读下面文段，完成后续小题。",
    passage: "廉颇者，赵之良将也。赵惠文王十六年，廉颇为赵将，伐齐，大破之，取阳晋，拜为上卿，以勇气闻于诸侯。",
    difficulty: 3, knowledge: ["k_judge", "k_shiji"],
    origin: { agent: "Haiku", confidence: 0.66, cost: 0.0058, reason: "采集《史记·廉颇蔺相如列传》选段，拟作阅读大题母本" },
    verify: { state: "needs_review", reason: "仅有 passage、无小题；作为大题需至少 1 道小题方可启用" },
  },
  {
    id: "d_010", kind: "mcq", source: "gen", ts: 949, when: "昨天 18:32",
    stem: "「廉颇者，赵**之**良将也」的句式是：",
    options: [
      { key: "A", text: "判断句" }, { key: "B", text: "被动句" },
      { key: "C", text: "省略句" }, { key: "D", text: "宾语前置" },
    ],
    answer: "A", difficulty: 2, knowledge: ["k_judge"],
    origin: { agent: "Sonnet", confidence: 0.93, cost: 0.0151, reason: "「……者，……也」判断句标志，高置信" },
    verify: { state: "unverified" },
  },
  {
    id: "d_011", kind: "trans", source: "manual", ts: 944, when: "昨天 17:05",
    stem: "翻译：「青，取之**于**蓝，而青**于**蓝。」",
    answer: "靛青是从蓝草中提取的，但颜色比蓝草更深。",
    difficulty: 2, knowledge: ["k_xuci_yu", "k_gujin"],
    verify: { state: "unverified" },
  },
  {
    id: "d_012", kind: "cloze", source: "gen", ts: 940, when: "昨天 16:20",
    stem: "填空：「廉颇」为赵宦者令缪贤**舍人**，「舍人」指 ＿＿＿。",
    answer: "门客、家臣", difficulty: 2, knowledge: ["k_shiji", "k_gujin"],
    origin: { agent: "Haiku", confidence: 0.74, cost: 0.0044, reason: "补充材料中的古今异义词考点" },
    verify: { state: "failed", reason: "史实错误：「舍人」属蔺相如而非廉颇，题面人物张冠李戴" },
  },
  {
    id: "d_013", kind: "mcq", source: "web", ts: 935, when: "前天 23:11",
    stem: "下列加点词解释**错误**的一项是：",
    options: [
      { key: "A", text: "「微夫人之力不及此」微：没有" },
      { key: "B", text: "「焉用亡郑以陪邻」陪：增加" },
      { key: "C", text: "「朝济而夕设版焉」济：救济" },
      { key: "D", text: "「秦伯说，与郑人盟」说：通「悦」" },
    ],
    answer: "C", difficulty: 3, knowledge: ["k_gujin"],
    origin: { agent: "Haiku", confidence: 0.69, cost: 0.0061, reason: "采集自《烛之武退秦师》实词辨析题" },
    latent: "答案存疑：「济」在「朝济而夕设版焉」中应解作「渡河」，C 项解释「救济」确为错误项，但选项 A「微：没有」亦不严谨，需复核唯一性",
    verify: { state: "unverified" },
  },
  {
    id: "d_014", kind: "short", source: "gen", ts: 930, when: "前天 22:40",
    stem: "在 $f(x)=x^3-3x+1$ 的条件下，求其在 $[-2,2]$ 上的最大值。",
    answer: "比较极值与端点：$f(-1)=3,\\;f(2)=3,\\;f(-2)=-1,\\;f(1)=-1$，最大值为 $3$。",
    difficulty: 4, knowledge: ["k_math_deriv"],
    origin: { agent: "Sonnet", confidence: 0.85, cost: 0.0178, reason: "在原导数大题上追加闭区间最值小问" },
    verify: { state: "unverified" },
  },
  {
    id: "d_015", kind: "mcq", source: "gen", ts: 925, when: "前天 21:02",
    stem: "完形：Last summer I ___ a small village in the mountains.",
    options: [
      { key: "A", text: "visited" }, { key: "B", text: "visit" },
      { key: "C", text: "visiting" }, { key: "D", text: "to visit" },
    ],
    answer: "A", difficulty: 2, knowledge: ["k_eng_cloze"],
    origin: { agent: "Haiku", confidence: 0.9, cost: 0.0043, reason: "记叙过去经历，一般过去时考点" },
    verify: { state: "unverified" },
  },
  {
    id: "d_016", kind: "cloze", source: "web", ts: 919, when: "前天 19:48",
    stem: "语法填空：The robots there were really ___ `(amaze)`.",
    answer: "amazing", difficulty: 2, knowledge: ["k_eng_grammar"],
    origin: { agent: "Haiku", confidence: 0.58, cost: 0.0055, reason: "采集自语法填空公开卷" },
    verify: { state: "needs_review", reason: "答案 amazing/amazed 取决于语境主语，需确认修饰对象后再启用" },
  },
  {
    id: "d_017", kind: "reading", source: "web", ts: 914, when: "前天 18:30",
    stem: "Read the passage and answer the question.",
    passage: "The public library is more than a place for books. In many towns it has quietly become a community center, where people attend free lectures, borrow tools, and even take coding classes — all at no cost.",
    difficulty: 3, knowledge: ["k_eng_read"],
    origin: { agent: "Haiku", confidence: 0.64, cost: 0.0059, reason: "采集英语阅读语篇，拟作阅读理解母本" },
    verify: { state: "needs_review", reason: "无小题；阅读大题需至少 1 道小题" },
  },
  {
    id: "d_018", kind: "mcq", source: "gen", ts: 908, when: "前天 16:12",
    stem: "「**于**」字三句中，表示比较的一项是：",
    options: [
      { key: "A", text: "苛政猛**于**虎也" }, { key: "B", text: "受任**于**败军之际" },
      { key: "C", text: "事急矣，请奉命求救**于**孙将军" }, { key: "D", text: "請" },
    ],
    answer: "A", difficulty: 3, knowledge: ["k_xuci_yu"],
    origin: { agent: "Sonnet", confidence: 0.55, cost: 0.0169, reason: "「于」表比较 vs 处所的辨析变体" },
    verify: { state: "failed", reason: "选项 D 仅含单字「請」，明显截断，选项不完整" },
  },
  {
    id: "d_019", kind: "short", source: "manual", ts: 902, when: "前天 14:50",
    stem: "解释「**因**」在「**因**人之力而敝之，不仁」中的意义。",
    answer: "介词，依靠、凭借。", difficulty: 2, knowledge: ["k_gujin"],
    verify: { state: "unverified" },
  },
  {
    id: "d_020", kind: "cloze", source: "gen", ts: 896, when: "3 天前",
    stem: "断句（限 3 处）：　　师者所以传道受业解惑也",
    answer: "师者 / 所以传道 / 受业 / 解惑也", difficulty: 4, knowledge: ["k_juedu", "k_judge"],
    origin: { agent: "Sonnet", confidence: 0.83, cost: 0.0157, reason: "《师说》经典断句，覆盖判断句尾「也」" },
    verify: { state: "unverified" },
  },
  {
    id: "d_021", kind: "mcq", source: "web", ts: 889, when: "3 天前",
    stem: "下列句子中，与「**句读之不知**」句式相同的一项是：",
    options: [
      { key: "A", text: "蚓无爪牙之利" }, { key: "B", text: "何陋之有" },
      { key: "C", text: "marp:渺沧海之一粟" }, { key: "D", text: "师道之不复，可知矣" },
    ],
    answer: "B", difficulty: 4, knowledge: ["k_xuci_zhi"],
    origin: { agent: "Haiku", confidence: 0.49, cost: 0.0063, reason: "宾语前置「之」标志的句式辨析" },
    verify: { state: "failed", reason: "选项 C 含异常前缀「marp:」，生成噪声未清洗" },
  },
  {
    id: "d_022", kind: "trans", source: "gen", ts: 882, when: "3 天前",
    stem: "翻译：「**所以**遣将守关者，备他盗之出入与非常也。」",
    answer: "（之所以）派遣将领把守函谷关的原因，是为了防备其他盗贼进出和意外变故。",
    difficulty: 3, knowledge: ["k_gusuoye", "k_gujin"],
    origin: { agent: "Sonnet", confidence: 0.87, cost: 0.0173, reason: "「所以」表原因的翻译变体" },
    latent: "重复检测：与题库 q_suoye_1 文本相似度 0.93，疑为已有题目的近似重复",
    verify: { state: "unverified" },
  },
  {
    id: "d_023", kind: "mcq", source: "gen", ts: 875, when: "3 天前",
    stem: "「**之**」作代词的一项是：",
    options: [
      { key: "A", text: "古之学者必有师" }, { key: "B", text: "人非生而知**之**者" },
      { key: "C", text: "道之所存，师之所存也" }, { key: "D", text: "欲人之无惑也难矣" },
    ],
    answer: "B", difficulty: 3, knowledge: ["k_xuci_zhi"],
    origin: { agent: "Haiku", confidence: 0.76, cost: 0.0046, reason: "「之」代词 vs 助词的辨析" },
    verify: { state: "unverified" },
  },
  {
    id: "d_024", kind: "cloze", source: "manual", ts: 868, when: "4 天前",
    stem: "填空：通假字「**契**」通 ＿＿＿，「契阔谈讌」中读作 ＿＿＿。",
    answer: "「锲」无 / qì",
    difficulty: 3, knowledge: ["k_duoyin"],
    verify: { state: "needs_review", reason: "answer 含占位串「无」，疑误填；通假对象与读音需复核" },
  },
  {
    id: "d_025", kind: "short", source: "web", ts: 861, when: "4 天前",
    stem: "分析「**会**当凌绝顶，一览众山小」中「会」的含义及其表达效果。",
    answer: "「会」意为「定要、终将」，表强烈的自信与抱负，使诗境由写景转向言志。",
    difficulty: 3, knowledge: ["k_gujin"],
    origin: { agent: "Haiku", confidence: 0.6, cost: 0.0057, reason: "采集自《望岳》鉴赏题" },
    latent: "知识点标注偏差：本题考诗歌炼字/情感，挂载 k_gujin（古今异义）不当，无法正确进入复习调度",
    verify: { state: "unverified" },
  },
  {
    id: "d_026", kind: "mcq", source: "gen", ts: 854, when: "4 天前",
    stem: "下列「**而**」表转折的一项是：",
    options: [
      { key: "A", text: "青，取之于蓝，**而**青于蓝" }, { key: "B", text: "锲**而**舍之，朽木不折" },
      { key: "C", text: "蟹六跪**而**二螯" }, { key: "D", text: "吾尝终日**而**思矣" },
    ],
    answer: "A", difficulty: 3, knowledge: ["k_xuci_zhi"],
    origin: { agent: "Sonnet", confidence: 0.84, cost: 0.0148, reason: "「而」连词用法辨析（转折/并列/修饰/承接）" },
    verify: { state: "unverified" },
  },
  {
    id: "d_027", kind: "short", source: "gen", ts: 847, when: "5 天前",
    stem: "已知 $f(x)=x^3-3ax+1$，当 $a=1$ 时求 $f(x)$ 的单调递增区间。",
    answer: "$f'(x)=3x^2-3$，令 $f'(x)>0$ 得 $x<-1$ 或 $x>1$，递增区间为 $(-\\infty,-1)$ 与 $(1,+\\infty)$。",
    difficulty: 3, knowledge: ["k_math_deriv"],
    origin: { agent: "Sonnet", confidence: 0.45, cost: 0.0191, reason: "导数单调性变体" },
    verify: { state: "failed", reason: "LaTeX 解析失败：题面外存在未配对的 `$`，渲染中断" },
  },
  {
    id: "d_028", kind: "mcq", source: "web", ts: 840, when: "5 天前",
    stem: "What is the main idea of the passage above?",
    options: [
      { key: "A", text: "Libraries are losing readers." },
      { key: "B", text: "Modern libraries serve as community centers." },
      { key: "C", text: "Coding classes should be paid for." },
      { key: "D", text: "Books are no longer important." },
    ],
    answer: "B", difficulty: 3, knowledge: ["k_eng_read"],
    origin: { agent: "Haiku", confidence: 0.72, cost: 0.006, reason: "采集英语阅读主旨题" },
    verify: { state: "needs_review", reason: "题面引用「the passage above」但草稿未附 passage，需挂载语篇后启用" },
  },
  {
    id: "d_029", kind: "cloze", source: "manual", ts: 833, when: "6 天前",
    stem: "填空：「**唯**利是图」与「**唯**才是举」中，「唯」的作用是 ＿＿＿。",
    answer: "构成「唯……是……」宾语前置句式，强调宾语。",
    difficulty: 4, knowledge: ["k_xuci_zhi"],
    verify: { state: "unverified" },
  },
  {
    id: "d_030", kind: "trans", source: "gen", ts: 826, when: "6 天前",
    stem: "翻译：「**臣本布衣**，躬耕于南阳，苟全性命于乱世，不求闻达于诸侯。」",
    answer: "我本来是平民，亲自在南阳耕种，只想在乱世中苟且保全性命，不奢求在诸侯之中显达扬名。",
    difficulty: 3, knowledge: ["k_xuci_yu", "k_gujin"],
    origin: { agent: "Sonnet", confidence: 0.89, cost: 0.0166, reason: "《出师表》经典句翻译，三个「于」连用" },
    verify: { state: "unverified" },
  },
];

// volume slices for the demo (Tweaks → 草稿池数据量)
function draftPool(volume) {
  if (volume === "none") return [];
  if (volume === "few") return DRAFTS.slice(0, 6);
  if (volume === "mid") return DRAFTS.slice(0, 15);
  return DRAFTS; // many
}

Object.assign(window, { DRAFTS, draftPool });
