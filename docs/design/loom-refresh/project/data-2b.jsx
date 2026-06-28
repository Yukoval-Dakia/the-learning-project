// Loom · round-2b data — extends DATA. Consumes existing backend fields.
// Flags for shapes to confirm are marked  // ⚑shape  inline.
// Domain: 文言文 (之 / 虚词 / 判断句 / 史记选读), consistent with 2a.

// ── block-tree note documents (shared by note-editor; G) ─────────────
// block: { id, type, text?, items?, lang?, checked?, verify?, link? }
// types: h | p | wenyan | latex | code | quiz | callout | divider | list
const NOTE_ZHI = [
  { id: "b1", type: "h", text: "「之」的四类核心用法" },
  { id: "b2", type: "p", text: "「之」是文言中最高频的虚词之一，按语法功能可分为下列四类。掌握的关键在于辨析「主谓之间」与「定语助词」。" },
  { id: "b3", type: "callout", tone: "info", text: "辨析口诀：主谓之间取消独立性，定中之间译作「的」。" },
  { id: "b4", type: "wenyan", text: "① 师道之不传也久矣。\n　 —— 用于主谓之间，取消句子独立性。" },
  { id: "b5", type: "wenyan", text: "② 古之学者必有师。\n　 —— 结构助词，定语标志，译「的」。", link: { kind: "knowledge", tag: "k_xuci_zhi_attr", label: "之·定语助词" } },
  { id: "b6", type: "latex", text: "P(\\text{recall}) = e^{-t/S}" },
  { id: "b7", type: "code", lang: "sql", text: "select * from event\nwhere subject_kind='knowledge'\n  and payload->>'tag'='k_xuci_zhi';" },
  { id: "b8", type: "quiz", text: "「水陆草木之花」中「之」的用法？", answer: "结构助词「的」（定中之间）", verify: "verified" },
  { id: "b9", type: "p", text: "下一步：对比「其」的代词用法，避免在主谓结构中误判。", link: { kind: "knowledge", tag: "k_xuci_qi", label: "其·用法" } },
];
const NOTE_ITEM = [
  { id: "a1", type: "h", text: "文言虚词系统 · 学习蓝图" },
  { id: "a2", type: "p", text: "本学习项聚合「之 / 其 / 于 / 而」四个高频虚词，目标是在阅读中即时辨析其语法功能。" },
  { id: "a3", type: "callout", tone: "coral", text: "AI 生成 · 已校验：拆解为 1 个 hub + 3 个 atomic 子项。", verify: "verified" },
  { id: "a4", type: "quiz", text: "「臣之壮也，犹不如人」——「之」？", answer: "主谓之间，取消独立性", verify: "draft" },
];

Object.assign(DATA, {
  // ── NOTES (first-class) — knowledge_id is a LABEL on a note, many-to-many.
  // A note can carry several knowledge labels; a knowledge node can have 0..n notes.
  notes: [
    { id: "note_zhi", title: "「之」的四类核心用法", blocks: NOTE_ZHI,
      labels: ["k_xuci_zhi", "k_zhi_subj"], updated: "昨日", verify: "verified", from: "user",
      versions: [
        { v: "v4", t: "昨日", actor: "user", note: "补「主谓取独」对比段" },
        { v: "v3", t: "4 天前", actor: "agent", note: "AI 校验通过，标记 verified" },
        { v: "v2", t: "上周", actor: "user", note: "加入两条文言例句" },
        { v: "v1", t: "2 周前", actor: "user", note: "初稿" },
      ] },
    { id: "note_xuci", title: "文言虚词系统 · 学习蓝图", blocks: NOTE_ITEM,
      labels: ["k_xuci", "k_xuci_zhi", "k_xuci_qi"], updated: "3 天前", verify: "verified", from: "dreaming",
      versions: [
        { v: "v2", t: "3 天前", actor: "agent", note: "Dreaming agent 重排 atomic 列表" },
        { v: "v1", t: "上周", actor: "agent", note: "由学习意图自动生成" },
      ] },
    { id: "note_judge", title: "判断句式 · 标志词表", blocks: [
        { id: "j1", type: "h", text: "判断句的五类标志" },
        { id: "j2", type: "p", text: "文言判断句多不用「是」，靠标志词或语序成句。" },
        { id: "j3", type: "wenyan", text: "者…也 / …也 / 乃 / 即 / 固…所…也" },
        { id: "j4", type: "quiz", text: "「臣本布衣」属哪类判断句？", answer: "无标志 · 靠语义判断", verify: "draft" },
      ], labels: ["k_judge", "k_gusuoye"], updated: "5 天前", verify: "draft", from: "user",
      versions: [{ v: "v1", t: "5 天前", actor: "user", note: "初稿" }] },
  ],

  // ── KNOWLEDGE (D) — rebuilt; nodes carry mastery/evidence/decay (⚑shape #1) ──
  knowledge: [
    { id: "k_wenyan", tag: "k_wenyan", title: "文言文", parent: null, depth: 0, mastery: 70, evidence: 41, decay: "stable", mistakes: 0, mesh: 2, kind: "hub" },
    { id: "k_xuci",   tag: "k_xuci",   title: "文言虚词", parent: "k_wenyan", depth: 1, mastery: 58, evidence: 22, decay: "slow", mistakes: 3, mesh: 4, kind: "hub" },
    { id: "k_xuci_zhi", tag: "k_xuci_zhi", title: "之 · 用法", parent: "k_xuci", depth: 2, mastery: 62, evidence: 9, decay: "decaying", mistakes: 3, mesh: 4, kind: "atomic" },
    { id: "k_xuci_zhi_attr", tag: "k_xuci_zhi_attr", title: "之 · 定语助词", parent: "k_xuci_zhi", depth: 3, mastery: 74, evidence: 5, decay: "stable", mistakes: 1, mesh: 2, kind: "atomic" },
    { id: "k_zhi_subj", tag: "k_zhi_subj", title: "主谓取独", parent: "k_xuci_zhi", depth: 3, mastery: 49, evidence: 4, decay: "decaying", mistakes: 2, mesh: 2, kind: "atomic" },
    { id: "k_xuci_qi", tag: "k_xuci_qi", title: "其 · 用法", parent: "k_xuci", depth: 2, mastery: 55, evidence: 6, decay: "slow", mistakes: 1, mesh: 2, kind: "atomic" },
    { id: "k_xuci_yu", tag: "k_xuci_yu", title: "于 · 用法", parent: "k_xuci", depth: 2, mastery: 67, evidence: 7, decay: "stable", mistakes: 0, mesh: 1, kind: "atomic" },
    { id: "k_judge",  tag: "k_judge",  title: "判断句式", parent: "k_wenyan", depth: 1, mastery: 64, evidence: 11, decay: "slow", mistakes: 1, mesh: 3, kind: "hub" },
    { id: "k_gusuoye", tag: "k_gusuoye", title: "固…所…也", parent: "k_judge", depth: 2, mastery: 41, evidence: 3, decay: "decaying", mistakes: 1, mesh: 1, kind: "atomic" },
  ],
  // typed mesh edges — 5 relations, directional where meaningful
  knowledgeEdges: [
    { rel: "prerequisite",   a: "k_xuci",     b: "k_xuci_zhi", dir: true },
    { rel: "prerequisite",   a: "k_judge",    b: "k_gusuoye",  dir: true },
    { rel: "derived_from",   a: "k_xuci_zhi_attr", b: "k_xuci_zhi", dir: true },
    { rel: "contrasts_with", a: "k_xuci_zhi", b: "k_zhi_subj", dir: false },
    { rel: "related_to",     a: "k_xuci_zhi", b: "k_xuci_qi",  dir: false },
    { rel: "applied_in",     a: "k_xuci_zhi", b: "k_judge",    dir: true },
  ],
  // proposed edges (AI) — decided in node drawer (accept / reverse / change-type / dismiss)
  knowledgeEdgeProposals: [
    { id: "kep1", rel: "contrasts_with", a: "k_xuci_zhi", b: "k_xuci_qi", from: "dreaming", confidence: 0.79, dir: false, evidence: { type: "event", id: "evt_3104" } },
    { id: "kep2", rel: "prerequisite", a: "k_zhi_subj", b: "k_xuci_zhi_attr", from: "maintenance", confidence: 0.71, dir: true, evidence: { type: "event", id: "evt_3120" } },
  ],
  // per-node detail extras (⚑shape #2 typed backlinks, #7 activity)
  knowledgeDetail: {
    k_xuci_zhi: {
      backlinks: {
        atomic: [{ tag: "k_zhi_subj", label: "主谓取独" }, { tag: "k_xuci_zhi_attr", label: "之·定语助词" }],
        hub:    [{ tag: "k_xuci", label: "文言虚词" }],
        long:   [{ id: "li_xuci", label: "文言虚词系统（学习项）" }],
        quiz:   [{ id: "q_zhi_1", label: "「水陆草木之花」测验" }, { id: "q_zhi_2", label: "主谓取独 5 题组" }],
      },
      activity: [
        { t: "14 天前", kind: "attempt", label: "attempt:failure · 之", note: "答成「代词」", tone: "again" },
        { t: "3 天前",  kind: "attempt", label: "attempt:partial · 之", note: "方向对、表述不全", tone: "hard" },
        { t: "昨日",    kind: "judge",   label: "judge:attribute", note: "AI 归因：概念混淆 (0.84)", tone: "info" },
        { t: "今日",    kind: "correction", label: "correction:done", note: "重做正确，纳入复习", tone: "good" },
      ],
    },
  },

  // ── LEARNING ITEMS (F) — rebuilt; hub/atomic/status/children/origin (⚑shape #3) ──
  items: [
    { id: "li_xuci", title: "文言虚词系统", kind: "hub", status: "in_progress", icon: "items", color: "coral",
      sub: "之 / 其 / 于 / 而 四个高频虚词", cards: 32, mastered: 19, knowledge: ["k_xuci", "k_xuci_zhi", "k_xuci_qi"],
      parent: null, children: ["li_zhi", "li_qi", "li_yu"], origin: null, artifact: NOTE_ITEM },
    { id: "li_zhi", title: "「之」精练", kind: "atomic", status: "in_progress", icon: "review", color: "info",
      sub: "聚焦主谓取独 vs 定语助词", cards: 12, mastered: 7, knowledge: ["k_xuci_zhi", "k_zhi_subj"],
      parent: "li_xuci", children: [], origin: { from: "dreaming", confidence: 0.86, when: "昨夜", reason: "近 7 天「之」3 次失败，建议拆出专项" }, artifact: NOTE_ZHI },
    { id: "li_qi", title: "「其」精练", kind: "atomic", status: "pending", icon: "review", color: "good",
      sub: "代词 / 语气副词辨析", cards: 8, mastered: 3, knowledge: ["k_xuci_qi"], parent: "li_xuci", children: [], origin: null },
    { id: "li_yu", title: "「于」精练", kind: "atomic", status: "done", icon: "review", color: "good",
      sub: "介词引进对象 / 处所 / 比较", cards: 7, mastered: 7, knowledge: ["k_xuci_yu"], parent: "li_xuci", children: [], origin: null },
    { id: "li_judge", title: "判断句式专题", kind: "hub", status: "resting", icon: "items", color: "hard",
      sub: "者…也 / …也 / 乃 / 即 / 固…所…也", cards: 14, mastered: 6, knowledge: ["k_judge", "k_gusuoye"],
      parent: null, children: [], origin: null, artifact: NOTE_ITEM },
    { id: "li_shiji", title: "史记选读", kind: "hub", status: "archived", icon: "items", color: "info",
      sub: "廉颇蔺相如 / 项羽本纪", cards: 20, mastered: 14, knowledge: ["k_shiji"], parent: null, children: [], origin: null },
  ],
  // intent → AI decomposition proposal (learning_item kind)
  intentProposal: {
    topic: "通假字系统",
    hub: { title: "通假字系统", sub: "声旁通假 / 形近通假 / 古今字", knowledge: ["k_tongjia"] },
    atomic: [
      { title: "声旁通假", sub: "如「蚤」通「早」", keep: true },
      { title: "古今字辨析", sub: "如「莫」「暮」分化", keep: true },
      { title: "形近易混", sub: "如「卒」「猝」", keep: true },
    ],
    confidence: 0.82, cost: "$0.0036", from: "analysis",
  },

  // ── LEARNING SESSIONS (J) — list + detail (⚑shape #4) ──
  sessionsList: [
    { id: "rs_41", type: "review", status: "in_progress", reviewed: 7, dist: { again: 1, hard: 2, good: 4 }, dur: "14m", started: "今天 09:12", knowledge: ["k_xuci_zhi", "k_zhi_subj"] },
    { id: "rs_39", type: "review", status: "partial", reviewed: 3, dist: { again: 1, hard: 0, good: 2 }, dur: "6m", started: "昨天 22:40", knowledge: ["k_shiji"] },
    { id: "rs_37", type: "review", status: "done", reviewed: 24, dist: { again: 3, hard: 5, good: 16 }, dur: "21m", started: "昨天 08:05", knowledge: ["k_xuci", "k_judge"] },
    { id: "s_ing_5", type: "ingestion", status: "extracted", reviewed: 0, dist: null, dur: "2m", started: "前天 19:30", knowledge: ["k_judge"], note: "报任安书 · 整页抽取 3 block" },
    { id: "s_ing_4", type: "ingestion", status: "failed", reviewed: 0, dist: null, dur: "—", started: "前天 19:02", knowledge: [], note: "vision_extract 超时" },
    { id: "rs_30", type: "review", status: "done", reviewed: 18, dist: { again: 2, hard: 4, good: 12 }, dur: "16m", started: "3 天前", knowledge: ["k_xuci_qi", "k_xuci_yu"] },
  ],
  sessionDetail: {
    rs_37: {
      summary: { type: "review", status: "done", dur: "21m", count: 24, cost: "$0.067", model: "Haiku" },
      dist: { again: 3, hard: 5, good: 16 },
      aiSummary: "本次复习覆盖「之 / 其」与判断句式。难点集中在「之」的主谓取独：3 次 again 全部来自此点，建议拆出专项强化。判断句整体稳固，固定结构「固…所…也」尚需巩固。",
      events: [
        { id: "evt_3120", t: "08:05", label: "attempt:failure · 之", tone: "again" },
        { id: "evt_3121", t: "08:06", label: "judge:attribute · 概念混淆", tone: "info" },
        { id: "evt_3124", t: "08:11", label: "attempt:good · 其", tone: "good" },
        { id: "evt_3129", t: "08:19", label: "attempt:hard · 固…所…也", tone: "hard" },
        { id: "evt_3133", t: "08:26", label: "session:complete", tone: "good" },
      ],
    },
  },

  // ── EVENTS (E) — focal + caused_by + downstream + corrections (⚑shape #5) ──
  events: {
    evt_3120: {
      focal: { id: "evt_3120", action: "attempt", outcome: "failure", subject: "之 · 用法", actor: "user", when: "14 天前 08:05", cost: null },
      causedBy: { id: "rs_41", kind: "review_session", label: "review_session rs_41", actor: "user" },
      downstream: [
        { id: "evt_3121", label: "judge:attribute(概念混淆)", actor: "agent", tone: "info" },
        { id: "m1", label: "mistake m1 创建", actor: "system", tone: "again" },
      ],
      corrections: [
        { id: "evt_3140", label: "correction:redo · 答对", when: "今日", actor: "user" },
      ],
      raw: {
        id: "evt_3120", action: "attempt", outcome: "failure", actor_kind: "user",
        subject_kind: "knowledge", subject_id: "k_xuci_zhi",
        caused_by_event_id: null, session_id: "rs_41",
        payload: { answer: "结构助词「的」", correct: false, latency_ms: 8400 },
        cost_usd: 0, created_at: "2026-05-19T08:05:11Z",
      },
    },
  },

  // ── COACH (I) — per-window aggregates (⚑shape #8: client rollup if未暴露) ──
  coach: {
    "7":  { reviews: 84, accuracy: 71, newMistakes: 6, cost: 4.10,
            dist: { again: 12, hard: 19, good: 53 },
            perDay: [[2,3,7],[1,4,9],[3,2,6],[0,5,8],[2,1,5],[3,2,9],[1,2,9]],
            topFail: [["之 · 用法", 5, "k_xuci_zhi"], ["判断句", 4, "k_judge"], ["主谓取独", 3, "k_zhi_subj"], ["其 · 用法", 2, "k_xuci_qi"]],
            causes: [["概念混淆", 9], ["审题偏差", 5], ["记忆遗忘", 4], ["表述不全", 3]] },
    "30": { reviews: 312, accuracy: 76, newMistakes: 21, cost: 16.8,
            dist: { again: 38, hard: 71, good: 203 },
            perDay: null,
            topFail: [["之 · 用法", 14, "k_xuci_zhi"], ["判断句", 11, "k_judge"], ["古今异义", 7, "k_gujin"], ["主谓取独", 6, "k_zhi_subj"]],
            causes: [["概念混淆", 31], ["记忆遗忘", 18], ["审题偏差", 14], ["表述不全", 9]] },
    "90": { reviews: 902, accuracy: 80, newMistakes: 48, cost: 47.2,
            dist: { again: 92, hard: 188, good: 622 },
            perDay: null,
            topFail: [["之 · 用法", 33, "k_xuci_zhi"], ["判断句", 24, "k_judge"], ["史记选读", 18, "k_shiji"], ["古今异义", 15, "k_gujin"]],
            causes: [["概念混淆", 71], ["记忆遗忘", 52], ["审题偏差", 38], ["方法不熟", 21]] },
  },

  // ── ADMIN (K) — runs / cost / failures (⚑shape #6) ──
  admin: {
    runs: [
      { id: "run_881", task: "dreaming", status: "done", cost: 0.071, latency: "118s", when: "今天 03:00", actor: "cron" },
      { id: "run_879", task: "vision_extract", status: "done", cost: 0.052, latency: "9.4s", when: "昨天 19:30", actor: "user" },
      { id: "run_878", task: "judge", status: "done", cost: 0.039, latency: "2.1s", when: "昨天 08:06", actor: "agent" },
      { id: "run_877", task: "maintenance", status: "done", cost: 0.018, latency: "44s", when: "昨天 03:00", actor: "cron" },
      { id: "run_876", task: "vision_extract", status: "failed", cost: 0.000, latency: "timeout", when: "前天 19:02", actor: "user" },
      { id: "run_874", task: "coach", status: "done", cost: 0.022, latency: "6.8s", when: "前天 03:00", actor: "cron" },
    ],
    costByTask: [["dreaming", 0.71], ["vision_extract", 0.52], ["judge", 0.39], ["coach", 0.22], ["maintenance", 0.18]],
    costByDay: [["05-27", 0.92], ["05-28", 1.13], ["05-29", 0.74], ["05-30", 1.51], ["05-31", 0.66], ["06-01", 1.20], ["06-02", 1.84]],
    failures: [
      { id: "job_5521", job: "vision_extract", error: "TimeoutError: SSE stream stalled @ 30s", retries: 2, when: "前天 19:02" },
      { id: "job_5famous", job: "dreaming", error: "RateLimitError: 429 from model gateway", retries: 1, when: "05-29 03:00" },
      { id: "job_5510", job: "judge", error: "ValidationError: empty attribution payload", retries: 0, when: "05-28 08:40" },
    ],

    // ── CALIBRATION MATURITY — GET /api/observability/calibration-maturity (adr-0035) ──
    // n=1 慢热期:每个知识点从冷启开始,随作答逐个 firm up。纯读视图。
    // 语义约束:冷启/低置信点绝不显示成精确分数 — 只给 可信/不可信 + 相对排序(θ̂ SE)。
    calibration: {
      total_kcs: 14,
      firm_count: 4,
      cold_start_count: 10,   // 非 firm 的总数(含从未作答)
      pct_firm: 0.286,        // firm 占比 = firm_count / total_kcs(是计数比,非掌握度)
      median_theta_se: 0.74,
      // firm ⟺ 有作答 且 evidence≥4 且 precision>1。se=1.0 ⟺ 冷启先验,θ̂ 不可信。
      // tier(UI 派生):firm=可信 / warming=渐稳(有证据未 firm) / blind=冷启盲区(evidence=0,从没练过)
      kcs: [
        { id: "k_xuci_zhi", name: "之 · 用法",   track: "虚词", evidence: 41, se: 0.21, confidence: 0.86, cold_start: false },
        { id: "k_judge",    name: "判断句",       track: "句式", evidence: 28, se: 0.29, confidence: 0.81, cold_start: false },
        { id: "k_gujin",    name: "古今异义",     track: "词义", evidence: 22, se: 0.34, confidence: 0.78, cold_start: false },
        { id: "k_tongjia",  name: "通假字",       track: "字词", evidence: 17, se: 0.43, confidence: 0.74, cold_start: false },
        { id: "k_huoyong",  name: "词类活用",     track: "语法", evidence: 3,  se: 0.58, confidence: 0.66, cold_start: true },
        { id: "k_xuci_er",  name: "而 · 用法",     track: "虚词", evidence: 3,  se: 0.62, confidence: 0.69, cold_start: true },
        { id: "k_binyu",    name: "宾语前置",     track: "句式", evidence: 2,  se: 0.71, confidence: null, cold_start: true },
        { id: "k_xuci_yi",  name: "以 · 用法",     track: "虚词", evidence: 2,  se: 0.77, confidence: null, cold_start: true },
        { id: "k_beidong",  name: "被动句",       track: "句式", evidence: 1,  se: 0.83, confidence: null, cold_start: true },
        { id: "k_shenglue", name: "省略句",       track: "句式", evidence: 0,  se: 1.0,  confidence: null, cold_start: true },
        { id: "k_shidong",  name: "使动用法",     track: "语法", evidence: 0,  se: 1.0,  confidence: null, cold_start: true },
        { id: "k_huwen",    name: "互文",         track: "修辞", evidence: 0,  se: 1.0,  confidence: null, cold_start: true },
        { id: "k_zhuangyu", name: "状语后置",     track: null,   evidence: 0,  se: 1.0,  confidence: null, cold_start: true },
        { id: "k_pianyi",   name: "偏义复词",     track: null,   evidence: 0,  se: 1.0,  confidence: null, cold_start: true },
      ],
    },
  },
});

// status enum (all 11) — non-color cue (icon + label) per brief §1.4
const STATUS_META = {
  pending:    { label: "待开始", icon: "clock",      tone: "neutral", glyph: "○" },
  in_progress:{ label: "进行中", icon: "review",     tone: "coral",   glyph: "◐" },
  done:       { label: "已完成", icon: "checkCircle", tone: "good",    glyph: "●" },
  resting:    { label: "搁置中", icon: "clock",      tone: "hard",    glyph: "◌" },
  dismissed:  { label: "已忽略", icon: "close",      tone: "neutral", glyph: "⊘" },
  archived:   { label: "已归档", icon: "archive",    tone: "neutral", glyph: "▽" },
  extracted:  { label: "已抽取", icon: "check",      tone: "good",    glyph: "▣" },
  partial:    { label: "部分完成", icon: "undo",     tone: "hard",    glyph: "◑" },
  failed:     { label: "失败",   icon: "alert",      tone: "again",   glyph: "✕" },
  queued:     { label: "排队中", icon: "clock",      tone: "info",    glyph: "⋯" },
  extracting: { label: "抽取中", icon: "refresh",    tone: "info",    glyph: "◍" },
};
const ITEM_STATUSES = ["pending", "in_progress", "done", "resting", "dismissed", "archived"];
// relation glyph + shape cue (non-color) for the 5 typed edges
const REL_CUE = {
  prerequisite:   { glyph: "→", dash: "0", label: "前置", en: "prerequisite", arrow: true },
  related_to:     { glyph: "—", dash: "0", label: "相关", en: "related_to", arrow: false },
  contrasts_with: { glyph: "⇆", dash: "5 4", label: "对比", en: "contrasts_with", arrow: false },
  applied_in:     { glyph: "↦", dash: "1 5", label: "应用", en: "applied_in", arrow: true },
  derived_from:   { glyph: "↳", dash: "8 3", label: "派生", en: "derived_from", arrow: true },
};

window.STATUS_META = STATUS_META; window.ITEM_STATUSES = ITEM_STATUSES; window.REL_CUE = REL_CUE;
// ── note ↔ {knowledge, item} joins. knowledge_id is ONLY a label on a note;
// nothing owns a note. Items relate to a note when they share any knowledge label.
function notesForKnowledge(kid) { return (DATA.notes || []).filter((n) => n.labels.includes(kid)); }
function noteById(id) { return (DATA.notes || []).find((n) => n.id === id); }
function knowledgeTitle(kid) { const k = (DATA.knowledge || []).find((n) => n.id === kid); return k ? k.title : kid; }
function notesForItem(item) {
  const kl = item && item.knowledge ? item.knowledge : [];
  return (DATA.notes || []).filter((n) => n.labels.some((l) => kl.includes(l)));
}
function itemsForNote(noteId) {
  const n = noteById(noteId); if (!n) return [];
  return (DATA.items || []).filter((it) => (it.knowledge || []).some((k) => n.labels.includes(k)));
}
window.notesForKnowledge = notesForKnowledge; window.noteById = noteById;
window.knowledgeTitle = knowledgeTitle; window.notesForItem = notesForItem; window.itemsForNote = itemsForNote;
