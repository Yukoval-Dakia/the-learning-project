// Loom · cold-start first-session data (onboarding flow).
// Shapes mirror the real backend contracts in the handoff (2026-06-21).
// Exported to window as OB.

const OB = {
  // ── ① Welcome · KNOWN_SUBJECT_IDS + displayName ──────────────
  subjects: [
    { id: "wenyan",  name: "文言文" },
    { id: "math",    name: "数学" },
    { id: "physics", name: "物理" },
  ],
  // 自述（轻 · 不落库，仅引导）
  stages: ["初中", "高中", "大学", "自定义"],
  // 可选偏好倾向
  leanings: [
    { id: "wenyan",  label: "文言文" },
    { id: "math",    label: "数学" },
    { id: "physics", label: "物理" },
    { id: "english", label: "英语" },
  ],
  paces: [
    { id: "light",  label: "轻", sub: "≈10 分钟 / 天" },
    { id: "medium", label: "适中", sub: "≈20 分钟 / 天" },
    { id: "dense",  label: "密集", sub: "≈40 分钟 / 天" },
  ],

  // POST /api/goals → { id, title, subjectId, scopeKnowledgeIds, status:'active' }
  goalSample: {
    id: "g_a91f",
    title: "把高中文言文虚词和句式啃下来",
    subjectId: "wenyan",
    scopeKnowledgeIds: ["k_xuci_zhi","k_xuci_qi","k_shidong","k_yidong","k_gujin","k_translate","k_reading","k_duyin"],
    status: "active",
  },

  // ── ②a 上传 · ingestion 抽题（SSE 进度逐条）─────────────────
  ingestSteps: [
    { label: "上传原件 · 错题本 3 页", meta: "1.2 MB" },
    { label: "OCR 逐页识别", meta: "3/3 页" },
    { label: "VLM 兜底校正 · 切分题块", meta: "切出 8 块" },
    { label: "LLM 归类学科 · 挂知识点 · 补参考答案", meta: "8 题就绪" },
  ],
  // 抽出题（SSE 终止后 GET /blocks）
  ingestBlocks: [
    { kind: "single_choice", k: "虚词·之", text: "下列各句中「之」的用法判断" },
    { kind: "translation",   k: "句子翻译", text: "苟全性命于乱世，不求闻达于诸侯" },
    { kind: "short_answer",  k: "通假·读音", text: "「卒相与欢」中「卒」的读音与义" },
    { kind: "reading",       k: "文意理解", text: "《陋室铭》作者借此表达的志趣" },
    { kind: "multiple_choice", k: "使动用法", text: "以下属于使动用法的有" },
    { kind: "single_choice", k: "古今异义", text: "「妻子」古今异义辨析" },
    { kind: "true_false",    k: "虚词·其", text: "「其」在此句作语气副词" },
    { kind: "essay",         k: "意动用法", text: "简述使动与意动的区别" },
  ],

  // ── ③ Placement · 每科 8 题 cap ─────────────────────────────
  // question.kind ∈ true_false / single_choice / multiple_choice /
  //   short_answer / translation / reading / essay
  placementCap: 8,
  placementQs: [
    {
      questionId: "q_pl_01", kind: "true_false", scoreKind: "binary",
      kp: "虚词·之", k: "k_xuci_zhi",
      prompt_md: "判断正误：在「臣**之**壮也，犹不如人」中，「之」用于主谓之间，**取消句子独立性**。",
      options: [{ k: "T", text: "正确" }, { k: "F", text: "错误" }],
    },
    {
      questionId: "q_pl_02", kind: "single_choice", scoreKind: "binary",
      kp: "虚词·其", k: "k_xuci_qi",
      prompt_md: "下列各句中，「其」的用法与其他三项**不同**的一项是：",
      options: [
        { k: "A", text: "**其**闻道也固先乎吾" },
        { k: "B", text: "**其**皆出于此乎" },
        { k: "C", text: "吾**其**还也" },
        { k: "D", text: "**其**孰能讥之乎" },
      ],
    },
    {
      questionId: "q_pl_03", kind: "multiple_choice", scoreKind: "partial",
      kp: "使动用法", k: "k_shidong",
      prompt_md: "下列句子中，加点词属于**使动用法**的有（多选）：",
      options: [
        { k: "A", text: "**项伯杀人，臣活之**" },
        { k: "B", text: "**先破秦入咸阳者王之**" },
        { k: "C", text: "**渔人甚异之**" },
        { k: "D", text: "**外连衡而斗诸侯**" },
      ],
    },
    {
      questionId: "q_pl_04", kind: "short_answer", scoreKind: "judge",
      kp: "通假·读音", k: "k_duyin",
      prompt_md: "解释「卒相与欢，为刎颈之交」中「**卒**」的**读音**与**含义**。",
    },
    {
      questionId: "q_pl_05", kind: "translation", scoreKind: "judge",
      kp: "句子翻译", k: "k_translate",
      prompt_md: "把下面的句子译成现代汉语：\n\n「苟全性命于乱世，不求闻达于诸侯。」",
    },
    {
      questionId: "q_pl_06", kind: "reading", scoreKind: "judge",
      kp: "文意理解", k: "k_reading",
      prompt_md: "阅读后回答：文段中，作者借「斯是陋室，惟吾德馨」表达了怎样的**人生态度**？",
      passage: "山不在高，有仙则名。水不在深，有龙则灵。斯是陋室，惟吾德馨。苔痕上阶绿，草色入帘青。谈笑有鸿儒，往来无白丁。",
      passageSrc: "《陋室铭》· 刘禹锡",
    },
    {
      questionId: "q_pl_07", kind: "single_choice", scoreKind: "binary",
      kp: "古今异义", k: "k_gujin",
      prompt_md: "「率**妻子**邑人来此绝境」中「妻子」的古义是：",
      options: [
        { k: "A", text: "妻子（配偶）" },
        { k: "B", text: "妻子和儿女" },
        { k: "C", text: "家中女眷" },
        { k: "D", text: "妻子的娘家人" },
      ],
    },
    {
      questionId: "q_pl_08", kind: "essay", scoreKind: "judge",
      kp: "意动用法", k: "k_yidong",
      prompt_md: "用两三句话，**简述**「使动用法」与「意动用法」的核心区别，各举一例。",
    },
  ],

  // ── ④ 起始档案 · per-KC mastery_state ───────────────────────
  // 展示的每个数字(p̂ 点 / lo·hi 带 / SE)都从 KC 的原始证据账本 ledger 重导:
  //   ledger = { s 答对, f 答错, b 难度锚→先验均值 }  · 先验强度 κ=2 · 带半宽 z=1.5
  //   Beta(κ·b + s, κ·(1−b) + f) → 均值=p̂=θ̂ · SE=√var · lo/hi=clamp(均值±z·SE)
  // 这套数学与服务端逐位一致(见 recompute-profile.jsx · recomputeKC),
  // 所以「重算」能在本设备离线重导并核对是否逐位相等。
  // 旧的展示字段保留作回退;真正显示的数由 recomputeKC(ledger) 派生。
  profileNarrative:
    "基于你刚答的这组题，初步看到你在**虚词**上手感不错，**使动 / 意动**这类活用还需要再练几轮确认 —— 现在这份判断证据还少，会随你练习一起变准。",
  profileKCs: [
    { id: "k_xuci_zhi", name: "虚词 · 之", track: "虚词", ledger: { s: 3, f: 1, b: 0.55 },
      theta_hat: 0.78, theta_precision: 2.1, p_l: 0.70,
      mastery_lo: 0.52, mastery_hi: 0.86, low_confidence: false, evidence_count: 3 },
    { id: "k_gujin", name: "古今异义", track: "词义", ledger: { s: 2, f: 1, b: 0.50 },
      theta_hat: 0.66, theta_precision: 1.35, p_l: 0.61,
      mastery_lo: 0.34, mastery_hi: 0.84, low_confidence: true, evidence_count: 2 },
    { id: "k_xuci_qi", name: "虚词 · 其", track: "虚词", ledger: { s: 1, f: 1, b: 0.50 },
      theta_hat: 0.58, theta_precision: 1.4, p_l: 0.56,
      mastery_lo: 0.30, mastery_hi: 0.80, low_confidence: true, evidence_count: 2 },
    { id: "k_reading", name: "文意理解", track: "阅读", ledger: { s: 1, f: 1, b: 0.48 },
      theta_hat: 0.52, theta_precision: 1.05, p_l: 0.50,
      mastery_lo: 0.22, mastery_hi: 0.79, low_confidence: true, evidence_count: 1 },
    { id: "k_duyin", name: "通假 · 读音", track: "字音", ledger: { s: 0, f: 1, b: 0.45 },
      theta_hat: 0.44, theta_precision: 1.1, p_l: 0.45,
      mastery_lo: 0.18, mastery_hi: 0.73, low_confidence: true, evidence_count: 1 },
    { id: "k_shidong", name: "使动用法", track: "活用", ledger: { s: 0, f: 2, b: 0.40 },
      theta_hat: 0.36, theta_precision: 1.2, p_l: 0.40,
      mastery_lo: 0.15, mastery_hi: 0.67, low_confidence: true, evidence_count: 2 },
    { id: "k_translate", name: "句子翻译", track: "翻译", ledger: { s: 0, f: 1, b: 0.40 },
      theta_hat: 0.33, theta_precision: 1.02, p_l: 0.38,
      mastery_lo: 0.12, mastery_hi: 0.66, low_confidence: true, evidence_count: 1 },
    { id: "k_yidong", name: "意动用法", track: "活用", ledger: { s: 0, f: 0, b: 0.40 },
      theta_hat: null, theta_precision: 1.0, p_l: null,
      mastery_lo: null, mastery_hi: null, low_confidence: true, evidence_count: 0 },
  ],
};

window.OB = OB;
