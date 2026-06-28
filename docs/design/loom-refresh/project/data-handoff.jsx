// Loom · A1 交班缕 (handoff thread) mock data.
// 「昨夜 D14 后台 job(dreaming/coach)为你想了什么」的展示落点。
// 每条 = 我帮你想了什么(gist) + 一句理由(reason) + 一个可点的下一步(next),
// 附 可追溯(trace) · 可否决(dismissable) · 渐进披露的叙事(narrative)。
// mastery 引用一律走离散档 + 置信区间 + 来源二态(hard 硬轨校准 / soft 软轨先验),
// 绝不裸数字(⑥ 硬约束)。band: 0 萌芽 · 1 成长 · 2 稳固 · 3 精熟。

const HANDOFF = {
  // 昨夜这趟后台运行的元信息(交班缕的「来源」)
  run: {
    posture: "dreaming",
    label: "夜链 · dreaming",
    started: "昨夜 02:40",
    finished: "今晨 03:14",
    dur: "34 分钟",
    cost: 0.067,
    events: 128,          // 复盘时纳入考量的 event 数
    ready: 4, total: 4,   // 已就绪 / 应产出 —— error 态下 ready < total
  },

  threads: [
    {
      id: "ho_reorder",
      agent: "dreaming",
      kind: "reorder",
      gist: "把「之」的复习提到了今天最前",
      reason: "你最近三次都卡在判断句里的「之」，趁还记得错在哪，纠回来比隔几天省力。",
      mastery: { node: "之 · 判断句用法", band: 1, lo: 1, hi: 2, source: "hard", lowConf: false },
      next: { label: "去复习「之」", route: "review" },
      milestone: false,
      narrative:
        "昨夜我把过去 7 天你在「之」上的每一次作答都重新看了一遍 —— 三次判断句、两次主谓取独，错因都指向同一处：在「者…也」结构里，你会把「之」误读成定语助词。" +
        "所以我没按 FSRS 原定的间隔排，而是把它提到今天最前。趁着错因还新鲜纠回来，比等它滑回「不会」再补省力得多。",
      trace: { posture: "dreaming", events: ["e_3104", "e_3119", "e_3127"], when: "今晨 03:14", note: "基于 3 次 attempt:failure 的共同错因 · 硬轨校准" },
    },
    {
      id: "ho_drill",
      agent: "dreaming",
      kind: "drill",
      gist: "备了 4 道「主谓取独」由浅入深的题",
      reason: "你在这点连错 2 次，我挑了梯度刚好接住你的题，没直接上难的。",
      mastery: { node: "主谓取独", band: 0, lo: 0, hi: 1, source: "soft", lowConf: true },
      next: { label: "开始这组练习", route: "practice" },
      milestone: false,
      narrative:
        "这点你真实作答只有 3 次，我对它的难度估计还很虚 —— 大半是模型先验，不是你练出来的。" +
        "所以这 4 道我特意排成由浅入深：第一道几乎是送分，只为让你重新摸到「取消句子独立性」的手感；后面三道才逐格加码。" +
        "练完这组，我对你这点的判断就能从『猜』变成『有据』。",
      trace: { posture: "dreaming", events: ["e_3140", "e_3141"], when: "今晨 03:12", note: "软轨先验 prior-echo · 真实作答仅 3 次,难度低置信" },
    },
    {
      id: "ho_edge",
      agent: "dreaming",
      kind: "edge",
      gist: "在图谱里把「词类活用」连到了「使动用法」",
      reason: "你两道题的错因是同一个 —— 把使动当成了普通活用。连上后能一起复习。",
      isChange: true,
      next: { label: "看这条改动", route: "knowledge" },
      milestone: false,
      narrative:
        "我注意到你在「使动用法」上的两次错，根子不在使动本身，而在你把它和「词类活用」当成了两件没关系的事。" +
        "其实前者是后者的一个特例。我在图谱里给它们连了一条 prerequisite 边 —— 这只是一条提议，写进了草稿，你点开能看见净 diff，留下或撤掉都行。",
      trace: { posture: "dreaming", events: ["e_3150"], when: "今晨 03:13", note: "knowledge_edge 提议 · 已写入草稿,待确认 · 可一键撤销" },
    },
    {
      id: "ho_recap",
      agent: "coach",
      kind: "recap",
      gist: "复盘了你这一周的虚词",
      reason: "相对位置在往上走；但绝对掌握还低置信，我还不敢拍一个数字。",
      mastery: { node: "虚词 · 整体", band: 1, lo: 0, hi: 2, source: "soft", lowConf: true },
      next: { label: "看成效趋势", route: "coach" },
      milestone: true,
      narrative:
        "这一周你做了 41 次和虚词相关的作答 —— 比上周多了 12 次。把它们按时间排开，你在「之」「其」上的相对次序确实往「可信」那一端挪了。" +
        "但我得诚实说：这只是『相对上周的你』在进步。绝对掌握度我给不出一个敢拍的数字 —— 证据还不够，n=1 的慢热期就是这样。再练一周，我能说得更准。",
      trace: { posture: "coach", events: ["e_3088", "e_3090"], when: "今晨 03:09", note: "coach_weekly · 慢热期只信相对排序(adr-0035)" },
    },
  ],
};

window.HANDOFF = HANDOFF;
