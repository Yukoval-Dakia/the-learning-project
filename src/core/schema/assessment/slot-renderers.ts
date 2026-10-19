import type { ResponseSlotT } from './response';

/**
 * 网页逐槽原生作答控件能画的槽位种类 —— 单一来源（YUK-1573）。
 *
 * - `nativeSlotFieldSpec`（src/ui/components/response/ResponseSlotField.tsx）先用
 *   `hasNativeSlotField` 收窄，再对收窄后的种类穷举 switch：本表加一种而 switch 没写，
 *   或 switch 多写一种本表没有的，都是编译错误。
 * - 出题门（serving-admission）以本表判「逐槽有输入控件」。
 * - 不在表内：`table` 是布局容器（单元格是其它槽，各自检查）；`sentence_breaks`
 *   的字间点选编辑器归 R10 UI 线；`select` / `blank` 只能由展示层输入积木画出
 *   （YUK-1496/1497）。
 */
export const NATIVE_FIELD_SLOT_KINDS = [
  'single_choice',
  'multi_choice',
  'text',
  'numeric',
  'formula',
  'matching',
  'ordering',
  'open_response',
] as const satisfies readonly ResponseSlotT['kind'][];
export type NativeFieldSlotKind = (typeof NATIVE_FIELD_SLOT_KINDS)[number];
export type NativeFieldSlotT = Extract<ResponseSlotT, { kind: NativeFieldSlotKind }>;

export const NATIVE_FIELD_SLOT_KIND_SET: ReadonlySet<ResponseSlotT['kind']> = new Set(
  NATIVE_FIELD_SLOT_KINDS,
);

export function hasNativeSlotField(slot: ResponseSlotT): slot is NativeFieldSlotT {
  return NATIVE_FIELD_SLOT_KIND_SET.has(slot.kind);
}

/**
 * 只能由展示层输入积木画出的槽位种类（YUK-1497 spec §4）：出题门要求它们被声明式输入积木
 * 绑定才发出（被自定义块绑定的一律扣发，直到 YUK-1513）。
 */
export const PRESENTATION_INPUT_SLOT_KINDS = [
  'select',
  'blank',
] as const satisfies readonly ResponseSlotT['kind'][];

/**
 * 整卷页（PfPaper）能作答的槽位种类：原生逐槽控件，加上展示层输入积木画的 select / blank
 * （YUK-1573：整卷页与单题页用同一个 PresentationBlocks）。发出的 select / blank 槽必被
 * 声明式积木绑定（出题门），所以整卷页总能画出。
 */
export const WHOLE_PAPER_SLOT_KINDS: ReadonlySet<ResponseSlotT['kind']> = new Set([
  ...NATIVE_FIELD_SLOT_KINDS,
  ...PRESENTATION_INPUT_SLOT_KINDS,
]);

/** 整卷开卷/交卷拒绝的 typed 原因码（服务端 409 error 字段；页面按它出学习者文案）。 */
export const PAPER_MODE_UNSUPPORTED_SLOT_KIND = 'paper_mode_unsupported_slot_kind';

/**
 * 发出范围内整卷页画不出控件的第一个作答槽；没有则 undefined。
 * table 是布局容器、本身不收作答，不计入（其单元格槽各自检查）。
 */
export function firstWholePaperUnrenderableSlot(
  slots: readonly ResponseSlotT[],
  partIds: readonly string[],
): ResponseSlotT | undefined {
  const selected = new Set(partIds);
  return slots.find(
    (slot) =>
      selected.has(slot.part_id) && slot.kind !== 'table' && !WHOLE_PAPER_SLOT_KINDS.has(slot.kind),
  );
}
