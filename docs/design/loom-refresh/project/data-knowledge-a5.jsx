// Loom · A5 知识探索面整轴 — 数据.
// 双层异构图(知识点 + 误区节点) · frontier 可供性 · 节点详情三维/迁移/CDM/IRT.
// 一切掌握/难度走离散档 + 置信区间 + 来源二态(hard 硬轨校准 / soft 软轨先验) —— 绝不裸数字(⑥)。

const KA5 = {
  // ── 误区节点(misconception)— 一等对象。「关于你大脑的信念」,不是知识点 ──
  // status: active(复发中) · fading(在消退) · retracted(已撤). source: hard|soft.
  misconceptions: [
    {
      id: "mc_zhi_de", label: "「之」≈ 万能「的」",
      belief: "你倾向把句中所有「之」都读成定语助词「的」",
      targets: ["k_xuci_zhi", "k_zhi_subj"], status: "active",
      source: "hard", conf: "中", seen: 3,
      evidence: ["e_3104", "e_3119", "e_3127"],
      note: "近 7 天 3 次判断句里复发 · 硬轨校准",
    },
    {
      id: "mc_gusuo", label: "「所」字结构 = 被动",
      belief: "你把「所」字结构误当成被动句标志",
      targets: ["k_gusuoye"], status: "fading",
      source: "soft", conf: "低", seen: 1,
      evidence: ["e_3150"],
      note: "仅 1 次 · 软轨先验 prior-echo · 低置信,可能判错",
    },
  ],

  // ── frontier — learnable_frontier:「你现在学得动的下一批」。propose 非 gating ──
  frontier: [
    { kid: "k_xuci_qi", reason: "「之」已稳到成长档,「其」是同族下一个,前置都满足了", propose: false, lowConf: false },
    { kid: "k_gusuoye", reason: "判断句基础够了,可以试这个特例 —— 但它证据少,我不太确定", propose: true, lowConf: true },
  ],

  // ── 节点详情扩展:B1 三维 / RT2 迁移 / CDM / IRT。键 = 知识点 id ──
  nodeExtra: {
    k_xuci_zhi: {
      tier: "firm",
      dims: {
        R:    { label: "记忆留存 R", band: 1, lo: 0, hi: 2, source: "hard", lowConf: false, note: "FSRS 可提取性 · 正在衰减,该复习了" },
        pL:   { label: "掌握诊断 p(L)", band: 2, lo: 1, hi: 2, source: "hard", lowConf: false, note: "9 次真实作答校准" },
        diff: { label: "题目难度 difficulty", band: 2, lo: 1, hi: 3, source: "hard", lowConf: false, note: "相对你当前水平偏难" },
      },
      transfer: [
        { from: "k_xuci_yu", amount: "成长", note: "同为虚词,「于」的稳固带来一部分语感", lowConf: true },
      ],
      cdm: [
        { attr: "辨「结构助词」", band: 2, source: "hard", lowConf: false },
        { attr: "辨「主谓取独」", band: 0, source: "hard", lowConf: false },
        { attr: "辨「代词」用法", band: 1, source: "soft", lowConf: true },
      ],
      irt: { aLabel: "区分度 · 高", bLabel: "难度 · 偏难", lowConf: false, note: "基于 9 次作答 · a≈1.4 b≈0.6" },
    },
    k_zhi_subj: {
      tier: "warming",
      coldNote: "这点真实作答仅 4 次 —— 下面的数字大半还是模型先验,不是你练出来的。慢热期只看相对排序,绝对值别太当真。",
      dims: {
        R:    { label: "记忆留存 R", band: 1, lo: 0, hi: 2, source: "soft", lowConf: true },
        pL:   { label: "掌握诊断 p(L)", band: 0, lo: 0, hi: 2, source: "soft", lowConf: true, note: "证据稀薄,软轨先验" },
        diff: { label: "题目难度 difficulty", band: 1, lo: 0, hi: 3, source: "soft", lowConf: true },
      },
      transfer: [],
      cdm: [],   // 证据不足 → 诚实留空
      irt: null, // 证据不足 → 诚实留空
    },
    k_gusuoye: {
      tier: "blind-ish",
      coldNote: "这点几乎没练过(evidence 3)。掌握档是冷启先验,我对它基本一无所知 —— 练一次就能开始 firm up。",
      dims: {
        R:    { label: "记忆留存 R", band: 0, lo: 0, hi: 2, source: "soft", lowConf: true },
        pL:   { label: "掌握诊断 p(L)", band: 0, lo: 0, hi: 2, source: "soft", lowConf: true },
        diff: { label: "题目难度 difficulty", band: 1, lo: 0, hi: 3, source: "soft", lowConf: true },
      },
      transfer: [],
      cdm: [],
      irt: null,
    },
  },
};

window.KA5 = KA5;
