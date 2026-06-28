// Loom · 成效趋势面 (A7) — 纵向 delta 读模型. demo 数据(多科目 / 合成根).
// ────────────────────────────────────────────────────────────────────────
// 诊断面(校准成熟度)答横截面:「这块现在 firm 吗、p(L) 多少、多可信」。
// 成效面(本面)答纵向:「相对上一次的我,涨/保持/退了吗;怎么走出来的」。
//
// 铁律:科目是派生视角不是结构 —— KC 的科目经 knowledge.domain → effective_domain
// 解析,绝不在 KC/事件上加 subject 列。本面把零散 experimental:mastery_progress 事件
// 按 attempt 序聚成 per-KC 时间序列,再沿派生轴卷到 per-subject。
//
// 合成根(多科森林):整图 = 各科目树 + 未归类孤儿 KC,挂在一个合成根下。
// 规模做法:首屏按科目卷起 + 只高亮「本期动了的」KC;逐 KC 轨迹是下钻态。
// ⑥硬约束:趋势 delta 绝不裸数字;方向用定性档;低置信显著降级;insufficient 一等公民。
// ────────────────────────────────────────────────────────────────────────

const EFF_DIR = {
  rising:       { label: "在涨",   glyph: "↑", tone: "good", ink: "var(--good-ink)",  soft: "var(--good-soft)",  line: "var(--good-line)",  base: "var(--good)" },
  holding:      { label: "持平",   glyph: "→", tone: "hold", ink: "var(--ink-3)",     soft: "var(--paper-sunk)", line: "var(--line)",       base: "var(--ink-4)" },
  falling:      { label: "在退",   glyph: "↓", tone: "down", ink: "var(--again-ink)",  soft: "var(--again-soft)", line: "var(--again-line)", base: "var(--again)" },
  insufficient: { label: "数据不足", glyph: "·", tone: "insf", ink: "var(--ink-4)",     soft: "var(--paper-sunk)", line: "var(--line)",       base: "var(--ink-5)" },
};

const EFF_EVIDENCE_FLOOR = 4;

const EFFICACY = {
  asOf: "采样于 今天 03:14 · 随作答更新",

  // ── 科目(派生轴的卷起单元) · 合成根下的子树。顺序 = 渲染序 ─────
  // whole: 冷启期题还堆在科目根上、子 KC 没抽出 → 只能给一条「科目整体」轨迹。
  subjects: [
    { id: "wenyan", name: "文言文", note: "整科卷起:虚词带头在抬,句式句读多数还慢热 —— 噪声被平均掉,比任一单条 KC 都稳。" },
    { id: "xiandai", name: "现代文阅读", note: "刚起步两周,多数 KC 证据薄。整科只敢给低置信,先别下结论。" },
    {
      id: "math", name: "数学", note: "题还堆在科目根上、子 KC 没抽出 —— 现在只能给一条「科目整体」轨迹,不是某个知识点。",
      whole: {
        points: [0.26, 0.31, 0.30, 0.38, 0.44, 0.49],
        direction: "rising", confidence: "low", span_evidence: 9,
        delta: "整科相对在抬 · 但还没分化出子 KC",
      },
    },
  ],

  // ── 轨迹型 KC(≥1 次作答)· 每条带 effective_domain(派生轴)──────
  series: [
    // ───────── 文言文 ─────────
    {
      id: "k_xuci_zhi", name: "之 · 用法", track: "虚词", effective_domain: "wenyan",
      evidence_count: 41, theta_hat: 0.74,
      points: [0.30, 0.37, 0.41, 0.46, 0.52, 0.58, 0.63, 0.71, 0.79, 0.86],
      direction: "rising", confidence: "firm", span_evidence: 41,
      source: { firm: 0.86, echo: 0.14 },
      delta: "从「萌芽」一路爬到「精熟」下沿",
      note: "相对 6 周前的你,「之」的相对位置稳定上行 —— 这条是你真练出来的(硬轨为主)。绝对档仍带置信,信这个方向。",
      events: ["e_3088", "e_3090", "e_3119", "e_3147"],
    },
    {
      id: "k_judge", name: "判断句", track: "句式", effective_domain: "wenyan",
      evidence_count: 28, theta_hat: 0.42,
      points: [0.74, 0.77, 0.75, 0.78, 0.76, 0.80, 0.79, 0.81],
      direction: "holding", confidence: "firm", span_evidence: 28,
      source: { firm: 0.83, echo: 0.17 },
      delta: "稳在「稳固」,六周没怎么动",
      note: "既没涨也没退 —— 不是坏事,是还没到该突破的点。要推一把,可以排一组难一点的。",
      events: ["e_3104", "e_3133"],
    },
    {
      id: "k_gujin", name: "古今异义", track: "词义", effective_domain: "wenyan",
      evidence_count: 22, theta_hat: 0.18,
      points: [0.66, 0.74, 0.80, 0.82, 0.79, 0.72, 0.65, 0.60],
      direction: "falling", confidence: "mid", span_evidence: 22,
      source: { firm: 0.78, echo: 0.22 },
      delta: "从「稳固」顶滑回「成长」中段",
      note: "这块在退,我不粉饰:近三周连错把它的相对位置拉了下来。横截面现在读 p(L)≈0.60 看着还行 —— 但它是从 0.82 滑下来的,方向比那个数字重要。该补一轮复习。",
      events: ["e_3098", "e_3131", "e_3140"],
      crossNote: "校准面把它标 firm · p≈0.60;只有这条纵向轨能告诉你这 0.60 是「跌下来的」。",
    },
    {
      id: "k_tongjia", name: "通假字", track: "字词", effective_domain: "wenyan",
      evidence_count: 17, theta_hat: 0.31,
      points: [0.40, 0.44, 0.43, 0.49, 0.53, 0.57, 0.62],
      direction: "rising", confidence: "mid", span_evidence: 17,
      source: { firm: 0.71, echo: 0.29 },
      delta: "「成长」里稳步往上,还没到顶",
      note: "缓慢但持续地涨。幅度别当真精确值,方向可信 —— 再练一轮大概能进「稳固」。",
      events: ["e_3071", "e_3115"],
    },
    {
      id: "k_huoyong", name: "词类活用", track: "语法", effective_domain: "wenyan",
      evidence_count: 3, theta_hat: -0.08,
      points: [0.33, 0.47, 0.52],
      direction: "rising", confidence: "low", span_evidence: 3,
      source: { firm: 0.38, echo: 0.62 },
      delta: "看着在涨 —— 但只 3 次,带宽很宽",
      note: "这条上扬很可能只是噪声:才 3 次作答,而且一多半是软轨先验的回声、不是你练出来的。别当真这条线,再练几次才看得准。",
      events: ["e_3122"],
    },
    {
      id: "k_xuci_er", name: "而 · 用法", track: "虚词", effective_domain: "wenyan",
      evidence_count: 3, theta_hat: -0.12,
      points: [0.40, 0.43, 0.42],
      direction: "holding", confidence: "low", span_evidence: 3,
      source: { firm: 0.45, echo: 0.55 },
      delta: "几乎没动 · 证据太薄说不准",
      note: "三个点基本平 —— 但带宽盖过了这点起伏,现在断「持平」也勉强。跟着「之」一起练,语感可能会带一带。",
      events: ["e_3126"],
    },
    {
      id: "k_binyu", name: "宾语前置", track: "句式", effective_domain: "wenyan",
      evidence_count: 2, theta_hat: -0.20,
      points: [0.31, 0.48],
      direction: "insufficient", confidence: "low", span_evidence: 2,
      source: { firm: 0.40, echo: 0.60 },
      delta: "只两点,连方向都不该断",
      note: "两次作答,p 从 0.31 到 0.48 —— 看着像涨,但两点连不成趋势。这是「数据不足」,不是上涨也不是退步。再练一两次就开始看得出走向。",
      events: ["e_3129"],
    },
    {
      id: "k_xuci_yi", name: "以 · 用法", track: "虚词", effective_domain: "wenyan",
      evidence_count: 2, theta_hat: -0.28,
      points: [0.35, 0.41],
      direction: "insufficient", confidence: "low", span_evidence: 2,
      source: { firm: 0.42, echo: 0.58 },
      delta: "只两点 · 方向待定",
      note: "和「而」一样还在冷启边上。两点之间的差全在噪声里,先不报方向。",
      events: ["e_3135"],
    },
    {
      id: "k_beidong", name: "被动句", track: "句式", effective_domain: "wenyan",
      evidence_count: 1, theta_hat: -0.35,
      points: [0.38],
      direction: "insufficient", confidence: "low", span_evidence: 1,
      source: { firm: 0.50, echo: 0.50 },
      delta: "只一次作答 · 算不出 delta",
      note: "单点 —— 首作答前没有 prior Δ,delta 无从算起。这是一等的「数据不足」态,不是平线。练第二次,这里才长出第一段轨迹。",
      events: ["e_3141"],
    },
    // ───────── 现代文阅读 ─────────
    {
      id: "x_lundian", name: "论点提取", track: "议论文", effective_domain: "xiandai",
      evidence_count: 12, theta_hat: 0.22,
      points: [0.38, 0.44, 0.49, 0.55, 0.58, 0.63],
      direction: "rising", confidence: "mid", span_evidence: 12,
      source: { firm: 0.66, echo: 0.34 },
      delta: "稳步上行 · 这科里走得最实的一条",
      note: "现代文里证据相对够的一条,方向可信、幅度别当真。是这科卷起能从「持平」往「涨」拉的主要力量。",
      events: ["e_3201", "e_3214"],
    },
    {
      id: "x_zhuzhi", name: "主旨概括", track: "记叙文", effective_domain: "xiandai",
      evidence_count: 6, theta_hat: -0.05,
      points: [0.55, 0.52, 0.48, 0.45, 0.43],
      direction: "falling", confidence: "low", span_evidence: 6,
      source: { firm: 0.52, echo: 0.48 },
      delta: "缓慢下滑 · 证据薄,方向先存疑",
      note: "看着在退,但只 6 次、置信低 —— 标低置信:可能是真退,也可能是这几篇偏难。别当成确定的下滑,排一组中等难度再看。",
      events: ["e_3219"],
    },
    {
      id: "x_cishang", name: "词句赏析", track: "散文", effective_domain: "xiandai",
      evidence_count: 4, theta_hat: -0.10,
      points: [0.41, 0.44, 0.42, 0.45],
      direction: "holding", confidence: "low", span_evidence: 4,
      source: { firm: 0.48, echo: 0.52 },
      delta: "基本平 · 还在慢热",
      note: "四个点几乎贴平,带宽盖过起伏。现在只能说「没看出方向」,不是真稳。",
      events: ["e_3223"],
    },
    {
      id: "x_jiegou", name: "段落结构", track: "议论文", effective_domain: "xiandai",
      evidence_count: 2, theta_hat: -0.30,
      points: [0.33, 0.40],
      direction: "insufficient", confidence: "low", span_evidence: 2,
      source: { firm: 0.40, echo: 0.60 },
      delta: "只两点 · 方向待定",
      note: "刚开练,两点连不成趋势。一等「数据不足」,不报方向。",
      events: ["e_3231"],
    },
    // ───────── 未归类(孤儿 KC,没挂到任何科目 · effective_domain=null)──
    {
      id: "u_mosie", name: "名句默写", track: null, effective_domain: null,
      evidence_count: 5, theta_hat: 0.10,
      points: [0.46, 0.50, 0.55, 0.58, 0.62],
      direction: "rising", confidence: "low", span_evidence: 5,
      source: { firm: 0.60, echo: 0.40 },
      delta: "在涨 · 但没挂到任何科目",
      note: "这条还没被归到哪一科(domain 空)—— 显式留在「未归类」,不替你硬塞进文言或现代文。",
      events: ["e_3260"],
    },
    {
      id: "u_changshi", name: "文学常识", track: null, effective_domain: null,
      evidence_count: 2, theta_hat: -0.22,
      points: [0.34, 0.39],
      direction: "insufficient", confidence: "low", span_evidence: 2,
      source: { firm: 0.45, echo: 0.55 },
      delta: "只两点 · 方向待定 · 未归类",
      note: "孤儿 KC + 证据不足,双重「先别下结论」。",
      events: ["e_3266"],
    },
  ],

  // ── 盲区 KC(0 次作答,没有任何轨迹)· 带 effective_domain ──────────
  blind: [
    { id: "k_shenglue", name: "省略句",   track: "句式", effective_domain: "wenyan" },
    { id: "k_shidong",  name: "使动用法", track: "语法", effective_domain: "wenyan" },
    { id: "k_huwen",    name: "互文",     track: "修辞", effective_domain: "wenyan" },
    { id: "k_zhuangyu", name: "状语后置", track: null,   effective_domain: "wenyan" },
    { id: "k_pianyi",   name: "偏义复词", track: null,   effective_domain: "wenyan" },
    { id: "x_yinyu",    name: "修辞 · 比喻", track: "散文", effective_domain: "xiandai" },
    { id: "x_renwu",    name: "人物形象", track: "记叙文", effective_domain: "xiandai" },
  ],

  // ── 跨 KC 迁移:相邻 prerequisite 边上的 KC 同期抬升(科目内子结构)──
  transfer: {
    clusters: [
      {
        id: "xuci", label: "虚词族", kind: "lift",
        nodes: [
          { id: "k_xuci_zhi", name: "之", dir: "rising", role: "source", conf: "firm" },
          { id: "k_xuci_er",  name: "而", dir: "rising", role: "lifted", conf: "low" },
          { id: "k_xuci_yi",  name: "以", dir: "rising", role: "lifted", conf: "low" },
        ],
        edges: [["k_xuci_zhi", "k_xuci_er"], ["k_xuci_zhi", "k_xuci_yi"]],
        note: "在「之」上练出的虚词语感,同一窗口里「而」「以」也跟着抬了一点 —— 相邻一起动,像真迁移,不是只记住了某道题。",
        caveat: "但「而」「以」本身才 2–3 次,这条迁移信号也只能算低置信:别当成定论,当成「值得顺着练下去」。",
      },
      {
        id: "jushi", label: "句式族", kind: "none",
        nodes: [
          { id: "k_judge",   name: "判断句", dir: "holding", role: "source", conf: "firm" },
          { id: "k_beidong", name: "被动句", dir: "insufficient", role: "flat", conf: "low" },
          { id: "k_binyu",   name: "宾语前置", dir: "insufficient", role: "flat", conf: "low" },
        ],
        edges: [["k_judge", "k_beidong"], ["k_judge", "k_binyu"]],
        note: "判断句稳住了,但相邻的被动句 / 宾语前置没跟着抬 —— 还没看到迁移。如实说:稳一个点 ≠ 这一族都通了。",
        caveat: null,
      },
    ],
    isolated: {
      id: "k_gujin", name: "古今异义", dir: "falling",
      note: "古今异义在退,但它在词义轴上相对孤立,没有连锁下滑 —— 像是这块本身松了,不是系统性问题。",
    },
  },

  // ── 开放题为主科目:客观三量退化 → owner 自评轨 ──────────────────
  openEnded: [
    {
      id: "essay", name: "作文 · 议论文", subject: "议论文",
      reason: "论述题的难度估计 / judge 归因 / 自校准都软 —— 客观「掌握度趋势」基本无效。",
      selfSeries: [null, "持平", "进步", null, "进步", "进步"],
      lastSelf: "进步",
      selfNote: "这块的成效是你自评的 —— 我把你每次的感受按时间排开,不假装有精确数字,也不替系统补一条算不出的曲线。",
    },
    {
      id: "trans", name: "翻译 · 长句", subject: "翻译",
      reason: "跨句翻译评分主观,自校准慢热,objective delta 不可信。",
      selfSeries: [null, null, "持平", "退步", null, null],
      lastSelf: "退步",
      selfNote: "你上次标了「退步」—— 留着它,不替你美化。要不要排一组长句专练?",
    },
  ],
};

// 派生:整图(合成根)方向分布 —— 跨所有科目 KC,只读,绝不写回。
EFFICACY.aggregate = (() => {
  const s = EFFICACY.series;
  const byDir = { rising: 0, holding: 0, falling: 0, insufficient: 0 };
  let firm = 0, tender = 0;
  s.forEach((k) => { byDir[k.direction]++; (k.confidence === "firm" ? firm++ : tender++); });
  return { total: s.length, blind: EFFICACY.blind.length, byDir, firm, tender };
})();

window.EFFICACY = EFFICACY;
window.EFF_DIR = EFF_DIR;
window.EFF_EVIDENCE_FLOOR = EFF_EVIDENCE_FLOOR;
