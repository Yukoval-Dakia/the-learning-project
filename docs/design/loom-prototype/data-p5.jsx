// Loom · P5 data — Questions bank, note kinds, annotations, artifact-typed
// backlinks, decay buckets. Extends DATA; consumes existing backend fields.
// ⚑shape markers note shapes to confirm with the backend.

// ── note kinds: atomic / hub / long (separate from 标注笔记 annotations) ──
(function () {
  const byId = Object.fromEntries((DATA.notes || []).map((n) => [n.id, n]));
  if (byId.note_zhi)   byId.note_zhi.kind = "atomic";   // primary reading note for 之
  if (byId.note_xuci)  byId.note_xuci.kind = "hub";     // hub overview across 虚词
  if (byId.note_judge) byId.note_judge.kind = "atomic";
})();

// a long-form note (kind=long) that also labels k_xuci_zhi
DATA.notes.push({
  id: "note_long_xuci", title: "虚词辨析长文 · 之/其/而 的历时演变", kind: "long",
  labels: ["k_xuci", "k_xuci_zhi", "k_xuci_qi"], updated: "6 天前", verify: "verified", from: "user",
  versions: [{ v: "v2", t: "6 天前", actor: "user", note: "补先秦用例" }, { v: "v1", t: "上月", actor: "user", note: "初稿" }],
  blocks: [
    { id: "L1", type: "h", text: "虚词的历时演变" },
    { id: "L2", type: "p", text: "「之」由动词（往）虚化为结构助词，是汉语语法化的典型路径。本文按先秦、两汉、唐宋三段梳理其功能分布的迁移。" },
    { id: "L3", type: "wenyan", text: "先秦：之 多作动词与代词；助词用法尚未定型。" },
    { id: "L4", type: "callout", tone: "info", text: "语法化路径：实词 → 代词 → 结构助词，伴随语音弱化。" },
  ],
});

// ── 标注笔记 (annotations) — short margin notes attached to a knowledge node.
// A lighter artifact than a full note; not one of the 3 note kinds. ⚑shape
DATA.annotations = [
  { id: "an_1", kid: "k_xuci_zhi", text: "「主谓之间」与「定中之间」最易混；做题时先判断「之」前后成分。", author: "user", when: "昨日", onNote: "note_zhi", onBlock: "b3" },
  { id: "an_2", kid: "k_xuci_zhi", text: "AI 标注：近 7 天此点 3 次答成「代词」，已上调复习权重。", author: "agent", when: "今日", onNote: "note_zhi", onBlock: "b4" },
  { id: "an_3", kid: "k_xuci_zhi", text: "对照《师说》全文再过一遍助词用法。", author: "user", when: "3 天前", onNote: null, onBlock: null },
];
function annotationsForKnowledge(kid) { return (DATA.annotations || []).filter((a) => a.kid === kid); }

// ── notes for a knowledge node, split by kind. Primary = first atomic. ──
function notesByKindForKnowledge(kid) {
  const ns = notesForKnowledge(kid);
  const atomic = ns.filter((n) => (n.kind || "atomic") === "atomic");
  return {
    primary: atomic[0] || null,
    atomic: atomic.slice(1),
    hub: ns.filter((n) => n.kind === "hub"),
    long: ns.filter((n) => n.kind === "long"),
  };
}
window.annotationsForKnowledge = annotationsForKnowledge;
window.notesByKindForKnowledge = notesByKindForKnowledge;

// ── backlinks grouped by SOURCE ARTIFACT TYPE (⚑shape #P5) ──
// artifact types: question | note | learning_item | mistake | session
DATA.backlinksByArtifact = {
  k_xuci_zhi: {
    question:      [{ id: "q_zhi_root", label: "「水陆草木之花」之·用法", meta: "root · active" }, { id: "q_zhi_v2", label: "「臣之壮也」变体", meta: "variant · active" }, { id: "q_zhi_cloze", label: "之·定中 填空 5 题组", meta: "part · draft" }],
    note:          [{ id: "note_zhi", label: "「之」的四类核心用法", meta: "atomic · 主笔记" }, { id: "note_long_xuci", label: "虚词辨析长文", meta: "long" }],
    learning_item: [{ id: "li_xuci", label: "文言虚词系统", meta: "hub · in_progress" }, { id: "li_zhi", label: "「之」精练", meta: "atomic · in_progress" }],
    mistake:       [{ id: "m_zhi_1", label: "attempt:failure · 误判为代词", meta: "14 天前" }],
    session:       [{ id: "rs_37", label: "复习会话 · 虚词专项", meta: "昨日 · 18 卡" }],
  },
};
function backlinksByArtifact(kid) { return DATA.backlinksByArtifact[kid] || null; }
window.backlinksByArtifact = backlinksByArtifact;

// ── decay bucket (mastery retrievability) — map decay → bucket + retr% ──
const DECAY_BUCKET = {
  stable:   { label: "稳固", tone: "good", retr: 0.94, hint: "可提取性高，复习间隔可拉长" },
  slow:     { label: "缓退", tone: "hard", retr: 0.78, hint: "缓慢衰减，按计划复习即可" },
  decaying: { label: "衰退", tone: "again", retr: 0.55, hint: "可提取性下降，建议尽快复习" },
};
window.DECAY_BUCKET = DECAY_BUCKET;

// ── QUESTIONS bank (题库) — root/variant/part, source tier, grounding,
// copy safety, difficulty, knowledge labels. ⚑shape: question table + lineage.
DATA.questions = [
  { id: "q_zhi_root", stem: "下列「之」字用法与其他三项不同的一项是？", kind: "mcq", status: "active",
    source: "exam_paper", sourceTier: "tier_a", grounding: "grounded", copy: "safe", difficulty: 0.42,
    lineage: "root", variants: 3, knowledge: ["k_xuci_zhi"], updated: "昨日" },
  { id: "q_zhi_v2", stem: "「臣之壮也，犹不如人」中「之」的语法功能是？", kind: "mcq", status: "active",
    source: "exam_paper", sourceTier: "tier_a", grounding: "grounded", copy: "safe", difficulty: 0.55,
    lineage: "variant", root: "q_zhi_root", knowledge: ["k_xuci_zhi", "k_zhi_subj"], updated: "昨日" },
  { id: "q_zhi_cloze", stem: "填空：古之学者必有师，「之」作 ___ 助词。", kind: "cloze", status: "draft",
    source: "ai_generated", sourceTier: "tier_c", grounding: "partial", copy: "review", difficulty: 0.30,
    lineage: "part", root: "q_zhi_root", knowledge: ["k_xuci_zhi"], updated: "今日" },
  { id: "q_qi_1", stem: "「其」在「其皆出于此乎」中表达的语气是？", kind: "mcq", status: "active",
    source: "textbook", sourceTier: "tier_b", grounding: "grounded", copy: "safe", difficulty: 0.61,
    lineage: "root", variants: 1, knowledge: ["k_xuci_qi"], updated: "前日" },
  { id: "q_judge_1", stem: "判断句「廉颇者，赵之良将也」的句式标志是？", kind: "short", status: "active",
    source: "exam_paper", sourceTier: "tier_a", grounding: "grounded", copy: "safe", difficulty: 0.48,
    lineage: "root", variants: 2, knowledge: ["k_judge"], updated: "上周" },
  { id: "q_judge_essay", stem: "简述文言判断句不用「是」字成句的三种主要方式。", kind: "essay", status: "draft",
    source: "ai_generated", sourceTier: "tier_c", grounding: "ungrounded", copy: "blocked", difficulty: 0.74,
    lineage: "root", variants: 0, knowledge: ["k_judge", "k_gusuoye"], updated: "今日" },
  { id: "q_yu_1", stem: "「青，取之于蓝」中「于」引进的是？", kind: "mcq", status: "active",
    source: "textbook", sourceTier: "tier_b", grounding: "grounded", copy: "safe", difficulty: 0.36,
    lineage: "root", variants: 1, knowledge: ["k_xuci_yu"], updated: "上周" },
  { id: "q_zhi_judge", stem: "「师道之不传也久矣」中「之」的作用，并标出停顿。", kind: "short", status: "active",
    source: "user_input", sourceTier: "tier_b", grounding: "grounded", copy: "safe", difficulty: 0.58,
    lineage: "variant", root: "q_zhi_root", knowledge: ["k_xuci_zhi"], updated: "4 天前" },
  { id: "q_gusuoye_1", stem: "「固一世之雄也」属何种判断句？", kind: "mcq", status: "draft",
    source: "ai_generated", sourceTier: "tier_c", grounding: "partial", copy: "review", difficulty: 0.52,
    lineage: "root", variants: 0, knowledge: ["k_gusuoye"], updated: "今日" },
  { id: "q_shiji_1", stem: "《廉颇蔺相如列传》中「以」字用法归类（多选）。", kind: "mcq", status: "archived",
    source: "exam_paper", sourceTier: "tier_a", grounding: "grounded", copy: "safe", difficulty: 0.66,
    lineage: "root", variants: 4, knowledge: ["k_shiji"], updated: "上月" },
];

// filter axes metadata for the Questions UI
const Q_KIND = { mcq: "选择", cloze: "填空", short: "简答", essay: "论述", judge: "判断" };
const Q_STATUS = { active: { label: "启用", tone: "good" }, draft: { label: "草稿", tone: "hard" }, archived: { label: "归档", tone: "neutral" } };
const Q_SOURCE = { exam_paper: "试卷", textbook: "教材", ai_generated: "AI 生成", user_input: "手动录入" };
const Q_TIER = { tier_a: { label: "A 级", tone: "good" }, tier_b: { label: "B 级", tone: "info" }, tier_c: { label: "C 级", tone: "hard" } };
const Q_GROUNDING = { grounded: { label: "已溯源", tone: "good", icon: "link" }, partial: { label: "部分溯源", tone: "hard", icon: "link" }, ungrounded: { label: "未溯源", tone: "again", icon: "alert" } };
const Q_COPY = { safe: { label: "可用", tone: "good", icon: "check" }, review: { label: "待审", tone: "hard", icon: "eye" }, blocked: { label: "受限", tone: "again", icon: "alert" } };
const Q_LINEAGE = { root: { label: "母题", glyph: "◆" }, variant: { label: "变体", glyph: "◇" }, part: { label: "子题", glyph: "▫" } };
Object.assign(window, { Q_KIND, Q_STATUS, Q_SOURCE, Q_TIER, Q_GROUNDING, Q_COPY, Q_LINEAGE });
