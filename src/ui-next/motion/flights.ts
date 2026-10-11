// One-off flights (M3, M4, M6): a shared title grows from where it was into where it lands, and a
// ghost travels from a rect into a target that may itself be moving. Each answers "where did this
// come from, where did it go". Interrupting a flight restarts from where the flying copy is right
// now; a cancelled flight fades where it is instead of arriving. Under reduced motion nothing flies.
import { DURATION, EASE, Z } from '../tokens';
import { prefersReducedMotion } from './reduced-motion';

const TEXT_PROPS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'color',
  'whiteSpace',
  'textOverflow',
  'overflow',
] as const;

function ghostOf(el: HTMLElement, rect: DOMRect, scale = 1): HTMLElement {
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('data-morph');
  // A clone must not duplicate ids (labels, aria references) in the document.
  ghost.removeAttribute('id');
  for (const child of ghost.querySelectorAll('[id]')) child.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  const computed = getComputedStyle(el);
  for (const prop of TEXT_PROPS) ghost.style[prop] = computed[prop];
  Object.assign(ghost.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width / scale}px`,
    margin: '0',
    padding: '0',
    visibility: 'visible',
    zIndex: String(Z.flight),
    pointerEvents: 'none',
    transformOrigin: '0 0',
    transform: scale === 1 ? '' : `scale(${scale})`,
  });
  return ghost;
}

/* ── Shared-element morph ─────────────────────────────── */

export interface MorphSnapshot {
  rect: DOMRect;
  /** The source's visual scale (1 at rest, <1 or >1 if it was itself mid-flight). */
  scale: number;
  fontSize: number;
  ghost: HTMLElement;
}

const flights = new Set<Animation>();
const flying = new Map<string, HTMLElement>();

function onScreen(rect: DOMRect): boolean {
  return rect.width > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight;
}

/** Before a change, remember where every `[data-morph]` element under `root` sits. */
export function snapshotMorphs(root: ParentNode | null): Map<string, MorphSnapshot> {
  const map = new Map<string, MorphSnapshot>();
  if (!root) return map;
  for (const el of root.querySelectorAll<HTMLElement>('[data-morph]')) {
    const key = el.dataset.morph;
    if (!key) continue;
    const inFlight = flying.get(key);
    const source = inFlight?.isConnected ? inFlight : el;
    const rect = source.getBoundingClientRect();
    if (!onScreen(rect)) continue;
    const scale = source === inFlight ? rect.width / (inFlight.offsetWidth || rect.width) : 1;
    map.set(key, {
      rect,
      scale,
      fontSize: Number.parseFloat(getComputedStyle(source).fontSize) * scale,
      ghost: ghostOf(source, rect, scale),
    });
  }
  return map;
}

function scopeOf(el: Element): Element {
  // Stay inside the ui-next scope so the ghosts keep the scoped styles.
  return el.closest('[data-ui-next]') ?? document.body;
}

function hideTarget(target: HTMLElement, key: string) {
  target.style.visibility = 'hidden';
  target.dataset.unMorphOwner = key;
  // A list row's own entrance would move the landing spot mid-flight (L3).
  const row = target.closest<HTMLElement>('li, [data-morph-row]');
  if (row) row.style.animation = 'none';
}

function showTarget(target: HTMLElement, key: string) {
  // Only un-hide the target if no newer flight owns it.
  if (flying.get(key) === undefined && target.dataset.unMorphOwner === key) {
    target.style.visibility = '';
    delete target.dataset.unMorphOwner;
  }
}

/** Fly one title: the new copy grows out of the old spot while the old copy fades along the path. */
function launch(target: HTMLElement, key: string, from: MorphSnapshot) {
  const outgoing = from.ghost;
  const to = target.getBoundingClientRect();
  if (!onScreen(to)) {
    outgoing.remove();
    showTarget(target, key);
    return;
  }
  const s = from.fontSize / Number.parseFloat(getComputedStyle(target).fontSize);
  const dx = from.rect.left - to.left;
  const dy = from.rect.top - to.top;
  const incoming = ghostOf(target, to);
  scopeOf(target).append(outgoing, incoming);
  hideTarget(target, key);
  const timing: KeyframeAnimationOptions = {
    duration: DURATION.flight,
    easing: EASE.springSoft,
    fill: 'both',
  };
  const grow = incoming.animate(
    [
      { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0 },
      { opacity: 1, offset: 0.4 },
      { transform: 'none', opacity: 1 },
    ],
    timing,
  );
  const fade = outgoing.animate(
    [
      { transform: `scale(${from.scale})`, opacity: 1 },
      { opacity: 0, offset: 0.4 },
      { transform: `translate(${-dx}px, ${-dy}px) scale(${from.scale / s})`, opacity: 0 },
    ],
    timing,
  );
  flights.add(grow);
  flying.set(key, incoming);
  const done = () => {
    flights.delete(grow);
    if (flying.get(key) === incoming) flying.delete(key);
    fade.cancel();
    incoming.remove();
    outgoing.remove();
    // cancel/finish fire asynchronously.
    showTarget(target, key);
  };
  grow.onfinish = done;
  grow.oncancel = done;
}

function matches(root: ParentNode, snapshot: Map<string, MorphSnapshot>) {
  const out: { target: HTMLElement; key: string; from: MorphSnapshot }[] = [];
  for (const target of root.querySelectorAll<HTMLElement>('[data-morph]')) {
    const key = target.dataset.morph;
    const from = key ? snapshot.get(key) : undefined;
    if (key && from) out.push({ target, key, from });
  }
  return out;
}

let pending: (() => void) | null = null;

/** Stop every morph: running flights end, a deferred one that has not launched is undone. */
export function cancelMorphs(): void {
  pending?.();
  pending = null;
  for (const animation of [...flights]) animation.cancel();
}

/**
 * After the change, grow each matching `[data-morph]` element out of its remembered spot.
 * Measures the new page in the same frame (forces layout); prefer `playMorphsAfterPaint`.
 */
export function playMorphs(root: ParentNode | null, snapshot: Map<string, MorphSnapshot> | null) {
  cancelMorphs();
  if (!root || !snapshot?.size || prefersReducedMotion()) return;
  for (const { target, key, from } of matches(root, snapshot)) launch(target, key, from);
}

/**
 * The same flight, but the landing spots are measured after the new page's first frame, when its
 * layout is already done, so the switch never pays for a forced synchronous layout (M4: the
 * prototype's slowest step at 4× CPU). Until then the old title holds its place and the new one
 * stays hidden, so nothing flashes. Returns a cancel function.
 */
export function playMorphsAfterPaint(
  root: ParentNode | null,
  snapshot: Map<string, MorphSnapshot> | null,
): () => void {
  cancelMorphs();
  if (!root || !snapshot?.size || prefersReducedMotion()) return () => {};
  const found = matches(root, snapshot);
  if (!found.length) return () => {};
  for (const { target, key, from } of found) {
    scopeOf(target).append(from.ghost);
    hideTarget(target, key);
  }
  let frame = 0;
  const undo = () => {
    if (!frame) return;
    cancelAnimationFrame(frame);
    frame = 0;
    for (const { target, key, from } of found) {
      from.ghost.remove();
      showTarget(target, key);
    }
  };
  frame = requestAnimationFrame(() => {
    // The first callback runs before the new page paints; the second, after it has.
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (pending === undo) pending = null;
      for (const { target, key, from } of found) {
        if (target.isConnected) launch(target, key, from);
        else from.ghost.remove();
      }
    });
  });
  pending = undo;
  return () => {
    if (pending === undo) cancelMorphs();
  };
}

/* ── Homing flight ────────────────────────────────────── */

export interface FlyOptions {
  from: DOMRect | null | undefined;
  /** The landing element, re-read every frame so a moving target is still hit. */
  to: () => Element | null;
  /** The visual that flies; it is positioned and removed by this function. */
  node: HTMLElement;
  /** Arc into a pocket and shrink (capture), instead of gliding onto the target's corner. */
  shrink?: boolean;
  /** Uniform end scale for a glide (text never stretches). */
  scale?: number;
  durationMs?: number;
  onLand?: () => void;
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Returns `cancel`: the ghost fades where it is and `onLand` is not called. */
export function flyTo({
  from,
  to,
  node,
  shrink = false,
  scale = 1,
  durationMs = 620,
  onLand,
}: FlyOptions): () => void {
  if (prefersReducedMotion() || !from || !to()) {
    onLand?.();
    return () => {};
  }
  Object.assign(node.style, {
    position: 'fixed',
    left: `${from.left}px`,
    top: `${from.top}px`,
    margin: '0',
    zIndex: String(Z.flight),
    pointerEvents: 'none',
    transformOrigin: '0 0',
  });
  const landing = to();
  if (landing) scopeOf(landing).append(node);
  const w0 = node.offsetWidth || from.width;
  const h0 = node.offsetHeight || from.height;
  const start = performance.now();
  let frame = 0;
  let ended = false;

  const end = (landed: boolean) => {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(frame);
    if (landed) {
      node.remove();
      onLand?.();
      return;
    }
    const fade = node.animate([{ opacity: node.style.opacity || '1' }, { opacity: 0 }], {
      duration: 180,
      fill: 'forwards',
    });
    fade.onfinish = () => node.remove();
  };

  const tick = (now: number) => {
    const target = to();
    if (!target?.isConnected) {
      end(true);
      return;
    }
    const r = target.getBoundingClientRect();
    const t = Math.min(1, (now - start) / durationMs);
    let x: number;
    let y: number;
    let k: number;
    let opacity = 1;
    if (shrink) {
      const e = easeInOut(t);
      const endX = r.left + r.width / 2 - w0 * 0.09;
      const endY = r.top + r.height / 2 - h0 * 0.09;
      const ctrlX = (from.left + endX) / 2;
      const ctrlY = Math.min(from.top, endY) - 80;
      x = (1 - e) ** 2 * from.left + 2 * (1 - e) * e * ctrlX + e * e * endX;
      y = (1 - e) ** 2 * from.top + 2 * (1 - e) * e * ctrlY + e * e * endY;
      k = 1 - 0.82 * e;
      opacity = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
    } else {
      const e = easeOut(t);
      x = from.left + (r.left - from.left) * e;
      y = from.top + (r.top - from.top) * e;
      k = 1 + (scale - 1) * e;
    }
    node.style.transform = `translate(${x - from.left}px, ${y - from.top}px) scale(${k})`;
    node.style.opacity = String(opacity);
    if (t < 1) frame = requestAnimationFrame(tick);
    else end(true);
  };
  frame = requestAnimationFrame(tick);
  return () => end(false);
}

/** A small spring "bump" on whatever received something. */
export function bump(el: Element | null): void {
  if (!el || prefersReducedMotion()) return;
  el.animate(
    [
      { transform: 'scale(1)' },
      { transform: 'scale(1.22)', offset: 0.35 },
      { transform: 'scale(1)' },
    ],
    { duration: 420, easing: EASE.spring },
  );
}

/* ── Named flights ────────────────────────────────────── */

export interface QuoteFlight {
  /** Where the quoted passage was on the page (e.g. the selection's bounding rect). */
  from: DOMRect | null | undefined;
  /** What flies: the quoted text, or a node (e.g. rendered math). */
  content: string | Node;
  /** The quote in the conversation it lands as; re-read every frame (the panel may be opening). */
  to: () => HTMLElement | null;
  onLand?: () => void;
}

/**
 * A passage leaves the page and lands as the quote in a new message (M6). The landing quote stays
 * hidden until the copy arrives, so the reader sees one object travel, not two. Returns `cancel`.
 */
export function flyQuote({ from, content, to, onLand }: QuoteFlight): () => void {
  const node = document.createElement('span');
  node.className = 'un-quote-ghost';
  node.setAttribute('aria-hidden', 'true');
  if (typeof content === 'string') node.textContent = content;
  else node.append(content);
  const target = to();
  if (target) target.style.visibility = 'hidden';
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    const landed = to() ?? target;
    if (landed) landed.style.visibility = '';
  };
  const cancel = flyTo({
    from,
    to,
    node,
    durationMs: 700,
    onLand: () => {
      show();
      onLand?.();
    },
  });
  return () => {
    cancel();
    show();
  };
}

export interface CaptureFlight {
  /** Where the captured thing was written (the input's rect). */
  from: DOMRect | null | undefined;
  text: string;
  /** The pocket it goes into: "收进来的" on desktop, the tab bar's "记一下" on phones. */
  to: () => Element | null;
  /** Count it here (the pocket bumps first). Not called when the flight is cancelled. */
  onLand?: () => void;
}

/**
 * Something written down arcs into its pocket and shrinks (M5); on landing the pocket gives a
 * small bump. Cancelling (e.g. undo mid-flight) fades the chip where it is and never counts it.
 */
export function flyCapture({ from, text, to, onLand }: CaptureFlight): () => void {
  const node = document.createElement('span');
  node.className = 'un-fly-chip';
  node.setAttribute('aria-hidden', 'true');
  node.textContent = text;
  return flyTo({
    from,
    to,
    node,
    shrink: true,
    durationMs: 660,
    onLand: () => {
      bump(to());
      onLand?.();
    },
  });
}
