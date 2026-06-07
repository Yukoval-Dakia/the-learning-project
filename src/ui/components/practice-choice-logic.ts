// YUK-261 — practice 选择题点选交互的纯逻辑层（无 React / 无 IO）。
//
// 把「当前已选 letter 串 + 用户点了某个选项」算成「新的 letter 串」拆成纯函数，
// 方便单测覆盖三类语义：单选切换/取消、多选 toggle、letter 串规范化。
//
// content_md 暂存规范（AUTOSAVE 草稿，*不是*提交答案）：
//   - 单个 letter：'A'（大写）
//   - 多选：升序拼接、无分隔符、去重，例如 {C,B} → 'BC'
// 这个 letter 串只用于「点选暂存 + 选项卡回显」（parseSelection 解析它点亮卡片）。
//
// ⚠️ SUBMIT 契约（grading 真相，bot-review round 修正）：本分支的 exact judge
// （src/core/capability/judges/exact.ts）做的是**纯 normalize 后整串相等比较**，
// 没有任何 letter→选项原文展开；而现存所有选择题 fixture 的 reference_md 存的是
// **选项原文**（src/subjects/wenyan/fixtures/data.json：'苏洵' / '何陋之有' …，
// index.test.ts:62 断言 choices.toContain(reference_md)）。因此点选暂存的裸 letter 串
// （'B'）若原样提交会和 '苏洵' normalize 后不等 → 正确答案被判错。
// → 提交前必须用 selectionToAnswerMd() 把 letter 串展开成对应选项原文再发给 judge。
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
 * 提交前展开：把暂存的 letter 串（'A' / 'BC'）展开成对应**选项原文**，供 exact judge
 * 整串比较（reference_md 存的是选项原文，见本文件头部 SUBMIT 契约说明）。
 *   - 单选：返回该选项原文（e.g. 'B' + ['苏轼','苏洵',…] → '苏洵'）。
 *   - 多选：按升序逐行拼接各选项原文（'\n' 分隔）。多选 reference 形态目前无 fixture，
 *     judge 整串比较需两侧同序同分隔——这是 best-effort，单选才是已验证的 grading 真相路径。
 *   - 空选 / 解析不出任何 index → 返回 ''（提交空答案，由上层 judge 走 unsupported / incorrect）。
 *
 * 注意：本函数只在**提交**那一刻调用；点选暂存（content_md autosave）始终保留 letter 串。
 *
 * @param raw      暂存的 letter 串
 * @param choices  选项原文列表（question.choices_md）
 */
export function selectionToAnswerMd(raw: string | null | undefined, choices: string[]): string {
  const indices = parseSelection(raw, choices.length);
  if (indices.length === 0) return '';
  return indices.map((i) => choices[i]).join('\n');
}

/**
 * 从可得信号派生「是否多选」（bot-review round 修正：旧实现用 `kind === 'multiple_choice'`
 * 恒为 false——持久 question.kind 已被 question-kind.ts 折叠成 canonical 'choice'，
 * single_choice / multiple_choice 不再可区分，PaperQuestionFace 也不带多选 flag）。
 *
 * 数据模型在 face 层无法区分单/多选，故采用「有 reference 时按 reference 形态推断，
 * 否则保守单选」：
 *   - reference 是纯 label 串且解析出 ≥2 个 index（如 'BC'）→ 多选。
 *   - reference 是选项原文且在 choices 里命中 ≥2 项（理论上少见，防御性覆盖）→ 多选。
 *   - 其它（无 reference / 单一正确项）→ 单选。
 * 现存 fixture 全为 single_choice（reference 命中 1 项），因此默认单选对所有真实数据正确；
 * 多选 reference 出现时（未来）也能在反馈/只读态正确点亮多张卡。answering 态无 reference
 * 时回退单选——这是 face 层信息缺失下的安全默认。
 *
 * @param reference  question.reference_md（可空；answering 态通常为 null）
 * @param choices    选项原文列表
 */
export function deriveMultiSelect(
  reference: string | null | undefined,
  choices: string[],
): boolean {
  if (!reference) return false;
  if (isNormalizedLabel(reference, choices.length)) {
    return parseSelection(reference, choices.length).length >= 2;
  }
  const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();
  const ref = norm(reference);
  // 选项原文 reference 一般只对应单一选项；这里仅在罕见的「reference 文本恰好匹配多张卡」
  // 时才升级为多选，绝大多数走单选默认。
  return choices.filter((c) => norm(c) === ref).length >= 2;
}

/**
 * 反演：把**已提交答案**（submission.answer_md）映射回规范化 letter 串，供选项卡回显
 * （bot-review round 修正：feedback / 只读态原先用 draft 回显，但提交冻结值在
 * submission.answer_md，draft 多为 null，导致卡片全不点亮）。
 *
 * 提交答案经 selectionToAnswerMd 展开后是选项原文（单选一项 / 多选 '\n' 分行）；本函数把
 * 每行原文 NFKC+trim+lower 后与 choices 匹配回 index，再 serialize 成 letter 串。
 *   - 命中 → 返回升序 letter 串（'B' / 'BC'）。
 *   - 全不命中（历史脏数据 / 答案就是 letter 串）→ 回退：若入参本身是 label 串原样返回，
 *     否则返回 ''（不点亮，交由文本反馈兜底）。
 *
 * @param answerMd  已提交答案（选项原文，可能多行）
 * @param choices   选项原文列表
 */
export function answerMdToSelection(
  answerMd: string | null | undefined,
  choices: string[],
): string {
  if (!answerMd) return '';
  const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();
  const byText = new Map<string, number>();
  choices.forEach((c, i) => byText.set(norm(c), i));
  const indices: number[] = [];
  for (const line of answerMd.split('\n')) {
    const idx = byText.get(norm(line));
    if (idx !== undefined) indices.push(idx);
  }
  if (indices.length > 0) return serializeSelection(indices);
  // 选项原文全不命中：可能是历史上直接存 letter 串的答案 → 若是范围内 label 串原样保留。
  return isNormalizedLabel(answerMd, choices.length)
    ? serializeSelection(parseSelection(answerMd, choices.length))
    : '';
}

/**
 * 一个串是否为「规范化的纯 label 串」——去掉 exact-judge 同款脏字符后，**全部**字符都是
 * A-Z 字母（NFKC + 去分隔符后）；传入 `count` 时还要求每个字母都落在 `[A, A+count)`
 * 范围内（即都是该题的合法选项 letter）。用来在 isReferenceChoice 里区分「reference 是
 * letter 串」还是「reference 是含 Latin 字母的选项原文（数学 'a + b'、英文单词）」。
 *
 * 收紧 count 这层（bot-review round）：英文学科选项原文如 'apple'（4 选项题）会含越界字母
 * （P/P/L/E > D），此时不当成 label，回落到选项原文比对，避免被误拆成 letter。
 * 空串返回 false。
 *
 * @param raw   待判定的串
 * @param count 选项总数；省略 / ≤0 时只做纯字母检查（不做范围约束）。
 */
export function isNormalizedLabel(raw: string | null | undefined, count?: number): boolean {
  if (!raw) return false;
  const cleaned = raw
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s,，、和与]/g, '');
  if (cleaned.length === 0) return false;
  if (!/^[A-Z]+$/.test(cleaned)) return false;
  if (count === undefined || count <= 0) return true;
  // 每个字母都必须是该题合法选项 letter（在范围内）。
  for (const ch of cleaned) {
    const idx = letterToIndex(ch);
    if (idx < 0 || idx >= count) return false;
  }
  return true;
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
 * 或选项原文（现存 fixture 全是选项原文）。两种形态的消歧（bot-review round 修正）：
 *   - reference 是**纯 label 串**（NFKC + 去分隔符后全为 A-Z）→ 当 letter 串解析，用 index 集合判定。
 *   - 否则（含 CJK，或含 Latin 字母的选项原文如数学 'a + b' / 英文单词）→ 当选项原文整串比对。
 * 旧实现先 parseSelection(reference)，只要 reference 含任意 A-Z 就走 letter 分支，会让
 * 数学 / 英文学科的选项原文被错当 label，反馈标错卡片——故改为先判 isNormalizedLabel。
 * 解析不出就返回 false（不显示对错指示，交由上层降级）。
 */
export function isReferenceChoice(
  reference: string | null | undefined,
  optionIndex: number,
  optionText: string,
  count: number,
): boolean {
  if (!reference) return false;
  // 只有「纯 label 串（且全在选项范围内）」才按 letter 解析，避免含 Latin 字母的选项原文被误判为 label。
  if (isNormalizedLabel(reference, count)) {
    const refIndices = parseSelection(reference, count);
    if (refIndices.length > 0) return refIndices.includes(optionIndex);
  }
  // reference 不是 label 串 → 当作选项原文比对（NFKC + trim + lower）。
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
