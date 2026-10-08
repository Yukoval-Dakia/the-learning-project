// Variant A · 纸页 (Folio)
// Navigation: top bar + ⌘K, no sidebar. Home: one reading column, a narrative lead and an
// equal "continue / suggestion" pair. Workbench: a single document — stem, my draft steps —
// with help as margin notes anchored to the step they concern (inline on narrow screens).
import { useState } from 'react';
import { absence, continueItems, lead, now, problem, suggestions } from './fixture.js';
import {
  Backlog,
  Btn,
  Composer,
  CostLine,
  DraftPhoto,
  ExplainBlock,
  GoalChips,
  HintCard,
  Icon,
  Judgement,
  Kbd,
  Mark,
  MathText,
  Minutes,
  NextUp,
  Part1Done,
  Part2Status,
  Readiness,
  RegionError,
  SaveState,
  Skeleton,
  StatusGlyph,
  Stem,
  StepMeta,
  StepText,
  StepUnclear,
  SuggestionMeta,
  SuggestionWhy,
  ThemeButton,
  useEnterToContinue,
  useSubmitShortcut,
} from './shared.jsx';
import { useLoft } from './store.jsx';

const A_NAV = [
  { id: 'home', label: '回来时', icon: 'home' },
  { id: 'library', label: '资料', icon: 'book' },
  { id: 'me', label: '我的学习', icon: 'user' },
];

export function Shell({ children }) {
  const { params, setPalette, go, toast } = useLoft();
  const nav = (id) => (id === 'home' ? go('home') : toast({ text: '该区域不在本次 loft 范围内。' }));
  return (
    <div className={`a-app a-on-${params.screen}`}>
      <header className="a-top">
        <button type="button" className="a-brand" onClick={() => go('home')}>
          <Mark />
          <span>Loom</span>
        </button>
        <nav className="a-nav" aria-label="主导航">
          {A_NAV.map((n) => (
            <button
              type="button"
              key={n.id}
              className={`a-nav-item ${params.screen === n.id ? 'is-active' : ''}`}
              aria-current={params.screen === n.id ? 'page' : undefined}
              onClick={() => nav(n.id)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn a-sys"
          aria-label="系统为我做了什么：1 项准备好了，1 项需要复核"
          title="系统为我做了什么"
          onClick={() => toast({ text: '“系统为我做了什么”不在本次 loft 范围内。' })}
        >
          <Icon name="tray" />
          <span className="a-sys-dot" />
        </button>
        <button type="button" className="a-search" onClick={() => setPalette(true)}>
          <Icon name="search" size={16} />
          <span className="a-search-label">搜索或跳转</span>
          <Kbd>⌘K</Kbd>
        </button>
        <Btn kind="ghost" icon="plus" className="a-bring" onClick={() => toast({ text: '带来材料：拍照、粘贴或口述（原型）。' })}>
          <span className="a-bring-label">带来材料</span>
        </Btn>
        <ThemeButton />
      </header>
      <main className="a-main">{children}</main>
      {params.screen === 'home' && (
        <nav className="a-tabbar" aria-label="主导航">
          {[A_NAV[0], A_NAV[1], { id: 'add', label: '带来', icon: 'plus' }, A_NAV[2]].map((n) => (
            <button
              type="button"
              key={n.id}
              className={`a-tab ${params.screen === n.id ? 'is-active' : ''} ${n.id === 'add' ? 'a-tab-add' : ''}`}
              onClick={() => (n.id === 'add' ? toast({ text: '带来材料：拍照、粘贴或口述（原型）。' }) : nav(n.id))}
            >
              <Icon name={n.icon} size={20} />
              <span>{n.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

/* ── Home ─────────────────────────────────────────────── */
export function Home() {
  const { params } = useLoft();
  useEnterToContinue();
  const state = params.state;
  if (state === 'loading') return <HomeLoading />;
  if (state === 'empty') return <HomeEmpty />;
  const primary = continueItems[0];
  const s0 = suggestions.find((s) => s.id === 'g-contrast');
  return (
    <div className="a-home">
      <p className="eyebrow num">
        {now.date} · {now.part}
      </p>
      {state === 'absent' ? (
        <div className="a-lead">
          <h1 className="a-lead-head">
            <span className="num">{absence.days}</span> 天没见。
          </h1>
          <p className="a-lead-body">
            {absence.text}
            {absence.offer}
          </p>
        </div>
      ) : (
        <div className="a-lead">
          <h1 className="a-lead-head">{lead.headline}</h1>
          <MathText as="p" className="a-lead-body" text={lead.body} />
        </div>
      )}
      <p className="a-budget">
        今晚约 <span className="num">{now.availableMinutes}</span> 分钟 <span className="a-dim">· {now.availableSource}</span>
        <button type="button" className="a-link">
          修改
        </button>
      </p>

      <div className="a-pair">
        <ContinueCard item={primary} />
        {state === 'error' ? (
          <div className="a-card a-card-error">
            <p className="a-card-label">系统建议</p>
            <RegionError what="系统建议" />
          </div>
        ) : s0 ? (
          <SuggestCard s={s0} />
        ) : (
          <div className="a-card a-card-quiet">
            <p className="a-card-label">系统建议</p>
            <p className="a-quiet">今晚没有新的建议。继续你自己的就好。</p>
          </div>
        )}
      </div>

      <BringRow />

      <section className="a-section">
        <h2 className="a-h2">也可以</h2>
        <ul className="a-rows">
          {continueItems.slice(1).map((c) => (
            <li key={c.id} className="a-row">
              <span className="a-row-src">你的</span>
              <div className="a-row-main">
                <span className="a-row-title">{c.title}</span>
                <MathText className="a-row-meta" text={`${c.where} · ${c.meta}`} />
              </div>
              <Btn kind="ghost" size="sm">
                继续
              </Btn>
            </li>
          ))}
          {state !== 'error' &&
            suggestions
              .filter((s) => s.id !== 'g-contrast')
              .map((s) => <SuggestRow key={s.id} s={s} />)}
        </ul>
      </section>

      <section className="a-section">
        <h2 className="a-h2">系统准备的</h2>
        <Readiness />
        <CostLine />
      </section>

      <Backlog />
    </div>
  );
}

function ContinueCard({ item }) {
  const { go, preload } = useLoft();
  return (
    <article className="a-card a-card-continue" onPointerEnter={() => preload('work', '悬停意图')}>
      <p className="a-card-label">
        继续你的 <span className="a-saved">· {item.saved}</span>
      </p>
      <h2 className="a-card-title" style={{ viewTransitionName: 'task-title' }}>
        {item.title}
      </h2>
      <MathText as="p" className="a-card-body" text={item.where} />
      <p className="a-card-meta">
        <GoalChips ids={[item.goal]} />
        <span className="num">已用 {item.spent} 分钟</span>
      </p>
      <div className="a-card-actions">
        <Btn kind="primary" kbd="↵" data-act="continue" onClick={() => go('work')}>
          继续
        </Btn>
      </div>
    </article>
  );
}

function SuggestCard({ s }) {
  const { expanded, toggleExpanded, toast } = useLoft();
  const open = expanded === s.id;
  return (
    <article className="a-card a-card-suggest" style={{ viewTransitionName: `card-${s.id}` }}>
      <p className="a-card-label">
        系统建议 <StatusGlyph state="ready" /> <span className="a-ready">准备好了</span>
      </p>
      <h2 className="a-card-title">{s.title}</h2>
      <p className="a-card-body">
        <span className="a-dim">为了：</span>
        <MathText text={s.purpose} />
      </p>
      <p className="a-card-meta">
        <Minutes n={s.minutes} />
        <span className="a-dim">纸笔</span>
      </p>
      {open && <SuggestionWhy s={s} />}
      <div className="a-card-actions">
        <Btn kind="secondary" onClick={() => toast({ text: '短对比例子已打开（原型未实现该页）。' })}>
          开始
        </Btn>
        <Btn kind="quiet" aria-expanded={open} data-act="why" onClick={() => toggleExpanded(s.id)}>
          {open ? '收起' : '为什么 · 换一种'}
        </Btn>
      </div>
    </article>
  );
}

function SuggestRow({ s }) {
  const { expanded, toggleExpanded, hideSuggestion } = useLoft();
  const open = expanded === s.id;
  return (
    <li className="a-row a-row-sugg" style={{ viewTransitionName: `row-${s.id}` }}>
      <span className="a-row-src">建议</span>
      <div className="a-row-main">
        <button type="button" className="a-row-title a-row-toggle" aria-expanded={open} onClick={() => toggleExpanded(s.id)}>
          {s.title}
          <Icon name="down" size={14} className={open ? 'rot' : ''} />
        </button>
        <span className="a-row-meta">
          <SuggestionMeta s={s} />
        </span>
        {open && <SuggestionWhy s={s} compact />}
      </div>
      {s.status === 'ready' ? (
        <Btn kind="ghost" size="sm" data-act="snooze" onClick={() => hideSuggestion(s.id, '已推迟到明天')}>
          推迟
        </Btn>
      ) : (
        <span />
      )}
    </li>
  );
}

function BringRow() {
  const { toast } = useLoft();
  return (
    <div className="a-bring-row">
      <span className="a-dim">或者带来新的：</span>
      {[
        ['camera', '拍照或上传'],
        ['paste', '粘贴文字'],
        ['mic', '说一段'],
      ].map(([icon, label]) => (
        <Btn key={label} kind="ghost" size="sm" icon={icon} onClick={() => toast({ text: `${label}（原型）。` })}>
          {label}
        </Btn>
      ))}
    </div>
  );
}

function HomeLoading() {
  return (
    <div className="a-home" aria-busy="true">
      <p className="eyebrow num">
        {now.date} · {now.part}
      </p>
      <div className="a-lead">
        <Skeleton lines={3} block />
      </div>
      <div className="a-pair">
        <div className="a-card">
          <Skeleton lines={4} block />
        </div>
        <div className="a-card">
          <Skeleton lines={4} block />
        </div>
      </div>
      <p className="a-dim a-loading-note">正在读取已保存的学习…</p>
    </div>
  );
}

function HomeEmpty() {
  const { toast } = useLoft();
  return (
    <div className="a-home">
      <p className="eyebrow num">
        {now.date} · {now.part}
      </p>
      <div className="a-lead">
        <h1 className="a-lead-head">这里还没有可以继续的学习。</h1>
        <p className="a-lead-body">从你手上的东西开始就好：一道题、一页笔记、一段想法。也可以让系统先提一个建议。</p>
      </div>
      <div className="a-empty-grid">
        {[
          ['camera', '带来一道题', '拍照或上传，原件会先保存'],
          ['paste', '粘贴一段材料', '文章、笔记或题目文字'],
          ['spark', '让系统先提一个', '会说明理由，可以不接受'],
        ].map(([icon, title, note]) => (
          <button type="button" key={title} className="a-empty-tile" onClick={() => toast({ text: `${title}（原型）。` })}>
            <Icon name={icon} size={22} />
            <span className="a-empty-title">{title}</span>
            <span className="a-dim">{note}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Workbench ────────────────────────────────────────── */
export function Workbench() {
  const { go, steps, part2, submitPart2, revealHint, startExplain, toast } = useLoft();
  useSubmitShortcut();
  const last = steps[steps.length - 1]?.id;
  return (
    <div className="a-work">
      <div className="a-context">
        <button type="button" className="a-back" data-act="back" onClick={() => go('home')}>
          <Icon name="back" size={16} />
          <span>回来时</span>
        </button>
        <div className="a-context-title">
          <h1 style={{ viewTransitionName: 'task-title' }}>{continueItems[0].title}</h1>
          <MathText className="a-context-part" text={problem.parts[1].text} />
        </div>
        <span className="spacer" />
        <NextUp />
        <SaveState />
      </div>

      <div className="a-doc">
        <section className="a-problem">
          <p className="a-problem-src">
            <span>{problem.source}</span>
            <GoalChips ids={problem.goals} />
          </p>
          <Stem />
          <Part1Done />
        </section>

        <section className="a-draft">
          <header className="a-draft-head">
            <h2 className="a-h2">第 (2) 问 · 我的草稿</h2>
            <span className="a-dim">点任一步可以修改</span>
          </header>
          <ol className="a-steps">
            {steps.map((s, i) => (
              <li key={s.id} className={`a-step ${s.fresh ? 'enter' : ''}`}>
                <MarginNote stepId={s.id} isLast={s.id === last} />
                <span className="a-step-n num">{i + 1}</span>
                <div className="a-step-body" style={{ viewTransitionName: `step-${s.id}` }}>
                  <StepText step={s} />
                  <StepMeta step={s} />
                  <StepUnclear step={s} />
                </div>
              </li>
            ))}
          </ol>
          <div className="a-composer">
            <Composer />
          </div>
          <Part2Status />
          <div className="a-actions">
            <Btn kind="primary" kbd="⌘↵" onClick={submitPart2} disabled={part2 !== 'working'}>
              提交第 (2) 问
            </Btn>
            <Btn kind="secondary" icon="bulb" kbd="H" data-act="hint2" onClick={() => { revealHint('h2'); bringNote(); }}>
              <span className="a-hide-sm">要一点</span>提示
            </Btn>
            <Btn kind="ghost" icon="eye" kbd="E" data-act="explain" onClick={() => { startExplain(); bringNote(); }}>
              讲解
            </Btn>
            <span className="spacer" />
            <Btn kind="quiet" icon="pause" onClick={() => toast({ text: '断点已保存：第 5 步。回来时从这里接上。' })}>
              <span className="a-hide-sm">停在这里</span>
            </Btn>
          </div>
        </section>
      </div>
    </div>
  );
}

// Help requested from the bottom bar lands in the last step's note; keep it in view.
function bringNote() {
  window.setTimeout(() => {
    document.querySelector('[data-note-last]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 260);
}

function MarginNote({ stepId, isLast }) {
  const { hintsSeen, explain } = useLoft();
  const [manual, setManual] = useState(null);
  // On narrow screens notes are collapsed; asking for help opens the note it lands in.
  const asked = isLast && (hintsSeen.h2 || explain.phase !== 'closed');
  const open = manual ?? asked;
  const setOpen = (fn) => setManual(fn(open));
  let label = null;
  let body = null;
  if (stepId === 's3') {
    label = '学校草稿照片 · 10/5';
    body = (
      <div className="a-note-photo">
        <DraftPhoto />
        <p className="hint-record">第 1–3 步来自这张照片；第 3 行后半段识别不清。</p>
      </div>
    );
  } else if (stepId === 's4') {
    label = '提示 1 · 19:42 已看';
    body = <HintCard id="h1" />;
  } else if (isLast) {
    label = '关于这一步 · 提示 2 · 讲解';
    body = (
      <div className="a-note-stack">
        <Judgement compact />
        <HintCard id="h2" />
        <ExplainBlock />
      </div>
    );
  }
  if (!body) return null;
  return (
    <aside className={`a-note ${open ? 'is-open' : ''}`} data-note-last={isLast ? '' : undefined}>
      <button type="button" className="a-note-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="down" size={14} className={open ? 'rot' : ''} />
        {label}
      </button>
      <div className="a-note-body">{body}</div>
    </aside>
  );
}
