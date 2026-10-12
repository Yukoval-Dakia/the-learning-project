// ====================================================================
// ADR-0074 D3a — 断句位置索引语义（纯确定性原语；无 IO、无状态）
// ====================================================================
//
// 位置（position）= 对【冻结明文】的 Unicode code point「字缝」索引：
//   - 冻结明文是 sentence_breaks 槽的 text 原文，随 revision 整体冻结。
//     客户端必须用同一字符串渲染与计数 —— 不做 HTML 实体解码、空白/换行
//     归一化或视觉折行修正：索引按逻辑字符序计算，与折行无关
//     （R10：每个字缝的点按区跨行延伸，「行尾也能点」不改逻辑索引）。
//   - 索引按 Unicode code point 计（iterable 语义），【不】按 UTF-16 code
//     unit：代理对（如 𝄞 U+1D11E、emoji）计 1 个字符，字缝永远落在完整
//     字符之间，绝不切进代理对。
//   - gap i ∈ [0, L]（L = code point 数）表示「第 i 个 code point 之前」的
//     字缝：i=0 是文首、i=L 是文末。有效【断句】位置只有内部字缝
//     i ∈ [1, L-1]；文首/文末不是断句位置，与越界一样结构性拒绝。
//   - 学习者提交 positions:number[]（sentence_breaks 作答）；判分只做
//     集合比较（accepted set + 题级 typed 规则），无文本解析、无猜测。

/** 冻结明文的 code point 数（= 字缝索引的闭合上界 L）。 */
export function codePointCount(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    index += codePoint > 0xffff ? 2 : 1;
    count += 1;
  }
  return count;
}

/**
 * gap i 是否为该明文的有效断句位置（内部字缝 1 ≤ i ≤ L-1）。
 * 整数性由 schema（z.number().int()）保证；此处防御性复核，纯函数。
 */
export function isInteriorGap(text: string, position: number): boolean {
  return Number.isInteger(position) && position >= 1 && position <= codePointCount(text) - 1;
}
