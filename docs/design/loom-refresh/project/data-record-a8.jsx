// Loom · A8 录入出口叙事 + rescue 失败态 + 边缘退化态. 数据.
// 录完 → 有意义的、活的出口:材料去哪了、变成了什么、下一步能干什么(不硬跳死链)。
// 与 A1 交班缕 / A3 主动开口呼应:录入后编排者可主动提议。
// 原始素材必须可见地留存;降级/失败一律诚实优先于隐藏。

const RECORD_A8 = {
  // 成功出口:这批材料 → 进了哪棵树 / 生成了哪些题 / 现在能不能练
  exit: {
    title: "报任安书 · 节选",
    chars: 642, blocks: 3,
    tree: { id: "li_wenyan", name: "文言文", path: "文言文 › 史传 › 报任安书" },
    nodes: [
      { label: "剖符丹书", tag: "k_typo_pofu", isNew: true },
      { label: "固…所…也", tag: "k_judge", isNew: false },
      { label: "之 · 结构助词", tag: "k_xuci_zhi", isNew: false },
    ],
    questions: 3,   // 可由这批生成的题
    // 编排者主动提议(克制、可忽略)
    proposal: "我把这批整理进了「文言文 › 报任安书」，顺手标了 1 个新知识点。要不要现在出 3 道针对「固…所…也」判断句的题？",
  },

  // 原始素材留存(任何降级/失败都能回到原图重来)
  original: { kind: "PDF", name: "报任安书_扫描页.pdf", pages: 2, retained: true },
};

window.RECORD_A8 = RECORD_A8;
