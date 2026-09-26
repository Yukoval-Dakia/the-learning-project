// YUK-1051 — 每题可选 1–5 信心自评（Q-922 owner 决定：题级、observe-only）。
//
// 语义（core/schema/event/known.ts ReviewOnQuestion.payload.self_confidence）：
//   学生在看到判定**之前**对本作答的主观把握，1 = 完全没底 … 5 = 十拿九稳。
//   **observe-only**：只作分析采集，绝不进 θ̂ / FSRS / 判分。
//   optional / 零强制：未自评 = null（键缺席），可随时「不评」清空。
//
// 视觉复用**已冻结**的 .rs-confidence* 设计（response.css，设计师稿）：本组件不改
// 类名、不改结构、不加新颜色系统，只把同一段 DOM 抽成受控组件并补键盘可达性
// （组内方向键移动焦点，Enter/Space 选择；镜像 ChoiceSetResponse 的键盘先例）。
//
// 与 ChoiceSetResponse 一致：裸 <button> 承载卡片式布局，ARIA 用 aria-pressed
// 表达选中（沿用设计稿标记，不用原生 radio）。disabled 态只由宿主在作答面冻结时传。

import './response.css';
import { useRef } from 'react';

export interface SelfConfidenceFieldProps {
  /** null / undefined = 未自评（optional；键缺席），1–5 = 自评档。 */
  value: number | null | undefined;
  onChange: (next: number | null) => void;
  disabled?: boolean;
  /** 前缀问句；默认与设计稿逐字一致。 */
  question?: string;
  /** 外层区域 aria-label（宿主可按题序号命名，如「第 3 题信心自评」）。 */
  ariaLabel?: string;
  /** 1 / 5 两端的语义提示；默认与设计稿逐字一致。 */
  hint?: string;
}

const SCALE = [1, 2, 3, 4, 5] as const;

export function SelfConfidenceField({
  value,
  onChange,
  disabled = false,
  question = '这题你有几分把握？',
  ariaLabel = '信心自评',
  hint = '1 = 全靠猜 · 5 = 十拿九稳 · 不评分',
}: SelfConfidenceFieldProps) {
  const selected = typeof value === 'number' ? value : null;
  const scaleRef = useRef<HTMLDivElement | null>(null);

  // 方向键在 1–5 档内移动焦点（Home/End 跳两端）；选择仍由 Enter/Space/点击触发。
  // 事件挂在组容器上，只在焦点确在组内时生效，不抢全局键。
  const onScaleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const buttons = scaleRef.current?.querySelectorAll<HTMLButtonElement>('.rs-confidence-btn');
    if (!buttons || buttons.length === 0) return;
    const activeIdx = Array.from(buttons).indexOf(document.activeElement as HTMLButtonElement);
    if (activeIdx < 0) return;
    e.preventDefault();
    let nextIdx = activeIdx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (activeIdx + 1) % buttons.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      nextIdx = (activeIdx - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = buttons.length - 1;
    buttons[nextIdx]?.focus();
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: 设计稿卡片式刻度（rs-confidence 布局）；
          native <fieldset> 无法承载该单行布局，真 <button> + role=group ARIA 模式语义完整
          （同 ChoiceSetResponse 先例）。 */}
      <div className="rs-confidence" role="group" aria-label={ariaLabel} onKeyDown={onScaleKeyDown}>
        <span className="rs-confidence-q">{question}</span>
        <div ref={scaleRef} className="rs-confidence-scale">
          {SCALE.map((score) => (
            <button
              type="button"
              key={score}
              className={`rs-confidence-btn${selected === score ? ' is-selected' : ''}`}
              aria-label={`把握 ${score} 分（共 5 分）`}
              aria-pressed={selected === score}
              disabled={disabled}
              onClick={() => onChange(score)}
            >
              {score}
            </button>
          ))}
          <button
            type="button"
            className="rs-confidence-skip"
            aria-pressed={selected === null}
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            不评
          </button>
        </div>
        <span className="rs-confidence-hint">{hint}</span>
      </div>
    </>
  );
}
