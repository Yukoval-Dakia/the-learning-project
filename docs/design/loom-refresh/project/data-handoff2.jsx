// Loom · 晨间交班叙事缕 (morning handoff thread) — refresh data.
// 段2「后叙事」：AI 以第一人称交班「昨夜(自上次到访以来)我替你做了什么」。
// 6 featured 类目 + 轻改动折叠 + 三种空/降级态。
//
// 硬契约(烤进数据形状, 不靠组件自觉)：
//  · mastery 一律 离散档 + 置信区间(lo..hi, band 索引含端) + 来源二态(hard 校准/soft 先验) + lowConf。绝不裸数字。
//  · 备课 conjecture 只给「备了几道」, predicted_p / 内部校准概率 绝不进数据。
//  · propose=软提议(待裁决) 与 refine=既成事实(可回滚) 在字段上就分开(proposal / change)。

const HO2_BANDS = ["萌芽", "成长", "稳固", "精熟"];

// 类目元数据 — label · icon(取自 components.jsx ICONS) · tone · 下钻归宿
const HO2_CAT = {
  recalibrate: { label: "重标定 · 掌握",  icon: "target",    tone: "info"    },
  drill:       { label: "题库补缺",       icon: "layers",    tone: "coral"   },
  propose:     { label: "新提议 · 待裁决", icon: "inbox",     tone: "info"    },
  prep:        { label: "为你而备",       icon: "sparkle",   tone: "coral"   },
  recap:       { label: "周度复盘",       icon: "history",   tone: "good"    },
  observe:     { label: "AI 观察",        icon: "eye",       tone: "neutral" },
  refine:      { label: "录入 refine",    icon: "undo",      tone: "neutral" },
};

const HANDOFF2 = {
  // 昨夜这趟夜链运行的元信息 — 交班缕的「来源」与「窗口」
  run: {
    agent: "dreaming",
    window: "昨夜 02:38 → 今晨 03:21",
    sinceVisit: "自你上次离开（昨晚 22:14）以来",
    events: 134,        // 复盘纳入考量的 event 数
    produced: 5,        // 本档可交班项（不含轻改动）
    cost: 0.071,
  },

  // 「昨夜这一档」快照 —— 有限不堆积；narrative 渐进披露(里程碑默认展开)。
  items: [
    // ① 重标定 · hard 校准（方向上行，敢挪档）
    {
      id: "recal_zhi", cat: "recalibrate", agent: "dreaming", time: "今晨 03:18",
      gist: "把「之 · 主谓取独」的掌握往上挪了一格",
      reason: "你这周三次作答合着看，方向稳稳在上行——趁有据，我把估计更新了。",
      mastery: { node: "之 · 主谓取独", band: 2, lo: 1, hi: 2, source: "hard", lowConf: false, dir: "up" },
      drill: { label: "看这点的画像", route: "知识点详情" },
      milestone: false,
      narrative:
        "过去 7 天你在「之」上作答 9 次，主谓取独那一档从「成长」边缘站进了「稳固」。" +
        "这是真实作答校准出来的，不是我先验里猜的——所以我敢把档位往上挪。精确数值留在详情页，缕里我只给方向。",
    },

    // ② 重标定 · soft 先验（盲区未消，低置信，不敢拍）
    {
      id: "recal_qi", cat: "recalibrate", agent: "dreaming", time: "今晨 03:18",
      gist: "「其 · 指代」我还在猜，盲区没消",
      reason: "这点你真实只答过 2 次，现在的档是模型先验回吐——别太当真。",
      mastery: { node: "其 · 指代", band: 1, lo: 0, hi: 2, source: "soft", lowConf: true, dir: "flat" },
      drill: { label: "补一次作答消盲区", route: "练习" },
      milestone: false,
    },

    // ③ 题库补缺
    {
      id: "drill_quqdu", cat: "drill", agent: "dreaming", time: "今晨 03:05",
      gist: "为「主谓取独」补了 4 道由浅入深的题",
      reason: "旧题池只剩 2 道、还都做过，接不住你——我备了一组梯度刚好的新题。",
      drill: { label: "开始这组练习", route: "练习" },
      milestone: false,
      narrative:
        "池子见底，再练就是背答案。这 4 道里第一道近乎送分，只为让你重新摸到「取消句子独立性」的手感；后三道逐格加码。" +
        "练完，我对你这点的判断能从『猜』变成『有据』。",
    },

    // ④ 新提议 · 软提议（待裁决，措辞克制不当成既成事实）
    {
      id: "prop_edge", cat: "propose", agent: "dreaming", time: "今晨 03:12", proposal: true,
      gist: "想在图谱里把「词类活用 → 使动用法」连一条边",
      reason: "你两道错的根子是同一个：把使动当成了普通活用。连上能一起复习。",
      drill: { label: "去裁决收件箱", route: "裁决收件箱" },
      milestone: false,
      narrative:
        "这是一条提议，不是我替你定了。我把它写进了草稿，你点开能看见净 diff——接受、改方向、或撤掉，方向盘都在你手里。",
    },

    // ⑤ 备课 conjecture「为你而备」(≤3)；NO predicted_p
    {
      id: "prep_conj", cat: "prep", agent: "dreaming", time: "今晨 03:20", conjectureCount: 3,
      gist: "为你而备了 3 道辨析题",
      reason: "针对你反复混淆的「定语助词『之』 vs 主谓取独」，我诱导了一组对照。",
      drill: { label: "去备课台看", route: "备课台" },
      milestone: false,
      narrative:
        "辨析题不考记忆，考你能不能在两个像的东西之间划清线。这 3 道都绕着同一处易混点转，做完你大概率能自己把差别说清。",
    },

    // ⑥ 周度复盘 · milestone（默认展开叙事）；soft 低置信，只信相对排序
    {
      id: "recap_week", cat: "recap", agent: "coach", time: "今晨 03:09", milestone: true,
      gist: "替你复盘了这一周的虚词",
      reason: "相对上周的你，确实在往上走；但绝对掌握，我还不敢拍一个数字。",
      mastery: { node: "虚词 · 整体", band: 1, lo: 0, hi: 2, source: "soft", lowConf: true, dir: "up" },
      drill: { label: "看成效趋势", route: "成效趋势" },
      narrative:
        "这一周你做了 41 次虚词相关的作答，比上周多 12 次。按时间排开，你在「之」「其」上的相对次序，确实往「可信」那一端挪了。" +
        "但我得诚实说：这只是『相对上周的你』在进步。绝对掌握度我给不出一个敢拍的数字——证据还不够，n=1 的慢热期就是这样。再练一周，我能说得更准。",
    },
  ],

  // 轻改动 —— 折叠在脚，避免「昨夜这一档」变成 backlog。(AI 观察 · 录入 refine)
  minor: [
    {
      id: "obs_pool", cat: "observe", agent: "qverify", time: "今晨 02:51",
      gist: "留了一条观察：`k_xuci_zhi` 题池临期", route: "AI 观察",
      note: "主谓取独题池只剩 2 题且都已 verified，提示 dreaming 去补。",
    },
    {
      id: "refine_note", cat: "refine", agent: "maintenance", time: "昨夜 23:40", change: true,
      gist: "顺手 refine 了你《师说》那条笔记", route: "笔记",
      note: "~1 block：把「之」的定语 / 取独两类用法分行标注。可一键回滚。",
    },
  ],

  // ── 空夜 · 首日（有档案，但还没有过任何一个夜晚）—— 预告基调，建立预期 ──
  firstNight: {
    eyebrow: "夜链 · 还没跑过",
    title: "昨夜还没有可以交给你的东西。",
    body:
      "团队是在你持续学习之后，才开始为你做夜间复盘的。今晚，它会第一次为你准备——" +
      "现在不必着急，先从一件小事起头就好。",
    ctas: [
      { label: "先做第一道题", route: "练习", icon: "layers", variant: "primary" },
      { label: "先录入材料",   route: "录入", icon: "record", variant: "secondary" },
    ],
    previewLabel: "今晚起，这里会出现",
    preview: [
      { icon: "target",    title: "昨夜重标定了什么", sub: "连同为什么往这个方向挪——绝不只给你一个干数字" },
      { icon: "layers",    title: "为你弱点备了哪些题", sub: "梯度刚好接住你，不直接上难的" },
      { icon: "inbox",     title: "提了哪条新边 / 学习项", sub: "一条提议，接受、改方向、撤掉都行" },
      { icon: "sparkle",   title: "为你而备的辨析题", sub: "围着你最容易混的那处，≤3 道" },
    ],
  },

  // ── 空夜 · 稳态安静夜（已过过夜，但昨夜窗内无产出）—— 极简、合法日常 ──
  quietNight: {
    eyebrow: "夜链 · 安静",
    title: "昨夜安静。",
    body: "夜链跑过了，只是没攒出要紧的东西要交给你。今天该练的，都在上面那条线里。",
    foot: "下次有动静，我会在这儿等你。",
  },

  // ── 加载（夜链仍在运行 · 正在准备）—— 与「安静」语义区分：有进度、在跑 ──
  loading: {
    banner: "夜链仍在运行 · 正在复盘昨夜的作答，交班缕马上就好。",
    progress: "dreaming · 3 / 5 就绪",
  },

  // ── 部分降级 + job 失败诚实交代 —— 段2 故障不拖垮段1；缺的不假装没有 ──
  degrade: {
    doneCount: 3,                 // 已就绪、照常渲染的前 N 项
    banner: "昨夜有一项没跑成——下面是已经备好的部分，缺的那几条今晚会重试。",
    jobsFailed: [
      { name: "coach_weekly", reason: "运行超时，未跑成" },
    ],
    missNote: "另有 2 项因 dreaming job 中断未生成 · 今晚自动重试。",
  },
};

window.HANDOFF2 = HANDOFF2;
window.HO2_BANDS = HO2_BANDS;
window.HO2_CAT = HO2_CAT;
