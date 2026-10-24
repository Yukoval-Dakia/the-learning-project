// 断句位置索引。position 是对冻结明文（sentence_breaks 槽 text）的 Unicode code
// point 字缝索引：
//   - 客户端必须用同一字符串渲染与计数：不做 HTML 实体解码、空白归一化或折行
//     修正；
//   - 按 code point 而非 UTF-16 code unit 计数，代理对（emoji 等）计 1 个字符；
//   - gap i ∈ [0, L]，只有内部字缝 [1, L-1] 是有效断句位置；
//   - 判分只做集合比较，不解析文本。

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
