// Loom · A7 成效趋势面 — 纵向 delta. 数据.
// 诊断答「现在的横截面」; 成效答「相对上次的 delta」—— 相对自己(n=1,无 cohort 基线)。
// 一切绝对值遵守 ⑥(带置信); 慢热期只信相对方向,不报精确百分点。
// 开放题(论述/翻译/鉴赏)客观成效信号无效 → 切到 owner 自评进步(一等输入,非次等兜底)。
// 退步如实呈现(认识论诚实,不只报喜)。

// band 序列(0 萌芽 1 成长 2 稳固 3 精熟)。series = 每周相对位置(慢热期只信排序)。
const COACH_A7 = {
  asOf: "近 6 周 · 相对你自己,非任何标准",

  // 客观成效轨(硬轨够热的科目/区域)
  objective: [
    {
      id: "k_xuci", area: "文言虚词", subject: "yuwen",
      dir: "up", series: [0, 0, 1, 1, 1, 2], conf: "中",
      delta: "从「萌芽」挪到了「成长」上沿", note: "相对 6 周前的你,虚词的相对位置稳定上行。绝对掌握仍低置信 —— 别太当真那个档,信这个方向。",
      evidence: ["e_3088", "e_3090", "e_3119"], lowConf: false,
    },
    {
      id: "k_judge", area: "句式 · 判断/取独", subject: "yuwen",
      dir: "hold", series: [1, 1, 1, 1, 1, 1], conf: "中",
      delta: "稳在「成长」,没动", note: "这块既没涨也没退 —— 不是坏事,是还没到该突破的点。要推一把可以排一组难一点的。",
      evidence: ["e_3104"], lowConf: false,
    },
    {
      id: "k_gujin", area: "古今异义", subject: "yuwen",
      dir: "down", series: [2, 2, 1, 1, 1, 0], conf: "低",
      delta: "从「稳固」滑回「成长」下沿", note: "这块在退 —— 我不粉饰:近两周连错拉低了它的相对位置。该补一轮复习了。证据偏薄,方向可信、幅度别太当真。",
      evidence: ["e_3098", "e_3131"], lowConf: true,
    },
  ],

  // 开放题退化 → 自评轨(客观成效信号无效的科目)
  openEnded: [
    {
      id: "essay", area: "作文 · 议论文", subject: "yuwen",
      reason: "论述/主观题的难度估计、judge 归因、自校准都软 —— 客观「掌握度趋势」基本无效。",
      selfSeries: [null, "持平", "进步", null, "进步", "进步"], // owner 自评打点
      lastSelf: "进步", selfNote: "这块的成效是你自评的 —— 我把你每次的感受按时间排开,不假装有精确数字。",
    },
    {
      id: "trans", area: "翻译 · 长句", subject: "yuwen",
      reason: "跨句翻译评分主观,自校准慢热,objective delta 不可信。",
      selfSeries: [null, null, "持平", "退步", null, null],
      lastSelf: "退步", selfNote: "你上次标了「退步」—— 留着它,不替你美化。要不要排一组长句专练？",
    },
  ],
};

window.COACH_A7 = COACH_A7;
