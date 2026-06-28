// Loom · A2 自主滑块 — 从 hint 滑到完整解. 数据 + 阶梯语义.
// H0–H5 阶梯(借 GPT Hint Ladder). 默认 hint-first; 每阶明确「这一阶给什么」;
// 阶与阶之间用户主动推进(非自动连发); 可一次性跳到完整解;
// 看完整解 = 记为「非独立完成」(ADR-0039 决定5),reveal 是明确可记录动作.

// 阶梯档定义(H0–H5). gives = 这一阶给什么(明确语义). reveal=true 即完整解.
const LADDER_H0H5 = [
  { h: 0, key: "定向", gives: "只点题型与该往哪看 — 不碰内容", weight: "最轻" },
  { h: 1, key: "方向", gives: "指出该调用哪个概念 / 思路", weight: "轻" },
  { h: 2, key: "缩小范围", gives: "排除干扰项，圈定关键处", weight: "中" },
  { h: 3, key: "关键步骤", gives: "给出破题的那一步，留你收尾", weight: "偏重" },
  { h: 4, key: "接近解", gives: "演算到最后一步，只差临门一脚", weight: "重" },
  { h: 5, key: "完整解", gives: "给出完整解答与理由", weight: "完整解", reveal: true },
];
// 3 阶 v0(gate §7 软决策): 方向 → 关键步骤 → 完整解
const LADDER_THREE = [
  { h: 0, key: "方向", gives: "指出该往哪个方向想 — 不碰内容", weight: "轻" },
  { h: 1, key: "关键步骤", gives: "给出破题的那一步，留你收尾", weight: "中" },
  { h: 2, key: "完整解", gives: "给出完整解答与理由", weight: "完整解", reveal: true },
];

// 把一题的内容铺到阶梯各档上。q.hints(若有) 填中间档,q.answer/explain 填完整解。
// 慢热期：滑块每阶可追溯到该题的 p(L) 难度档 + 错因(若误区已晋升)。
function ladderFor(q, mode) {
  const ladder = mode === "three" ? LADDER_THREE : LADDER_H0H5;
  const hints = q.hints || [];
  const full = q.answer || (q.options && q.correct != null ? q.options[q.correct] : null) || "（完整解答）";
  const explain = q.explain || q.passageNote || "";
  const mid = ladder.filter((s) => !s.reveal);
  return ladder.map((s) => {
    if (s.reveal) {
      return { ...s, body: full, explain, isFull: true };
    }
    // distribute available hints across the non-reveal stages
    const idx = mid.indexOf(s);
    const ratio = mid.length > 1 ? idx / (mid.length - 1) : 0;
    const pick = hints.length ? hints[Math.min(hints.length - 1, Math.round(ratio * (hints.length - 1)))] : null;
    return { ...s, body: pick || `（${s.key}级提示将在这里生成）` };
  });
}

// 该题的可追溯锚:难度档 + 错因(示例,真实从 p(L)/误区读)
const LADDER_TRACE = {
  band: "成长档", bandLow: false,
  cause: "近 3 次错因集中在「主谓取独」识别",
  evidence: ["e_3104", "e_3119"],
};

window.LADDER_H0H5 = LADDER_H0H5;
window.LADDER_THREE = LADDER_THREE;
window.ladderFor = ladderFor;
window.LADDER_TRACE = LADDER_TRACE;
