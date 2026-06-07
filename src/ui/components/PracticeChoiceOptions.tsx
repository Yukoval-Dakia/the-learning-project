// YUK-261 — practice 选择题点选交互组件（可点选项卡片）。
//
// Design authority: docs/superpowers/plans/2026-06-05-u5-paper-model.md §5
// (practice 做卷答题页)；owner 已批 pre-flight（含一处修正）。
//
// 组件类型：嵌入 /practice/[id] 答题页的「选项卡片组」（非 drawer/modal/route）。
// 视觉复用 .practice-choices / .practice-choice-btn（globals.css §choice question
// options），点选态 / 反馈态新增的视觉规则也追加在同一节。
//
// ⚠️ owner 显式修正：**点选 ≠ 提交**。点击只把规范化 letter 串写回暂存（content_md
// autosave 通道，点击即存、不走 500ms 防抖），提交仍由答题页既有的显式「提交」按钮触发。
// 本组件**不**调用任何提交路径，只通过 onSelect(content_md) 把新草稿值交给上层。
//
// 选中态硬约束（round2a §1.3：不能只靠颜色传达状态）：
//   coral 边框 + ✓ 图标 + aria-pressed=true（图标是非颜色线索，满足无障碍）。
// 键盘可达：组件容器聚焦时，A-D / 1-9 选择对应选项。监听**只挂在组件容器**（onKeyDown），
//   不挂 window —— 避免与答题页文本框 / 全局 ⌘Enter 提交监听打架（owner 约束）。
//
// content_md 规范化（升序大写裸 letter 串，'A' / 多选 'BC'）由 practice-choice-logic.ts
// 负责，与 exact choice-aware judge（YUK-260 / PR #337）双向兼容，零后端改动。

'use client';

import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useId } from 'react';
import {
  indexToLetter,
  isReferenceChoice,
  keyToIndex,
  parseSelection,
  toggleChoice,
} from './practice-choice-logic';

export interface PracticeChoiceOptionsProps {
  /** 选项原文列表（来自 question.choices_md）。 */
  choices: string[];
  /** 当前暂存的 content_md（规范化 letter 串，如 'A' / 'BC'）。 */
  value: string | null | undefined;
  /**
   * 多选语义开关。persisted question.kind 是 canonical 'choice'，不区分单/多选；
   * 上层（答题页）按 face kind 派生（kind === 'multiple_choice' → true），默认单选。
   */
  multiSelect: boolean;
  /**
   * 点选后回调：传出新的规范化 content_md 串。上层把它接到既有 autosave 通道
   * （点击即存，不防抖）。**不是**提交。
   */
  onSelect: (contentMd: string) => void;
  /** 只读（read-only review of a completed paper）—— 禁用点选与键盘。 */
  disabled?: boolean;
  /**
   * 反馈阶段标志。为 true 时每个选项卡显示对错指示（✓/✗ 图标 + tone class），
   * 不可再点选。需要配合 reference 才能算出每项对错。
   */
  feedback?: boolean;
  /**
   * 参考答案（question.reference_md）。可为 letter 串或选项原文；feedback 阶段用来
   * 标注每个选项是否属于正确答案。缺省时反馈阶段只回显用户选择、不显示对错。
   */
  reference?: string | null;
}

/**
 * 选择题可点选项卡片组。受控组件：自身不持状态，选中集合从 `value` 解析。
 */
export function PracticeChoiceOptions({
  choices,
  value,
  multiSelect,
  onSelect,
  disabled = false,
  feedback = false,
  reference = null,
}: PracticeChoiceOptionsProps) {
  const groupId = useId();
  const count = choices.length;
  const selected = new Set(parseSelection(value, count));
  // 点选在 feedback / disabled 下一律锁死。
  const interactive = !disabled && !feedback;

  function handleClick(index: number) {
    if (!interactive) return;
    onSelect(toggleChoice(value, index, count, multiSelect));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    if (!interactive) return;
    // 作用域限组件：只处理本容器 onKeyDown，不挂 window。
    const idx = keyToIndex(e.key, count);
    if (idx === null) return;
    e.preventDefault();
    onSelect(toggleChoice(value, idx, count, multiSelect));
  }

  return (
    <ul
      className="practice-choices practice-choices--clickable"
      // biome-ignore lint/a11y/useSemanticElements: <ul role="group"> keeps the existing
      // .practice-choices list visual while exposing one keyboard-focusable group; each
      // option is a real <button>, so AT still announces them as buttons (a <fieldset>
      // would drag in default chrome and break the list layout).
      role="group"
      aria-label="选项"
      aria-multiselectable={multiSelect || undefined}
      // tabIndex makes the group focusable so the scoped A-D / 1-9 keyboard
      // contract works without a global window listener (owner constraint).
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={handleKeyDown}
    >
      {choices.map((choice, index) => {
        const letter = indexToLetter(index);
        const isSelected = selected.has(index);
        // feedback 阶段：该选项是否属于参考答案。
        const isCorrectChoice = feedback
          ? isReferenceChoice(reference, index, choice, count)
          : false;
        // 反馈指示：用户选了的项 → 对(✓)/错(✗)；未选但属正确答案 → 也标 ✓（漏选提示）。
        let feedbackTone = '';
        let feedbackIcon: 'check' | 'close' | null = null;
        if (feedback && reference) {
          if (isSelected && isCorrectChoice) {
            feedbackTone = 'is-correct';
            feedbackIcon = 'check';
          } else if (isSelected && !isCorrectChoice) {
            feedbackTone = 'is-wrong';
            feedbackIcon = 'close';
          } else if (!isSelected && isCorrectChoice) {
            // 漏选的正确项 —— 标 ✓ 提示应选。
            feedbackTone = 'is-missed';
            feedbackIcon = 'check';
          }
        }

        return (
          <li key={`${groupId}-${letter}`} className="practice-choice-item">
            <button
              type="button"
              className={`practice-choice-btn${isSelected ? ' is-selected' : ''}${
                feedbackTone ? ` ${feedbackTone}` : ''
              }`}
              // aria-pressed 暴露选中态（非颜色线索之一，配合 ✓ 图标）。
              aria-pressed={isSelected}
              disabled={!interactive}
              onClick={() => handleClick(index)}
            >
              <span className="practice-choice-label">{letter}</span>
              <span className="wenyan practice-choice-text">{choice}</span>
              {/* 选中态 ✓ —— round2a §1.3 硬约束：状态不能只靠颜色，这是图标线索。 */}
              {isSelected && !feedback && (
                <span className="practice-choice-mark" aria-hidden="true">
                  <LoomIcon name="check" size={16} />
                </span>
              )}
              {/* 反馈态 ✓/✗ —— 图标 + tone class，非纯颜色。 */}
              {feedbackIcon && (
                <span
                  className={`practice-choice-mark practice-choice-mark--${feedbackTone}`}
                  aria-label={feedbackIcon === 'check' ? '正确选项' : '错误选项'}
                >
                  <LoomIcon name={feedbackIcon} size={16} />
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
