// Variant B · 工作室 (Studio)
// Navigation: persistent left rail (desktop) / bottom tab bar (phone). Home: a two-column
// panel — "your work" beside "system suggestions" — under a strip of real constraints.
// Workbench: three panes (problem / my draft / help); on a phone, a segmented switch.
import { useState } from 'react';
import { absence, continueItems, goals, lead, now, problem, suggestions } from './fixture.js';
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

const NAV = [
  { id: 'home', label: '今天', icon: 'home' },
  { id: 'work', label: '学习', icon: 'pen', badge: '1' },
  { id: 'library', label: '资料', icon: 'book' },
  { id: 'me', label: '我的学习', icon: 'user' },
  { id: 'system', label: '系统为我做了什么', icon: 'tray', badge: '1', tone: 'caution' },
];

export function Shell({ children }) {
  const { params, go, setPalette, toast } = useLoft();
  const here = params.screen;
  const nav = (id) => (id === 'home' || id === 'work' ? go(id) : toast({ text: '该区域不在本次 loft 范围内。' }));
  return (
    <div className="b-app">
      <aside className="b-rail">
        <div className="b-brand">
          <Mark />
          <span>Loom</span>
        </div>
        <nav className="b-nav">
          {NAV.map((n) => (
            <button
              type="button"
              key={n.id}
              className={`b-nav-item ${here === n.id ? 'is-active' : ''}`}
              aria-current={here === n.id ? 'page' : undefined}
              onClick={() => nav(n.id)}
            >
              <Icon name={n.icon} />
              <span>{n.label}</span>
              {n.badge && <span className={`b-badge ${n.tone ? `b-badge-${n.tone}` : ''}`}>{n.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="b-rail-foot">
          <button type="button" className="b-nav-item" onClick={() => toast({ text: '设置（原型）。' })}>
            <Icon name="settings" />
            <span>设置</span>
          </button>
          <ThemeButton />
        </div>
      </aside>
      <div className="b-main">
        <header className="b-top">
          {here === 'work' ? (
            <nav className="b-crumbs" aria-label="位置">
              <button type="button" data-act="back" onClick={() => go('home')}>
                <Icon name="back" size={16} className="b-only-sm" />
                <span className="b-hide-sm">今天</span>
              </button>
              <Icon name="chevron" size={14} className="b-hide-sm" />
              <span>学习</span>
            </nav>
          ) : (
            <h1 className="b-top-title">今天</h1>
          )}
          <span className="spacer" />
          <button type="button" className="b-search" onClick={() => setPalette(true)}>
            <Icon name="search" size={16} />
            <span className="b-hide-sm">搜索或跳转</span>
            <Kbd>⌘K</Kbd>
          </button>
          <Btn kind="primary" size="sm" icon="plus" className="b-bring" onClick={() => toast({ text: '带来材料（原型）。' })}>
            <span className="b-hide-sm">带来材料</span>
          </Btn>
          <ThemeButton className="b-only-sm" />
        </header>
        <div className="b-content">{children}</div>
      </div>
      <nav className="b-tabbar" aria-label="主导航">
        {[NAV[0], NAV[1], { id: 'add', label: '带来', icon: 'plus' }, NAV[2], NAV[3]].map((n) => (
          <button
            type="button"
            key={n.id}
            className={`b-tab ${here === n.id ? 'is-active' : ''} ${n.id === 'add' ? 'b-tab-add' : ''}`}
            onClick={() => (n.id === 'add' ? toast({ text: '带来材料（原型）。' }) : nav(n.id))}
          >
            <Icon name={n.icon} size={20} />
            <span>{n.id === 'me' ? '我的' : n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

/* ── Home ─────────────────────────────────────────────── */
function Stat({ label, value, unit, note, locked }) {
  return (
    <div className="b-stat">
      <span className="b-stat-label">
        {label}
        {locked && <span className="b-lock">锁定</span>}
      </span>
      <span className="b-stat-value">
        <span className="num">{value}</span>
        <span className="b-stat-unit">{unit}</span>
      </span>
      <span className="b-stat-note">{note}</span>
    </div>
  );
}

export function Home() {
  const { params, suggestions: live } = useLoft();
  useEnterToContinue();
  const state = params.state;
  const loading = state === 'loading';
  return (
    <div className="b-home">
      <header className="b-home-head">
        <p className="eyebrow num">
          {now.date} · {now.part}
        </p>
        <div className="b-constraints">
          <Stat label="今晚可用" value={now.availableMinutes} unit="分钟" note={`${now.availableSource} · 可改`} />
          <Stat label="期中考试" value="14" unit="天后" note="10/21 · 选必一第三章" />
          <Stat label="学校作业" value="周五" unit="交" note="圆锥曲线 · 剩 2 题" locked />
        </div>
      </header>

      {state === 'absent' ? (
        <p className="b-summary">
          <strong>
            <span className="num">{absence.days}</span> 天没见。
          </strong>
          {absence.text}
        </p>
      ) : state === 'empty' ? (
        <p className="b-summary">
          <strong>还没有可以继续的学习。</strong>带来一道题或一页笔记就能开始，也可以让系统先提一个建议。
        </p>
      ) : loading ? (
        <div className="b-summary">
          <Skeleton lines={2} />
        </div>
      ) : (
        <p className="b-summary">
          <strong>{lead.headline}</strong>
          <MathText text={lead.body} />
        </p>
      )}

      <div className="b-columns">
        <section className="b-panel" aria-label="接着做">
          <header className="b-panel-head">
            <h2>接着做</h2>
            <span className="b-panel-sub">你的</span>
            <span className="b-count num">{state === 'empty' ? 0 : continueItems.length}</span>
          </header>
          {loading ? (
            <Skeleton lines={4} block />
          ) : state === 'empty' ? (
            <EmptyPanel />
          ) : (
            <ul className="b-list">
              {continueItems.map((c, i) => (
                <ContinueRow key={c.id} c={c} primary={i === 0} />
              ))}
            </ul>
          )}
        </section>

        <section className="b-panel" aria-label="系统建议">
          <header className="b-panel-head">
            <h2>建议</h2>
            <span className="b-panel-sub">系统的 · 都可以不接受</span>
            <span className="b-count num">{state === 'error' || loading ? '–' : live.length}</span>
          </header>
          {loading ? (
            <Skeleton lines={4} block />
          ) : state === 'error' ? (
            <RegionError what="系统建议" />
          ) : (
            <ul className="b-list">
              {live.map((s) => (
                <SuggestRow key={s.id} s={s} />
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="b-columns b-columns-lower">
        <section className="b-panel b-panel-sunk" aria-label="系统为我做了什么">
          <header className="b-panel-head">
            <h2>系统为我做了什么</h2>
          </header>
          <Readiness dense />
          <CostLine />
        </section>
        <section className="b-panel b-panel-sunk" aria-label="目标">
          <header className="b-panel-head">
            <h2>目标</h2>
            <span className="b-panel-sub">管理</span>
          </header>
          <ul className="b-goals">
            {goals.map((g) => (
              <li key={g.id}>
                <span className="b-goal-label">{g.label}</span>
                <span className="b-goal-detail">{g.detail}</span>
                <span className="b-goal-note num">{g.note}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <Backlog />
    </div>
  );
}

function ContinueRow({ c, primary }) {
  const { go, preload } = useLoft();
  return (
    <li className={`b-row ${primary ? 'b-row-primary' : ''}`} onPointerEnter={() => primary && preload('work', '悬停意图')}>
      <div className="b-row-main">
        <span className="b-row-title" style={primary ? { viewTransitionName: 'task-title' } : undefined}>
          {c.title}
        </span>
        <MathText className="b-row-where" text={c.where} />
        <span className="b-row-meta">
          <GoalChips ids={[c.goal]} />
          {c.spent > 0 && <span className="num">已用 {c.spent} 分钟</span>}
          <span>{c.saved}</span>
        </span>
      </div>
      {primary ? (
        <Btn kind="primary" kbd="↵" data-act="continue" onClick={() => go('work')}>
          继续
        </Btn>
      ) : (
        <Btn kind="ghost" size="sm">
          继续
        </Btn>
      )}
    </li>
  );
}

function SuggestRow({ s }) {
  const { expanded, toggleExpanded, hideSuggestion, toast } = useLoft();
  const open = expanded === s.id;
  return (
    <li className="b-row b-row-sugg" style={{ viewTransitionName: `brow-${s.id}` }}>
      <StatusGlyph state={s.status} />
      <div className="b-row-main">
        <span className="b-row-title">{s.title}</span>
        <span className="b-row-where">
          <span className="b-dim">为了：</span>
          <MathText text={s.purpose} />
        </span>
        <span className="b-row-meta">
          <SuggestionMeta s={s} />
          <button type="button" className="b-why" aria-expanded={open} data-act={s.id === 'g-contrast' ? 'why' : undefined} onClick={() => toggleExpanded(s.id)}>
            {open ? '收起' : '为什么 · 换一种'}
            <Icon name="down" size={14} className={open ? 'rot' : ''} />
          </button>
        </span>
        {open && <SuggestionWhy s={s} compact />}
      </div>
      <div className="b-row-actions">
        <Btn kind="secondary" size="sm" disabled={s.status !== 'ready'} onClick={() => toast({ text: `${s.title}（原型未实现该页）。` })}>
          开始
        </Btn>
        {s.status === 'ready' && (
          <Btn kind="quiet" size="sm" data-act={s.id === 'g-review' ? 'snooze' : undefined} onClick={() => hideSuggestion(s.id, '已推迟到明天')}>
            推迟
          </Btn>
        )}
      </div>
    </li>
  );
}

function EmptyPanel() {
  return (
    <div className="b-empty">
      <p>还没有进行中的学习。</p>
      <div className="b-empty-actions">
        <Btn kind="secondary" size="sm" icon="camera">
          拍一道题
        </Btn>
        <Btn kind="secondary" size="sm" icon="paste">
          粘贴材料
        </Btn>
      </div>
    </div>
  );
}

/* ── Workbench: three panes ───────────────────────────── */
export function Workbench() {
  const { steps, part2, submitPart2, revealHint, startExplain, hintsSeen, explain } = useLoft();
  const [tab, setTab] = useState('draft');
  const [showProblem, setShowProblem] = useState(true);
  useSubmitShortcut();
  const helpCount = Object.values(hintsSeen).filter(Boolean).length + (explain.phase !== 'closed' ? 1 : 0);
  return (
    <div className="b-work">
      <div className="b-work-bar">
        <div className="b-work-title">
          <h1 style={{ viewTransitionName: 'task-title' }}>{continueItems[0].title}</h1>
          <GoalChips ids={problem.goals} />
        </div>
        <span className="spacer" />
        <NextUp short />
        <SaveState />
        <button
          type="button"
          className="icon-btn b-hide-sm"
          aria-pressed={showProblem}
          aria-label={showProblem ? '收起题目栏' : '展开题目栏'}
          onClick={() => setShowProblem((v) => !v)}
        >
          <Icon name="sidebar" />
        </button>
      </div>

      <div className="b-mtabs" role="tablist">
        {[
          ['problem', '题目'],
          ['draft', '我的草稿'],
          ['help', `帮助 · ${helpCount}`],
        ].map(([id, label]) => (
          <button
            type="button"
            role="tab"
            key={id}
            aria-selected={tab === id}
            data-act={id === 'help' ? 'help' : id === 'draft' ? 'help-close' : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className={`b-panes tab-${tab} ${showProblem ? '' : 'no-problem'}`}>
        <section className="b-pane b-pane-problem" aria-label="题目">
          <header className="b-pane-head">
            <h2>题目</h2>
            <span className="b-dim">{problem.source}</span>
          </header>
          <div className="b-pane-body">
            <Stem />
            <Part1Done />
            <div className="b-photo">
              <p className="b-pane-label">学校草稿照片 · 10/5</p>
              <DraftPhoto />
              <p className="hint-record">第 1–3 步来自这张照片；第 3 行后半段识别不清。</p>
            </div>
          </div>
        </section>

        <section className="b-pane b-pane-draft" aria-label="我的草稿">
          <header className="b-pane-head">
            <h2>第 (2) 问 · 我的草稿</h2>
            <MathText className="b-dim b-pane-sub" text={problem.parts[1].text} />
          </header>
          <div className="b-pane-body">
            <ol className="b-steps">
              {steps.map((s, i) => (
                <li key={s.id} className={`b-step ${s.fresh ? 'enter' : ''}`} style={{ viewTransitionName: `bstep-${s.id}` }}>
                  <span className="b-step-n num">{i + 1}</span>
                  <div className="b-step-body">
                    <StepText step={s} />
                    <StepMeta step={s} />
                    <StepUnclear step={s} />
                  </div>
                </li>
              ))}
            </ol>
            <Composer />
            <Part2Status />
          </div>
          <div className="b-pane-actions">
            <Btn kind="primary" kbd="⌘↵" onClick={submitPart2} disabled={part2 !== 'working'}>
              提交第 (2) 问
            </Btn>
            <span className="spacer" />
            <Btn kind="quiet" icon="pause">
              <span className="b-hide-sm">停在这里</span>
            </Btn>
          </div>
        </section>

        <section className="b-pane b-pane-help" aria-label="帮助">
          <header className="b-pane-head">
            <h2>帮助</h2>
            <span className="b-dim">打开不会清掉草稿</span>
          </header>
          <div className="b-pane-body b-help-stack">
            <Judgement compact />
            <HintCard id="h1" />
            <HintCard id="h2" />
            <ExplainBlock />
          </div>
          <form className="b-ask" onSubmit={(e) => e.preventDefault()}>
            <input placeholder="问学习伙伴：为什么不能直接用均值不等式？" />
            <Btn kind="secondary" size="sm" type="submit">
              问
            </Btn>
          </form>
          <div className="b-help-quick b-only-sm">
            <Btn kind="secondary" size="sm" icon="bulb" onClick={() => revealHint('h2')}>
              提示 2
            </Btn>
            <Btn kind="ghost" size="sm" icon="eye" onClick={startExplain}>
              讲解
            </Btn>
          </div>
        </section>
      </div>
    </div>
  );
}
