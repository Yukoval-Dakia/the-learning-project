// YUK-1051 — 排序作答控件（通用）。
//
// 规格（preflight §3 + grounding §7.2）：可键盘上下移动 / 序号编辑即足够，不要求
// 拖拽编辑器。每项一行：↑/↓ 按钮（aria-label 带项文本）+ 目标序号输入（1-based，
// clamp 到 [1, N]）。移动经 aria-live polite 播报（「『甲』移到第 2 位」）。

import './response.css';
import { useId, useRef, useState } from 'react';

import { MathMarkdown } from '@/ui/lib/math-markdown';
import { LoomIcon } from '@/ui/primitives/LoomIcon';

import { moveOrderedItem, moveOrderedItemTo } from './response-types';

export interface OrderingItem {
  id: string;
  text_md: string;
}

export interface OrderingResponseProps {
  items: OrderingItem[];
  /** 当前顺序（item id 数组）。应与 items 同集合；缺漏的 id 追加在尾。 */
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  notation?: string | null;
  ariaLabel?: string;
}

/** 显示序：value 里的已知 id（按 value 序）+ value 缺漏的 items（按 spec 序补尾）。 */
export function resolveOrderedIds(
  items: readonly OrderingItem[],
  value: readonly string[],
): string[] {
  const known = new Set(items.map((i) => i.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of value) {
    if (known.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  for (const item of items) {
    if (!seen.has(item.id)) out.push(item.id);
  }
  return out;
}

export function OrderingResponse({
  items,
  value,
  onChange,
  disabled = false,
  notation = null,
  ariaLabel = '排序作答',
}: OrderingResponseProps) {
  const baseId = useId();
  const orderedIds = resolveOrderedIds(items, value);
  const byId = new Map(items.map((i) => [i.id, i]));
  // 序号输入是「键入中」的本地态：失焦/回车才落定（onBlur/Enter），避免逐键重排跳动。
  const [posDraft, setPosDraft] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState('');
  const moveBtns = useRef<Map<string, HTMLButtonElement>>(new Map());

  const announceMove = (id: string, next: string[]) => {
    const item = byId.get(id);
    setAnnouncement(`「${item?.text_md ?? id}」移到第 ${next.indexOf(id) + 1} 位`);
  };

  const move = (id: string, direction: 'up' | 'down') => {
    const next = moveOrderedItem(orderedIds, id, direction);
    if (next.join('\n') === orderedIds.join('\n')) return;
    onChange(next);
    announceMove(id, next);
    // 移动后焦点留在原按钮上（同一 id 的控件），不丢键盘上下文。
    requestAnimationFrame(() => moveBtns.current.get(id)?.focus());
  };

  const commitPosition = (id: string) => {
    const raw = posDraft[id];
    if (raw === undefined) return;
    setPosDraft((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });
    const n = Number(raw);
    if (!Number.isFinite(n) || raw.trim() === '') return;
    const next = moveOrderedItemTo(orderedIds, id, n);
    if (next.join('\n') === orderedIds.join('\n')) return;
    onChange(next);
    announceMove(id, next);
  };

  return (
    <div>
      <ol className="rs-order" aria-label={ariaLabel}>
        {orderedIds.map((id, idx) => {
          const item = byId.get(id);
          if (!item) return null;
          const text = item.text_md;
          return (
            <li className="rs-order-row" key={id}>
              <span className="rs-order-idx">{idx + 1}</span>
              <span className="rs-order-t">
                <MathMarkdown notation={notation}>{text}</MathMarkdown>
              </span>
              <span className="rs-order-ctrls">
                <button
                  type="button"
                  className="rs-order-move"
                  disabled={disabled || idx === 0}
                  aria-label={`上移「${text}」`}
                  ref={(el) => {
                    if (el) moveBtns.current.set(id, el);
                    else moveBtns.current.delete(id);
                  }}
                  onClick={() => move(id, 'up')}
                >
                  <LoomIcon name="chevronDown" size={13} style={{ transform: 'rotate(180deg)' }} />
                </button>
                <button
                  type="button"
                  className="rs-order-move"
                  disabled={disabled || idx === orderedIds.length - 1}
                  aria-label={`下移「${text}」`}
                  onClick={() => move(id, 'down')}
                >
                  <LoomIcon name="chevronDown" size={13} />
                </button>
                <input
                  className="rs-order-pos"
                  inputMode="numeric"
                  aria-label={`「${text}」的目标序号（1 到 ${orderedIds.length}）`}
                  disabled={disabled}
                  value={posDraft[id] ?? String(idx + 1)}
                  onChange={(e) => setPosDraft((d) => ({ ...d, [id]: e.target.value }))}
                  onBlur={() => commitPosition(id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitPosition(id);
                    }
                  }}
                  id={`${baseId}-pos-${idx}`}
                />
              </span>
            </li>
          );
        })}
      </ol>
      {/* 移动播报：polite live region（仓库 live-region 惯例，不加 role=status）。 */}
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
