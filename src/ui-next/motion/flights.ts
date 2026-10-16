// One-off flights (M4, M6): a shared title grows from where it was into where it lands, and a
// quoted passage travels from the page into a target that may itself be moving. Each answers
// "where did this come from, where did it go". Interrupting a flight restarts from where the
// flying copy is right now; a cancelled flight fades where it is instead of arriving (M3).
// Under reduced motion nothing flies: every change lands at once.
import { prefersReducedMotion } from './reduced-motion';

/** A flying copy passes over every other layer while it moves (T7). */
const Z_FLIGHT = 65;
/** The morph's length (T4: between --un-t-ui and --un-t-panel; one continuous move). */
const FLIGHT_MS = 540;
/** Mirrors --un-ease-spring-soft. */
const EASE_SPRING_SOFT = 'cubic-bezier(0.32, 1.12, 0.48, 1)';

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
    zIndex: String(Z_FLIGHT),
    pointerEvents: 'none',
    transformOrigin: '0 0',
    transform: scale === 1 ? '' : `scale(${scale})`,
  });
  return ghost;
}

/* ── Shared-element morph (M4) ────────────────────────── */

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

/**
 * Before a change, remember where every `[data-morph]` element under `root` sits. `rename` maps a
 * key to the key it should land on (e.g. the title of the next question), or drops it (null).
 */
export function snapshotMorphs(
  root: ParentNode | null,
  rename?: (key: string) => string | null,
): Map<string, MorphSnapshot> {
  const map = new Map<string, MorphSnapshot>();
  if (!root || prefersReducedMotion()) return map;
  for (const el of root.querySelectorAll<HTMLElement>('[data-morph]')) {
    const own = el.dataset.morph;
    const key = own && rename ? rename(own) : own;
    if (!own || !key) continue;
    const inFlight = flying.get(own);
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
  // A list row's own entrance would move the landing spot mid-flight.
  const row = target.closest<HTMLElement>('[data-morph-row]');
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
    duration: FLIGHT_MS,
    easing: EASE_SPRING_SOFT,
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

function dropGhosts(snapshot: Map<string, MorphSnapshot> | null) {
  for (const from of snapshot?.values() ?? []) from.ghost.remove();
}

let pending: (() => void) | null = null;

/** Stop every morph: running flights end, a deferred one that has not launched is undone. */
export function cancelMorphs(): void {
  pending?.();
  pending = null;
  for (const animation of [...flights]) animation.cancel();
}

/**
 * After the change, grow each matching `[data-morph]` element under `root` out of its remembered
 * spot. The landing spots are measured after the new view's first frame, when its layout is done,
 * so the switch never pays for a forced synchronous layout (M4). Until then the old title holds
 * its place and the new one stays hidden, so nothing flashes. Returns a cancel function.
 */
export function playMorphsAfterPaint(
  root: ParentNode | null,
  snapshot: Map<string, MorphSnapshot> | null,
): () => void {
  cancelMorphs();
  if (!root || !snapshot?.size || prefersReducedMotion()) {
    dropGhosts(snapshot);
    return () => {};
  }
  const found = matches(root, snapshot);
  const used = new Set(found.map((f) => f.from));
  for (const from of snapshot.values()) if (!used.has(from)) from.ghost.remove();
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
    // The first callback runs before the new view paints; the second, after it has.
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

interface FlyOptions {
  from: DOMRect | null | undefined;
  /** The landing element, re-read every frame so a moving target is still hit. */
  to: () => Element | null;
  /** The visual that flies; it is positioned and removed by this function. */
  node: HTMLElement;
  /** Where the flying node is attached (a ui-next scope, so it keeps its styles). */
  scope: Element;
  durationMs: number;
  onLand?: () => void;
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Returns `cancel`: the ghost fades where it is and `onLand` is not called. */
function flyTo({ from, to, node, scope, durationMs, onLand }: FlyOptions): () => void {
  if (prefersReducedMotion() || !from || !to()) {
    onLand?.();
    return () => {};
  }
  Object.assign(node.style, {
    position: 'fixed',
    left: `${from.left}px`,
    top: `${from.top}px`,
    margin: '0',
    zIndex: String(Z_FLIGHT),
    pointerEvents: 'none',
    transformOrigin: '0 0',
  });
  scope.append(node);
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
    if (prefersReducedMotion()) {
      node.remove();
      return;
    }
    const fade = node.animate([{ opacity: node.style.opacity || '1' }, { opacity: 0 }], {
      duration: 180,
      fill: 'forwards',
    });
    fade.onfinish = () => node.remove();
    fade.oncancel = () => node.remove();
  };

  const tick = (now: number) => {
    const target = to();
    if (!target?.isConnected) {
      end(true);
      return;
    }
    const r = target.getBoundingClientRect();
    const t = Math.min(1, (now - start) / durationMs);
    const e = easeOut(t);
    const x = from.left + (r.left - from.left) * e;
    const y = from.top + (r.top - from.top) * e;
    node.style.transform = `translate(${x - from.left}px, ${y - from.top}px)`;
    if (t < 1) frame = requestAnimationFrame(tick);
    else end(true);
  };
  frame = requestAnimationFrame(tick);
  return () => end(false);
}

/* ── Quote flight (M6) ────────────────────────────────── */

export interface QuoteFlight {
  /** Where the quoted passage was on the page (e.g. the selection's bounding rect). */
  from: DOMRect | null | undefined;
  /** The quoted text. */
  content: string;
  /** Where it lands (a composer); re-read every frame, since a drawer may be opening. */
  to: () => HTMLElement | null;
  /** The ui-next scope the flying copy is attached to. */
  scope: Element;
  onLand?: () => void;
}

/**
 * A passage leaves the page and lands where the quote is written (M6). The landing spot stays
 * hidden until the copy arrives, so the reader sees one object travel, not two. Reduced motion or
 * no visible target: it lands at once. Returns `cancel` (the copy fades, the target shows).
 */
export function flyQuote({ from, content, to, scope, onLand }: QuoteFlight): () => void {
  const node = document.createElement('span');
  node.className = 'un-quote-ghost';
  node.setAttribute('aria-hidden', 'true');
  node.textContent = content;
  const target = prefersReducedMotion() ? null : to();
  if (target) target.style.visibility = 'hidden';
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    if (target) target.style.visibility = '';
    const landed = to();
    if (landed && landed !== target) landed.style.visibility = '';
  };
  const cancel = flyTo({
    from,
    to,
    node,
    scope,
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
