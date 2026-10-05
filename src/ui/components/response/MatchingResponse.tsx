// YUK-1051 — 配对作答控件（通用）。
//
// 规格（preflight §3 + grounding §7.2）：配对 = 选择 + 键盘。每个左项一个原生
// <select>（方向键 / 字母快打 / Home-End 全键盘可达，零自制键盘协议）；不要求
// 拖拽编辑器。默认一对一（exclusive）：把一个右项配给新左项时，它从旧左项上摘下
// （assignMatch 纯函数，response-types.ts）。

import './response.css';

import { MathMarkdown } from '@/ui/lib/math-markdown';

import { assignMatch } from './response-types';

export interface MatchingSide {
  id: string;
  text_md: string;
}

export interface MatchingResponseProps {
  left: MatchingSide[];
  right: MatchingSide[];
  /** leftId → rightId；null = 该左项尚未配对。缺席的左项键视为 null。 */
  value: Record<string, string | null>;
  onChange: (next: Record<string, string | null>) => void;
  disabled?: boolean;
  notation?: string | null;
  ariaLabel?: string;
  /** true（默认）= 一对一：右项被占用时改配会摘下旧配对；false = 允许复用。 */
  exclusive?: boolean;
  /** 未配对选项的占位文案。 */
  placeholder?: string;
}

export function MatchingResponse({
  left,
  right,
  value,
  onChange,
  disabled = false,
  notation = null,
  ariaLabel = '配对作答',
  exclusive = true,
  placeholder = '选择匹配项…',
}: MatchingResponseProps) {
  return (
    <div className="rs-match" role="group" aria-label={ariaLabel}>
      {left.map((l) => {
        const current = value[l.id] ?? null;
        return (
          <div className="rs-match-row" key={l.id}>
            <span className="rs-match-left">
              <MathMarkdown notation={notation}>{l.text_md}</MathMarkdown>
            </span>
            <select
              className="rs-match-select"
              disabled={disabled}
              value={current ?? ''}
              aria-label={`${l.text_md} 的匹配项`}
              onChange={(e) =>
                onChange(
                  assignMatch(value, l.id, e.target.value === '' ? null : e.target.value, {
                    exclusive,
                  }),
                )
              }
            >
              <option value="">{placeholder}</option>
              {right.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.text_md}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}
