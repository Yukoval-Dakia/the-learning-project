// YUK-261 — practice 选择题点选交互的纯逻辑层（无 React / 无 IO）。
//
// 把「当前已选 letter 串 + 用户点了某个选项」算成「新的 letter 串」拆成纯函数，
// 方便单测覆盖三类语义：单选切换/取消、多选 toggle、letter 串规范化。
//
// content_md 写入规范（与 src/core/capability/judges/exact.ts 的 choice-aware
// exact judge 双向兼容，YUK-260 / PR #337）：
//   - 单个 letter：'A'（大写）
//   - 多选：升序拼接、无分隔符、去重，例如 {C,B} → 'BC'
// exact judge 解析 letter 串时做 `toUpperCase().replace(/[\s,，、和与]/g,'')` 再
// `charCodeAt-65`、去重、升序，所以本层产出的「升序大写裸串」是它的子集，零后端改动即兼容。
//
// 选项 index ↔ letter：index 0 → 'A'，index 1 → 'B'，…（charCodeAt 65='A'）。

/** 选项 0-based index → 大写字母（0→A, 1→B, …, 25→Z）。 */
export function indexToLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** 大写字母 → 0-based index（'A'→0）。非 A-Z 返回 -1。 */
export function letterToIndex(letter: string): number {
  const code = letter.toUpperCase().charCodeAt(0);
  if (code < 65 || code > 90) return -1;
  return code - 65;
}

/**
 * 把任意 content_md 草稿串解析成「已选 index 集合」。
 * 容忍 exact-judge 同款的脏输入（小写 / 全角 / 分隔符 / 乱序 / 重复），始终归一成
 * 升序去重的 index 数组。无法解析的字符直接丢弃（不抛错）——草稿渲染要尽量稳。
 *
 * @param raw    持久化的 content_md（可能为 ''/undefined）
 * @param count  选项总数；越界 letter（如只有 4 个选项却出现 'E'）被丢弃
 */
export function parseSelection(raw: string | null | undefined, count: number): number[] {
  if (!raw) return [];
  const cleaned = raw
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s,，、和与]/g, '');
  const indices = new Set<number>();
  for (const ch of cleaned) {
    const idx = letterToIndex(ch);
    if (idx >= 0 && idx < count) indices.add(idx);
  }
  return [...indices].sort((a, b) => a - b);
}

/** 已选 index 集合 → 规范化 content_md 串（升序、大写、无分隔符）。空选 → ''。 */
export function serializeSelection(indices: number[]): string {
  return [...new Set(indices)]
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
    .map(indexToLetter)
    .join('');
}

/**
 * 单选语义：点击某个选项后的新 content_md。
 *   - 点未选项 → 选中它（替换之前的选择）
 *   - 点已选的同一项 → 取消选择（清空）
 */
export function toggleSingle(
  raw: string | null | undefined,
  clickedIndex: number,
  count: number,
): string {
  const current = parseSelection(raw, count);
  if (current.length === 1 && current[0] === clickedIndex) return '';
  return serializeSelection([clickedIndex]);
}

/**
 * 多选语义：点击某个选项后的新 content_md（toggle）。
 *   - 点未选项 → 加入
 *   - 点已选项 → 移除
 * 其它已选项保持不动；结果始终升序规范化。
 */
export function toggleMulti(
  raw: string | null | undefined,
  clickedIndex: number,
  count: number,
): string {
  const current = new Set(parseSelection(raw, count));
  if (current.has(clickedIndex)) current.delete(clickedIndex);
  else current.add(clickedIndex);
  return serializeSelection([...current]);
}

/** 统一入口：按 multiSelect 分流到单选 / 多选 toggle。 */
export function toggleChoice(
  raw: string | null | undefined,
  clickedIndex: number,
  count: number,
  multiSelect: boolean,
): string {
  return multiSelect
    ? toggleMulti(raw, clickedIndex, count)
    : toggleSingle(raw, clickedIndex, count);
}

/**
 * 反馈阶段：判断某个选项是否属于「参考答案」。reference_md 可能存 letter 串（'A'/'BC'）
 * 或选项原文（exact judge 两种都认）。本层只处理 letter-串与原文两种最常见形态：
 *   - reference 解析出非空 index 集合 → 用该集合判定
 *   - 否则尝试把 reference 整体当作某个选项原文匹配
 * 解析不出就返回 false（不显示对错指示，交由上层降级）。
 */
export function isReferenceChoice(
  reference: string | null | undefined,
  optionIndex: number,
  optionText: string,
  count: number,
): boolean {
  if (!reference) return false;
  const refIndices = parseSelection(reference, count);
  if (refIndices.length > 0) return refIndices.includes(optionIndex);
  // reference 不是 letter 串 → 当作选项原文比对（NFKC + trim + lower）。
  const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();
  return norm(reference) === norm(optionText);
}

/**
 * 键盘按键 → 选项 index。作用域限组件内（上层只在组件聚焦时监听），支持：
 *   - 字母 A-Z（大小写）
 *   - 数字 1-9（1→index 0）
 * 返回越界 / 无关按键时为 null。
 */
export function keyToIndex(key: string, count: number): number | null {
  if (/^[a-zA-Z]$/.test(key)) {
    const idx = letterToIndex(key);
    return idx >= 0 && idx < count ? idx : null;
  }
  if (/^[1-9]$/.test(key)) {
    const idx = Number(key) - 1;
    return idx < count ? idx : null;
  }
  return null;
}
