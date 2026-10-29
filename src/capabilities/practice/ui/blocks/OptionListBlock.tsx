// YUK-1497 — option_list input block (presentation spec §1.2): single or multi pick from a frozen
// list. Options render in the order they arrive (issuance option_order, else declaration order);
// `marker` only changes what is printed beside each option, never which item_id is sent.
// Keyboard: one tab stop, arrows move (single pick follows focus, the ARIA radio pattern), Space or
// Enter toggles, digits 1–9 pick the option at that display position while focus is in the list.

import { type KeyboardEvent, useRef, useState } from 'react';
import { withoutLabelPrefix } from '@/ui/components/response/response-types';

import { MathMarkdown } from '@/ui/lib/math-markdown';

import {
  BlockHead,
  type BlockStateProps,
  blockMode,
  markerText,
  rovingMove,
  shownOutcome,
} from './shared';

export interface OptionListItem {
  /** Stable item_id; the only thing that goes into the answer. */
  id: string;
  label_md: string;
}

export interface OptionListBlockProps extends BlockStateProps {
  /** Accessible name, e.g. 「第 3 题 选项」. */
  label: string;
  /** In frozen display order. */
  items: OptionListItem[];
  pick: 'one' | 'many';
  layout?: 'vertical' | 'grid' | 'inline';
  marker?: 'letter' | 'number' | 'none';
  /** Selected item_ids. */
  value: string[];
  onChange: (next: string[]) => void;
  /** Subject notation for MathMarkdown (server-resolved). */
  notation?: string | null;
  className?: string;
}

export function OptionListBlock({
  label,
  items,
  pick,
  layout = 'vertical',
  marker = 'letter',
  value,
  onChange,
  notation = null,
  className,
  ...state
}: OptionListBlockProps) {
  const mode = blockMode(state);
  const outcome = shownOutcome(state);
  const interactive = mode === 'edit';
  const selected = new Set(value);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [active, setActive] = useState<string | null>(null);

  // The single tab stop: last focused option, else the first selected one, else the first option.
  const tabStop =
    (active && items.some((item) => item.id === active) ? active : null) ??
    items.find((item) => selected.has(item.id))?.id ??
    items[0]?.id;

  const choose = (id: string) => {
    if (!interactive) return;
    if (pick === 'one') {
      if (!selected.has(id) || value.length !== 1) onChange([id]);
      return;
    }
    // Answer order follows display order, so the same choice always gives the same envelope.
    const next = selected.has(id) ? value.filter((x) => x !== id) : [...value, id];
    const keep = new Set(next);
    onChange(items.filter((item) => keep.has(item.id)).map((item) => item.id));
  };

  const focusAt = (index: number) => {
    const id = items[index]?.id;
    if (!id) return;
    setActive(id);
    buttons.current.get(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || event.ctrlKey || event.metaKey || event.altKey) return;
    const index = items.findIndex((item) => item.id === (active ?? tabStop));
    if (/^[1-9]$/.test(event.key)) {
      const at = Number(event.key) - 1;
      const id = items[at]?.id;
      if (!id) return;
      event.preventDefault();
      focusAt(at);
      choose(id);
      return;
    }
    const next = rovingMove(event.key, Math.max(0, index), items.length);
    if (next === null) return;
    event.preventDefault();
    focusAt(next);
    if (pick === 'one') {
      const id = items[next]?.id;
      if (id) choose(id);
    }
  };

  const count = pick === 'many' && value.length > 0 ? `已选 ${value.length} 项` : undefined;

  return (
    <div
      className={['un-blk', 'un-blk-opts', className].filter(Boolean).join(' ')}
      data-mode={mode}
    >
      <BlockHead
        mode={mode}
        hint={pick === 'one' ? '选一项 · 数字键直选' : '可选多项 · 再点一次取消'}
        count={count}
        outcome={outcome}
      />
      {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: role is radiogroup or group by `pick`; Biome cannot read a conditional role. The key handler serves the options inside. */}
      <div
        className="un-blk-opts-list"
        role={pick === 'one' ? 'radiogroup' : 'group'}
        aria-label={label}
        aria-disabled={!interactive || undefined}
        data-layout={layout}
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => {
          const isOn = selected.has(item.id);
          const mark = markerText(marker, index);
          return (
            // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is radio or checkbox by `pick` (Biome cannot read a conditional role); rich MathMarkdown options cannot live in native inputs.
            <button
              key={item.id}
              ref={(node) => {
                if (node) buttons.current.set(item.id, node);
                else buttons.current.delete(item.id);
              }}
              type="button"
              className="un-blk-opt"
              role={pick === 'one' ? 'radio' : 'checkbox'}
              aria-checked={isOn}
              disabled={!interactive}
              tabIndex={item.id === tabStop ? 0 : -1}
              data-on={isOn || undefined}
              data-pick={pick}
              data-outcome={isOn && outcome ? outcome : undefined}
              onClick={() => {
                setActive(item.id);
                choose(item.id);
              }}
              onFocus={() => setActive(item.id)}
            >
              <span
                className="un-blk-opt-mark"
                data-empty={mark === null || undefined}
                aria-hidden="true"
              >
                {mark}
              </span>
              <MathMarkdown className="un-blk-opt-text" notation={notation}>
                {mark
                  ? withoutLabelPrefix(withoutLabelPrefix(item.label_md, mark), mark)
                  : item.label_md}
              </MathMarkdown>
            </button>
          );
        })}
      </div>
    </div>
  );
}
