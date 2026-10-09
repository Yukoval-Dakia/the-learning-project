// Loom product prototype (YUK-1353, round 2). One considered design for the real product:
// review, reading questions and notes, working with the learning companion, quick capture.
// Prototype only — never part of the production build.
import 'katex/dist/katex.min.css';
import './tokens.css';
import './base.css';
import './app.css';
import { StrictMode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { attempts, conversations, followUps, library, note, recentChats } from './data.js';
import { continueItems, draftSteps, explanation, hints, judgement, lead, now, problem, readiness, suggestions } from './fixture.js';
import { EllipseFigure, Icon, Kbd, MathText, mathHTML, warmMath } from './kit.jsx';
import { Mascot } from './mascot.jsx';
import { bump, flyTo, holdReadingPosition, playMorphs, reduced, reveal, snapshotMorphs } from './motion.js';

/* ── Palette shared with the mascot ───────────────────── */
const PAL = {
  light: { soft: '#f2d9c9', accent: '#d97757', body: '#efe8dc', ink: '#1f1e1d' },
  dark: { soft: '#6b4436', accent: '#e8916e', body: '#3a3631', ink: '#f2efe8' },
};

// Each page's banner decides the mascot's size (slot width) and its resting orientation.
// Rest orientations stay close to facing the reader.
const REST = {
  home: { x: -10, y: 14, z: 0 },
  question: { x: -6, y: -12, z: 8 },
  note: { x: -8, y: 10, z: -6 },
  library: { x: -4, y: -8, z: 12 },
};

const ROUTES = {
  home: { label: '回来时', icon: 'home' },
  library: { label: '资料', icon: 'stack' },
  question: { label: '椭圆综合题', icon: 'pen', parent: '题目' },
  note: { label: '椭圆中的“设而不求”', icon: 'note', parent: '笔记' },
};

/* ── Logo: a separate 2D mark, not the mascot ─────────── */
function Logo({ size = 20 }) {
  // A woven square: two warps, three wefts passing over/under; the middle weft is coral.
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="6.5" className="logo-tile" />
      <path className="logo-warp" d="M9 5.5v4.2M9 11.6v1.1M9 14.8v3.7M15 5.5v1.4M15 8.8v6.1M15 16.9v1.6" />
      <path className="logo-weft" d="M5.5 7.8h7.4M17 7.8h1.5M5.5 16h1.6M11 16h7.5" />
      <path className="logo-weft-accent" d="M5.5 12h7.4M17 12h1.5" />
    </svg>
  );
}

/* ── Small pieces ─────────────────────────────────────── */
function Segmented({ value, options, onPick }) {
  const idx = Math.max(0, options.findIndex(([v]) => v === value));
  return (
    <div className="seg" style={{ '--n': options.length, '--i': idx }} role="tablist">
      <span className="seg-ink" aria-hidden="true" />
      {options.map(([v, label, count]) => (
        <button type="button" role="tab" key={v} aria-selected={v === value} onClick={() => onPick(v)}>
          {label}
          {count != null && <span className="seg-count num">{count}</span>}
        </button>
      ))}
    </div>
  );
}

// A count that rolls to its new value: up when it grows, down when it shrinks.
function RollNum({ value, className = '' }) {
  const [state, setState] = useState({ cur: value, prev: null, dir: 'up', n: 0 });
  if (value !== state.cur) setState({ cur: value, prev: state.cur, dir: value > state.cur ? 'up' : 'down', n: state.n + 1 });
  return (
    <span className={`roll num ${className}`} data-dir={state.dir}>
      <span key={`c${state.n}`} className={state.prev == null ? 'roll-now' : 'roll-now roll-in'}>
        {state.cur}
      </span>
      {state.prev != null && (
        <span key={`p${state.n}`} className="roll-out" aria-hidden="true">
          {state.prev}
        </span>
      )}
    </span>
  );
}

function Toasts({ items, dismiss }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className="toast glass">
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.onAction();
                dismiss(t.id);
              }}
            >
              {t.action}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Home ─────────────────────────────────────────────── */
const INTENTS = [
  ['save', '只保存'],
  ['understand', '帮我理解'],
  ['together', '一起做'],
];

function Capture({ onSave }) {
  const [text, setText] = useState('');
  const [intent, setIntent] = useState('save');
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '');
      if (!typing && !e.metaKey && !e.ctrlKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <form
      className="capture"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSave(text.trim(), intent, ref.current?.getBoundingClientRect());
        setText('');
      }}
    >
      <Icon name="plus" size={16} className="capture-lead" />
      <input ref={ref} value={text} onChange={(e) => setText(e.target.value)} placeholder="记一下：一句话、一张图或一段粘贴……" aria-label="快速记录" />
      <div className="capture-tools">
        <button type="button" className="icon-btn" aria-label="拍照或上传">
          <Icon name="camera" size={16} />
        </button>
        <button type="button" className="icon-btn" aria-label="说一段">
          <Icon name="mic" size={16} />
        </button>
        <select className="capture-intent" value={intent} onChange={(e) => setIntent(e.target.value)} aria-label="记下之后">
          {INTENTS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim()}>
          记下
        </button>
      </div>
    </form>
  );
}

function Home({ go, captures, onCapture, undoCapture, hidden, hide, preload }) {
  const [open, setOpen] = useState(null);
  const s0 = suggestions.find((s) => s.id === 'g-contrast');
  const rest = suggestions.filter((s) => s.id !== 'g-contrast' && !hidden.includes(s.id));
  return (
    <div className="page page-home">
      <section className="banner banner-home">
        <div className="banner-text">
          <p className="eyebrow num">
            {now.date} · {now.part} · 今晚约 {now.availableMinutes} 分钟
          </p>
          <h1 className="banner-title">{lead.headline}</h1>
          <MathText as="p" className="banner-body" text={lead.body} />
        </div>
        <span className="mascot-slot mascot-slot-home" data-mascot-slot />
      </section>

      <Capture onSave={onCapture} />
      {captures.length > 0 && (
        <ul className="captured">
          {captures.map((c) => (
            <li key={c.id} className="captured-item">
              <div className="captured-row">
                <span className="captured-dot" />
                <span className="captured-text">{c.text}</span>
                <span className="captured-meta">{INTENTS.find(([v]) => v === c.intent)[1]} · 已收进来</span>
                <button type="button" className="link-btn" onClick={() => undoCapture(c.id)}>
                  撤销
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="section">
        <h2 className="section-title">接着来</h2>
        <div className="pair">
          <button type="button" className="card card-continue" onClick={() => go('question')} onPointerEnter={() => preload('question')}>
            <span className="card-kicker">继续你的</span>
            <span className="card-title" data-morph="question">
              {continueItems[0].title}
            </span>
            <MathText className="card-body" text={`${continueItems[0].where} · ${continueItems[0].saved}`} />
            <span className="card-foot">
              <span className="chip">学校作业 · 周五交</span>
              <span className="card-go">
                继续 <Kbd>↵</Kbd>
              </span>
            </span>
          </button>
          <div className="card">
            <span className="card-kicker">
              <span className="status-glyph status-ready" /> 建议 · 准备好了
            </span>
            <span className="card-title">{s0.title}</span>
            <span className="card-body">
              <MathText text={`为了：${s0.purpose}`} />
            </span>
            <span className="card-foot">
              <span className="chip num">约 {s0.minutes} 分钟 · 估计</span>
              <button type="button" className="link-btn" aria-expanded={open === s0.id} onClick={() => setOpen(open === s0.id ? null : s0.id)}>
                {open === s0.id ? '收起' : '为什么 · 换一种'}
              </button>
            </span>
            <div className={`why ${open === s0.id ? 'is-open' : ''}`} inert={open !== s0.id}>
              <div className="why-inner">
                {[
                  ['为什么现在', s0.whyNow],
                  ['需要', s0.needs],
                  ['可以停下', s0.stop],
                ].map(([k, v]) => (
                  <p key={k} className="why-row">
                    <span>{k}</span>
                    <MathText text={v} />
                  </p>
                ))}
                <div className="why-alts">
                  {s0.alternatives.map((a) => (
                    <button type="button" key={a} className="chip chip-btn">
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section two-col">
        <div>
          <h2 className="section-title">今天</h2>
          <ul className="rows">
            {rest.map((s) => (
              <li key={s.id} className="row">
                <span className={`status-glyph status-${s.status}`} />
                <div className="row-main">
                  <span className="row-title">{s.title}</span>
                  <span className="row-meta num">
                    {s.status === 'generating' ? `生成中 ${s.progress[0]}/${s.progress[1]} · 还不能开始` : `约 ${s.minutes} 分钟${s.deterministic ? ' · 按复习间隔，不需要 AI' : ''}`}
                  </span>
                </div>
                {s.status === 'ready' && (
                  <button type="button" className="link-btn" onClick={() => hide(s.id, s.title)}>
                    推迟
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="section-title">系统准备的</h2>
          <ul className="rows">
            {readiness.map((r) => (
              <li key={r.id} className="row">
                <span className={`status-glyph status-${r.state}`} />
                <div className="row-main">
                  <span className="row-title">{r.title}</span>
                  <MathText className="row-meta" text={r.detail} />
                </div>
                <span className="row-at num">{r.at}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

/* ── Question ─────────────────────────────────────────── */
// A margin mark on content the learning companion has cited; it leads back to that message.
function CiteMark({ anchor, cited, onCite }) {
  if (!cited?.has(anchor)) return null;
  return (
    <button type="button" className="cite-mark" aria-label={`看学习伙伴关于“${anchor}”的回复`} title="学习伙伴引用了这里" onClick={() => onCite(anchor)}>
      <Icon name="chat" size={13} />
    </button>
  );
}

function Question({ cited, onCite }) {
  return (
    <div className="page page-read">
      <section className="banner banner-read">
        <div className="banner-text">
          <p className="eyebrow">{problem.source}</p>
          <h1 className="banner-title banner-title-sm" data-morph="question">
            椭圆综合题
          </h1>
          <p className="banner-chips">
            <span className="chip">学校作业 · 周五交</span>
            <span className="chip">期中范围</span>
            <span className="chip chip-ok">第 (1) 问 正确</span>
            <span className="chip chip-warn">第 (2) 问 待订正</span>
          </p>
        </div>
        <span className="mascot-slot mascot-slot-read" data-mascot-slot />
      </section>

      <section className="doc-section">
        <h2 className="doc-h">题目</h2>
        <div className="stem">
          <figure className="stem-figure">
            <EllipseFigure />
          </figure>
          <MathText as="p" className="stem-text" text={problem.stem} />
          <ol className="stem-parts">
            {problem.parts.map((p) => (
              <li key={p.id}>
                <span className="part-label">{p.label}</span>
                <MathText text={p.text} />
              </li>
            ))}
          </ol>
          <p className="stem-req">{problem.requirement}</p>
        </div>
      </section>

      <section className="doc-section">
        <h2 className="doc-h">第 (2) 问 · 草稿</h2>
        <ol className="steps">
          {draftSteps.map((st, n) => (
            <li key={st.id} className={`step ${st.current ? 'is-current' : ''}`} data-anchor={`第 ${n + 1} 步`}>
              <span className="step-n num">{n + 1}</span>
              <div className="step-main">
                <MathText as="p" className="step-text" text={st.text} />
                <p className="step-meta">
                  {st.origin === 'photo' ? '10/5 作业照片' : '今晚'}
                  {st.help !== 'none' && ' · 看提示后'}
                  {st.unclear && <span className="step-unclear"> · {st.unclear}</span>}
                </p>
              </div>
              <CiteMark anchor={`第 ${n + 1} 步`} cited={cited} onCite={onCite} />
            </li>
          ))}
        </ol>
      </section>

      <section className="doc-section">
        <h2 className="doc-h">我的作答</h2>
        <ol className="timeline">
          {attempts.map((a) => (
            <li key={a.at} className={`tl tl-${a.kind}`}>
              <span className="tl-dot" />
              <span className="tl-at num">{a.at}</span>
              <MathText as="p" className="tl-text" text={a.text} />
              {a.note && <MathText as="p" className="tl-note" text={a.note} />}
            </li>
          ))}
        </ol>
      </section>

      <section className="doc-section">
        <h2 className="doc-h">
          系统目前的理解 <button type="button" className="link-btn">纠正</button>
        </h2>
        <dl className="understanding">
          <div>
            <dt>
              <span className="j-mark j-observed" />
              观察到
            </dt>
            <dd>{judgement.observed}</dd>
          </div>
          <div>
            <dt>
              <span className="j-mark j-said" />
              你说过
            </dt>
            <dd>{judgement.said}</dd>
          </div>
          <div>
            <dt>
              <span className="j-mark j-unknown" />
              还不知道
            </dt>
            <dd>
              <MathText text={judgement.unknown} />
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

/* ── Note ─────────────────────────────────────────────── */
// Selected text with formulas turned back into their TeX source, so a quote keeps its math.
function selectionText(sel) {
  // A formula is quoted whole or not at all: widen the range to the formulas it touches.
  const range = sel.cloneRange();
  const at = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest('[data-tex]');
  const k0 = at(range.startContainer);
  const k1 = at(range.endContainer);
  if (k0) range.setStartBefore(k0);
  if (k1) range.setEndAfter(k1);
  const frag = range.cloneContents();
  for (const k of frag.querySelectorAll('[data-tex]')) k.replaceWith(`$${k.dataset.tex}$`);
  return frag.textContent.replace(/\s+/g, ' ').trim();
}

function Note({ onAsk, cited, onCite }) {
  const bodyRef = useRef(null);
  const [sel, setSel] = useState(null);
  useEffect(() => {
    const onUp = () => {
      const s = window.getSelection();
      if (!s?.toString().trim() || !bodyRef.current?.contains(s.anchorNode)) return setSel(null);
      const range = s.getRangeAt(0);
      const text = selectionText(range);
      const r = range.getBoundingClientRect();
      const host = bodyRef.current.getBoundingClientRect();
      const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
      // The first line of the selection is where the quote will lift off from.
      const first = range.getClientRects()[0] ?? r;
      setSel({ text, x: r.left - host.left + r.width / 2, y: r.top - host.top, from: first, anchor: node?.closest('[data-anchor]')?.dataset.anchor });
    };
    document.addEventListener('pointerup', onUp);
    return () => document.removeEventListener('pointerup', onUp);
  }, []);
  return (
    <div className="page page-read">
      <section className="banner banner-read">
        <div className="banner-text">
          <p className="eyebrow">课堂笔记</p>
          <h1 className="banner-title banner-title-sm" data-morph="note">
            {note.title}
          </h1>
          <p className="banner-meta">{note.meta}</p>
        </div>
        <span className="mascot-slot mascot-slot-read" data-mascot-slot />
      </section>
      <article className="note" ref={bodyRef}>
        {note.sections.map((s) => (
          <section key={s.h} className="note-sec" data-anchor={s.h}>
            <h2 className="doc-h">
              {s.h}
              <CiteMark anchor={s.h} cited={cited} onCite={onCite} />
            </h2>
            <MathText as="p" className={`note-p ${s.mark ? 'is-marked' : ''}`} text={s.p} />
            {s.mark && <p className="note-mark">{s.mark}</p>}
          </section>
        ))}
        <p className="note-related">
          <Icon name="pen" size={14} /> {note.related}
        </p>
        {sel && (
          <div className="ask-bubble glass" style={{ left: sel.x, top: sel.y }}>
            <button
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                onAsk(sel.text, sel.from, sel.anchor);
                setSel(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              <Icon name="chat" size={14} /> 问学习伙伴
            </button>
          </div>
        )}
      </article>
    </div>
  );
}

/* ── Library ──────────────────────────────────────────── */
let lastTab = 'questions'; // coming back lands on the same tab, so the row is there to morph into

function Library({ go }) {
  const [tab, setTabState] = useState(lastTab);
  const setTab = (t) => {
    lastTab = t;
    setTabState(t);
  };
  const [onlyFollow, setOnlyFollow] = useState(false);
  const items = library[tab].filter((i) => !onlyFollow || i.follow);
  return (
    <div className="page page-library">
      <section className="banner banner-library">
        <div className="banner-text">
          <p className="eyebrow num">共 {library.questions.length + library.notes.length} 项 · 错题 {library.mistakes.length}</p>
          <h1 className="banner-title banner-title-sm">你学过、记下和做过的东西</h1>
        </div>
        <span className="mascot-slot mascot-slot-library" data-mascot-slot />
      </section>
      <div className="lib-bar">
        <Segmented
          value={tab}
          onPick={setTab}
          options={[
            ['questions', '题目', library.questions.length],
            ['notes', '笔记', library.notes.length],
            ['mistakes', '错题', library.mistakes.length],
          ]}
        />
        <span className="spacer" />
        <button type="button" className={`chip chip-btn ${onlyFollow ? 'is-on' : ''}`} aria-pressed={onlyFollow} onClick={() => setOnlyFollow((v) => !v)}>
          <Icon name="flag" size={13} /> 有待跟进
        </button>
        <button type="button" className="chip chip-btn">
          <Icon name="filter" size={13} /> 来源
        </button>
      </div>
      <div className="lib-head">
        <span>名称</span>
        <span>来源</span>
        <span>状态</span>
        <span>最近</span>
        <span>下次复习</span>
      </div>
      <ul className="lib-list" key={`${tab}-${onlyFollow}`}>
        {items.map((i, n) => (
          <li key={i.id} style={{ '--n': n }}>
            <button type="button" className="lib-row" onClick={() => i.open && go(i.open)}>
              <span className="lib-name">
                <Icon name={tab === 'notes' ? 'note' : 'pen'} size={15} />
                <span className="lib-title" data-morph={i.open}>
                  {i.title}
                </span>
                <span className="lib-sub">{i.sub}</span>
                {i.follow > 0 && <span className="lib-follow" title="有待跟进" />}
              </span>
              <span className="lib-cell">{i.source}</span>
              <span className="lib-cell">{i.state}</span>
              <span className="lib-cell num">{i.seen}</span>
              <span className="lib-cell num">{i.next}</span>
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="lib-empty">没有待跟进的条目。</li>}
      </ul>
    </div>
  );
}

/* ── Copilot panel ────────────────────────────────────── */
const CONTEXT = { question: '椭圆综合题 · 第 (2) 问', note: '笔记 · 椭圆中的“设而不求”', home: '回来时', library: '资料' };

const uid = () => Math.random().toString(36).slice(2);
const SETTLE_SHOWN = 2600; // ms the "已记录" receipt stays before folding away

function Copilot({ route, open, thread, setThread, thinking, setThinking, toast, close, sheet, onSettle, onReveal }) {
  const [draft, setDraft] = useState('');
  const [stream, setStream] = useState(null);
  const listRef = useRef(null);
  const timer = useRef({ wait: 0, tick: 0, done: 0 });
  const flight = useRef(null);
  const active = useRef(null); // the reply currently being generated: { aid, ctx, answer }
  const ctx = route === 'library' ? 'home' : route;
  const msgs = thread[ctx] ?? [];

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced() ? 'auto' : 'smooth' });
  }, [msgs.length, stream?.shown]);

  const ask = useCallback(
    (text, quote, cite, from) => {
      const t = timer.current;
      window.clearTimeout(t.wait);
      window.clearInterval(t.tick);
      window.clearTimeout(t.done);
      // A new question while another reply is still coming (e.g. asked from a different page):
      // the earlier reply is recorded in its own conversation instead of being dropped.
      const pending = active.current;
      if (pending) setThread((th) => ({ ...th, [pending.ctx]: [...(th[pending.ctx] ?? []), { id: pending.aid, role: 'ai', text: pending.answer }] }));
      const id = uid();
      if (quote && from) flight.current = { id, from, quote };
      setThread((th) => ({ ...th, [ctx]: [...(th[ctx] ?? []), { id, role: 'me', text, quote, cite }] }));
      setThinking(true);
      const answer = followUps[ctx] ?? followUps.home;
      // The answer keeps one identity from the first token to the committed record, so the same
      // element settles in place instead of being swapped for a new one.
      const aid = uid();
      active.current = { aid, ctx, answer };
      let shown = 0;
      setStream({ id: aid, ctx, text: answer, shown: 0, phase: 'thinking' });
      t.wait = window.setTimeout(() => {
        t.tick = window.setInterval(() => {
          shown = Math.min(answer.length, shown + 3);
          setStream({ id: aid, ctx, text: answer, shown, phase: shown >= answer.length ? 'confirming' : 'streaming' });
          if (shown >= answer.length) {
            window.clearInterval(t.tick);
            t.done = window.setTimeout(() => {
              setThread((th) => ({ ...th, [ctx]: [...(th[ctx] ?? []), { id: aid, role: 'ai', text: answer, settledAt: Date.now() }] }));
              active.current = null;
              setStream(null);
              setThinking(false);
              onSettle?.();
            }, 700);
          }
        }, 40);
      }, 900);
    },
    [ctx, setThread, setThinking, onSettle],
  );

  useEffect(() => {
    const onAsk = (e) => ask(e.detail.question, e.detail.quote, e.detail.cite, e.detail.from);
    window.addEventListener('loom:ask', onAsk);
    return () => window.removeEventListener('loom:ask', onAsk);
  }, [ask]);

  // Content → conversation: a cited passage's margin mark brings its message into view.
  useEffect(() => {
    const onCite = (e) => {
      const all = listRef.current?.querySelectorAll(`[data-cite="${CSS.escape(e.detail.anchor)}"]`);
      if (all?.length) reveal(listRef.current, all[all.length - 1], { block: 'nearest' });
    };
    window.addEventListener('loom:cite', onCite);
    return () => window.removeEventListener('loom:cite', onCite);
  }, []);

  // The selected passage lifts off the page and lands as the quote in the new message.
  useLayoutEffect(() => {
    const f = flight.current;
    if (!f) return;
    const el = listRef.current?.querySelector(`[data-quote="${f.id}"]`);
    if (!el) return;
    flight.current = null;
    el.style.visibility = 'hidden';
    const node = document.createElement('span');
    node.className = 'quote-ghost';
    node.innerHTML = mathHTML(f.quote);
    flyTo({
      from: f.from,
      to: () => (el.isConnected ? el : null),
      node,
      duration: 700,
      onLand: () => {
        el.style.visibility = '';
      },
    });
  }, [msgs.length]);

  // Collapsed or peeking content is out of reach for keyboard and assistive tech, not just invisible.
  const peeking = sheet?.snap === 'peek';
  const items = msgs.map((m, i) => ({ ...m, key: m.id ?? `m${i}` }));
  // A reply belongs to the conversation it was asked in; it never streams into another page's panel.
  if (stream && stream.ctx === ctx) items.push({ key: stream.id, role: 'ai', stream });
  const badge = (m) => {
    if (m.stream) return m.stream.phase === 'thinking' ? '在想…' : m.stream.phase === 'confirming' ? '生成完毕 · 正在记录' : '生成中 · 还未生效';
    return (
      <>
        <Icon name="check" size={12} className="settle-check" /> 已记录
      </>
    );
  };

  return (
    <aside ref={sheet?.ref} className={`copilot ${open ? 'is-open' : ''} ${sheet ? `is-sheet snap-${sheet.snap}` : ''}`} aria-label="学习伙伴" inert={!open}>
      {sheet && <span className="sheet-grip" aria-hidden="true" {...sheet.handlers} />}
      <header className="copilot-head" {...(sheet?.handlers ?? {})}>
        <span className="copilot-name">学习伙伴</span>
        <span className={`copilot-state ${thinking ? 'is-thinking' : ''}`}>{thinking ? '在想…' : '在这里'}</span>
        <span className="spacer" />
        <button type="button" className="icon-btn" aria-label="收起学习伙伴" onClick={close}>
          <Icon name="panel_right" size={16} />
        </button>
      </header>
      <p className="copilot-ctx" inert={peeking}>
        <Icon name="eye" size={13} /> 正在看：{CONTEXT[route]}
      </p>
      <div className="copilot-list" ref={listRef} inert={peeking}>
        {items.length === 0 && (
          <div className="copilot-empty">
            <p>可以问我正在看的内容，或者让我帮你安排今晚。</p>
            <button type="button" className="chip chip-btn" onClick={() => ask('今晚怎么安排比较好？')}>
              今晚怎么安排比较好？
            </button>
          </div>
        )}
        {items.map((m) => {
          if (m.role === 'proposal') return <Proposal key={m.key} m={m} toast={toast} />;
          const fresh = m.settledAt && Date.now() - m.settledAt < SETTLE_SHOWN;
          const phase = m.stream ? `is-temp is-${m.stream.phase}` : fresh ? 'is-settled' : '';
          return (
            <div key={m.key} className={`msg msg-${m.role} ${phase}`} data-cite={m.cite ?? m.ref}>
              {m.quote && (
                <button type="button" className="msg-quote" data-quote={m.key} disabled={!m.cite} onClick={() => onReveal(m.cite)} title={m.cite ? `回到原文：${m.cite}` : undefined}>
                  <MathText text={m.quote} />
                </button>
              )}
              {m.ref && (
                <button type="button" className="msg-ref" onClick={() => onReveal(m.ref)} title="在正文里看">
                  ↳ {m.ref}
                </button>
              )}
              {(m.stream || fresh) && <span className="tmp-badge">{badge(m)}</span>}
              {m.stream ? m.stream.shown > 0 && <MathText as="p" text={cut(m.stream.text, m.stream.shown)} /> : <MathText as="p" text={m.text} />}
            </div>
          );
        })}
      </div>
      <form
        className="copilot-compose"
        inert={peeking}
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim() || thinking) return;
          ask(draft.trim());
          setDraft('');
        }}
      >
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form.requestSubmit();
            }
          }}
          placeholder={thinking ? '它在想，稍等…' : '问点什么，或 @ 引用正在看的内容'}
        />
        <div className="compose-bar">
          <button type="button" className="icon-btn" aria-label="引用">
            <Icon name="at" size={15} />
          </button>
          <span className="compose-hint">
            <Kbd>⌘J</Kbd> 收起
          </span>
          <span className="spacer" />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!draft.trim() || thinking}>
            <Icon name="send" size={14} />
          </button>
        </div>
      </form>
    </aside>
  );
}

function cut(s, n) {
  let out = s.slice(0, n);
  if ((out.match(/\$/g) || []).length % 2 === 1) out = out.slice(0, out.lastIndexOf('$'));
  return out;
}

function Proposal({ m, toast }) {
  const [state, setState] = useState('open');
  if (state === 'dismissed') return null;
  return (
    <div className={`proposal ${state === 'added' ? 'is-added' : ''}`}>
      <p className="proposal-kicker">{state === 'added' ? '已加入待跟进' : '建议 · 需要你确认'}</p>
      <p className="proposal-title">{m.title}</p>
      <p className="proposal-body">{m.body}</p>
      {state === 'open' && (
        <div className="proposal-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setState('added');
              toast('已加入待跟进', '撤销', () => setState('open'));
            }}
          >
            加入
          </button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setState('dismissed')}>
            不用
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Command palette (glass) ──────────────────────────── */
function Palette({ open, close, commands }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const ref = useRef(null);
  const list = commands.filter((c) => !q || c.label.includes(q) || c.group.includes(q));
  useEffect(() => {
    if (open) {
      setQ('');
      setI(0);
      requestAnimationFrame(() => ref.current?.focus());
    }
  }, [open]);
  return (
    <div className={`palette-layer ${open ? 'is-open' : ''}`} onPointerDown={close} inert={!open}>
      <div
        className="palette glass"
        role="dialog"
        aria-label="命令面板"
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setI((x) => Math.min(list.length - 1, x + 1));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setI((x) => Math.max(0, x - 1));
          }
          if (e.key === 'Enter' && list[i]) {
            close();
            list[i].run();
          }
        }}
      >
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input ref={ref} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索、跳转，或输入要做的事" />
          <Kbd>Esc</Kbd>
        </div>
        <ul className="palette-list">
          {list.map((c, n) => (
            <li key={c.label}>
              <button
                type="button"
                className={`palette-item ${n === i ? 'is-active' : ''}`}
                onPointerEnter={() => setI(n)}
                onClick={() => {
                  close();
                  c.run();
                }}
              >
                <Icon name={c.icon} size={15} />
                <span>{c.label}</span>
                <span className="palette-group">{c.group}</span>
                {c.kbd && <Kbd>{c.kbd}</Kbd>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/* ── App ──────────────────────────────────────────────── */
/* ── Phone ────────────────────────────────────────────── */
function useIsPhone() {
  const q = '(max-width: 720px)';
  const [phone, setPhone] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setPhone(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return phone;
}

// Draggable bottom sheet with snap points. Position is a damped spring that keeps its velocity,
// so a fling carries into the snap and a new drag can grab the sheet mid-animation.
const SNAPS = ['full', 'half', 'peek'];
function useSheet(enabled, snap, setSnap, canClose) {
  const ref = useRef(null);
  const st = useRef({ y: 0, v: 0, raf: 0, drag: null, placed: false });
  const pos = useCallback((name) => {
    const H = ref.current?.offsetHeight ?? window.innerHeight;
    // Peek sits just above the floating tab bar (≈ 62px bar + 12px gap + safe area).
    return { full: 0, half: Math.round(H * 0.5), peek: H - 92 - 86, closed: H + 32 }[name];
  }, []);
  const write = () => {
    if (ref.current) ref.current.style.transform = `translate3d(0, ${st.current.y}px, 0)`;
  };
  const animate = useCallback(
    (target) => {
      const s = st.current;
      cancelAnimationFrame(s.raf);
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!s.placed || reduce) {
        Object.assign(s, { y: target, v: 0, placed: true, raf: 0 });
        write();
        return;
      }
      const k = 240;
      const c = 29;
      const dt = 1 / 60;
      const tick = () => {
        const a = -k * (s.y - target) - c * s.v;
        s.v += a * dt;
        s.y += s.v * dt;
        write();
        if (Math.abs(s.y - target) > 0.4 || Math.abs(s.v) > 4) s.raf = requestAnimationFrame(tick);
        else {
          s.y = target;
          s.v = 0;
          s.raf = 0;
          write();
        }
      };
      s.raf = requestAnimationFrame(tick);
    },
    [],
  );
  useEffect(() => {
    if (!enabled) {
      if (ref.current) ref.current.style.transform = '';
      st.current.placed = false;
      return;
    }
    animate(pos(snap));
    const onResize = () => animate(pos(snap));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [enabled, snap, animate, pos]);

  const handlers = enabled
    ? {
        onPointerDown: (e) => {
          if (e.target.closest('button')) return;
          const s = st.current;
          cancelAnimationFrame(s.raf);
          s.raf = 0;
          s.drag = { y0: s.y, c0: e.clientY, last: e.clientY, t: performance.now(), v: 0, moved: 0 };
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // The pointer is already gone (e.g. a cancelled touch); the drag ends on the next release.
          }
        },
        onPointerMove: (e) => {
          const s = st.current;
          const d = s.drag;
          if (!d) return;
          const now = performance.now();
          const dy = e.clientY - d.last;
          d.v = 0.8 * (dy / Math.max(1, now - d.t)) * 1000 + 0.2 * d.v;
          d.last = e.clientY;
          d.t = now;
          d.moved = Math.max(d.moved, Math.abs(e.clientY - d.c0));
          s.y = Math.max(-12, Math.min(pos('closed'), d.y0 + (e.clientY - d.c0)));
          write();
        },
        onPointerUp: release,
        // A cancelled drag (system gesture, interruption) settles like a release instead of freezing.
        onPointerCancel: release,
      }
    : {};
  function release() {
    const s = st.current;
    const d = s.drag;
    if (!d) return;
    s.drag = null;
    let next;
    if (d.moved < 5) next = snap === 'peek' || snap === 'closed' ? 'half' : 'peek';
    else {
      const projected = s.y + d.v * 0.2;
      const names = canClose ? [...SNAPS, 'closed'] : SNAPS;
      next = names.reduce((best, n) => (Math.abs(pos(n) - projected) < Math.abs(pos(best) - projected) ? n : best), names[0]);
    }
    s.v = d.moved < 5 ? 0 : d.v;
    if (next === snap) animate(pos(next));
    else setSnap(next);
  }
  return { ref, handlers, snap };
}

function TabBar({ route, go, compact, onCapture, onCopilot, copilotUp, hidden, inbox }) {
  const items = [
    ['home', '回来时', 'home', () => go('home')],
    ['library', '资料', 'stack', () => go('library')],
    ['capture', '记一下', 'plus', onCapture],
    ['copilot', '学习伙伴', 'chat', onCopilot],
  ];
  return (
    <nav className={`tabbar glass ${compact ? 'is-compact' : ''} ${hidden ? 'is-hidden' : ''}`} aria-label="主导航" inert={hidden}>
      {items.map(([id, label, icon, run]) => {
        const active = id === route || (id === 'library' && (route === 'question' || route === 'note')) || (id === 'copilot' && copilotUp);
        return (
          <button type="button" key={id} className={`tab ${id === 'capture' ? 'tab-capture' : ''} ${active ? 'is-active' : ''}`} onClick={run}>
            <span className="tab-icon">
              <Icon name={icon} size={id === 'capture' ? 18 : 20} />
              {id === 'capture' && <RollNum value={inbox} className="tab-badge" />}
            </span>
            <span className="tab-label">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function CaptureSheet({ open, close, onSave }) {
  const [text, setText] = useState('');
  const [intent, setIntent] = useState('save');
  const ref = useRef(null);
  useEffect(() => {
    if (open) requestAnimationFrame(() => ref.current?.focus());
  }, [open]);
  return (
    <div className={`capture-layer ${open ? 'is-open' : ''}`} onPointerDown={close} inert={!open}>
      <form
        className="capture-sheet glass"
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          onSave(text.trim(), intent, ref.current?.getBoundingClientRect());
          setText('');
          close();
        }}
      >
        <p className="capture-sheet-title">记一下 · 先存下，稍后整理</p>
        <textarea ref={ref} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="一句话、一个问题，或者粘贴一段……" />
        <div className="capture-sheet-bar">
          <button type="button" className="icon-btn" aria-label="拍照或上传">
            <Icon name="camera" size={18} />
          </button>
          <button type="button" className="icon-btn" aria-label="说一段">
            <Icon name="mic" size={18} />
          </button>
          <select className="capture-intent" value={intent} onChange={(e) => setIntent(e.target.value)} aria-label="记下之后">
            {INTENTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <span className="spacer" />
          <button type="button" className="btn btn-quiet btn-sm" onClick={close}>
            取消
          </button>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim()}>
            记下
          </button>
        </div>
      </form>
    </div>
  );
}

const DEFAULT_COPILOT = { home: false, library: false, question: true, note: true };

function App() {
  const q = new URLSearchParams(window.location.search);
  const [route, setRoute] = useState(q.get('page') ?? 'home');
  const [theme, setTheme] = useState(q.get('theme') ?? 'light');
  const [collapsed, setCollapsed] = useState(false);
  const [copilot, setCopilot] = useState(DEFAULT_COPILOT);
  const [thread, setThread] = useState(conversations);
  const [thinking, setThinking] = useState(false);
  const [pulseKey, setPulseKey] = useState(0);
  const [palette, setPalette] = useState(false);
  const [captures, setCaptures] = useState([]);
  const [hidden, setHidden] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [inbox, setInbox] = useState(3); // things captured earlier, still waiting to be sorted
  const inFlight = useRef(new Map()); // capture id → cancel its flight
  const undone = useRef(new Set());
  const landed = useRef(new Set());
  const morphSnap = useRef(null);
  const routeRef = useRef(route);
  const hostRef = useRef(null);
  const scrollRef = useRef(null);
  const phone = useIsPhone();
  const frameRef = useRef(null);
  const [snap, setSnap] = useState(DEFAULT_COPILOT[route] ? 'peek' : 'closed');
  const [compact, setCompact] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const open = phone ? snap !== 'closed' : copilot[route];
  const sheet = useSheet(phone, snap, setSnap, route === 'home' || route === 'library');

  // Phone: reading pages keep the companion peeking; elsewhere it rests closed.
  useEffect(() => {
    setSnap(DEFAULT_COPILOT[route] ? 'peek' : 'closed');
    setCompact(false);
  }, [route]);

  // Phone: tab bar condenses while reading downward, returns on the way back up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !phone) return;
    let last = el.scrollTop;
    const onScroll = () => {
      const d = el.scrollTop - last;
      if (Math.abs(d) > 6) {
        setCompact(d > 0 && el.scrollTop > 80);
        last = el.scrollTop;
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [phone, route]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    // Everything the next screens will typeset, so a page switch never pays for KaTeX in its first frame.
    warmMath([
      problem.stem,
      ...problem.parts.map((p) => p.text),
      ...draftSteps.map((st) => st.text),
      ...attempts.flatMap((a) => [a.text, a.note ?? '']),
      judgement.unknown,
      ...note.sections.map((s) => s.p),
      ...Object.values(conversations).flatMap((c) => c.map((m) => m.text ?? '')),
      ...Object.values(followUps),
      ...hints.map((h) => h.text),
      ...explanation,
    ]);
  }, []);

  const go = useCallback((r) => {
    if (r === routeRef.current) {
      scrollRef.current?.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' });
      return;
    }
    // Remember where shared titles sit now, so the next page can grow them out of the same spot.
    morphSnap.current = snapshotMorphs(hostRef.current);
    routeRef.current = r;
    setRoute(r);
    const url = new URL(window.location.href);
    url.searchParams.set('page', r);
    window.history.replaceState(null, '', url);
  }, []);

  useLayoutEffect(() => {
    const snap = morphSnap.current;
    morphSnap.current = null;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    playMorphs(hostRef.current, snap);
  }, [route]);

  // Opening the companion or folding the sidebar reflows the reading column; keep the
  // paragraph under the reader's eyes where it was.
  const prevLayout = useRef({ route, open, collapsed });
  useLayoutEffect(() => {
    const p = prevLayout.current;
    prevLayout.current = { route, open, collapsed };
    if (phone || p.route !== route || (p.open === open && p.collapsed === collapsed)) return;
    return holdReadingPosition(scrollRef.current, 560);
  }, [route, open, collapsed, phone]);

  const toast = useCallback((text, action, onAction) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-2), { id, text, action, onAction }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  const dismiss = (id) => setToasts((t) => t.filter((x) => x.id !== id));

  const toggleCopilot = useCallback(() => {
    if (phone) setSnap((s) => (s === 'half' || s === 'full' ? (DEFAULT_COPILOT[route] ? 'peek' : 'closed') : 'half'));
    else setCopilot((c) => ({ ...c, [route]: !c[route] }));
  }, [route, phone]);

  const commands = useMemo(
    () => [
      { group: '前往', label: '回来时', icon: 'home', run: () => go('home') },
      { group: '前往', label: '资料', icon: 'stack', run: () => go('library') },
      { group: '继续', label: '椭圆综合题 · 第 (2) 问', icon: 'pen', run: () => go('question') },
      { group: '继续', label: '笔记：椭圆中的“设而不求”', icon: 'note', run: () => go('note') },
      { group: '动作', label: '记一下', icon: 'plus', kbd: 'N', run: () => go('home') },
      { group: '动作', label: open ? '收起学习伙伴' : '打开学习伙伴', icon: 'chat', kbd: '⌘J', run: toggleCopilot },
      { group: '外观', label: theme === 'dark' ? '亮色' : '暗色', icon: theme === 'dark' ? 'sun' : 'moon', run: () => setTheme(theme === 'dark' ? 'light' : 'dark') },
    ],
    [go, open, toggleCopilot, theme],
  );

  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        toggleCopilot();
      }
      if (mod && e.key === '\\') {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCopilot]);

  // Captured things travel into the inbox entry, so it is obvious where they went.
  const pocket = useCallback(() => document.querySelector(phone ? '.tab-capture .tab-icon' : '[data-pocket]'), [phone]);
  const removeCapture = (id) => {
    setCaptures((c) => c.filter((x) => x.id !== id));
    undone.current.add(id);
    inFlight.current.get(id)?.();
    inFlight.current.delete(id);
    if (landed.current.delete(id)) setInbox((n) => n - 1);
  };
  const onCapture = (text, intent, from) => {
    const id = Math.random().toString(36).slice(2);
    setCaptures((c) => [{ id, text, intent }, ...c].slice(0, 3));
    setPulseKey((k) => k + 1);
    const node = document.createElement('span');
    node.className = 'fly-chip';
    node.textContent = text;
    const cancel = flyTo({
      from,
      to: pocket,
      node,
      shrink: true,
      duration: 660,
      onLand: () => {
        if (undone.current.has(id)) return; // undone mid-flight: never counted
        inFlight.current.delete(id);
        landed.current.add(id);
        setInbox((n) => n + 1);
        bump(pocket());
      },
    });
    if (!landed.current.has(id)) inFlight.current.set(id, cancel);
    toast('已收进来，稍后整理', '撤销', () => removeCapture(id));
  };
  const hide = (id, title) => {
    setHidden((h) => [...h, id]);
    toast(`已推迟：${title}`, '撤销', () => setHidden((h) => h.filter((x) => x !== id)));
  };
  const askFromNote = (quote, from, cite) => {
    setCopilot((c) => ({ ...c, note: true }));
    if (phone) setSnap('half');
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('loom:ask', { detail: { quote, cite, from, question: '这段能再讲清楚一点吗？' } })), 260);
  };

  // Conversation ↔ content: a reference in a reply scrolls the page to the passage; a cited
  // passage's margin mark brings the reply into view.
  const revealInPage = useCallback(
    (anchor) => {
      const el = hostRef.current?.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`);
      if (!el) return;
      if (phone) setSnap('peek');
      window.setTimeout(() => reveal(scrollRef.current, el), phone ? 240 : 0);
    },
    [phone],
  );
  const revealInCopilot = useCallback(
    (anchor) => {
      if (phone) setSnap((s) => (s === 'full' ? s : 'half'));
      else setCopilot((c) => ({ ...c, [route]: true }));
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('loom:cite', { detail: { anchor } })), open ? 0 : 360);
    },
    [phone, route, open],
  );
  const ctx = route === 'library' ? 'home' : route;
  const cited = useMemo(() => new Set((thread[ctx] ?? []).map((m) => m.cite ?? m.ref).filter(Boolean)), [thread, ctx]);
  const onSettle = useCallback(() => setPulseKey((k) => k + 1), []);

  const nav = [
    ['home', '回来时', 'home'],
    ['library', '资料', 'stack'],
  ];

  return (
    <div className={`app ${collapsed ? 'is-collapsed' : ''} ${open ? 'has-copilot' : ''}`}>
      <aside className="side">
        <div className="side-top">
          <button type="button" className="side-brand" onClick={() => go('home')}>
            <Logo />
            <span className="side-word">Loom</span>
          </button>
          <button type="button" className="icon-btn side-collapse" aria-label="收起侧栏" onClick={() => setCollapsed((c) => !c)}>
            <Icon name="sidebar" size={16} />
          </button>
        </div>
        <button type="button" className="side-search" onClick={() => setPalette(true)}>
          <Icon name="search" size={15} />
          <span className="side-label">搜索或跳转</span>
          <Kbd>⌘K</Kbd>
        </button>
        <nav className="side-nav" aria-label="主导航">
          {nav.map(([id, label, icon]) => (
            <button type="button" key={id} className={`side-item ${route === id ? 'is-active' : ''}`} onClick={() => go(id)}>
              <Icon name={icon} size={16} />
              <span className="side-label">{label}</span>
            </button>
          ))}
          <div className="side-sub">
            {[
              ['question', '题目', 'pen', library.questions.length],
              ['note', '笔记', 'note', library.notes.length],
              ['library', '错题', 'flag', library.mistakes.length],
            ].map(([id, label, icon, n]) => (
              <button type="button" key={label} className={`side-item side-item-sub ${route === id && label !== '错题' ? 'is-active' : ''}`} onClick={() => go(id === 'question' || id === 'note' ? 'library' : id)}>
                <Icon name={icon} size={15} />
                <span className="side-label">{label}</span>
                <span className="side-count num">{n}</span>
              </button>
            ))}
          </div>
          <button type="button" className="side-item">
            <Icon name="user" size={16} />
            <span className="side-label">我的学习</span>
          </button>
          <button type="button" className="side-item side-pocket">
            <span className="side-icon" data-pocket>
              <Icon name="tray" size={16} />
            </span>
            <span className="side-label">收进来的</span>
            <RollNum value={inbox} className="side-badge" />
          </button>
          <button type="button" className="side-item">
            <Icon name="spark" size={16} />
            <span className="side-label">系统为我做了什么</span>
            <span className="side-badge num">2</span>
          </button>
        </nav>
        <div className="side-group">
          <p className="side-heading">最近和学习伙伴</p>
          {recentChats.map((c) => (
            <button type="button" key={c.id} className="side-item side-chat" onClick={() => go(c.route)}>
              <Icon name="chat" size={15} />
              <span className="side-label">{c.title}</span>
            </button>
          ))}
        </div>
        <div className="side-foot">
          <button type="button" className="side-item" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
            <span className="side-label">{theme === 'dark' ? '亮色' : '暗色'}</span>
          </button>
        </div>
      </aside>

      <div className="frame" ref={frameRef}>
        <header className="topbar">
          {route !== 'home' && (
            <button type="button" className="icon-btn topbar-back phone-only" aria-label="返回" onClick={() => go(route === 'library' ? 'home' : 'library')}>
              <Icon name="back" size={18} />
            </button>
          )}
          <nav className="crumbs" aria-label="位置">
            {ROUTES[route].parent && (
              <>
                <button type="button" onClick={() => go('library')}>
                  资料
                </button>
                <Icon name="chevron" size={13} />
                <span className="crumb-muted">{ROUTES[route].parent}</span>
                <Icon name="chevron" size={13} />
              </>
            )}
            <span className="crumb-here">{ROUTES[route].label}</span>
          </nav>
          <span className="spacer" />
          {route === 'question' && (
            <button type="button" className="btn btn-ghost btn-sm">
              复习这道题
            </button>
          )}
          <button type="button" className={`btn btn-sm desk-only ${open ? 'btn-secondary' : 'btn-ghost'}`} onClick={toggleCopilot} aria-pressed={open}>
            <Icon name="chat" size={15} /> 学习伙伴 <Kbd>⌘J</Kbd>
          </button>
          <span className="mascot-dock phone-only" data-mascot-dock />
        </header>
        <div className="body">
          <main className="scroll" ref={scrollRef}>
            <div className="scroll-host" ref={hostRef}>
              <div className={`page-wrap ${morphSnap.current?.size ? 'is-morph-in' : ''}`} key={route}>
                {route === 'home' && (
                  <Home go={go} captures={captures} onCapture={onCapture} undoCapture={removeCapture} hidden={hidden} hide={hide} preload={() => {}} />
                )}
                {route === 'question' && <Question cited={cited} onCite={revealInCopilot} />}
                {route === 'note' && <Note onAsk={askFromNote} cited={cited} onCite={revealInCopilot} />}
                {route === 'library' && <Library go={go} />}
              </div>
              {!phone && <Mascot key="desk" hostRef={hostRef} routeKey={`${route}-${open}-${collapsed}`} rest={REST[route]} thinking={thinking} pulseKey={pulseKey} pal={PAL[theme]} warm />}
            </div>
          </main>
          <Copilot
            route={route}
            open={open}
            thread={thread}
            setThread={setThread}
            thinking={thinking}
            setThinking={setThinking}
            toast={toast}
            close={phone ? () => setSnap(DEFAULT_COPILOT[route] ? 'peek' : 'closed') : toggleCopilot}
            sheet={phone ? sheet : null}
            onSettle={onSettle}
            onReveal={revealInPage}
          />
        </div>
        {phone && <Mascot key="phone" dock hostRef={frameRef} scrollRef={scrollRef} routeKey={route} rest={REST[route]} thinking={thinking} pulseKey={pulseKey} pal={PAL[theme]} warm />}
      </div>
      {phone && (
        <>
          <TabBar route={route} go={go} compact={compact} onCapture={() => setCaptureOpen(true)} onCopilot={toggleCopilot} copilotUp={snap === 'half' || snap === 'full'} hidden={snap === 'half' || snap === 'full'} inbox={inbox} />
          <CaptureSheet open={captureOpen} close={() => setCaptureOpen(false)} onSave={onCapture} />
        </>
      )}

      <Palette open={palette} close={() => setPalette(false)} commands={commands} />
      <Toasts items={toasts} dismiss={dismiss} />
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
