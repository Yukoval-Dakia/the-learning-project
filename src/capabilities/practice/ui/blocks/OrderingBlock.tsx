// YUK-1497 — ordering input block (presentation spec §1.2, §1.2.1). Each placeable
// (position, object) pair is one item; the answer is the item_ids of the placements made. A partial
// order is a valid answer. Tap an object to drop it into the next empty position it may go to; tap
// a position first to choose where the next object goes. Tapping a placed object takes it back
// out. at_most_per_coordinate ({ position: 1, object: 1 } for a plain sequence) is enforced: a
// filled position swaps its object out, an object already placed elsewhere moves.
// Keyboard: the object tray and the positions are two lists, each one tab stop; arrows move inside
// a list, Enter or Space acts, Delete takes the object out, Escape drops the chosen position.
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';

import { MathMarkdown } from '@/ui/lib/math-markdown';

import { type RelationItem, findPair, link, linkedItems, unlinkAll } from './relation';
import {
  BlockHead,
  type BlockStateProps,
  type BlockStatus,
  InlineMd,
  StatusLine,
  blockMode,
  joinNodes,
  markerText,
  rovingMove,
  shownOutcome,
} from './shared';

export interface OrderingEntry {
  /** Stable axis value id (axes.position / axes.object). */
  id: string;
  label_md: string;
}

export interface OrderingPlacement {
  /** Stable item_id that goes into the answer. */
  id: string;
  position: string;
  object: string;
}

export interface OrderingBlockProps extends BlockStateProps {
  /** Accessible name, e.g. 「第 4 题 排序」. */
  label: string;
  /** Positions in display order (axes.position). */
  positions: OrderingEntry[];
  /** Objects in display order (axes.object). */
  objects: OrderingEntry[];
  /** The universe: every placement allowed. Full cross product or a subset. */
  placements: OrderingPlacement[];
  /** at_most_per_coordinate; a plain sequence is { position: 1, object: 1 }. */
  atMost?: { position?: number; object?: number };
  /** item_ids of the placements made. */
  value: string[];
  onChange: (next: string[]) => void;
  notation?: string | null;
  className?: string;
}

type List = 'tray' | 'slots';

export function OrderingBlock({
  label,
  positions,
  objects,
  placements,
  atMost,
  value,
  onChange,
  notation = null,
  className,
  ...state
}: OrderingBlockProps) {
  const mode = blockMode(state);
  const outcome = shownOutcome(state);
  const interactive = mode === 'edit';
  const uid = useId();

  // a = position, b = object.
  const items: RelationItem[] = placements.map((p) => ({ id: p.id, a: p.position, b: p.object }));
  const limits = { a: atMost?.position, b: atMost?.object };
  const made = linkedItems(items, value);

  const [armedState, setArmed] = useState<string | null>(null); // a position id
  const armed = interactive ? armedState : null;
  const [status, setStatus] = useState<BlockStatus | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [focus, setFocus] = useState<Record<List, number>>({ tray: 0, slots: 0 });
  const nodes = useRef(new Map<string, HTMLElement>());

  const posIndex = (id: string) => positions.findIndex((p) => p.id === id);
  const objMark = (id: string) =>
    markerText(
      'letter',
      objects.findIndex((o) => o.id === id),
    ) ?? '';
  const posName = (id: string) => `第 ${posIndex(id) + 1} 位`;
  const objText = (id: string) => objects.find((o) => o.id === id)?.label_md ?? id;
  // Rendered content, never raw label_md: KaTeX's MathML is what screen readers read.
  const objName = (id: string): ReactNode => (
    <>
      {objMark(id)}「<InlineMd source={objText(id)} notation={notation} />」
    </>
  );
  const inSlot = (positionId: string) => made.filter((m) => m.a === positionId);
  const slotsOf = (objectId: string) => made.filter((m) => m.b === objectId);
  const slotFull = (positionId: string) =>
    limits.a !== undefined && inSlot(positionId).length >= limits.a;
  const objectUsedUp = (objectId: string) =>
    limits.b !== undefined && slotsOf(objectId).length >= limits.b;

  const place = (positionId: string, objectId: string) => {
    const result = link(items, value, 'a', positionId, objectId, limits);
    switch (result.kind) {
      case 'unavailable':
        setStatus({
          tone: 'caution',
          text: (
            <>
              {objName(objectId)} 不能放在{posName(positionId)}。
            </>
          ),
        });
        return;
      case 'unlinked':
        onChange(result.next);
        setStatus({
          text: (
            <>
              已从{posName(positionId)}拿出 {objName(objectId)}。
            </>
          ),
        });
        return;
      case 'linked': {
        onChange(result.next);
        const pair = findPair(items, positionId, objectId);
        if (pair) setFresh(pair.id);
        const out = result.replaced.map((m) => objMark(m.b)).join('、');
        setStatus({
          text: (
            <>
              {objName(objectId)} 放在{posName(positionId)}
              {out ? `，${out} 退回待放区` : ''}。
            </>
          ),
        });
        return;
      }
      case 'full': {
        // The object is already placed elsewhere: moving it is the intent, no confirmation.
        onChange(result.forced);
        const pair = findPair(items, positionId, objectId);
        if (pair) setFresh(pair.id);
        const from = result.holders.map((m) => posName(m.a)).join('、');
        setStatus({
          text: (
            <>
              {objName(objectId)} 从{from}移到{posName(positionId)}。
            </>
          ),
        });
        return;
      }
    }
  };

  const tapObject = (objectId: string) => {
    if (!interactive) return;
    if (armed) {
      setArmed(null);
      place(armed, objectId);
      return;
    }
    if (objectUsedUp(objectId)) {
      onChange(unlinkAll(items, value, 'b', objectId));
      setStatus({ text: <>{objName(objectId)} 已拿回待放区。</> });
      return;
    }
    // Tap-to-place: the first position that is not full and accepts this object.
    const target = positions.find(
      (p) =>
        !slotFull(p.id) &&
        findPair(items, p.id, objectId) &&
        !inSlot(p.id).some((m) => m.b === objectId),
    );
    if (!target) {
      setStatus({
        tone: 'caution',
        text: <>{objName(objectId)} 没有空位可放。先点一个位置，再点它就能换进去。</>,
      });
      return;
    }
    place(target.id, objectId);
  };

  const clearSlot = (positionId: string) => {
    setArmed(null);
    if (inSlot(positionId).length === 0) {
      setStatus({ text: `${posName(positionId)}是空的。` });
      return;
    }
    onChange(unlinkAll(items, value, 'a', positionId));
    setStatus({ text: `已清空${posName(positionId)}。` });
  };

  const tapSlot = (positionId: string) => {
    if (!interactive) return;
    if (armed === positionId) {
      setArmed(null);
      setStatus(null);
      return;
    }
    setArmed(positionId);
    const held = inSlot(positionId);
    setStatus({
      text: held.length
        ? `已选${posName(positionId)}（现在是 ${held.map((m) => objMark(m.b)).join('、')}），点一个对象换进来。`
        : `已选${posName(positionId)}，点一个对象放进来。`,
      action: held.length ? { label: '拿出', run: () => clearSlot(positionId) } : undefined,
    });
  };

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const listOf = (list: List) => (list === 'tray' ? objects : positions);
  const focusAt = (list: List, index: number) => {
    const entries = listOf(list);
    const clamped = Math.max(0, Math.min(entries.length - 1, index));
    setFocus((f) => ({ ...f, [list]: clamped }));
    const id = entries[clamped]?.id;
    if (id) nodes.current.get(`${list}:${id}`)?.focus();
  };
  const onKey = (event: KeyboardEvent, list: List, index: number, id: string) => {
    const move = rovingMove(event.key, index, listOf(list).length);
    if (move !== null) {
      focusAt(list, move);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (list === 'slots') clearSlot(id);
      else if (slotsOf(id).length) tapObject(id);
    } else if (event.key === 'Escape' && armed) {
      setArmed(null);
      setStatus({ text: '已取消选择。' });
    } else {
      return;
    }
    event.preventDefault();
  };
  const setNode = (key: string) => (node: HTMLElement | null) => {
    if (node) nodes.current.set(key, node);
    else nodes.current.delete(key);
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const tray = objects.map((object, index) => {
    const where = slotsOf(object.id);
    const usedUp = objectUsedUp(object.id);
    const disallowed = armed !== null && !findPair(items, armed, object.id);
    const content = (
      <>
        <span className="un-blk-ord-mark" aria-hidden="true">
          {objMark(object.id)}
        </span>
        <MathMarkdown className="un-blk-ord-text" notation={notation}>
          {object.label_md}
        </MathMarkdown>
        {where.length ? (
          <span className="un-blk-ord-where un-num" aria-hidden="true">
            {where.map((m) => posIndex(m.a) + 1).join('、')}
          </span>
        ) : null}
        <span className="un-sr-only">
          {where.length ? `，在${where.map((m) => posName(m.a)).join('、')}` : '，待放'}
        </span>
      </>
    );
    const common = {
      className: 'un-blk-ord-obj',
      'data-placed': where.length > 0 || undefined,
      'data-used-up': usedUp || undefined,
      'data-unavailable': disallowed || undefined,
    };
    return (
      <li key={object.id}>
        {interactive ? (
          <button
            type="button"
            ref={setNode(`tray:${object.id}`)}
            {...common}
            tabIndex={focus.tray === index ? 0 : -1}
            onClick={() => {
              setFocus((f) => ({ ...f, tray: index }));
              tapObject(object.id);
            }}
            onKeyDown={(event) => onKey(event, 'tray', index, object.id)}
          >
            {content}
          </button>
        ) : (
          <div {...common}>{content}</div>
        )}
      </li>
    );
  });

  const slots = positions.map((position, index) => {
    const held = inSlot(position.id);
    const isArmed = armed === position.id;
    const slotOutcome = outcome && held.length ? outcome : undefined;
    const content = (
      <>
        <span className="un-sr-only">{`${posName(position.id)}，`}</span>
        <span className="un-blk-ord-pos" aria-hidden="true">
          <MathMarkdown notation={notation}>{position.label_md}</MathMarkdown>
        </span>
        {/* The placed object's rendered label is the slot's accessible name. */}
        <span className="un-blk-ord-drop">
          {held.length ? (
            held.map((m) => (
              <span
                key={m.id}
                className="un-blk-ord-placed"
                data-fresh={m.id === fresh || undefined}
              >
                <span className="un-blk-ord-mark" aria-hidden="true">
                  {objMark(m.b)}
                </span>
                <MathMarkdown className="un-blk-ord-text" notation={notation}>
                  {objText(m.b)}
                </MathMarkdown>
              </span>
            ))
          ) : (
            <span className="un-blk-ord-empty">{isArmed ? '点一个对象放进来' : '空'}</span>
          )}
        </span>
      </>
    );
    const common = {
      className: 'un-blk-ord-slot',
      'data-filled': held.length > 0 || undefined,
      'data-armed': isArmed || undefined,
      'data-outcome': slotOutcome,
    };
    return (
      <li key={position.id}>
        {interactive ? (
          <button
            type="button"
            ref={setNode(`slots:${position.id}`)}
            {...common}
            aria-pressed={isArmed}
            tabIndex={focus.slots === index ? 0 : -1}
            onClick={() => {
              setFocus((f) => ({ ...f, slots: index }));
              tapSlot(position.id);
            }}
            onKeyDown={(event) => onKey(event, 'slots', index, position.id)}
          >
            {content}
          </button>
        ) : (
          <div {...common}>{content}</div>
        )}
      </li>
    );
  });

  const summary = joinNodes(
    positions.map((p) => {
      const held = inSlot(p.id);
      return (
        <>
          {posName(p.id)}
          {held.length
            ? joinNodes(
                held.map((m) => objName(m.b)),
                '、',
              )
            : '空'}
        </>
      );
    }),
    '；',
  );

  return (
    <section
      className={['un-blk', 'un-blk-ord', className].filter(Boolean).join(' ')}
      aria-label={label}
      aria-describedby={`${uid}-summary`}
      data-mode={mode}
    >
      <BlockHead
        mode={mode}
        hint="点对象依次放入空位 · 先点位置可指定放哪"
        count={`已放 ${made.length} / ${positions.length}`}
        outcome={outcome}
      />
      <div className="un-blk-ord-body">
        <div className="un-blk-ord-col" data-col="tray">
          <h4 className="un-blk-col-h" id={`${uid}-tray`}>
            待放
          </h4>
          <ul className="un-blk-ord-tray" aria-labelledby={`${uid}-tray`}>
            {tray}
          </ul>
        </div>
        <div className="un-blk-ord-col" data-col="slots">
          <h4 className="un-blk-col-h" id={`${uid}-slots`}>
            顺序
          </h4>
          <ol className="un-blk-ord-slots" aria-labelledby={`${uid}-slots`}>
            {slots}
          </ol>
        </div>
      </div>
      <StatusLine status={status} mode={mode} />
      <footer className="un-blk-foot">
        <div id={`${uid}-summary`} className="un-sr-only">
          当前顺序：{summary}
        </div>
        {interactive ? (
          <button
            type="button"
            className="un-blk-link un-hit"
            disabled={made.length === 0}
            onClick={() => {
              onChange([]);
              setArmed(null);
              setStatus({ text: '已全部拿回待放区。' });
            }}
          >
            全部清除
          </button>
        ) : null}
      </footer>
    </section>
  );
}
