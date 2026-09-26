// YUK-1051 — 通用 response 组件族的共享类型与纯函数。
//
// 依据 docs/design/2026-09-24-assessment-ui-preflight.md §2–§3 与
// docs/planning/2026-09-24-question-assessment-implementation-grounding.md §7.2
// 「通用交互覆盖，不按学科造控件」：
//   - 单/多选：stable option IDs（内容派生，非数组下标）；空集合 ≠ missing。
//   - 文本/数值/公式：原文保留；结构化预览是派生物，不回写原答案。
//   - 配对/排序：ID 对选择 + 可键盘上下移动/序号编辑；不要求拖拽编辑器。
//   - 开放作答：通用文字 + 附件证据；附件默认绑定整个 evaluation group，子集可改。
//   - 状态六态：草稿未提交 / 已提交待评 / 联合组暂定 / 材料不可读待复核 / 生效 / 被替代。
//
// 本文件零 React / 零 IO，所有纯函数供组件与单测共享（unit partition 友好）。

// ── stable option identity ───────────────────────────────────────────────────
//
// 现行 wire 只有 choices_md: string[]（位置数组），后端不下发选项 id。作答侧需要的
// 「stable option id」在这里从**内容**派生（FNV-1a，非加密用途），而不是数组下标：
// 同一选项文本在重新渲染 / 草稿恢复 / 复盘里得到同一 id；文本完全相同的重复选项按
// 出现次序加 -2 / -3… 后缀消歧。scope（题 id / 槽 id）参与哈希，避免跨题同文本撞 id。
//
// §7.3：新 serve 默认不 shuffle；stable id 不自动授权重排——「以上都对」/引用字母的
// 选项必须保持原顺序。允许重排的题未来由执行计划显式声明，重排不改变这里的 id。

export interface ChoiceOption {
  /** 内容派生的稳定 id（见 deriveOptionIds）。 */
  id: string;
  /** 展示序号（A/B/C/…，超出 26 个后退化为数字）。label 是展示物，不是身份。 */
  label: string;
  /** 选项 markdown 原文。 */
  text_md: string;
}

/** FNV-1a 32-bit over UTF-8 — 确定性内容哈希，浏览器 / node 都可跑。 */
export function fnv1aHex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = 0x811c9dc5;
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeOptionText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * 为一组选项文本派生稳定 id 数组（与输入等长、按位对应）。
 * 同一次调用内重复文本得到 `-2` / `-3`… 后缀；scope 变化整组 id 变化。
 */
export function deriveOptionIds(texts: readonly string[], scope = ''): string[] {
  const scopePrefix = scope ? `${fnv1aHex(scope)}-` : '';
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = `opt_${scopePrefix}${fnv1aHex(normalizeOptionText(text))}`;
    const ordinal = (seen.get(base) ?? 0) + 1;
    seen.set(base, ordinal);
    return ordinal === 1 ? base : `${base}-${ordinal}`;
  });
}

const UPPER_A = 65;
const LETTER_COUNT = 26;

/** 展示序号：0→A … 25→Z，之后退化为 27/28…（选项数不硬编码 4，也不假设 ≤26）。 */
export function optionLabel(index: number): string {
  return index < LETTER_COUNT ? String.fromCharCode(UPPER_A + index) : String(index + 1);
}

/** 从 wire 的 choices_md 位置数组构造带稳定 id 的选项列表。 */
export function optionsFromChoicesMd(choicesMd: readonly string[], scope = ''): ChoiceOption[] {
  const ids = deriveOptionIds(choicesMd, scope);
  return choicesMd.map((text, i) => ({ id: ids[i], label: optionLabel(i), text_md: text }));
}

// ── slot response value model ────────────────────────────────────────────────
//
// ResponseSet 以 slot_id 为键。**missing（键缺席 / undefined）≠ 空集合**：多选显式
// 清空是 `choice: []`，与「从未作答」在草稿恢复、已答计数、提交门上都分开。

export type SlotResponseValue =
  | { kind: 'choice'; option_ids: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'matching'; pairs: Record<string, string | null> }
  | { kind: 'ordering'; ordered_ids: string[] };

export type ResponseSet = Record<string, SlotResponseValue>;

/** 「这一槽有实质作答吗」——missing 与空集合都返回 false；多空/配对看是否有非空项。 */
export function isSlotResponseAnswered(value: SlotResponseValue | null | undefined): boolean {
  if (value == null) return false;
  switch (value.kind) {
    case 'choice':
      return value.option_ids.length > 0;
    case 'text':
      return value.text.trim().length > 0;
    case 'matching':
      return Object.values(value.pairs).some((rightId) => rightId !== null);
    case 'ordering':
      return value.ordered_ids.length > 0;
  }
}

/** 两个 choice 选择是否同集合（与次序无关）。 */
export function choiceSelectionsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}

function serializeSlotEntry(k: string, v: SlotResponseValue): unknown[] {
  switch (v.kind) {
    case 'choice':
      return [k, v.kind, [...v.option_ids].sort()];
    case 'text':
      return [k, v.kind, v.text];
    case 'matching':
      return [
        k,
        v.kind,
        Object.keys(v.pairs)
          .sort()
          .map((leftId) => [leftId, v.pairs[leftId]]),
      ];
    case 'ordering':
      return [k, v.kind, v.ordered_ids];
  }
}

/** 把 slots 的作答集压成可比较的字符串（autosave 脏检查 / 测试断言用）。 */
export function serializeResponseSet(set: ResponseSet): string {
  const keys = Object.keys(set).sort();
  return JSON.stringify(keys.map((k) => serializeSlotEntry(k, set[k])));
}

// ── matching / ordering 纯操作（键盘可操作的排序在 OrderingResponse 里复用） ──

/** 配对指派：exclusive 模式下把 rightId 从其他 left 上摘下（一对一配对）。 */
export function assignMatch(
  pairs: Record<string, string | null>,
  leftId: string,
  rightId: string | null,
  opts: { exclusive?: boolean } = {},
): Record<string, string | null> {
  const exclusive = opts.exclusive ?? true;
  const next = { ...pairs };
  if (exclusive && rightId !== null) {
    for (const key of Object.keys(next)) {
      if (key !== leftId && next[key] === rightId) next[key] = null;
    }
  }
  next[leftId] = rightId;
  return next;
}

/** 排序移动：把 id 向上/下移一位；越界返回原数组（引用不变，方便调用方短路）。 */
export function moveOrderedItem(
  orderedIds: readonly string[],
  id: string,
  direction: 'up' | 'down',
): string[] {
  const from = orderedIds.indexOf(id);
  if (from < 0) return [...orderedIds];
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= orderedIds.length) return [...orderedIds];
  const next = [...orderedIds];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** 序号编辑：把 id 移到 1-based 目标位置（clamp 到 [1, len]）；id 不在表里原样返回。 */
export function moveOrderedItemTo(
  orderedIds: readonly string[],
  id: string,
  position: number,
): string[] {
  const from = orderedIds.indexOf(id);
  if (from < 0) return [...orderedIds];
  const clamped = Math.min(Math.max(Math.trunc(position), 1), orderedIds.length);
  const next = [...orderedIds];
  const [item] = next.splice(from, 1);
  next.splice(clamped - 1, 0, item);
  return next;
}

// ── evaluation group / evidence attachment（D10 媒体附件口径） ────────────────

export type EvidenceKind = 'image' | 'audio' | 'video' | 'pdf' | 'text' | 'other';

/** 从 MIME 推断证据类别；null/未知 → other（保守降级为下载，不假装可内联）。 */
export function evidenceKindFromMime(mime: string | null | undefined): EvidenceKind {
  if (!mime) return 'other';
  const m = mime.toLowerCase().split(';')[0].trim();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('text/')) return 'text';
  return 'other';
}

export interface EvidenceAttachment {
  asset_id: string;
  /**
   * 展示类别。新上传的附件由 upload 回执的 mime 决定；从 wire 恢复的引用只有 id，
   * 留 undefined，由 AssetEvidencePreview 按 content 响应头解析（不猜）。
   */
  kind?: EvidenceKind;
  /** 展示名（文件名 / 上传序号）。 */
  label?: string;
  /**
   * 绑定范围：null = 整个 evaluation group（整页解题照的默认）；否则为显式 slot_id
   * 子集（EvaluationGroupPanel 里可改）。绝不由模型切图归属串用相邻题答案。
   */
  slot_ids: string[] | null;
}

/** 联合判分组：一组共享证据/联合计分的 slot。 */
export interface EvaluationGroup {
  id: string;
  slot_ids: string[];
}

// ── 六状态 submission lifecycle（§3 交互规格 / §7.3） ─────────────────────────
//
// 每个状态都必须有 submission 锚点（submission id / run id），刷新不重交。
// badge tone 刻意不含对错语义：pending/tentative/review 都是中性或注意级；
// 对错色只来自 released 之后的 outcome（见 SlotResultBadge）。

export type SubmissionLifecycle =
  | 'draft'
  | 'submitted_pending'
  | 'group_tentative'
  | 'needs_review'
  | 'effective'
  | 'superseded';

export type SubmissionLifecycleTone = 'neutral' | 'info' | 'hard' | 'good';

export const SUBMISSION_LIFECYCLE_META: Record<
  SubmissionLifecycle,
  { label: string; tone: SubmissionLifecycleTone }
> = {
  draft: { label: '草稿 · 未提交', tone: 'neutral' },
  submitted_pending: { label: '已提交 · 待评', tone: 'info' },
  group_tentative: { label: '暂定 · 待全组', tone: 'info' },
  needs_review: { label: '待复核', tone: 'hard' },
  effective: { label: '已生效', tone: 'good' },
  superseded: { label: '已被替代', tone: 'neutral' },
};

/** 判分反馈的粗粒度结果（与 JudgeResult coarse_outcome 对齐）。 */
export type CoarseOutcome = 'correct' | 'partial' | 'incorrect' | 'unsupported';

export const COARSE_OUTCOME_META: Record<
  CoarseOutcome,
  { label: string; tone: 'good' | 'hard' | 'again' }
> = {
  correct: { label: '对', tone: 'good' },
  partial: { label: '部分对', tone: 'hard' },
  incorrect: { label: '错', tone: 'again' },
  unsupported: { label: '无法判定', tone: 'hard' },
};
