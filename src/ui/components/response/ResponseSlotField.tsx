// YUK-1051 — ResponseSlotField：按槽 spec 分发到通用作答控件的门面组件。
// 「多空/表格」= 每显式 slot 一个 ResponseSlotField（宿主按行/列/题面定位摆放），
// 混合响应与整题计分不互相强制一对一（grounding §7.2）。

import './response.css';
import { ChoiceSetResponse } from './ChoiceSetResponse';
import { MatchingResponse, type MatchingSide } from './MatchingResponse';
import { type OrderingItem, OrderingResponse } from './OrderingResponse';
import type {
  ChoiceOption,
  CoarseOutcome,
  SlotResponseValue,
  SubmissionLifecycle,
} from './response-types';
import { SlotResultBadge } from './SlotResultBadge';
import { TextResponse } from './TextResponse';

/** 槽位规格：题目这一槽要什么形态的作答。 */
export type ResponseSlotSpec =
  | { kind: 'choice_single'; options: ChoiceOption[] }
  | { kind: 'choice_multi'; options: ChoiceOption[] }
  | { kind: 'text' }
  | { kind: 'numeric' }
  | { kind: 'formula' }
  | { kind: 'matching'; left: MatchingSide[]; right: MatchingSide[] }
  | { kind: 'ordering'; items: OrderingItem[] };
export interface ResponseSlotFieldProps {
  spec: ResponseSlotSpec;
  /** undefined = missing（从未作答）。 */
  value: SlotResponseValue | undefined;
  onChange: (value: SlotResponseValue) => void;
  disabled?: boolean;
  notation?: string | null;
  /** 槽标签（「第 1 空」「(2)」）；缺席则无标签行。 */
  label?: string;
  /** 生命周期 badge（作答/复盘都挂）；缺席不渲。 */
  lifecycle?: SubmissionLifecycle;
  /** lifecycle='effective' 且已 release 时的对错（§6.4 release 后才允许出现）。 */
  releasedOutcome?: CoarseOutcome | null;
  /** §6.4：paper 作答过程恒 'none'；solo 即时反馈在 feedback 相位传 'graded'。 */
  feedback?: 'none' | 'graded';
  /** feedback='graded' 时选择的对错归属。 */
  selectionOutcome?: 'correct' | 'not_correct' | null;
  /** 数字键直选（solo 面开启）。 */
  hotkeys?: boolean;
  ariaLabel?: string;
}
export function ResponseSlotField({
  spec,
  value,
  onChange,
  disabled = false,
  notation = null,
  label,
  lifecycle,
  releasedOutcome,
  feedback = 'none',
  selectionOutcome = null,
  hotkeys = false,
  ariaLabel = '作答',
}: ResponseSlotFieldProps) {
  const body = (() => {
    switch (spec.kind) {
      case 'choice_single':
      case 'choice_multi': {
        const choiceValue = value?.kind === 'choice' ? value.option_ids : null;
        return (
          <ChoiceSetResponse
            options={spec.options}
            mode={spec.kind === 'choice_single' ? 'single' : 'multi'}
            value={choiceValue}
            onChange={(ids) => onChange({ kind: 'choice', option_ids: ids })}
            disabled={disabled}
            notation={notation}
            feedback={feedback}
            selectionOutcome={selectionOutcome}
            hotkeys={hotkeys}
            ariaLabel={ariaLabel}
            clearable={spec.kind === 'choice_multi'}
          />
        );
      }
      case 'text':
      case 'numeric':
      case 'formula': {
        const textValue = value?.kind === 'text' ? value.text : null;
        return (
          <TextResponse
            value={textValue}
            onChange={(text) => onChange({ kind: 'text', text })}
            disabled={disabled}
            inputKind={spec.kind}
            notation={notation}
            ariaLabel={ariaLabel}
          />
        );
      }
      case 'matching': {
        const matchValue = value?.kind === 'matching' ? value.pairs : {};
        return (
          <MatchingResponse
            left={spec.left}
            right={spec.right}
            value={matchValue}
            onChange={(pairs) => onChange({ kind: 'matching', pairs })}
            disabled={disabled}
            notation={notation}
            ariaLabel={ariaLabel}
          />
        );
      }
      case 'ordering': {
        const orderValue = value?.kind === 'ordering' ? value.ordered_ids : [];
        return (
          <OrderingResponse
            items={spec.items}
            value={orderValue}
            onChange={(ids) => onChange({ kind: 'ordering', ordered_ids: ids })}
            disabled={disabled}
            notation={notation}
            ariaLabel={ariaLabel}
          />
        );
      }
    }
  })();
  return (
    <div className="rs-slotfield">
      {(label || lifecycle) && (
        <span className="rs-slotfield-label">
          {label}
          {lifecycle && (
            <>
              {' '}
              <SlotResultBadge lifecycle={lifecycle} releasedOutcome={releasedOutcome} />
            </>
          )}
        </span>
      )}
      {body}
    </div>
  );
}
