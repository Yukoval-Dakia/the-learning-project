// Seamless-motion helpers. Each one answers "where did this come from, where did it go":
// it only runs on a state change, can be interrupted, and becomes an instant change under
// prefers-reduced-motion.
export const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SPRING = 'cubic-bezier(0.32, 1.12, 0.48, 1)';
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;

const TEXT_PROPS = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'whiteSpace', 'textOverflow', 'overflow'];

function copyText(from, to) {
  const cs = getComputedStyle(from);
  for (const p of TEXT_PROPS) to.style[p] = cs[p];
}

// `k` is the ghost's own visual scale: 1 for a resting title, the current in-flight scale for a
// ghost that is itself still flying.
function ghostOf(el, rect, k = 1) {
  const g = el.cloneNode(true);
  g.removeAttribute('data-morph');
  copyText(el, g);
  Object.assign(g.style, {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width / k}px`,
    visibility: 'visible',
    transform: k === 1 ? '' : `scale(${k})`,
    margin: '0',
    padding: '0',
    zIndex: '60',
    pointerEvents: 'none',
    transformOrigin: '0 0',
    willChange: 'transform, opacity',
  });
  return g;
}

/* ── Shared-element morph ─────────────────────────────── */
// Before a route change, remember where every [data-morph] element sits and what it looks like.
// If that title is still mid-flight from the previous change, start from where the flying copy
// is right now, so an interrupted morph continues instead of jumping.
export function snapshotMorphs(root) {
  const map = new Map();
  if (!root) return map;
  for (const el of root.querySelectorAll('[data-morph]')) {
    const flying = live.get(el.dataset.morph);
    const src = flying?.isConnected ? flying : el;
    const rect = src.getBoundingClientRect();
    if (!rect.width || rect.bottom < 0 || rect.top > window.innerHeight) continue;
    const k = src === flying ? rect.width / (flying.offsetWidth || rect.width) : 1;
    map.set(el.dataset.morph, { rect, k, fs: Number.parseFloat(getComputedStyle(src).fontSize) * k, ghost: ghostOf(src, rect, k) });
  }
  return map;
}

const flights = new Set();
const live = new Map(); // morph key → the incoming ghost currently flying

// After the new page mounts, the matching element grows out of where the old one was;
// the old one crossfades away along the same path.
export function playMorphs(root, snap) {
  for (const a of [...flights]) a.cancel();
  if (!root || !snap?.size || reduced()) return;
  for (const target of root.querySelectorAll('[data-morph]')) {
    const from = snap.get(target.dataset.morph);
    if (!from) continue;
    // A list row's own entrance would move the landing spot mid-flight.
    const li = target.closest('li');
    if (li) li.style.animation = 'none';
    const to = target.getBoundingClientRect();
    if (!to.width || to.top > window.innerHeight) continue;
    const s = from.fs / Number.parseFloat(getComputedStyle(target).fontSize);
    const dx = from.rect.left - to.left;
    const dy = from.rect.top - to.top;
    const incoming = ghostOf(target, to);
    const outgoing = from.ghost;
    document.body.append(outgoing, incoming);
    target.style.visibility = 'hidden';
    const opts = { duration: 540, easing: SPRING, fill: 'both' };
    const a = incoming.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0 },
        { opacity: 1, offset: 0.4 },
        { transform: 'none', opacity: 1 },
      ],
      opts,
    );
    const b = outgoing.animate(
      [
        { transform: `scale(${from.k})`, opacity: 1 },
        { opacity: 0, offset: 0.4 },
        { transform: `translate(${-dx}px, ${-dy}px) scale(${from.k / s})`, opacity: 0 },
      ],
      opts,
    );
    flights.add(a);
    live.set(target.dataset.morph, incoming);
    const done = () => {
      flights.delete(a);
      if (live.get(target.dataset.morph) === incoming) live.delete(target.dataset.morph);
      b.cancel();
      incoming.remove();
      outgoing.remove();
      target.style.visibility = '';
    };
    a.onfinish = done;
    a.oncancel = done;
  }
}

/* ── Homing flight ────────────────────────────────────── */
// A ghost travels from a rect to an element, re-measuring the element every frame so it still
// lands if the target is itself moving (a panel opening, a list settling).
// `shrink` throws the ghost into a pocket; otherwise it glides onto the target's top-left corner,
// scaling uniformly (text never stretches) by `scale`.
export function flyTo({ from, to, node, shrink = false, scale = 1, duration = 620, onLand }) {
  const target = typeof to === 'function' ? to : () => to;
  if (reduced() || !from || !target()) {
    onLand?.();
    return () => {};
  }
  const g = node;
  Object.assign(g.style, {
    position: 'fixed',
    left: `${from.left}px`,
    top: `${from.top}px`,
    margin: '0',
    zIndex: '60',
    pointerEvents: 'none',
    transformOrigin: '0 0',
    willChange: 'transform, opacity',
  });
  document.body.append(g);
  const w0 = g.offsetWidth || from.width;
  const h0 = g.offsetHeight || from.height;
  const t0 = performance.now();
  let raf = 0;
  let stopped = false;
  const end = (landed) => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    if (landed) {
      g.remove();
      onLand?.();
      return;
    }
    // Cancelled (e.g. undone mid-flight): the copy fades where it is instead of arriving.
    g.animate([{ opacity: g.style.opacity || 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' }).onfinish = () => g.remove();
  };
  const tick = (now) => {
    const el = target();
    if (!el) return end(true);
    const r = el.getBoundingClientRect();
    const t = Math.min(1, (now - t0) / duration);
    let x;
    let y;
    let sx;
    let sy;
    let o = 1;
    if (shrink) {
      // Arc into the pocket: a quadratic curve that lifts, then drops in.
      const e = easeInOut(t);
      const ex = r.left + r.width / 2 - w0 * 0.09;
      const ey = r.top + r.height / 2 - h0 * 0.09;
      const cx = (from.left + ex) / 2;
      const cy = Math.min(from.top, ey) - 80;
      x = (1 - e) ** 2 * from.left + 2 * (1 - e) * e * cx + e * e * ex;
      y = (1 - e) ** 2 * from.top + 2 * (1 - e) * e * cy + e * e * ey;
      sx = sy = 1 - 0.82 * e;
      o = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
    } else {
      const e = easeOut(t);
      x = from.left + (r.left - from.left) * e;
      y = from.top + (r.top - from.top) * e;
      sx = sy = 1 + (scale - 1) * e;
    }
    g.style.transform = `translate(${x - from.left}px, ${y - from.top}px) scale(${sx}, ${sy})`;
    g.style.opacity = String(o);
    if (t < 1) raf = requestAnimationFrame(tick);
    else end(true);
  };
  raf = requestAnimationFrame(tick);
  return () => end(false);
}

// A small spring "bump" on whatever received something.
export function bump(el) {
  if (!el || reduced()) return;
  el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.22)', offset: 0.35 }, { transform: 'scale(1)' }], { duration: 420, easing: SPRING });
}

/* ── Reveal ───────────────────────────────────────────── */
// Bring a referenced passage into view and let it glow once.
const glows = new WeakMap();

export function reveal(scroller, el, { block = 'center' } = {}) {
  if (!scroller || !el) return;
  el.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block });
  window.clearTimeout(glows.get(el));
  el.classList.remove('is-flash');
  // Restart the glow even if it is mid-way through a previous one.
  void el.offsetWidth;
  el.classList.add('is-flash');
  glows.set(el, window.setTimeout(() => el.classList.remove('is-flash'), 1800));
}

/* ── Reading position ─────────────────────────────────── */
// While a side panel opens or closes, the reading column reflows on every frame. Pin the
// paragraph at the reading line so the words under your eyes stay put. A wheel, touch or key
// hands control straight back to the reader.
const BLOCKS = 'p, li, h1, h2, dt, dd, figure, .card, .row, .lib-row, .step';

export function holdReadingPosition(scroller, ms = 560) {
  if (!scroller || scroller.scrollTop < 4) return () => {};
  const box = scroller.getBoundingClientRect();
  const line = box.top + Math.min(140, box.height * 0.25);
  let anchor = null;
  for (const el of scroller.querySelectorAll(BLOCKS)) {
    const r = el.getBoundingClientRect();
    if (r.height && r.bottom > line && r.top < box.bottom) {
      anchor = el;
      break;
    }
  }
  if (!anchor) return () => {};
  const offset = anchor.getBoundingClientRect().top - box.top;
  const until = performance.now() + ms;
  let raf = 0;
  const stop = () => {
    cancelAnimationFrame(raf);
    for (const ev of ['wheel', 'touchstart', 'keydown']) scroller.removeEventListener(ev, stop);
  };
  for (const ev of ['wheel', 'touchstart', 'keydown']) scroller.addEventListener(ev, stop, { passive: true });
  const tick = () => {
    const now = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const d = now - offset;
    if (Math.abs(d) > 0.5) scroller.scrollTop += d;
    if (performance.now() < until) raf = requestAnimationFrame(tick);
    else stop();
  };
  raf = requestAnimationFrame(tick);
  return stop;
}
