// Loom · 练习面 (practice face) data — 流 (stream) + 卷架 (shelf).
// Contract: GET /api/practice/stream?date=today → { opening_line, items[], progress }.
// item: { item_kind: 'question'|'paper', source, reasoning(第一人称), status }.
// 机制不暴露：无 FSRS 参数、无 proposal 状态 — 只有 AI 的一句话理由。

const PFACE_SRC = {
  decay:     { label: "衰减复习", tone: "info",    icon: "history" },
  variant:   { label: "错题变式", tone: "again",   icon: "mistakes" },
  new_check: { label: "新学自测", tone: "good",    icon: "spark2" },
  paper:     { label: "打包卷",   tone: "coral",   icon: "layers" },
  on_demand: { label: "点播",     tone: "neutral", icon: "send" },
  import:    { label: "导入",     tone: "neutral", icon: "record" },
};

const PFACE = {
  date: "2026-06-10",
  opening: "昨晚我看了你的曲线：「之」的主谓取独衰减得厉害，今天先把它补回来，再带一张虚词小卷。",
  openingMeta: "coach · 今 07:00 · $0.011",
  closing: "今天 7 项织完了。「之 · 取独」回到稳定区；上午那道否定句宾语前置的变式我排进了明天的流。晚上不用再碰文言文。",

  // ── 今日流 · 有序 items ──────────────────────────────────────
  items: [
    { id: "si_1", kind: "question", ref: "q_201", source: "decay",
      reason: "「宾语前置的之」上周到了边缘，先热个身。",
      init: "done", doneVerdict: "good", doneAt: "08:12" },
    { id: "si_2", kind: "question", ref: "q_202", source: "variant",
      reason: "前天「不己知」翻车了，这道换了说法再来一次。",
      init: "done", doneVerdict: "again", doneAt: "08:16" },
    { id: "si_3", kind: "question", ref: "q_203", source: "decay",
      reason: "我昨晚看到你「主谓取独」那块衰减得厉害——核心一道，先把它咬住。" },
    { id: "si_4", kind: "question", ref: "q_204", source: "decay",
      reason: "同一个知识点换成翻译题，看你是真懂还是认得题型。" },
    { id: "si_5", kind: "question", ref: "q_205", source: "variant",
      reason: "上周「其」的语气你判反了一次，这道是它的变式。" },
    { id: "si_6", kind: "paper", ref: "pp_today", source: "paper",
      reason: "散题做完后用这张小卷收口——卷内不给即时反馈，交卷统一判。" },
    { id: "si_7", kind: "question", ref: "q_206", source: "new_check",
      reason: "昨天你读了判断句的笔记，自测一道确认真的进脑子了。" },
  ],

  // AI 白天增补 demo — 对 si_2 错题的即时变式
  extraItem: { id: "si_x1", kind: "question", ref: "q_207", source: "variant",
    reason: "刚才「不己知」的变式你又错在宾语位置，我现做了一道只考语序的——趁热。",
    isNew: true },

  // ── 散题题库 ────────────────────────────────────────────────
  questions: {
    q_201: { kp: "宾语前置 · 之", type: "choice", done: true },
    q_202: { kp: "否定句宾语前置", type: "text", done: true },

    q_203: {
      kp: "之 · 主谓取独", type: "choice",
      stem: "下列句中「之」用作主谓之间取消句子独立性的是？",
      options: [
        { k: "A", text: "辍耕之垄上", note: "动词，往" },
        { k: "B", text: "师道之不传也久矣", note: "主谓之间，取独" },
        { k: "C", text: "句读之不知，惑之不解", note: "宾语前置标志" },
        { k: "D", text: "蚓无爪牙之利", note: "定语后置标志" },
      ],
      correct: 1,
      fb: {
        good: "对。「师道」与「不传」本是一个完整的主谓句，「之」插进去把它降格成了短语——这就是取独。你这次没有犹豫，比上周快。",
        again: "你把别的「之」认成了取独——还是上次那个坑。判别口诀：先找主谓。「师道之不传」里「师道」是主语、「不传」是谓语，「之」夹在中间取消独立性；C 的「句读之不知」还原语序是「不知句读」，「之」只是提宾的标志。",
      },
      advice: { good: "good", again: "again" },
      hints: [
        "别先看「之」，先找每个选项里有没有完整的「主语 + 谓语」结构。",
        "B 里「师道」和「不传」是什么关系？把「之」抽掉读一遍试试。",
        "对比 C：「句读之不知」语序还原是「不知句读」——这个「之」在干别的活。",
      ],
    },

    q_204: {
      kp: "之 · 取独 / 意动 / 判断句", type: "text",
      stem: "翻译下面的句子，注意加点词的用法：",
      passage: "吾妻之美我者，私我也。",
      passageSrc: "《邹忌讽齐王纳谏》",
      reference: "我的妻子认为我美，是因为偏爱我啊。（之：取独 · 美：意动「认为……美」 · 「……者，……也」判断句）",
      // canned 判定：partial — 漏标意动；不服判后改判 good
      cannedVerdict: "hard",
      fb: {
        hard: "三个点你拿到两个：「之」的取独处理对了，判断句的「是因为……」也译出来了。但「美我」你译成「我美」，意动「认为我美」这一层没有落在译文里。",
      },
      appealReply: "你说得对——「觉得我美」已经含了意动义，是我判严了。改判：对。评级建议同步上调。",
      advice: { hard: "hard" },
      hints: [
        "这句有三个考点：「之」、「美」、句式。先把主干找出来。",
        "「美我」——「美」后面带了宾语「我」，形容词带宾语，通常是哪种活用？",
        "「……者，……也」是文言里最典型的哪种句式？译文里要补一个什么字？",
      ],
    },

    q_205: {
      kp: "其 · 语气副词", type: "choice",
      stem: "下列句中「其」表示揣测语气的是？",
      options: [
        { k: "A", text: "其真无马邪？", note: "反诘，难道" },
        { k: "B", text: "其皆出于此乎？", note: "揣测，大概" },
        { k: "C", text: "余嘉其能行古道", note: "代词，他" },
        { k: "D", text: "安陵君其许寡人！", note: "祈使，加重语气" },
      ],
      correct: 1,
      fb: {
        good: "对。句末的「乎」和「其」配合，「大概都出于这个原因吧」——揣测。上周你把 A 的反诘当成揣测，这次分清了。",
        again: "又是语气这一关。看句末：B 配「乎」，语气是商量着的「大概……吧」；A 配「邪」，是顶回去的「难道……吗」。「其」自己不定语气，它跟句末词合谋。",
      },
      advice: { good: "good", again: "again" },
      hints: [
        "「其」表语气时，自己说了不算——看它和句末哪个词搭配。",
        "把四句各自读出声，哪一句的口气是「拿不准、商量着说」？",
        "A 的「邪」是反问收尾，B 的「乎」在这里是缓和的疑问——区别就在这。",
      ],
    },

    q_206: {
      kp: "判断句", type: "choice",
      stem: "下列属于判断句的是？",
      options: [
        { k: "A", text: "城北徐公，齐国之美丽者也", note: "……者也，判断" },
        { k: "B", text: "忌不自信", note: "否定句宾语前置" },
        { k: "C", text: "吾孰与徐公美", note: "比较疑问" },
        { k: "D", text: "皆以美于徐公", note: "状语后置" },
      ],
      correct: 0,
      fb: {
        good: "对。「……者也」连用是判断句最响亮的标志。昨天笔记里的四种标志（者也 / 也 / 乃·为 / 无标志），你至少抓住了第一种。",
        again: "判断句认标志：A 句末「……者也」连用，是教科书级的判断句。B 是你前天错过的否定句宾语前置——它还会回来找你。",
      },
      advice: { good: "good", again: "again" },
      hints: [
        "判断句的本质是「X 是 Y」。四个选项哪个在下定义？",
        "昨天笔记里记了四种标志，最常见的一种在句末。",
        "A 的句末两个字连读——想起来了吗？",
      ],
    },

    q_207: {
      kp: "否定句宾语前置", type: "choice",
      stem: "「不患人之不己知」中「不己知」的正常语序是？",
      options: [
        { k: "A", text: "己不知", note: "" },
        { k: "B", text: "不知己", note: "否定句中代词宾语前置" },
        { k: "C", text: "知不己", note: "" },
        { k: "D", text: "语序不变", note: "" },
      ],
      correct: 1,
      fb: {
        good: "对，「不知己」。规则只有一条：否定句 + 代词作宾语 → 宾语提到动词前。上午你栽在整句翻译里，单拎出语序你是会的——明天我把它放回完整句子里再验一次。",
        again: "还是语序。规则：否定词（不/未/莫）+ 代词宾语（己/之/我）时，宾语挪到动词前。「不己知」= 不 + 己(宾) + 知(动) → 还原成「不知己」。",
      },
      advice: { good: "good", again: "again" },
      hints: [
        "先标出这三个字里哪个是动词、哪个是代词。",
        "否定句里，代词宾语喜欢站到动词的前面去。",
        "把「己」放回「知」的后面读一遍。",
      ],
    },
  },

  // ── 今日卷 ──────────────────────────────────────────────────
  paper: {
    id: "pp_today", title: "今日成卷 · 文言虚词强化", count: 6, est: "约 10 分钟",
    source: "paper", created: "今 07:00",
    kps: ["而 · 用法", "以 · 用法", "于 · 用法", "宾语前置"],
    note: "卷内不给即时反馈 — 交卷后统一判分。",
    questions: [
      { id: "pq_1", kp: "而 · 转折", type: "choice",
        stem: "下列句中「而」表转折的是？",
        options: [
          { k: "A", text: "青，取之于蓝，而青于蓝" },
          { k: "B", text: "吾尝终日而思矣" },
          { k: "C", text: "蟹六跪而二螯" },
          { k: "D", text: "登高而招" },
        ], correct: 0,
        explain: "A「却比蓝更青」，转折。B 修饰（终日地想），C 并列（六跪与二螯），D 承接。" },
      { id: "pq_2", kp: "以 · 用法", type: "choice",
        stem: "「以」作连词、表目的（用来）的是？",
        options: [
          { k: "A", text: "愿以十五城请易璧" },
          { k: "B", text: "作《师说》以贻之" },
          { k: "C", text: "以勇气闻于诸侯" },
          { k: "D", text: "皆以美于徐公" },
        ], correct: 1,
        explain: "B「写《师说》来送给他」，目的连词。A 介词「拿」，C 介词「凭」，D 动词「认为」。" },
      { id: "pq_3", kp: "于 · 用法", type: "choice",
        stem: "「于」表被动的是？",
        options: [
          { k: "A", text: "战于长勺" },
          { k: "B", text: "苛政猛于虎" },
          { k: "C", text: "受制于人" },
          { k: "D", text: "于其身也，则耻师焉" },
        ], correct: 2,
        explain: "C「被人控制」，于=被。A 表处所（在），B 表比较（比），D 表对象（对于）。" },
      { id: "pq_4", kp: "而 · 修饰", type: "choice",
        stem: "「而」连接状语与中心词、表修饰的是？",
        options: [
          { k: "A", text: "人不知而不愠" },
          { k: "B", text: "温故而知新" },
          { k: "C", text: "面山而居" },
          { k: "D", text: "学而时习之" },
        ], correct: 2,
        explain: "C「面对着山居住」，「面山」修饰「居」。A 转折，B 承接（递进），D 并列/承接。" },
      { id: "pq_5", kp: "宾语前置", type: "choice",
        stem: "下列不属于宾语前置的是？",
        options: [
          { k: "A", text: "何陋之有" },
          { k: "B", text: "莫之能御也" },
          { k: "C", text: "微斯人，吾谁与归" },
          { k: "D", text: "甚矣，汝之不惠" },
        ], correct: 3,
        explain: "D 是主谓倒装（谓语「甚矣」前置），不是宾语前置。A 之字提宾，B 否定句代词宾前，C 疑问代词宾前。" },
      { id: "pq_6", kp: "翻译 · 综合", type: "text",
        stem: "翻译：",
        passage: "不患人之不己知，患不知人也。",
        passageSrc: "《论语 · 学而》",
        reference: "不担心别人不了解自己，只担心自己不了解别人。（之：取独 · 不己知：否定句宾语前置 · 也：判断/肯定语气）",
        cannedVerdict: "hard",
        explain: "「不己知」的语序你这次还原对了——上午的账算是结了。扣的是「患」字：两个「患」要译出同一个「担心」，你前后用了两个词。" },
    ],
    // 整卷小结模板 — 按错数挑选
    summaryByWrong: {
      0: "全对。虚词这张网今天没有漏的——「而」的四种连法、「以」的虚实、「于」的被动都接住了。明天我会把间隔拉长，别的科目见。",
      1: "5 + 1 部分对。整体是稳的：四个「而」「以」「于」的辨析全对，丢的都在细节上。错的那道我已经归因，变式排进了明天的流。",
      2: "对 4 错 2。虚词辨析的框架在，但「于」的被动和翻译的细节还松。两道错题都已归因，各生成一道变式，明天的流里见。",
      n: "今天这张卷错得有点多——不是坏事，正好把没织牢的线都暴露出来了。每道错题我都归了因、配了变式，明天的流会围绕它们重排。",
    },
  },

  // ── 卷架 · 历史卷（已完成，可复盘） ─────────────────────────
  shelf: {
    generating: { id: "pp_gen", title: "判断句式专题卷", count: 8, source: "on_demand",
      created: "今 09:42", genPct: 60, reason: "你点播的——「来份判断句专项」。" },
    done: [
      { id: "pp_31", title: "文言虚词 · 周测", count: 5, source: "paper", created: "昨日",
        completedAt: "昨 22:10", dur: "11m", right: 4, wrong: 1,
        kps: ["之 · 用法", "于 · 用法", "其 · 用法"],
        summary: "4/5。「之」的三种用法全对，丢在「其」的语气判断——反诘和揣测又混了。这道已归因（语气辨析依赖句末词的规律没建立），变式 q_205 已排进今天的流。",
        review: [
          { kp: "之 · 取独", stem: "「师道之不传也久矣」中「之」的用法", you: "主谓之间取消句子独立性", verdict: "good",
            fb: "对，干脆利落。" },
          { kp: "之 · 提宾", stem: "「句读之不知」的句式", you: "宾语前置，之为标志", verdict: "good",
            fb: "对。还原「不知句读」也写出来了，判定为完全掌握。" },
          { kp: "之 · 动词", stem: "「辍耕之垄上」中「之」的词义", you: "动词，到、往", verdict: "good",
            fb: "对。" },
          { kp: "其 · 语气", stem: "「其真无马邪」中「其」的语气", you: "揣测，大概", verdict: "again",
            fb: "反诘（难道），不是揣测。你把「邪」的顶撞语气漏了——「其」的语气要看句末词。",
            trace: { attributed: "e_512 · 归因：语气判断依赖句末词的规律未建立", variant: "q_205 · 变式已排入 6-10 的流" } },
          { kp: "于 · 比较", stem: "「苛政猛于虎」中「于」的用法", you: "介词，比", verdict: "good",
            fb: "对。" },
        ] },
      { id: "pp_28", title: "报任安书 · 段考真题", count: 4, source: "import", created: "3 天前",
        completedAt: "3 天前", dur: "16m", right: 2, wrong: 2,
        kps: ["报任安书", "判断句", "古今异义"],
        summary: "2/4。导入的这张真题暴露了两个洞：判断句的无标志形态、「恨」的古今异义。两道都已归因生成变式，其中判断句的自测今天流里就有（最后一项）。",
        review: [
          { kp: "判断句", stem: "「此人皆意有所郁结」的句式判断", you: "判断句", verdict: "again",
            fb: "不是。「皆」在这里是范围副词，整句是陈述句。你把「皆」误当成了判断标志「乃/为」一类。",
            trace: { attributed: "e_498 · 归因：判断句无标志形态掌握不全", variant: "q_206 · 新学自测已排入今日流" } },
          { kp: "古今异义", stem: "「恨私心有所不尽」中「恨」的词义", you: "怨恨", verdict: "again",
            fb: "古义是「遗憾」。古今异义里「恨/憾」这一对你是第二次混了。",
            trace: { attributed: "e_499 · 归因：恨-憾 古今义位混淆", variant: "变式生成中 · 明日流" } },
          { kp: "实词", stem: "「虽万被戮，岂有悔哉」中「被」的词义", you: "遭受", verdict: "good", fb: "对。" },
          { kp: "翻译", stem: "「人固有一死，或重于泰山，或轻于鸿毛」", you: "人本来都有一死，有的比泰山还重，有的比鸿毛还轻", verdict: "good",
            fb: "对，「固」「或」「于」三个点全在。" },
        ] },
    ],
  },
};

window.PFACE = PFACE;
window.PFACE_SRC = PFACE_SRC;
