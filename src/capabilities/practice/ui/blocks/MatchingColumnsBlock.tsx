// YUK-1497 — matching_columns input block (presentation spec §1.2; R10 配对). Tap a left item then
// a right item (either order) to make a pair; the answer is the item_id of each pair that exists in
// the universe. Tapping a made pair again undoes it. at_most_per_coordinate is enforced here: an
// armed item at a limit of 1 is re-paired, a full target gets a calm caution line with
// 「改配给 X」 (no shaking). Wide blocks draw curved connectors, only the new one draws in; below
// 540px (container query) the columns stack, lines give way to matching number chips.
import { type KeyboardEvent, useCallback, useId, useRef, useState } from 'react';

import { MathMarkdown } from '@/ui/lib/math-markdown';

import {
  type LinkResult,
  type RelationItem,
  type Side,
  findPair,
  link,
  linkedItems,
  other,
  unlinkAll,
} from './relation';
import {
  BlockHead,
  type BlockStateProps,
  type BlockStatus,
  StatusLine,
  blockMode,
  markerText,
  rovingMove,
  shownOutcome,
} from './shared';

export interface MatchingEntry {
  /** Stable axis value id (axes.left / axes.right). */
  id: string;
  label_md: string;
}

export interface MatchingPairItem {
  /** Stable item_id that goes into the answer. */
  id: string;
  left: string;
  right: string;
}

export interface MatchingColumnsBlockProps extends BlockStateProps {
  /** Accessible name, e.g. 「第 3 题 配对」. */
  label: string;
  left: MatchingEntry[];
  right: MatchingEntry[];
  /** The universe: every pair the learner may make. Full cross product or a subset. */
  pairs: MatchingPairItem[];
  /** at_most_per_coordinate; one-to-one is { left: 1, right: 1 }. */
  atMost?: { left?: number; right?: number };
  /** item_ids of the pairs made. */
  value: string[];
  onChange: (next: string[]) => void;
  leftHeading?: string;
  rightHeading?: string;
  notation?: string | null;
  className?: string;
}

type Armed = { side: Side; id: string } | null;
type Box = { top: number; bottom: number; left: number; right: number };

export function MatchingColumnsBlock({
  label,
  left,
  right,
  pairs,
  atMost,
  value,
  onChange,
  leftHeading = '左列',
  rightHeading = '右列',
  notation = null,
  className,
  ...state
}: MatchingColumnsBlockProps) {
  const mode = blockMode(state);
  const outcome = shownOutcome(state);
  const interactive = mode === 'edit';
  const uid = useId();

  const items: RelationItem[] = pairs.map((p) => ({ id: p.id, a: p.left, b: p.right }));
  const limits = { a: atMost?.left, b: atMost?.right };
  const made = linkedItems(items, value);
  const lists: Record<Side, MatchingEntry[]> = { a: left, b: right };

  const [armedState, setArmed] = useState<Armed>(null);
  const armed = interactive ? armedState : null;
  const [status, setStatus] = useState<BlockStatus | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [hover, setHover] = useState<{ side: Side; id: string } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState<Record<Side, number>>({ a: 0, b: 0 });

  const marker = (side: Side, id: string) => {
    const index = lists[side].findIndex((entry) => entry.id === id);
    return side === 'a' ? String(index + 1) : (markerText('letter', index) ?? '');
  };
  const text = (side: Side, id: string) =>
    lists[side].find((entry) => entry.id === id)?.label_md ?? id;
  const nameOf = (side: Side, id: string) => `${marker(side, id)}「${text(side, id)}」`;
  const pairName = (item: RelationItem) => `${nameOf('a', item.a)} — ${nameOf('b', item.b)}`;
  const partners = (side: Side, id: string) =>
    made.filter((item) => item[side] === id).map((item) => item[other(side)]);

  // ── Connector geometry: measured by a ResizeObserver owned by the body node. ──
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const itemNodes = useRef(new Map<string, HTMLElement>());
  const entryKey = `${left.map((e) => e.id).join('\u0001')}\u0000${right.map((e) => e.id).join('\u0001')}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe when the entries or the item elements change (entryKey, interactive).
  const bodyRef = useCallback(
    (body: HTMLDivElement | null) => {
      if (!body || typeof ResizeObserver === 'undefined') return undefined;
      const measure = () => {
        const origin = body.getBoundingClientRect();
        const next: Record<string, Box> = {};
        for (const [key, node] of itemNodes.current) {
          const r = node.getBoundingClientRect();
          next[key] = {
            top: r.top - origin.top,
            bottom: r.bottom - origin.top,
            left: r.left - origin.left,
            right: r.right - origin.left,
          };
        }
        setBoxes((prev) => (sameBoxes(prev, next) ? prev : next));
      };
      const observer = new ResizeObserver(measure);
      observer.observe(body);
      for (const node of itemNodes.current.values()) observer.observe(node);
      return () => observer.disconnect();
    },
    [entryKey, interactive],
  );

  // ── Answer changes ───────────────────────────────────────────────────────
  const apply = (result: LinkResult, armedSide: Side, armedId: string, targetId: string) => {
    const pair =
      armedSide === 'a' ? findPair(items, armedId, targetId) : findPair(items, targetId, armedId);
    switch (result.kind) {
      case 'unavailable':
        setStatus({
          tone: 'caution',
          text: `${nameOf(armedSide, armedId)} 和 ${nameOf(other(armedSide), targetId)} 不能相连。`,
        });
        return;
      case 'unlinked':
        onChange(result.next);
        if (pair) setStatus({ text: `已解除：${pairName(pair)}` });
        return;
      case 'linked':
        onChange(result.next);
        if (pair) {
          setFresh(pair.id);
          setStatus({
            text: `已配对：${pairName(pair)}${
              result.replaced.length
                ? `（原来配的 ${result.replaced
                    .map((item) => marker(other(armedSide), item[other(armedSide)]))
                    .join('、')} 已换掉）`
                : ''
            }`,
          });
        }
        return;
      case 'full': {
        const fullId = result.side === armedSide ? armedId : targetId;
        const limit = limits[result.side] ?? 1;
        const holders = result.holders
          .map((item) => nameOf(other(result.side), item[other(result.side)]))
          .join('、');
        setBlocked(`${result.side}:${fullId}`);
        setStatus({
          tone: 'caution',
          text:
            limit === 1
              ? `${nameOf(result.side, fullId)} 已经配给了 ${holders}。本题一项只配一次。`
              : `${nameOf(result.side, fullId)} 已经配了 ${holders}，本题最多配 ${limit} 项。`,
          action: {
            label: `改配给 ${marker(other(result.side), result.side === armedSide ? targetId : armedId)}`,
            run: () => {
              onChange(result.forced);
              setBlocked(null);
              if (pair) {
                setFresh(pair.id);
                setStatus({ text: `已配对：${pairName(pair)}` });
              }
            },
          },
        });
        return;
      }
    }
  };

  const unlinkSide = (side: Side, id: string) => {
    setArmed(null);
    setBlocked(null);
    const next = unlinkAll(items, value, side, id);
    if (next.length === made.length) {
      setStatus({ text: `${nameOf(side, id)} 还没有配对。` });
      return;
    }
    onChange(next);
    setStatus({ text: `已解除 ${nameOf(side, id)} 的配对。` });
  };

  const activate = (side: Side, id: string) => {
    if (!interactive) return;
    setBlocked(null);
    if (!armed || armed.side === side) {
      if (armed?.id === id) {
        setArmed(null);
        setStatus(null);
        return;
      }
      setArmed({ side, id });
      const linked = partners(side, id);
      const otherName = side === 'a' ? rightHeading : leftHeading;
      setStatus({
        text: linked.length
          ? `已选 ${nameOf(side, id)}，现在配着 ${linked
              .map((x) => marker(other(side), x))
              .join('、')}。再点${otherName}一项换配，点原来那项就解除。`
          : `已选 ${nameOf(side, id)}，再点${otherName}一项。`,
        action: linked.length ? { label: '解除', run: () => unlinkSide(side, id) } : undefined,
      });
      return;
    }
    setArmed(null);
    apply(link(items, value, armed.side, armed.id, id, limits), armed.side, armed.id, id);
  };

  // ── Keyboard: roving focus inside each column, ←/→ jump to the partner. ──
  const focusItem = (side: Side, index: number) => {
    const list = lists[side];
    const clamped = Math.max(0, Math.min(list.length - 1, index));
    const id = list[clamped]?.id;
    setFocusIndex((f) => ({ ...f, [side]: clamped }));
    if (id) itemNodes.current.get(`${side}:${id}`)?.focus();
  };

  const onItemKey = (event: KeyboardEvent, side: Side, index: number, id: string) => {
    const move = rovingMove(
      event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? '' : event.key,
      index,
      lists[side].length,
    );
    if (move !== null) {
      focusItem(side, move);
    } else if (
      (event.key === 'ArrowRight' && side === 'a') ||
      (event.key === 'ArrowLeft' && side === 'b')
    ) {
      const target = other(side);
      const partner = partners(side, id)[0];
      const at = partner ? lists[target].findIndex((e) => e.id === partner) : -1;
      focusItem(target, at >= 0 ? at : Math.min(index, lists[target].length - 1));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      unlinkSide(side, id);
    } else if (event.key === 'Escape' && armed) {
      setArmed(null);
      setStatus({ text: '已取消选择。' });
    } else {
      return;
    }
    event.preventDefault();
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const probe = hover ?? armed;
  const lit = (side: Side, id: string) => {
    if (!probe) return false;
    if (probe.side === side) return probe.id === id;
    return partners(probe.side, probe.id).includes(id);
  };
  const unavailable = (side: Side, id: string) =>
    armed !== null &&
    armed.side !== side &&
    !(side === 'b' ? findPair(items, armed.id, id) : findPair(items, id, armed.id));

  const renderItem = (side: Side, entry: MatchingEntry, index: number) => {
    const linked = partners(side, entry.id);
    const key = `${side}:${entry.id}`;
    const isArmed = armed?.side === side && armed.id === entry.id;
    const pairText = linked.length
      ? `，已配 ${linked.map((x) => nameOf(other(side), x)).join('、')}`
      : side === 'a'
        ? '，未配对'
        : '，未使用';
    const chips =
      linked.length > 0 ? (
        <span
          className="un-blk-match-chips"
          data-side={side === 'a' ? 'left' : 'right'}
          aria-hidden="true"
        >
          {linked.map((x) => (
            <span
              key={x}
              className="un-blk-match-chip"
              data-variant={side === 'a' ? 'to' : undefined}
            >
              {marker(other(side), x)}
            </span>
          ))}
        </span>
      ) : null;
    const itemOutcome = outcome && linked.length > 0 ? outcome : undefined;
    const content = (
      <>
        <span className="un-blk-match-marker" aria-hidden="true">
          {marker(side, entry.id)}
        </span>
        <MathMarkdown className="un-blk-match-text" notation={notation}>
          {entry.label_md}
        </MathMarkdown>
        {chips}
        <span className="un-sr-only">{pairText}</span>
      </>
    );
    const common = {
      className: 'un-blk-match-item',
      'data-linked': linked.length > 0 || undefined,
      'data-armed': isArmed || undefined,
      'data-lit': lit(side, entry.id) || undefined,
      'data-blocked': blocked === key || undefined,
      'data-unavailable': unavailable(side, entry.id) || undefined,
      'data-outcome': itemOutcome,
    };
    const setNode = (node: HTMLElement | null) => {
      if (node) itemNodes.current.set(key, node);
      else itemNodes.current.delete(key);
    };
    if (!interactive) {
      return (
        <li key={entry.id}>
          <div ref={setNode} {...common}>
            {content}
          </div>
        </li>
      );
    }
    return (
      <li key={entry.id}>
        <button
          type="button"
          ref={setNode}
          {...common}
          tabIndex={focusIndex[side] === index ? 0 : -1}
          aria-pressed={isArmed}
          onClick={() => {
            setFocusIndex((f) => ({ ...f, [side]: index }));
            activate(side, entry.id);
          }}
          onKeyDown={(event) => onItemKey(event, side, index, entry.id)}
          onPointerEnter={(event) => {
            if (event.pointerType === 'mouse') setHover({ side, id: entry.id });
          }}
          onPointerLeave={() => setHover(null)}
        >
          {content}
        </button>
      </li>
    );
  };

  const lines = made.flatMap((item) => {
    const a = boxes[`a:${item.a}`];
    const b = boxes[`b:${item.b}`];
    if (!a || !b) return [];
    const x1 = a.right;
    const y1 = (a.top + a.bottom) / 2;
    const x2 = b.left;
    const y2 = (b.top + b.bottom) / 2;
    if (x2 <= x1) return []; // stacked: no room between the columns
    const dx = Math.max(16, (x2 - x1) * 0.55);
    return [
      {
        item,
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        x1,
        y1,
        x2,
        y2,
      },
    ];
  });
  const lineLit = (item: RelationItem) =>
    probe ? (probe.side === 'a' ? probe.id === item.a : probe.id === item.b) : false;

  const limitHint =
    limits.a === 1 && limits.b === 1
      ? '每项只配一次'
      : limits.b === 1
        ? `${rightHeading}每项只配一次`
        : limits.a === 1
          ? `${leftHeading}每项只配一次`
          : '一项可以配多项';
  const summary = made.length ? made.map(pairName).join('；') : '还没有配对';

  return (
    <section
      className={['un-blk', 'un-blk-match', className].filter(Boolean).join(' ')}
      aria-label={label}
      aria-describedby={`${uid}-summary`}
      data-mode={mode}
    >
      <BlockHead
        mode={mode}
        hint={`先点一边一项，再点另一边一项 · ${limitHint}`}
        count={`已配 ${made.length} 对`}
        outcome={outcome}
      />

      <div ref={bodyRef} className="un-blk-match-body">
        <fieldset className="un-blk-match-col" data-col="left">
          <legend className="un-blk-col-h">{leftHeading}</legend>
          <ul className="un-blk-match-list">{left.map((e, i) => renderItem('a', e, i))}</ul>
        </fieldset>
        <fieldset className="un-blk-match-col" data-col="right">
          <legend className="un-blk-col-h">{rightHeading}</legend>
          <ul className="un-blk-match-list">{right.map((e, i) => renderItem('b', e, i))}</ul>
        </fieldset>
        <svg className="un-blk-match-lines" aria-hidden="true">
          {lines.map((l) => (
            <g
              key={l.item.id}
              data-lit={lineLit(l.item) || undefined}
              data-fresh={l.item.id === fresh || undefined}
            >
              <path d={l.d} pathLength={1} className="un-blk-match-line" />
              <circle cx={l.x1} cy={l.y1} r={3} className="un-blk-match-port" />
              <circle cx={l.x2} cy={l.y2} r={3} className="un-blk-match-port" />
            </g>
          ))}
        </svg>
      </div>

      <StatusLine status={status} mode={mode} />
      <footer className="un-blk-foot">
        <p id={`${uid}-summary`} className="un-sr-only">
          当前配对：{summary}
        </p>
        {interactive ? (
          <button
            type="button"
            className="un-blk-link un-hit"
            disabled={made.length === 0}
            onClick={() => {
              onChange([]);
              setArmed(null);
              setBlocked(null);
              setStatus({ text: '已清除全部配对。' });
            }}
          >
            全部清除
          </button>
        ) : null}
      </footer>
    </section>
  );
}

function sameBoxes(a: Record<string, Box>, b: Record<string, Box>): boolean {
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length) return false;
  return keys.every((key) => {
    const x = a[key];
    const y = b[key];
    return (
      x !== undefined &&
      y !== undefined &&
      Math.abs(x.top - y.top) < 0.5 &&
      Math.abs(x.bottom - y.bottom) < 0.5 &&
      Math.abs(x.left - y.left) < 0.5 &&
      Math.abs(x.right - y.right) < 0.5
    );
  });
}
