// 左右配对 tap-answer block (ADR-0074 D3a). Controlled: the learner taps a left item then a right
// item (either order) to link them; the answer goes out as stable id pairs. Wide layouts draw calm
// curved connectors between the columns; narrow layouts stack the columns and show each pair as a
// matching number chip on both items. Presentation and interaction only: it never knows the key.
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { prefersReducedMotion } from '../motion/reduced-motion';
import { DURATION, EASE } from '../tokens';
import type { MatchingCardinality, MatchingItem, MatchingPair, MatchingResponse } from './types';

export interface MatchingBlockProps {
  /** Accessible name of the whole block, e.g. 「第 3 题 配对」. */
  label: string;
  left: MatchingItem[];
  right: MatchingItem[];
  cardinality: MatchingCardinality;
  /** The question says some right items stay unused; only changes the instruction line. */
  distractors?: boolean;
  /** The question's own instruction or scoring note, shown as written. */
  instruction?: string;
  leftHeading?: string;
  rightHeading?: string;
  value: MatchingResponse;
  onChange: (next: MatchingResponse) => void;
  /** Not interactive for now (e.g. while submitting); the answer stays visible. */
  disabled?: boolean;
  /** Submitted: shows the learner's answer read-only. Never shows correctness. */
  submitted?: boolean;
  className?: string;
}

type Side = 'left' | 'right';
type Armed = { side: Side; id: string } | null;
type Status = {
  text: string;
  tone?: 'caution';
  action?: { label: string; run: () => void };
};
type Line = { key: string; d: string; x1: number; y1: number; x2: number; y2: number };

/** Below this block width the columns stack and lines give way to chips (390px phones). */
const STACK_BELOW = 540;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function MatchingBlock({
  label,
  left,
  right,
  cardinality,
  distractors,
  instruction,
  leftHeading = '左列',
  rightHeading = '右列',
  value,
  onChange,
  disabled,
  submitted,
  className,
}: MatchingBlockProps) {
  const readOnly = Boolean(disabled || submitted);
  const uid = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const [stacked, setStacked] = useState(false);
  const [armed, setArmed] = useState<Armed>(null);
  const [focusIndex, setFocusIndex] = useState<Record<Side, number>>({ left: 0, right: 0 });
  const [status, setStatus] = useState<Status | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [hover, setHover] = useState<{ side: Side; id: string } | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  const pairs = value.pairs;
  const leftMarker = useMemo(
    () => new Map(left.map((it, i) => [it.id, it.label ?? String(i + 1)])),
    [left],
  );
  const rightMarker = useMemo(
    () => new Map(right.map((it, i) => [it.id, it.label ?? LETTERS[i] ?? String(i + 1)])),
    [right],
  );
  const leftText = useMemo(() => new Map(left.map((it) => [it.id, it.text])), [left]);
  const rightText = useMemo(() => new Map(right.map((it) => [it.id, it.text])), [right]);
  const leftOrder = useMemo(() => new Map(left.map((it, i) => [it.id, i])), [left]);

  const rightOf = (leftId: string) => pairs.find((p) => p.left_id === leftId)?.right_id;
  const leftsOf = (rightId: string) =>
    pairs
      .filter((p) => p.right_id === rightId)
      .map((p) => p.left_id)
      .sort((a, b) => (leftOrder.get(a) ?? 0) - (leftOrder.get(b) ?? 0));

  const nameOf = (side: Side, id: string) =>
    side === 'left'
      ? `${leftMarker.get(id)}「${leftText.get(id)}」`
      : `${rightMarker.get(id)}「${rightText.get(id)}」`;
  const pairName = (l: string, r: string) => `${nameOf('left', l)} — ${nameOf('right', r)}`;

  // ── Layout: measure the block, stack below the threshold. ─────────────────
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => setStacked(el.getBoundingClientRect().width < STACK_BELOW);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Connectors: recomputed after every render that can move an item. ─────
  const computeLines = useCallback(() => {
    const body = bodyRef.current;
    if (!body || stacked) {
      setLines((prev) => (prev.length ? [] : prev));
      return;
    }
    const origin = body.getBoundingClientRect();
    const next: Line[] = [];
    for (const p of pairs) {
      const a = itemRefs.current.get(`left:${p.left_id}`)?.getBoundingClientRect();
      const b = itemRefs.current.get(`right:${p.right_id}`)?.getBoundingClientRect();
      if (!a || !b) continue;
      const x1 = a.right - origin.left;
      const y1 = a.top + a.height / 2 - origin.top;
      const x2 = b.left - origin.left;
      const y2 = b.top + b.height / 2 - origin.top;
      const dx = Math.max(16, (x2 - x1) * 0.55);
      next.push({
        key: `${p.left_id}\u0000${p.right_id}`,
        d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
        x1,
        y1,
        x2,
        y2,
      });
    }
    setLines((prev) =>
      prev.length === next.length &&
      prev.every((l, i) => l.d === next[i]?.d && l.key === next[i]?.key)
        ? prev
        : next,
    );
  }, [pairs, stacked]);

  useLayoutEffect(() => {
    computeLines();
  });

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => computeLines());
    ro.observe(body);
    let alive = true;
    document.fonts?.ready.then(() => {
      if (alive) computeLines();
    });
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [computeLines]);

  // Draw a new connector in (motion only on change; never on first paint, never when reduced).
  const seenLines = useRef<Set<string> | null>(null);
  const pathRefs = useRef(new Map<string, SVGPathElement>());
  useEffect(() => {
    const keys = new Set(lines.map((l) => l.key));
    const seen = seenLines.current;
    seenLines.current = keys;
    if (!seen || prefersReducedMotion()) return;
    for (const key of keys) {
      if (seen.has(key)) continue;
      pathRefs.current.get(key)?.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], {
        duration: DURATION.ui,
        easing: EASE.glide,
      });
    }
  }, [lines]);

  // Clear transient feedback when the block becomes read-only.
  useEffect(() => {
    if (readOnly) {
      setArmed(null);
      setStatus(null);
    }
  }, [readOnly]);

  useEffect(() => {
    if (!blocked) return;
    const t = window.setTimeout(() => setBlocked(null), 1400);
    return () => window.clearTimeout(t);
  }, [blocked]);

  // ── Answer changes ───────────────────────────────────────────────────────
  const commit = (next: MatchingPair[]) => {
    next.sort((a, b) => (leftOrder.get(a.left_id) ?? 0) - (leftOrder.get(b.left_id) ?? 0));
    onChange({ kind: 'matching', pairs: next });
  };

  const link = (l: string, r: string, from: Side) => {
    if (rightOf(l) === r) {
      commit(pairs.filter((p) => p.left_id !== l));
      setStatus({ text: `已解除：${pairName(l, r)}` });
      return;
    }
    const others = leftsOf(r).filter((x) => x !== l);
    if (cardinality === 'one_to_one' && others.length > 0 && from === 'left') {
      const holder = others[0] as string;
      setBlocked(r);
      setStatus({
        tone: 'caution',
        text: `${nameOf('right', r)} 已经配给了 ${nameOf('left', holder)}。本题一项只配一次。`,
        action: {
          label: `改配给 ${leftMarker.get(l)}`,
          run: () => {
            commit([
              ...pairs.filter((p) => p.left_id !== l && p.right_id !== r),
              { left_id: l, right_id: r },
            ]);
            setStatus({ text: `已配对：${pairName(l, r)}` });
          },
        },
      });
      return;
    }
    let next = pairs.filter((p) => p.left_id !== l);
    if (cardinality === 'one_to_one') next = next.filter((p) => p.right_id !== r);
    commit([...next, { left_id: l, right_id: r }]);
    setStatus({ text: `已配对：${pairName(l, r)}` });
  };

  const unlink = (side: Side, id: string) => {
    const next = pairs.filter((p) => (side === 'left' ? p.left_id !== id : p.right_id !== id));
    setArmed(null);
    if (next.length === pairs.length) {
      setStatus({ text: `${nameOf(side, id)} 还没有配对。` });
      return;
    }
    commit(next);
    setStatus({ text: `已解除 ${nameOf(side, id)} 的配对。` });
  };

  const activate = (side: Side, id: string) => {
    if (readOnly) return;
    if (!armed || armed.side === side) {
      if (armed?.id === id) {
        setArmed(null);
        setStatus(null);
        return;
      }
      setArmed({ side, id });
      const linked = side === 'left' ? [rightOf(id)].filter(Boolean) : leftsOf(id);
      const other = side === 'left' ? '右列' : '左列';
      setStatus({
        text: linked.length
          ? `已选 ${nameOf(side, id)}，现在配着 ${linked
              .map((x) => (side === 'left' ? rightMarker : leftMarker).get(x as string))
              .join('、')}。再点${other}一项换配，点原来那项就解除。`
          : `已选 ${nameOf(side, id)}，再点${other}一项。`,
        action: linked.length ? { label: '解除', run: () => unlink(side, id) } : undefined,
      });
      return;
    }
    const l = side === 'left' ? id : armed.id;
    const r = side === 'right' ? id : armed.id;
    setArmed(null);
    link(l, r, armed.side);
  };

  // ── Keyboard: roving focus inside each column. ───────────────────────────
  const focusItem = (side: Side, index: number) => {
    const list = side === 'left' ? left : right;
    const clamped = Math.max(0, Math.min(list.length - 1, index));
    const id = list[clamped]?.id;
    setFocusIndex((f) => ({ ...f, [side]: clamped }));
    if (id) itemRefs.current.get(`${side}:${id}`)?.focus();
  };

  const onItemKey = (event: KeyboardEvent, side: Side, index: number, id: string) => {
    const list = side === 'left' ? left : right;
    const other: Side = side === 'left' ? 'right' : 'left';
    const toOther = () => {
      const partner = side === 'left' ? rightOf(id) : leftsOf(id)[0];
      const otherList = other === 'left' ? left : right;
      const at = partner ? otherList.findIndex((it) => it.id === partner) : -1;
      focusItem(other, at >= 0 ? at : Math.min(index, otherList.length - 1));
    };
    switch (event.key) {
      case 'ArrowDown':
        focusItem(side, index + 1);
        break;
      case 'ArrowUp':
        focusItem(side, index - 1);
        break;
      case 'Home':
        focusItem(side, 0);
        break;
      case 'End':
        focusItem(side, list.length - 1);
        break;
      case 'ArrowRight':
        if (side === 'left') toOther();
        else return;
        break;
      case 'ArrowLeft':
        if (side === 'right') toOther();
        else return;
        break;
      case 'Delete':
      case 'Backspace':
        unlink(side, id);
        break;
      case 'Escape':
        if (!armed) return;
        setArmed(null);
        setStatus({ text: '已取消选择。' });
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  // ── Render ───────────────────────────────────────────────────────────────
  const highlighted = (side: Side, id: string) => {
    const probe = hover ?? armed;
    if (!probe) return false;
    if (probe.side === side) return probe.id === id;
    return side === 'right' ? rightOf(probe.id) === id : leftsOf(probe.id).includes(id);
  };
  const lineLit = (key: string) => {
    const probe = hover ?? armed;
    if (!probe) return false;
    const [l, r] = key.split('\u0000');
    return probe.side === 'left' ? probe.id === l : probe.id === r;
  };

  const renderItem = (side: Side, item: MatchingItem, index: number) => {
    const marker = (side === 'left' ? leftMarker : rightMarker).get(item.id);
    const linked =
      side === 'left'
        ? [rightOf(item.id)].filter((x): x is string => Boolean(x))
        : leftsOf(item.id);
    const isArmed = armed?.side === side && armed.id === item.id;
    const pairText = linked.length
      ? side === 'left'
        ? `，已配 ${linked.map((r) => nameOf('right', r)).join('')}`
        : `，已配 ${linked.map((l) => nameOf('left', l)).join('、')}`
      : side === 'left'
        ? '，未配对'
        : '，未使用';
    const chips =
      side === 'right' && linked.length > 0 ? (
        <span className="un-match-chips" aria-hidden="true">
          {linked.map((l) => (
            <span key={l} className="un-match-chip">
              {leftMarker.get(l)}
            </span>
          ))}
        </span>
      ) : side === 'left' && stacked && linked[0] ? (
        <span className="un-match-chips" aria-hidden="true">
          <span className="un-match-chip" data-variant="to">
            {rightMarker.get(linked[0])}
          </span>
        </span>
      ) : null;
    const content = (
      <>
        <span className="un-match-marker" aria-hidden="true">
          {marker}
        </span>
        <span className="un-match-text">{item.text}</span>
        {chips}
        <span className="un-sr-only">{pairText}</span>
      </>
    );
    const common = {
      className: 'un-match-item',
      'data-side': side,
      'data-linked': linked.length > 0 || undefined,
      'data-armed': isArmed || undefined,
      'data-lit': highlighted(side, item.id) || undefined,
      'data-blocked': blocked === item.id || undefined,
    };
    const setRef = (el: HTMLElement | null) => {
      const key = `${side}:${item.id}`;
      if (el) itemRefs.current.set(key, el);
      else itemRefs.current.delete(key);
    };
    if (readOnly) {
      return (
        <li key={item.id}>
          <div ref={setRef} {...common}>
            {content}
          </div>
        </li>
      );
    }
    return (
      <li key={item.id}>
        <button
          type="button"
          ref={setRef}
          {...common}
          tabIndex={focusIndex[side] === index ? 0 : -1}
          aria-pressed={isArmed}
          onClick={() => {
            setFocusIndex((f) => ({ ...f, [side]: index }));
            activate(side, item.id);
          }}
          onKeyDown={(e) => onItemKey(e, side, index, item.id)}
          onPointerEnter={(e) => {
            if (e.pointerType === 'mouse') setHover({ side, id: item.id });
          }}
          onPointerLeave={() => setHover(null)}
        >
          {content}
        </button>
      </li>
    );
  };

  const hint = cardinality === 'one_to_one' ? '每项只配一次' : '右列一项可以配给多项';
  const statusLine = (
    <div
      className="un-match-status"
      data-tone={status?.tone}
      data-empty={!status || undefined}
      id={`${uid}-status`}
    >
      <span role="status" aria-live="polite">
        {status?.text ?? ''}
      </span>
      {status?.action && !readOnly ? (
        <button type="button" className="un-answer-link un-hit" onClick={status.action.run}>
          {status.action.label}
        </button>
      ) : null}
    </div>
  );

  const summary = pairs.length
    ? pairs.map((p) => pairName(p.left_id, p.right_id)).join('；')
    : '还没有配对';

  return (
    <section
      ref={rootRef}
      className={['un-answer', 'un-match', className].filter(Boolean).join(' ')}
      aria-label={label}
      data-layout={stacked ? 'stacked' : 'columns'}
      data-mode={submitted ? 'submitted' : disabled ? 'disabled' : 'edit'}
    >
      <header className="un-answer-head">
        <p className="un-answer-instruction">
          {instruction ? <span>{instruction}</span> : null}
          <span className="un-answer-meta">
            {readOnly
              ? submitted
                ? '你的作答（已提交）'
                : '暂不可修改'
              : `先点${leftHeading}一项，再点${rightHeading}一项 · ${hint}${distractors ? ' · 右列有不用的项' : ''}`}
          </span>
        </p>
        <span className="un-answer-count un-num">已配 {pairs.length} 对</span>
      </header>

      <div ref={bodyRef} className="un-match-body">
        <fieldset className="un-match-col">
          <legend className="un-match-col-h">{leftHeading}</legend>
          <ul className="un-match-list">{left.map((it, i) => renderItem('left', it, i))}</ul>
        </fieldset>
        {stacked && !readOnly ? statusLine : null}
        <fieldset className="un-match-col">
          <legend className="un-match-col-h">{rightHeading}</legend>
          <ul className="un-match-list">{right.map((it, i) => renderItem('right', it, i))}</ul>
        </fieldset>
        {stacked ? null : (
          <svg className="un-match-lines" aria-hidden="true">
            {lines.map((l) => (
              <g key={l.key} data-lit={lineLit(l.key) || undefined}>
                <path
                  ref={(el) => {
                    if (el) pathRefs.current.set(l.key, el);
                    else pathRefs.current.delete(l.key);
                  }}
                  d={l.d}
                  pathLength={1}
                  className="un-match-line"
                />
                <circle cx={l.x1} cy={l.y1} r={3} className="un-match-port" />
                <circle cx={l.x2} cy={l.y2} r={3} className="un-match-port" />
              </g>
            ))}
          </svg>
        )}
      </div>

      {stacked || readOnly ? null : statusLine}
      <footer className="un-answer-foot">
        <p className="un-sr-only">当前配对：{summary}</p>
        {readOnly ? null : (
          <button
            type="button"
            className="un-answer-link un-hit"
            disabled={pairs.length === 0}
            onClick={() => {
              commit([]);
              setArmed(null);
              setStatus({ text: '已清除全部配对。' });
            }}
          >
            全部清除
          </button>
        )}
      </footer>
    </section>
  );
}
