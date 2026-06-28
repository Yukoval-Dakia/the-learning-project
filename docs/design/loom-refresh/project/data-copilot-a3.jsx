// Loom · A3 单编排者对话 — PR/checkpoint 数据.
// per-utterance checkpoint(PR 模型): 用户一句话 = 编排者多步改动 = 一个可审的 PR.
// 用户可 keep(默认) / revert 整 PR / cherry-pick 单条.
// user_verified 硬边界: 触及用户亲手「已验证」内容的改动 → 强制高亮 + 默认不勾.

const COPILOT_A3 = {
  // 一个 per-utterance checkpoint PR(回应「把『之』这块给我补强」)
  pr: {
    summary: "把「之」补强了一轮：重排复习 + 补 2 张卡 + 改 1 条图谱边。",
    posture: "前台编排者 · 引用昨夜 dreaming",
    cost: 0.021, model: "sonnet", steps: 4,
    diffs: [
      { id: "d1", op: "add", kind: "variant_question", text: "新增 2 张「主谓取独」卡片", detail: "梯度由浅入深,接住你连错的两次", verified: false, checked: true },
      { id: "d2", op: "edit", kind: "reorder", text: "把「之」复习提到今天最前", detail: "原 FSRS 排在第 3 天,趁错因新鲜提前", verified: false, checked: true },
      { id: "d3", op: "edit", kind: "knowledge_edge", text: "「词类活用」→「使动用法」加一条 prerequisite 边", detail: "你两次错都源自把使动当普通活用", verified: false, checked: true },
      { id: "d4", op: "edit", kind: "note_update", text: "改写了你已验证的「之」释义笔记", detail: "补入「者…也」结构的辨析 —— 但这条是你亲手核对过的", verified: true, checked: false },
    ],
  },

  // 长程 durable run(搬后台,边跑边更新 step,关页/刷新可重连重放)
  run: {
    title: "为你这周的薄弱点重建一套练习",
    posture: "durable run · 后台",
    steps: [
      { label: "扫描近 7 天作答", state: "done" },
      { label: "聚类错因 → 3 个薄弱点", state: "done" },
      { label: "为每个点生成梯度题", state: "running" },
      { label: "排进复习队列 + 写 PR", state: "pending" },
    ],
    note: "关页或刷新都不丢 —— 回来时这里会重连重放进度，跑完给你一份可审的 PR。",
  },

  // 主动开口(克制·可忽略·不打断): 录入后 / 卡住时
  proactive: {
    afterIngest: { trigger: "录入材料后", text: "我把刚录的《报任安书》整理进了「文言文」树，要不要现在出 3 道针对性的题？" },
    stuck: { trigger: "练习卡住时", text: "这道在「主谓取独」上你停了一会儿 —— 需要我给个方向提示，还是你再想想？" },
  },

  // SSE 半截流(已出残文 + 「没说完」 + 可续)
  partial: "「之」作主谓之间的助词时，取消句子的独立性，使它降格为句子成分。比如「师道之不传也久矣」里，「之」就把「师道不传」",
};

window.COPILOT_A3 = COPILOT_A3;
