// The mascot: one persistent glass pinwheel flower. It springs to the current page's banner
// slot ([data-mascot-slot]). On phones (`dock`), it follows the banner while it is on screen
// and, once the banner scrolls under the top bar, shrinks into the top bar ([data-mascot-dock]).
// Everything is interruptible: position/scale use a damped spring that keeps its velocity when
// the target changes; rotation is slerped toward a target every frame in the WebGL loop.
import { useEffect, useRef } from 'react';
import { createGLMark } from './mark-gl.js';

const CANVAS = 220; // CSS px the canvas is drawn at; slots scale it down.
const LOOK_RADIUS = 300; // px: how close the pointer must come before the flower notices
const LOOK_MAX = { x: 16, y: 20 }; // degrees the flower may turn toward the pointer / touch
const LIMIT = { x: 22, y: 28 }; // never more side-on than this, in any state

const clamp = (v, m) => Math.max(-m, Math.min(m, v));

export function Mascot({ hostRef, scrollRef, routeKey, rest, thinking, pulseKey, pal, warm, dock = false }) {
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const gl = useRef(null);
  const spring = useRef({ x: 0, y: 0, s: 0.5, vx: 0, vy: 0, vs: 0, tx: 0, ty: 0, ts: 0.5, placed: false, raf: 0, docked: false, follow: true });
  const restRef = useRef(rest);
  const lookRef = useRef({ x: 0, y: 0 });
  const latest = useRef({ pal, warm, thinking });
  latest.current = { pal, warm, thinking };

  useEffect(() => {
    let alive = true;
    createGLMark(canvasRef.current, { kind: 'flower', pal, warm }).then((h) => {
      if (!alive) return h.dispose();
      gl.current = h;
      const now = latest.current;
      if (now.pal !== pal) h.setLook('flower', now.pal, now.warm);
      apply();
      h.setThinking(now.thinking);
    });
    return () => {
      alive = false;
      gl.current?.dispose();
      gl.current = null;
    };
    // biome-ignore lint: create once
  }, []);

  useEffect(() => {
    gl.current?.setLook('flower', pal, warm);
  }, [pal, warm]);
  useEffect(() => {
    gl.current?.setThinking(thinking);
  }, [thinking]);
  const firstPulse = useRef(pulseKey);
  useEffect(() => {
    if (pulseKey !== firstPulse.current) gl.current?.pulse();
  }, [pulseKey]);

  const apply = () => {
    const r = restRef.current;
    const l = lookRef.current;
    gl.current?.setRotation({ x: clamp(r.x + l.x, LIMIT.x), y: clamp(r.y + l.y, LIMIT.y), z: r.z });
  };
  useEffect(() => {
    restRef.current = rest;
    apply();
  }, [rest]);

  const write = () => {
    const st = spring.current;
    const el = boxRef.current;
    if (el) el.style.transform = `translate3d(${st.x}px, ${st.y}px, 0) scale(${st.s})`;
  };

  const step = () => {
    const st = spring.current;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const k = 190;
    const c = 23; // slightly under critical (2√k ≈ 27.6): a soft settle with a whisper of overshoot
    const dt = 1 / 60;
    if (reduce || !st.placed) {
      Object.assign(st, { x: st.tx, y: st.ty, s: st.ts, vx: 0, vy: 0, vs: 0, placed: true });
    } else {
      for (const [p, v, t] of [
        ['x', 'vx', 'tx'],
        ['y', 'vy', 'ty'],
        ['s', 'vs', 'ts'],
      ]) {
        const a = -k * (st[p] - st[t]) - c * st[v];
        st[v] += a * dt;
        st[p] += st[v] * dt;
      }
    }
    write();
    const moving = Math.abs(st.x - st.tx) + Math.abs(st.y - st.ty) > 0.2 || Math.abs(st.s - st.ts) > 0.001 || Math.abs(st.vx) + Math.abs(st.vy) > 0.5;
    st.raf = moving ? requestAnimationFrame(step) : 0;
    // Once a docking transition settles, resume tracking the banner directly while scrolling.
    if (!moving) st.follow = true;
  };

  const measure = () => {
    const host = hostRef.current;
    if (!host) return null;
    const h = host.getBoundingClientRect();
    const slot = host.querySelector('[data-mascot-slot]');
    const dockEl = dock ? host.querySelector('[data-mascot-dock]') : null;
    if (!slot) return null;
    const r = slot.getBoundingClientRect();
    let docked = false;
    if (dockEl) {
      const bar = dockEl.closest('.topbar')?.getBoundingClientRect();
      docked = bar ? r.top + r.height * 0.45 < bar.bottom : false;
    }
    const t = docked ? dockEl.getBoundingClientRect() : r;
    return { docked, x: t.left - h.left, y: t.top - h.top, s: t.width / CANVAS };
  };

  const retarget = (fromScroll = false) => {
    const m = measure();
    if (!m) return;
    const st = spring.current;
    const changed = m.docked !== st.docked;
    st.docked = m.docked;
    st.tx = m.x;
    st.ty = m.y;
    st.ts = m.s;
    if (fromScroll && !changed && !m.docked && st.follow && st.placed) {
      // Riding along with the banner: stick to it exactly, no lag behind the finger.
      st.x = st.tx;
      st.y = st.ty;
      st.s = st.ts;
      st.vx = st.vy = st.vs = 0;
      write();
      return;
    }
    if (changed) st.follow = false;
    if (!st.raf) st.raf = requestAnimationFrame(step);
  };

  useEffect(() => {
    retarget();
    const host = hostRef.current;
    const ro = new ResizeObserver(() => retarget());
    if (host) ro.observe(host);
    const slot = host?.querySelector('[data-mascot-slot]');
    if (slot) ro.observe(slot);
    const late = window.setTimeout(() => retarget(), 420);
    const scroller = dock ? scrollRef?.current : null;
    const onScroll = () => retarget(true);
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      window.clearTimeout(late);
      scroller?.removeEventListener('scroll', onScroll);
    };
    // biome-ignore lint: retarget reads refs
  }, [routeKey, dock]);

  // Turn toward a nearby pointer or touch; drift back to rest when it leaves or lifts.
  useEffect(() => {
    let raf = 0;
    const onMove = (e) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = boxRef.current;
        if (!el) return;
        const b = el.getBoundingClientRect();
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        const dx = e.clientX - cx;
        const dy = e.clientY - cy;
        const d = Math.hypot(dx, dy);
        const reach = LOOK_RADIUS + b.width / 2;
        const w = d >= reach ? 0 : (1 - d / reach) ** 0.7;
        const nx = d ? dx / d : 0;
        const ny = d ? dy / d : 0;
        lookRef.current = { x: ny * LOOK_MAX.x * w, y: nx * LOOK_MAX.y * w };
        apply();
      });
    };
    const onLeave = () => {
      lookRef.current = { x: 0, y: 0 };
      apply();
    };
    const onUp = (e) => e.pointerType === 'touch' && onLeave();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerdown', onMove);
    window.addEventListener('pointerup', onUp);
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      window.removeEventListener('pointerup', onUp);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
    // biome-ignore lint: apply reads refs
  }, []);

  return (
    <div className={`mascot ${dock ? 'mascot-dockable' : ''}`} ref={boxRef} aria-hidden="true">
      <canvas ref={canvasRef} className="mascot-canvas" />
    </div>
  );
}
