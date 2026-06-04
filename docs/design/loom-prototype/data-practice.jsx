// Loom · Practice (练习) data — 成卷练习. Papers = ordered sets of questions.
// session(type='paper'): not_started / in_progress(可恢复, pos) / done(completedAt).
// Distinct from review (FSRS 逐张流): practice manages whole 卷.

// source taxonomy — Coach 排期 / 用户自建 / 笔记小测
const PRACTICE_SRC = {
  coach:  { label: "Coach 排期", icon: "target", tone: "good",    q: "actor=cron · coach.schedule" },
  custom: { label: "用户自建",   icon: "pencil", tone: "coral",   q: "actor=user · paper.create" },
  note:   { label: "笔记小测",   icon: "doc",    tone: "info",    q: "actor=system · note.embedded_quiz" },
};

Object.assign(DATA, {
  practice: {
    // ── 今日 · 待做 / 进行中 置顶 ──────────────────────────────────
    today: [
      // in_progress — resumable, shows progress position
      { id: "pa_cont", title: "史记选读 · 廉颇蔺相如", count: 10, source: "custom",
        created: "昨 21:30", gen: "ready", sid: "ps_52",
        session: { status: "in_progress", pos: 4, dur: "已用 8m", left: "余 6 题" },
        knowledge: ["史记选读", "判断句", "古今异义"] },
      // ready, not started — Coach 推荐 今日卷
      { id: "pa_today", title: "今日成卷 · 文言虚词强化", count: 12, source: "coach",
        created: "今 07:00", gen: "ready", est: "约 18 分钟",
        reason: "针对近 7 天「之 · 主谓取独」3 次失败排出",
        session: { status: "not_started" },
        knowledge: ["之 · 用法", "其 · 用法", "主谓取独"] },
      // still generating — Coach 仍在排
      { id: "pa_gen", title: "判断句式专题卷", count: 8, source: "coach",
        created: "今 07:01", gen: "generating", genPct: 60,
        session: { status: "not_started" },
        knowledge: ["判断句", "固…所…也"] },
    ],

    // ── 往日 · 历史倒序（按来源可筛） ─────────────────────────────
    past: [
      { id: "pa_31", title: "文言虚词 · 周测", count: 20, source: "coach", created: "昨日",
        session: { status: "done", completedAt: "昨 22:10", dur: "24m", right: 16, wrong: 4 },
        knowledge: ["之 · 用法", "于 · 用法", "其 · 用法"] },
      { id: "pa_28", title: "报任安书 · 自建测验", count: 12, source: "custom", created: "3 天前",
        session: { status: "done", completedAt: "3 天前", dur: "16m", right: 9, wrong: 3 },
        knowledge: ["报任安书", "判断句"] },
      { id: "pa_25", title: "笔记小测 · 主谓取独", count: 5, source: "note", created: "4 天前",
        session: { status: "done", completedAt: "4 天前", dur: "6m", right: 3, wrong: 2 },
        knowledge: ["主谓取独"] },
      { id: "pa_22", title: "通假与多音 · 巩固卷", count: 15, source: "coach", created: "6 天前",
        session: { status: "done", completedAt: "6 天前", dur: "19m", right: 13, wrong: 2 },
        knowledge: ["通假 / 多音", "史记选读"] },
      { id: "pa_18", title: "古今异义 · 自测", count: 10, source: "custom", created: "上周",
        session: { status: "done", completedAt: "8 天前", dur: "12m", right: 6, wrong: 4 },
        knowledge: ["古今异义"] },
      { id: "pa_15", title: "笔记小测 · 之的四类用法", count: 6, source: "note", created: "上周",
        session: { status: "done", completedAt: "9 天前", dur: "7m", right: 5, wrong: 1 },
        knowledge: ["之 · 用法"] },
    ],
  },
});

window.PRACTICE_SRC = PRACTICE_SRC;
