// Shared visual vocabulary for all three variants. Variants differ in structure
// (navigation, information architecture, layout) — not in these pieces.
import katex from 'katex';
import { useEffect, useMemo, useRef, useState } from 'react';
import { explanation, goals, hints, judgement, problem, readiness, cost, backlog } from './fixture.js';
import { useLoft } from './store.jsx';

/* ── Math ─────────────────────────────────────────────── */
const texCache = new Map();
function tex(src) {
  if (!texCache.has(src)) texCache.set(src, katex.renderToString(src, { throwOnError: false, output: 'html' }));
  return texCache.get(src);
}

// Preload rule: render every formula of the likely next screen in idle chunks, so the
// screen switch never pays for KaTeX inside the transition frame.
export function warmMath(strings) {
  const queue = strings.flatMap((s) => s.match(/\$[^$]+\$/g) ?? []).map((m) => m.slice(1, -1)).filter((m) => !texCache.has(m));
  const idle = window.requestIdleCallback ?? ((fn) => window.setTimeout(() => fn({ timeRemaining: () => 8 }), 1));
  const step = (deadline) => {
    while (queue.length && deadline.timeRemaining() > 2) tex(queue.shift());
    if (queue.length) idle(step);
  };
  idle(step);
}

export function MathText({ text, as: Tag = 'span', className }) {
  const parts = useMemo(() => text.split(/(\$[^$]+\$)/g).filter(Boolean), [text]);
  return (
    <Tag className={className}>
      {parts.map((p, i) =>
        p.startsWith('$') ? (
          // biome-ignore lint: prototype renders trusted fixture TeX
          <span key={i} className="tex" dangerouslySetInnerHTML={{ __html: tex(p.slice(1, -1)) }} />
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </Tag>
  );
}

/* ── Icons (1.5px stroke, 24 grid) ───────────────────── */
const P = {
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z',
  pen: 'M15.5 4.5l4 4L8 20H4v-4zM13.5 6.5l4 4',
  book: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  layers: 'M12 4 3 9l9 5 9-5zM3 14l9 5 9-5',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  plus: 'M12 5v14M5 12h14',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 11a3 3 0 1 1 0 6 3 3 0 0 1 0-6z',
  paste: 'M9 4h6v3H9zM7 5.5H5V20h14V5.5h-2M8 12h8M8 16h5',
  mic: 'M12 4a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V7a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v3',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  back: 'M15 6l-6 6 6 6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6 6 18',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
  clock: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM12 8v4l3 2',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  moon: 'M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z',
  sun: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  user: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4.5 20a7.5 7.5 0 0 1 15 0',
  settings: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM19 12l2-1-1-3-2.2.3-1.3-1.3L16.8 4.8l-3-1-1 2h-1.6l-1-2-3 1 .3 2.2L6.2 8.3 4 8l-1 3 2 1v.1l-2 1 1 3 2.2-.3 1.3 1.3-.3 2.2 3 1 1-2h1.6l1 2 3-1-.3-2.2 1.3-1.3 2.2.3 1-3-2-1z',
  thread: 'M7 4v16M7 8h7a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3H7',
  pause: 'M8 5v14M16 5v14',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  sidebar: 'M4 5h16v14H4zM9 5v14',
  panel: 'M4 5h16v14H4zM4 14h16',
  question: 'M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  photo: 'M4 5h16v14H4zM4 15l4.5-4.5 4 4 2.5-2.5L20 17M15.5 8.5h.01',
  undo: 'M9 7 5 11l4 4M5 11h9a5 5 0 0 1 0 10h-2',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  tray: 'M4 13h4l1.5 3h5l1.5-3h4M4 13l2.5-7h11L20 13v6H4z',
};

export function Icon({ name, size, className }) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size ?? 18}
      height={size ?? 18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={P[name]} />
    </svg>
  );
}

/* ── Controls ─────────────────────────────────────────── */
export function Btn({ kind = 'secondary', size, icon, kbd, children, className, ...rest }) {
  return (
    <button type="button" className={`btn btn-${kind} ${size ? `btn-${size}` : ''} ${className ?? ''}`} {...rest}>
      {icon && <Icon name={icon} />}
      {children && <span>{children}</span>}
      {kbd && <Kbd>{kbd}</Kbd>}
    </button>
  );
}

export function Kbd({ children }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Chip({ tone = 'neutral', children, icon }) {
  return (
    <span className={`chip chip-${tone}`}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

export function GoalChips({ ids }) {
  return (
    <span className="goal-chips">
      {ids.map((id) => {
        const g = goals.find((x) => x.id === id);
        return (
          <span key={id} className="goal-chip">
            {g.label}
          </span>
        );
      })}
    </span>
  );
}

export function Minutes({ n, estimate = true }) {
  return (
    <span className="minutes">
      <Icon name="clock" size={14} />
      <span className="num">约 {n} 分钟</span>
      {estimate && <span className="minutes-note">估计</span>}
    </span>
  );
}

export function StatusGlyph({ state }) {
  return <span className={`status-glyph status-${state}`} aria-hidden="true" />;
}

const STATE_LABEL = { ready: '准备好了', generating: '生成中', review: '需要复核' };

/* ── Suggestion detail: the seven questions of §7.2 ─────── */
export function SuggestionWhy({ s, compact }) {
  const { hideSuggestion } = useLoft();
  const rows = [
    ['做什么', s.what],
    ['为了什么', s.purpose],
    ['为什么现在', s.whyNow],
    ['需要', s.needs],
    ['可以停下', s.stop],
  ];
  return (
    <div className={`why ${compact ? 'why-compact' : ''}`} style={{ viewTransitionName: `why-${s.id}` }}>
      <dl className="why-rows">
        {rows.map(([k, val]) => (
          <div key={k} className="why-row">
            <dt>{k}</dt>
            <dd>
              <MathText text={val} />
            </dd>
          </div>
        ))}
      </dl>
      <div className="why-alts">
        <span className="why-alts-label">也可以</span>
        {s.alternatives.map((a) => (
          <button
            type="button"
            key={a}
            className="alt"
            onClick={() => hideSuggestion(s.id, a.startsWith('不') ? '已不再跟进' : `已改为：${a}`)}
          >
            {a}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SuggestionMeta({ s }) {
  return (
    <span className="sugg-meta">
      {s.status === 'generating' ? (
        <span className="gen-note">
          <StatusGlyph state="generating" />
          <span className="num">
            生成中 {s.progress[0]}/{s.progress[1]} · 还不能开始
          </span>
        </span>
      ) : (
        <Minutes n={s.minutes} />
      )}
      {s.deterministic && <span className="det-note">按复习间隔 · 不需要 AI</span>}
    </span>
  );
}

/* ── Uncertain judgement: observed / said / unknown ─────── */
export function Judgement({ compact }) {
  return (
    <section className={`judgement ${compact ? 'judgement-compact' : ''}`} aria-label="系统目前的判断">
      <header className="judgement-head">
        <span className="eyebrow">关于“{judgement.topic}”，目前知道的</span>
      </header>
      <dl>
        <div className="j-row">
          <dt>
            <span className="j-mark j-observed" />
            观察到
          </dt>
          <dd>{judgement.observed}</dd>
        </div>
        <div className="j-row">
          <dt>
            <span className="j-mark j-said" />
            你说过
          </dt>
          <dd>{judgement.said}</dd>
        </div>
        <div className="j-row j-unknown-row">
          <dt>
            <span className="j-mark j-unknown" />
            还不知道
          </dt>
          <dd>
            <MathText text={judgement.unknown} />
          </dd>
        </div>
      </dl>
      {!compact && (
        <p className="j-foot">
          会改变它的证据：{judgement.changeBy}
          <br />
          {judgement.photo}
        </p>
      )}
    </section>
  );
}

/* ── Hints & explanation ─────────────────────────────── */
export function HintCard({ id, inline }) {
  const { hintsSeen, revealHint } = useLoft();
  const h = hints.find((x) => x.id === id);
  const seen = hintsSeen[id];
  return (
    <div className={`hint ${seen ? 'hint-seen' : 'hint-locked'} ${inline ? 'hint-inline' : ''}`} style={{ viewTransitionName: `hint-${id}` }}>
      <div className="hint-head">
        <Icon name="bulb" size={16} />
        <span className="hint-level">{h.level}</span>
        {seen && h.seenAt && <span className="hint-at num">{h.seenAt} 已看</span>}
      </div>
      {seen ? (
        <>
          <MathText as="p" className="hint-text" text={h.text} />
          <p className="hint-record">{h.seenAt ? h.record : '第 5 步记为“看提示后完成”'}</p>
        </>
      ) : (
        <div className="hint-reveal">
          <p className="hint-record">{h.record}</p>
          <Btn kind="secondary" size="sm" kbd="H" data-act={id === 'h2' ? 'hint2' : undefined} onClick={() => revealHint(id)}>
            看这个提示
          </Btn>
        </div>
      )}
    </div>
  );
}

export function ExplainBlock() {
  const { explain, startExplain } = useLoft();
  if (explain.phase === 'closed') {
    return (
      <div className="explain explain-closed">
        <div className="hint-head">
          <Icon name="eye" size={16} />
          <span className="hint-level">完整讲解</span>
        </div>
        <p className="hint-record">打开不会清掉你的草稿；这一问会记为“看过完整讲解”。</p>
        <Btn kind="ghost" size="sm" kbd="E" data-act="explain" onClick={startExplain}>
          看完整讲解
        </Btn>
      </div>
    );
  }
  let budget = explain.shown;
  const shownParas = [];
  for (const para of explanation) {
    if (budget <= 0) break;
    shownParas.push(budget >= para.length ? para : cutTex(para, budget));
    budget -= para.length;
  }
  return (
    <div className={`explain explain-${explain.phase}`} aria-live="polite">
      <div className="hint-head">
        <Icon name="eye" size={16} />
        <span className="hint-level">完整讲解</span>
        {explain.phase === 'streaming' ? (
          <span className="tmp-badge">生成中 · 未生效</span>
        ) : (
          <span className="hint-at">已记为“看过完整讲解”</span>
        )}
      </div>
      {shownParas.map((p, i) => (
        <MathText key={i} as="p" className="explain-text" text={p} />
      ))}
      {explain.phase === 'done' && <p className="hint-record">讲解不会改动你的草稿或判分；草稿仍由你决定是否修改。</p>}
    </div>
  );
}

// Never cut inside a $…$ span while streaming.
function cutTex(s, n) {
  let out = s.slice(0, n);
  if ((out.match(/\$/g) || []).length % 2 === 1) out = out.slice(0, out.lastIndexOf('$'));
  return out;
}

/* ── Problem pieces ───────────────────────────────────── */
export function Stem({ withFigure = true, clamp }) {
  return (
    <div className={`stem ${clamp ? 'stem-clamp' : ''}`}>
      {withFigure && (
        <figure className="stem-figure">
          <EllipseFigure />
        </figure>
      )}
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
  );
}

export function Part1Done() {
  const p = problem.parts[0];
  return (
    <div className="part-done">
      <Icon name="check" size={16} />
      <span>
        第 {p.label} 问 · <span className="num">{p.at}</span> 已提交 · 核对正确
      </span>
      <MathText className="part-done-detail" text={p.check} />
    </div>
  );
}

export function Part2Status() {
  const { part2 } = useLoft();
  if (part2 === 'working') return null;
  if (part2 === 'checking')
    return (
      <div className="part-result part-checking" style={{ viewTransitionName: 'part2' }}>
        <StatusGlyph state="generating" />
        已收到第 (2) 问，正在核对最终答案…
      </div>
    );
  return (
    <div className="part-result part-mismatch" style={{ viewTransitionName: 'part2' }}>
      <p>
        <strong>最终答案与参考不一致。</strong>
        <MathText text="你的答案 $2\sqrt{3}$，参考答案 $3$（确定性核对）。" />
      </p>
      <p className="part-cause">
        <span className="j-mark j-unknown" />
        原因还没判断：可能在取等条件，也可能在 <MathText text="$t$" /> 的范围。不会只按最终答案解释你的能力。
      </p>
    </div>
  );
}

export function PhotoChip() {
  return (
    <span className="photo-chip">
      <Icon name="photo" size={14} />
      学校草稿照片 · {problem.photoDate}
    </span>
  );
}

/* ── Draft steps ──────────────────────────────────────── */
export function StepText({ step }) {
  const { editStep } = useLoft();
  const [editing, setEditing] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (editing && ref.current) {
      ref.current.focus();
      ref.current.style.height = 'auto';
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  }, [editing]);
  if (editing)
    return (
      <textarea
        ref={ref}
        className="step-edit"
        value={step.text}
        onChange={(e) => {
          e.target.style.height = 'auto';
          e.target.style.height = `${e.target.scrollHeight}px`;
          editStep(step.id, e.target.value);
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
      />
    );
  return (
    <button type="button" className="step-text" onClick={() => setEditing(true)} title="点击修改">
      <MathText text={step.text} />
    </button>
  );
}

export function StepMeta({ step }) {
  return (
    <span className="step-meta">
      {step.origin === 'photo' ? (
        <span className="prov prov-photo">
          <Icon name="photo" size={13} />
          学校草稿
        </span>
      ) : (
        <span className="prov prov-tonight">今晚</span>
      )}
      {step.help === 'h1' && <span className="prov prov-help">看提示 1 后</span>}
      {step.current && <span className="prov prov-current">正在写</span>}
    </span>
  );
}

export function StepUnclear({ step }) {
  if (!step.unclear) return null;
  return (
    <p className="step-unclear">
      <span className="j-mark j-unknown" />
      {step.unclear}
    </p>
  );
}

export function Composer({ placeholder = '写下一步…  $公式$ · 回车添加' }) {
  const { addStep } = useLoft();
  const [text, setText] = useState('');
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        addStep(text.trim());
        setText('');
      }}
    >
      <textarea
        className="composer-input"
        data-draft-input
        rows={1}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form.requestSubmit();
          }
        }}
      />
      <Btn kind="secondary" size="sm" type="submit" icon="plus">
        添加
      </Btn>
    </form>
  );
}

export function SaveState() {
  const { save } = useLoft();
  return (
    <span className={`save save-${save}`} aria-live="polite">
      <span className="save-dot" />
      {save === 'saving' ? '保存中…' : '已保存'}
    </span>
  );
}

export function NextUp({ short }) {
  const { prefetch, preload } = useLoft();
  useEffect(() => {
    const t = window.setTimeout(() => preload('next', '作答时预取'), 900);
    return () => window.clearTimeout(t);
  }, [preload]);
  if (!prefetch.next) return null;
  return (
    <span className="next-up">
      <StatusGlyph state="ready" />
      <span className="next-up-label">{short ? '下一项' : '下一项已备好'}</span>
    </span>
  );
}

/* ── Readiness / cost / backlog ───────────────────────── */
export function Readiness({ dense }) {
  return (
    <ul className={`readiness ${dense ? 'readiness-dense' : ''}`}>
      {readiness.map((r) => (
        <li key={r.id} className={`ready-row ready-${r.state}`}>
          <StatusGlyph state={r.state} />
          <div className="ready-body">
            <div className="ready-title">
              <span>{r.title}</span>
              <span className={`ready-state ready-state-${r.state}`}>{STATE_LABEL[r.state]}</span>
            </div>
            <MathText as="p" className="ready-detail" text={r.detail} />
          </div>
          <span className="ready-at num">{r.at}</span>
        </li>
      ))}
    </ul>
  );
}

export function CostLine() {
  return (
    <p className="cost-line">
      本周 AI 费用{' '}
      <span className="num">
        {cost.currency}
        {cost.week.toFixed(2)}
      </span>{' '}
      / 上限{' '}
      <span className="num">
        {cost.currency}
        {cost.cap}
      </span>
    </p>
  );
}

export function Backlog() {
  const [open, setOpen] = useState(false);
  return (
    <section className="backlog">
      <button type="button" className="backlog-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="down" size={16} className={open ? 'rot' : ''} />
        <span>
          全部未完成 <span className="num">{backlog.length}</span>
        </span>
        <span className="backlog-note">不会累积成欠账，想看时再看</span>
      </button>
      {open && (
        <ul className="backlog-list">
          {backlog.map((b) => (
            <li key={b.id}>
              <span>{b.title}</span>
              <span className="backlog-meta">{b.meta}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── Data states ──────────────────────────────────────── */
export function Skeleton({ lines = 3, block }) {
  return (
    <div className={`sk ${block ? 'sk-block' : ''}`} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="sk-line" style={{ width: `${[92, 76, 58, 84][i % 4]}%` }} />
      ))}
    </div>
  );
}

export function RegionError({ what = '建议', onRetry }) {
  return (
    <div className="region-error" role="status">
      <p>
        <strong>{what}暂时取不到。</strong>服务没有响应；已保存的学习不受影响，可以照常继续。
      </p>
      <Btn kind="secondary" size="sm" onClick={onRetry}>
        重试
      </Btn>
    </div>
  );
}

/* ── Figures ──────────────────────────────────────────── */
export function EllipseFigure() {
  // x²/4 + y²/3 = 1, scale 56px/unit, origin (170,125); l: x = 0.5y + 1.
  return (
    <svg className="fig" viewBox="0 0 340 250" role="img" aria-label="椭圆 C、焦点 F1 F2 与过 F2 的直线 l 交 C 于 A、B">
      <line className="fig-axis" x1="20" y1="125" x2="324" y2="125" />
      <line className="fig-axis" x1="170" y1="240" x2="170" y2="10" />
      <path className="fig-axis" d="M318 121l6 4-6 4M166 16l4-6 4 6" />
      <ellipse className="fig-curve" cx="170" cy="125" rx="112" ry="97" />
      <polygon className="fig-area" points="114,125 256.7,63.6 177.6,221.8" />
      <line className="fig-line" x1="167.2" y1="242.6" x2="268" y2="41" />
      <line className="fig-dash" x1="226" y1="41" x2="226" y2="125" />
      {[
        [114, 125],
        [226, 125],
        [256.7, 63.6],
        [177.6, 221.8],
        [226, 41],
      ].map(([x, y]) => (
        <circle key={`${x},${y}`} className="fig-pt" cx={x} cy={y} r="3" />
      ))}
      <g className="fig-label">
        <text x="98" y="143">F₁</text>
        <text x="232" y="143">F₂</text>
        <text x="262" y="60">A</text>
        <text x="186" y="236">B</text>
        <text x="232" y="38">P</text>
        <text x="156" y="141">O</text>
        <text x="314" y="143">x</text>
        <text x="178" y="20">y</text>
        <text x="246" y="104" className="fig-l">l</text>
      </g>
    </svg>
  );
}

export function DraftPhoto() {
  return (
    <svg className="photo" viewBox="0 0 300 168" role="img" aria-label="学校草稿照片，第 3 行识别不清">
      <defs>
        <pattern id="grid" width="12" height="12" patternUnits="userSpaceOnUse">
          <path d="M12 0H0V12" fill="none" stroke="#d9e2ea" strokeWidth="0.6" />
        </pattern>
        <filter id="smudge">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      <g transform="rotate(-1.2 150 84)">
        <rect x="6" y="6" width="288" height="156" rx="3" fill="#f7f4ec" />
        <rect x="6" y="6" width="288" height="156" rx="3" fill="url(#grid)" />
        <g className="photo-ink">
          <text x="20" y="34">设 l: y=k(x−1)，代入</text>
          <text x="20" y="60">(3+4k²)x² − 8k²x + 4k² − 12 = 0</text>
          <text x="20" y="86">x₁+x₂ = 8k²/(3+4k²) …</text>
          <text x="20" y="112">S = ½·|F₁F₂|·|y₁−y₂| =</text>
          <text x="196" y="112" filter="url(#smudge)">|k|·√(1+k²)…</text>
        </g>
        <rect className="photo-unclear" x="188" y="94" width="96" height="26" rx="4" />
      </g>
    </svg>
  );
}

/* ── Command palette ──────────────────────────────────── */
export function CommandPalette({ commands }) {
  const { palette, setPalette } = useLoft();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const inputRef = useRef(null);
  const list = useMemo(
    () => commands.filter((c) => !q || `${c.label}${c.group}${c.keywords ?? ''}`.toLowerCase().includes(q.toLowerCase())),
    [commands, q],
  );
  useEffect(() => {
    if (palette) {
      setQ('');
      setI(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [palette]);
  if (!palette) return null;
  const run = (c) => {
    setPalette(false);
    c.run();
  };
  let lastGroup = null;
  return (
    <div className="palette-scrim" onMouseDown={() => setPalette(false)}>
      <div
        className="palette"
        role="dialog"
        aria-label="命令面板"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setPalette(false);
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setI((x) => Math.min(list.length - 1, x + 1));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setI((x) => Math.max(0, x - 1));
          }
          if (e.key === 'Enter' && list[i]) run(list[i]);
        }}
      >
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setI(0);
            }}
            placeholder="搜索、跳转，或输入要做的事…"
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul className="palette-list">
          {list.map((c, idx) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.label}>
                {head && <div className="palette-group">{head}</div>}
                <button
                  type="button"
                  className={`palette-item ${idx === i ? 'is-active' : ''}`}
                  onMouseEnter={() => setI(idx)}
                  onClick={() => run(c)}
                >
                  <Icon name={c.icon ?? 'arrow'} size={16} />
                  <span className="palette-label">{c.label}</span>
                  {c.kbd && <Kbd>{c.kbd}</Kbd>}
                </button>
              </li>
            );
          })}
          {list.length === 0 && <li className="palette-empty">没有匹配的命令。回车可以把这句话交给学习伙伴。</li>}
        </ul>
      </div>
    </div>
  );
}

export function useCommands() {
  const { go, setParam, params, revealHint, startExplain, setHelpOpen, toast } = useLoft();
  return [
    { group: '继续', label: '继续：椭圆综合题 · 第 (2) 问', icon: 'pen', run: () => go('work') },
    { group: '继续', label: '开始：短对比例子（约 12 分钟）', icon: 'spark', run: () => toast({ text: '短对比例子已打开（原型未实现该页）。' }) },
    { group: '继续', label: '到期复习 · 4 项', icon: 'layers', run: () => toast({ text: '复习页不在本次 loft 范围内。' }) },
    { group: '带来', label: '拍照或上传材料', icon: 'camera', keywords: 'photo upload', run: () => toast({ text: '上传入口（原型）。' }) },
    { group: '带来', label: '粘贴一段文字', icon: 'paste', run: () => toast({ text: '粘贴入口（原型）。' }) },
    { group: '带来', label: '说一段经历', icon: 'mic', run: () => toast({ text: '口述入口（原型）。' }) },
    { group: '这道题', label: '要一点提示（提示 2）', icon: 'bulb', kbd: 'H', run: () => { go('work'); setHelpOpen(true); revealHint('h2'); } },
    { group: '这道题', label: '看完整讲解', icon: 'eye', kbd: 'E', run: () => { go('work'); setHelpOpen(true); startExplain(); } },
    { group: '这道题', label: '只保存，今晚停在这里', icon: 'pause', run: () => toast({ text: '断点已保存：第 5 步。回来时从这里接上。' }) },
    { group: '前往', label: '回来时（首页）', icon: 'home', run: () => go('home') },
    { group: '前往', label: '我的学习', icon: 'user', run: () => toast({ text: '“我的学习”不在本次 loft 范围内。' }) },
    { group: '前往', label: '系统为我做了什么', icon: 'spark', run: () => toast({ text: '“系统为我做了什么”不在本次 loft 范围内。' }) },
    { group: '外观', label: params.theme === 'dark' ? '切换到亮色' : '切换到暗色', icon: params.theme === 'dark' ? 'sun' : 'moon', run: () => setParam({ theme: params.theme === 'dark' ? 'light' : 'dark' }) },
  ];
}

/* ── Toasts ───────────────────────────────────────────── */
export function Toasts() {
  const { toasts, dismissToast } = useLoft();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone ?? 'neutral'}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.onAction?.();
                dismissToast(t.id);
              }}
            >
              {t.action === '撤销' && <Icon name="undo" size={14} />}
              {t.action}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Shortcuts ────────────────────────────────────────── */
export function useProductShortcuts(extra = {}) {
  const { params, setPalette, palette, go, revealHint, startExplain, setHelpOpen, helpOpen } = useLoft();
  useEffect(() => {
    const onKey = (e) => {
      const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName ?? '');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(!palette);
        return;
      }
      if (typing || palette || e.metaKey || e.ctrlKey || e.altKey) return;
      if (params.screen === 'work') {
        if (e.key === 'h' || e.key === 'H') {
          setHelpOpen(true);
          revealHint('h2');
        }
        if (e.key === 'e' || e.key === 'E') {
          setHelpOpen(true);
          startExplain();
        }
        if (e.key === 'Escape' && helpOpen) setHelpOpen(false);
        if (e.key === 'd' || e.key === 'D') {
          e.preventDefault();
          document.querySelector('[data-draft-input]')?.focus();
        }
        if (e.key === '[') go('home');
      }
      extra[e.key]?.(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
}

/* ── Brand mark: woven grid with one coral thread ─────── */
export function Mark({ size = 22 }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="var(--bg-inverse)" />
      <path d="M8 6v12M16 6v12M6 8h12M6 16h12" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" opacity="0.55" />
      <path d="M6 12h12" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function ThemeButton({ className }) {
  const { params, setParam } = useLoft();
  const dark = params.theme === 'dark';
  return (
    <button
      type="button"
      className={`icon-btn ${className ?? ''}`}
      aria-label={dark ? '切换到亮色' : '切换到暗色'}
      onClick={() => setParam({ theme: dark ? 'light' : 'dark' })}
    >
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  );
}

export function useEnterToContinue() {
  const { go, palette } = useLoft();
  useEffect(() => {
    const onKey = (e) => {
      const typing = /INPUT|TEXTAREA|BUTTON/.test(document.activeElement?.tagName ?? '');
      if (e.key === 'Enter' && !typing && !palette && !e.metaKey) go('work');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, palette]);
}

export function useSubmitShortcut() {
  const { submitPart2, part2 } = useLoft();
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && part2 === 'working') {
        e.preventDefault();
        submitPart2();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submitPart2, part2]);
}
