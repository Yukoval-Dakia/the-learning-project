// Loom · A4 读 vs 判 — inbox 三档分流 + A3 copilot PR/checkpoint 数据.
// 按「可逆性 × 后果」分三档:
//   A 自动 + 撤销窗口(静默应用,不进裁决 lane,靠静态可逆性兜底)
//   B 逐条人审(真裁决项,保留 accept/dismiss)
//   C 纯状态不进队列(snooze / 软归档 / 移到旁观)
// A 档判定靠「静态可逆性」非 confidence(confidence 数据基础不足)。

// kind → 档位映射(owner 待终拍;此为 claude design v0 默认,可被 owner 映射表覆盖)
const INBOX_TIER = {
  // A — 安全可逆,静默应用
  record_links: "A", record_promotion: "A", completion: "A",
  // B — 真裁决,逐条人审
  knowledge_node: "B", knowledge_edge: "B", knowledge_mutation: "B",
  learning_item: "B", note_update: "B", variant_question: "B",
  relearn: "B", goal_scope: "B", block_merge: "B",
  // C — 纯状态,移出裁决面
  defer: "C", archive: "C", judge_retraction: "C",
};

const TIER_META = {
  A: { label: "自动应用", sub: "安全可逆 · 已静默应用 · 撤销窗口内一键回退", tone: "good", icon: "bolt" },
  B: { label: "待你裁决", sub: "真裁决项 · 逐条 accept / dismiss · 每次写一条事件", tone: "coral", icon: "inbox" },
  C: { label: "已自动处理", sub: "纯状态变更 · 不占裁决队列 · 可在旁观面回看", tone: "neutral", icon: "archive" },
};

const INBOX_A4 = {
  // A 档:已被后台静默应用,带撤销窗口。state: live(窗口内可撤) · consumed(已被下游消费,无法干净撤销) · reverted
  autoApplied: [
    { id: "aa_1", kind: "record_links", title: "关联录入块到《报任安书》",
      body: "把今早录入的 3 个块自动挂到了已有来源《报任安书》下 —— 同一份材料的延续。",
      reversible: "干净可逆", window: "4 分钟内可撤销", state: "live",
      trace: { posture: "ingest", events: ["e_4120", "e_4121"], note: "静态可逆性兜底 · 非 confidence 判定" } },
    { id: "aa_2", kind: "completion", title: "标记「主谓取独」首练完成",
      body: "你刚把这点的入门练习做完了，自动记了一次 completion。",
      reversible: "干净可逆", window: "刚刚 · 9 分钟内可撤销", state: "live",
      trace: { posture: "coach", events: ["e_4130"], note: "completion 事件可逆" } },
    { id: "aa_3", kind: "record_promotion", title: "把一条手记升格为正式笔记",
      body: "你三次引用了这条随手记，已自动升格进 k_xuci_zhi 的主笔记。",
      reversible: "已被下游引用", window: "已无法干净撤销", state: "consumed",
      trace: { posture: "maintenance", events: ["e_4101"], note: "升格后已被 2 处引用,撤销不再干净" } },
  ],
  // A 档熔断:单位时间 auto-apply 超上限 → 退回全人审
  breaker: { tripped: false, applied: 6, cap: 12, window: "近 1 小时", note: "auto-apply 在阈值内,自动通道正常。" },

  // C 档:已移出裁决面的纯状态项(展示「去哪了」,可回看,不要求裁决)
  movedOut: [
    { id: "co_1", kind: "defer", title: "「导数→单调性」前置边",
      body: "证据还不足，编排者先把它 snooze 了，攒够再提。", action: "已 snooze · 7 天后重提" },
    { id: "co_2", kind: "archive", title: "重复的「于」释义块",
      body: "与已有块高度重复，直接软归档，没占你的裁决队列。", action: "已软归档 · 可在题库取回" },
    { id: "co_3", kind: "judge_retraction", title: "撤回一条过期的归因",
      body: "上周一条 attribution 被新证据推翻，编排者自行撤回了 —— 纯记录，移到旁观面。", action: "已移到 AI 观察" },
  ],
};

window.INBOX_TIER = INBOX_TIER;
window.TIER_META = TIER_META;
window.INBOX_A4 = INBOX_A4;
