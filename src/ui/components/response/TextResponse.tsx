// YUK-1051 — 文本 / 数值 / 公式作答控件（通用）。
//
// 规格（grounding §7.2）：保留原文输入——value 恒为用户键入的原文，绝不被结构化
// 解释悄悄改写；公式模式下的数学预览是**派生物**（textarea 下方只读渲染，不回写）。
// 数值模式只给 inputMode 提示，不收窄字符集（分数线「3/4」、负号、科学计数法都合法原文）。

import './response.css';
import { useId } from 'react';

import { MathMarkdown } from '@/ui/lib/math-markdown';

export interface TextResponseProps {
  /** 原文；null = 从未作答（missing），'' = 已触碰但未输入。 */
  value: string | null;
  onChange: (text: string) => void;
  disabled?: boolean;
  /** 语义提示：数值给 decimal 键盘；公式开派生预览。三者都不改写原文。 */
  inputKind?: 'text' | 'numeric' | 'formula';
  /** 公式预览的 MathMarkdown notation（server-resolved）。 */
  notation?: string | null;
  /** 公式模式下是否渲染实时预览（默认开；纯派生，只读）。 */
  showPreview?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  rows?: number;
  maxLength?: number;
}

export function TextResponse({
  value,
  onChange,
  disabled = false,
  inputKind = 'text',
  notation = null,
  showPreview = true,
  placeholder = '写下你的解答…',
  ariaLabel = '作答',
  rows = 3,
  maxLength,
}: TextResponseProps) {
  const id = useId();
  const text = value ?? '';
  const wantsPreview = inputKind === 'formula' && showPreview && text.trim().length > 0;
  return (
    <div className="rs-textwrap">
      <textarea
        id={id}
        className="rs-textarea"
        rows={rows}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        inputMode={inputKind === 'numeric' ? 'decimal' : undefined}
        maxLength={maxLength}
      />
      {wantsPreview && (
        <div className="rs-preview" data-testid={`${id}-preview`}>
          <span className="rs-preview-label">公式预览 · 派生自你的原文，不参与判分原文</span>
          <MathMarkdown notation={notation}>{text}</MathMarkdown>
        </div>
      )}
    </div>
  );
}
