// YUK-1051 — 单/多选作答控件（通用，不按学科造控件）。
//
// 规格（preflight §3 + grounding §7.2）：
//   - stable option IDs（内容派生，见 response-types.ts）；选项数不硬编码 4。
//   - 空集合 vs missing：value=null 是「从未作答」；多选显式清空是 []（可达：逐项取消
//     或「清除选择」），二者对调用方严格可分。
//   - a11y：单选 role=radiogroup + role=radio/aria-checked（同 PfSolo 先例）；多选
//     role=group + aria-pressed（同 screen-onboarding.jsx:496–498 ob-opt-multi 先例）。
//   - 键盘：方向键在组内移动（单选按 ARIA radio 模式随焦点即选）；数字键 1–9 直选
//    （hotkeys 开启时；PfSolo 旧键位 1–4 的一般化，上限随选项数）。
//   - §6.4：对错色只在 feedback release 后出现——feedback='graded' 且给出
//     selectionOutcome 时才挂 .is-right/.is-wrong；paper 作答全程 feedback='none'。

import './response.css';
import { useEffect, useRef } from 'react';

import { MathMarkdown } from '@/ui/lib/math-markdown';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

import type { ChoiceOption } from './response-types';

export interface ChoiceSetResponseProps {
  options: ChoiceOption[];
  mode: 'single' | 'multi';
  /** null = 从未作答（missing）；[] = 显式空集合（多选清空）。 */
  value: string[] | null;
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** 选项正文的 MathMarkdown notation（server-resolved，不猜）。 */
  notation?: string | null;
  /** 'none'（作答/缓冲，默认）| 'graded'（feedback release 后，对错色才允许出现）。 */
  feedback?: 'none' | 'graded';
  /** feedback='graded' 时：所选集合被判对（correct）与否；null/undefined = 不着色。 */
  selectionOutcome?: 'correct' | 'not_correct' | null;
  /** 数字键 1–9 直选（仅限未被文本输入框占用焦点时）。 */
  hotkeys?: boolean;
  ariaLabel?: string;
  /** 多选且已有选择时给「清除选择」（→ onChange([])，显式空集合）。 */
  clearable?: boolean;
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'INPUT' ||
    target.isContentEditable === true
  );
}

export function ChoiceSetResponse({
  options,
  mode,
  value,
  onChange,
  disabled = false,
  notation = null,
  feedback = 'none',
  selectionOutcome = null,
  hotkeys = false,
  ariaLabel = '选项',
  clearable = false,
}: ChoiceSetResponseProps) {
  const selected = new Set(value ?? []);
  const graded = feedback === 'graded';
  const groupRef = useRef<HTMLDivElement | null>(null);

  const selectSingle = (id: string) => {
    if (disabled) return;
    onChange([id]);
  };
  const toggleMulti = (id: string) => {
    if (disabled) return;
    // 取消最后一项 → []（显式空集合），不是 null。
    onChange(selected.has(id) ? [...selected].filter((x) => x !== id) : [...selected, id]);
  };

  // 方向键：组内移动焦点；单选按 ARIA radio 模式「焦点到即选中」。事件挂在容器上，
  // 只在焦点确在组内时生效，不抢全局键。
  const onGroupKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('.rs-opt');
    if (!buttons || buttons.length === 0) return;
    const activeIdx = Array.from(buttons).findIndex((b) => b === document.activeElement);
    if (activeIdx < 0) return;
    e.preventDefault();
    let nextIdx = activeIdx;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight')
      nextIdx = (activeIdx + 1) % buttons.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft')
      nextIdx = (activeIdx - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = buttons.length - 1;
    const target = buttons[nextIdx];
    target.focus();
    if (mode === 'single') selectSingle(options[nextIdx].id);
  };

  // 数字键直选 1–9（PfSolo 1–4 键的一般化；不硬编码选项数）。挂在 window 上与既有
  // 行为一致，但只在组件活着、未禁用、焦点不在文本输入时响应。
  useEffect(() => {
    if (!hotkeys || disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (!/^[1-9]$/.test(e.key)) return;
      if (isTextEntryTarget(e.target)) return;
      const idx = Number(e.key) - 1;
      const opt = options[idx];
      if (!opt) return;
      if (mode === 'single') selectSingle(opt.id);
      else toggleMulti(opt.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // options/selected 每次渲染都新鲜；回调里只用最新闭包值即可。
  });

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: 设计稿卡片式选项（rs-opt 布局）；
          native <input type=radio> 无法承载该布局，真 <button> + radiogroup/group ARIA
          模式语义完整（同 PfSolo / PracticeChoiceOptions / screen-onboarding 先例）。 */}
      <div
        ref={groupRef}
        className="rs-opts"
        role={mode === 'single' ? 'radiogroup' : 'group'}
        aria-label={ariaLabel}
        onKeyDown={onGroupKeyDown}
      >
        {options.map((opt, i) => {
          const isSel = selected.has(opt.id);
          const cls = [
            'rs-opt',
            mode === 'multi' ? 'is-multi' : '',
            !graded && isSel ? 'is-sel' : '',
            graded && isSel && selectionOutcome === 'correct' ? 'is-right' : '',
            graded && isSel && selectionOutcome === 'not_correct' ? 'is-wrong' : '',
            // graded 模式下未被选的选项不着色也不标选中（判定已定格，选中态无意义）。
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              type="button"
              key={opt.id}
              data-option-id={opt.id}
              className={cls}
              disabled={disabled}
              role={mode === 'single' ? 'radio' : undefined}
              aria-checked={mode === 'single' ? isSel : undefined}
              aria-pressed={mode === 'multi' ? isSel : undefined}
              onClick={() => (mode === 'single' ? selectSingle(opt.id) : toggleMulti(opt.id))}
            >
              {mode === 'multi' && (
                <span className="rs-opt-box" aria-hidden="true">
                  {isSel && <LoomIcon name="check" size={10} />}
                </span>
              )}
              <span className="rs-opt-k">{opt.label}</span>
              <span className="rs-opt-t">
                <MathMarkdown notation={notation}>{opt.text_md}</MathMarkdown>
              </span>
            </button>
          );
        })}
      </div>
      {mode === 'multi' && clearable && !disabled && value !== null && value.length > 0 && (
        <div className="rs-opts-foot">
          <button type="button" className="rs-clear" onClick={() => onChange([])}>
            清除选择（{value.length}）
          </button>
        </div>
      )}
    </>
  );
}
