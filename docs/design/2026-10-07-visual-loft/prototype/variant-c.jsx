// Variant C · 学习线 (Thread)
// Navigation: no persistent chrome; a bottom input-style command dock (ask, bring, jump).
// Home: the current learning thread — a "now" node forking into continue / suggestion / stop,
// with the thread's history below. Workbench: a two-column stage (problem | my draft) and a
// help sheet that rises from the bottom and pushes the stage instead of covering the draft.
import { useEffect } from 'react';
import { absence, absenceSuggestion, continueItems, lead, now, otherThreads, problem, suggestions, thread } from './fixture.js';
import {
  Backlog,
  Btn,
  Composer,
  CostLine,
  DraftPhoto,
  ExplainBlock,
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
  PhotoChip,
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

export function Shell({ children }) {
  const { params, go, setPalette, toast } = useLoft();
  return (
    <div className={`c-app c-on-${params.screen}`}>
      <header className="c-top">
        <button type="button" className="c-brand" onClick={() => go('home')}>
          <Mark />
          <span>Loom</span>
        </button>
        {params.screen === 'work' && (
          <nav className="c-crumbs" aria-label="位置">
            <Icon name="chevron" size={14} />
            <span>{thread.title}</span>
          </nav>
        )}
        <span className="spacer" />
        <ThemeButton />
      </header>
      <main className="c-main">{children}</main>
      {params.screen !== 'work' && (
        <div className="c-dock" role="search">
          <button type="button" className="c-dock-btn" aria-label="带来材料" onClick={() => toast({ text: '带来材料：拍照、粘贴或口述（原型）。' })}>
            <Icon name="plus" />
          </button>
          <button type="button" className="c-dock-input" onClick={() => setPalette(true)}>
            <span>问点什么、带来材料，或跳转…</span>
            <Kbd>⌘K</Kbd>
          </button>
          <button type="button" className="c-dock-btn" aria-label="说一段" onClick={() => toast({ text: '口述（原型）。' })}>
            <Icon name="mic" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Home ─────────────────────────────────────────────── */
const EVENT_ICON = { help: 'bulb', check: 'check', photo: 'camera', link: 'thread' };

export function Home() {
  const { params, suggestions: live } = useLoft();
  useEnterToContinue();
  const state = params.state;
  if (state === 'loading') return <HomeLoading />;
  if (state === 'empty') return <HomeEmpty />;
  const later = live.filter((s) => s.id !== 'g-contrast' && (state !== 'error' || s.deterministic));
  return (
    <div className="c-home">
      <section className="c-now" aria-label="现在">
        <p className="c-now-eyebrow">
          <span className="c-now-dot" />
          <span className="num">
            现在 · {now.date}
            {now.part} · 今晚约 {now.availableMinutes} 分钟
          </span>
        </p>
        {state === 'absent' ? (
          <>
            <h1 className="c-now-head">
              <span className="num">{absence.days}</span> 天没见，这条线停在第 (2) 问。
            </h1>
            <p className="c-now-body">
              {absence.text}
              {absence.offer}
            </p>
          </>
        ) : (
          <>
            <h1 className="c-now-head">{lead.headline}</h1>
            <MathText as="p" className="c-now-body" text={lead.body} />
          </>
        )}
        <Forks error={state === 'error'} absent={state === 'absent'} />
      </section>

      <div className="c-body">
        <section className="c-thread" aria-label="这条学习线">
          <header className="c-sec-head">
            <h2>这条学习线 · {thread.title}</h2>
            <p className="c-dim">关联依据：{thread.basis}</p>
          </header>
          <ol className="c-timeline">
            {thread.events.map((e) => (
              <li key={e.id} className="c-event">
                <span className="c-event-node">
                  <Icon name={EVENT_ICON[e.kind]} size={14} />
                </span>
                <div className="c-event-body">
                  <span className="c-event-at num">{e.at}</span>
                  <p>{e.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
        <aside className="c-side">
          <section className="c-side-block">
            <Judgement />
          </section>
          <section className="c-side-block">
            <h2 className="c-side-title">系统准备的</h2>
            <Readiness dense />
            <CostLine />
          </section>
        </aside>
      </div>

      <section className="c-others" aria-label="其他学习线">
        <header className="c-sec-head">
          <h2>其他学习线</h2>
        </header>
        <ul className="c-other-list">
          <li className="c-other">
            <Icon name="book" size={16} />
            <div className="c-other-main">
              <span className="c-other-title">{otherThreads[0].title}</span>
              <span className="c-dim">{otherThreads[0].meta}</span>
            </div>
            <span className="c-dim num">{otherThreads[0].at}</span>
          </li>
          {later.map((s) => (
              <li key={s.id} className="c-other" style={{ viewTransitionName: `crow-${s.id}` }}>
                <StatusGlyph state={s.status} />
                <div className="c-other-main">
                  <span className="c-other-title">{s.title}</span>
                  <SuggestionMeta s={s} />
                </div>
                {s.status === 'ready' ? <SnoozeBtn s={s} /> : <span className="c-dim">生成中</span>}
              </li>
            ))}
        </ul>
      </section>
      <Backlog />
    </div>
  );
}

function SnoozeBtn({ s }) {
  const { hideSuggestion } = useLoft();
  return (
    <Btn kind="ghost" size="sm" data-act="snooze" onClick={() => hideSuggestion(s.id, '已推迟到明天')}>
      推迟
    </Btn>
  );
}

function Forks({ error, absent }) {
  const { go, preload, expanded, toggleExpanded, toast, suggestions: live } = useLoft();
  const c = continueItems[0];
  const s = absent ? absenceSuggestion : (live.find((x) => x.id === 'g-contrast') ?? suggestions[0]);
  const open = expanded === s.id;
  return (
    <>
      <div className="c-forks">
        <article className="c-fork c-fork-mine" onPointerEnter={() => preload('work', '悬停意图')}>
          <p className="c-fork-label">继续你的</p>
          <h2 className="c-fork-title" style={{ viewTransitionName: 'task-title' }}>
            {c.title}
          </h2>
          <MathText as="p" className="c-fork-note" text={`${c.where} · ${c.saved}`} />
          <Btn kind="primary" kbd="↵" data-act="continue" onClick={() => go('work')}>
            继续
          </Btn>
        </article>
        {error ? (
          <article className="c-fork c-fork-suggest">
            <p className="c-fork-label">系统建议</p>
            <RegionError what="建议" />
          </article>
        ) : (
          <article className="c-fork c-fork-suggest">
            <p className="c-fork-label">
              系统建议 <StatusGlyph state="ready" /> 准备好了
            </p>
            <h2 className="c-fork-title">{s.id === 'g-contrast' ? '短对比例子' : s.title}</h2>
            <p className="c-fork-note">
              <Minutes n={s.minutes} /> <MathText text={`为了${s.purpose.replace('确认', '确认：')}`} />
            </p>
            <div className="c-fork-actions">
              <Btn kind="secondary" onClick={() => toast({ text: `${s.title}（原型未实现该页）。` })}>
                开始
              </Btn>
              <Btn kind="quiet" aria-expanded={open} data-act="why" onClick={() => toggleExpanded(s.id)}>
                {open ? '收起' : '为什么'}
              </Btn>
            </div>
          </article>
        )}
        <article className="c-fork c-fork-stop">
          <p className="c-fork-label">也可以</p>
          <h2 className="c-fork-title">今晚只记录，或停在这里</h2>
          <p className="c-fork-note">断点会保存；不会变成欠账。</p>
          <Btn kind="ghost" icon="pause" onClick={() => toast({ text: '今晚只记录：不会追加练习。' })}>
            只记录
          </Btn>
        </article>
      </div>
      {open && !error && (
        <div className="c-why">
          <SuggestionWhy s={s} />
        </div>
      )}
    </>
  );
}

function HomeLoading() {
  return (
    <div className="c-home" aria-busy="true">
      <section className="c-now">
        <Skeleton lines={3} block />
        <div className="c-forks">
          {[0, 1, 2].map((i) => (
            <div key={i} className="c-fork">
              <Skeleton lines={3} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function HomeEmpty() {
  const { toast } = useLoft();
  return (
    <div className="c-home">
      <section className="c-now">
        <p className="c-now-eyebrow">
          <span className="c-now-dot" />
          现在
        </p>
        <h1 className="c-now-head">还没有学习线。从手上的东西开始就好。</h1>
        <div className="c-forks">
          {[
            ['camera', '带来一道题', '拍照或上传，原件先保存'],
            ['paste', '粘贴一段材料', '文章、笔记或题目文字'],
            ['spark', '让系统先提一个', '会说明理由，可以不接受'],
          ].map(([icon, title, note]) => (
            <button type="button" key={title} className="c-fork c-fork-empty" onClick={() => toast({ text: `${title}（原型）。` })}>
              <Icon name={icon} size={20} />
              <span className="c-fork-title">{title}</span>
              <span className="c-fork-note">{note}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

/* ── Workbench: stage + rising help sheet ─────────────── */
export function Workbench() {
  const { go, steps, part2, submitPart2, helpOpen, setHelpOpen, hintsSeen, toast } = useLoft();
  useSubmitShortcut();
  useEffect(() => {
    if (!helpOpen) return;
    // Lift the step being written above the sheet so help never hides the attempt.
    const t = window.setTimeout(() => {
      const step = document.querySelector('.c-step:last-child');
      const sheet = document.querySelector('.c-sheet');
      if (!step || !sheet) return;
      const overlap = step.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top + 16;
      if (overlap > 0) window.scrollBy({ top: overlap, behavior: 'smooth' });
    }, 260);
    return () => window.clearTimeout(t);
  }, [helpOpen]);
  const seen = Object.entries(hintsSeen)
    .filter(([, v]) => v)
    .map(([k]) => (k === 'h1' ? '提示 1' : '提示 2'));
  return (
    <div className={`c-work ${helpOpen ? 'is-help-open' : ''}`}>
      <div className="c-work-head">
        <button type="button" className="c-back" data-act="back" onClick={() => go('home')}>
          <Icon name="back" size={16} />
          <span>学习线</span>
        </button>
        <div className="c-work-title">
          <h1 style={{ viewTransitionName: 'task-title' }}>{continueItems[0].title}</h1>
          <span className="c-dim">{problem.source}</span>
        </div>
        <span className="spacer" />
        <NextUp short />
        <SaveState />
      </div>

      <div className="c-stage">
        <section className="c-stage-problem" aria-label="题目">
          <Stem />
          <Part1Done />
          <details className="c-photo">
            <summary>
              <PhotoChip />
              <span className="c-dim">第 1–3 步来自这张照片</span>
            </summary>
            <DraftPhoto />
          </details>
        </section>
        <section className="c-stage-draft" aria-label="我的草稿">
          <header className="c-draft-head">
            <h2>第 (2) 问 · 我的草稿</h2>
            <span className="c-dim">点任一步可以修改</span>
          </header>
          <ol className="c-steps">
            {steps.map((s, i) => (
              <li key={s.id} className={`c-step ${s.fresh ? 'enter' : ''}`} style={{ viewTransitionName: `cstep-${s.id}` }}>
                <span className="c-step-n num">{i + 1}</span>
                <div className="c-step-body">
                  <StepText step={s} />
                  <StepMeta step={s} />
                  <StepUnclear step={s} />
                </div>
              </li>
            ))}
          </ol>
          <Composer />
          <Part2Status />
          <div className="c-draft-actions">
            <Btn kind="primary" kbd="⌘↵" onClick={submitPart2} disabled={part2 !== 'working'}>
              提交第 (2) 问
            </Btn>
            <Btn kind="quiet" icon="pause" onClick={() => toast({ text: '断点已保存：第 5 步。回来时从这里接上。' })}>
              停在这里
            </Btn>
          </div>
        </section>
      </div>

      <section className="c-sheet" aria-label="帮助" style={{ viewTransitionName: 'help-sheet' }}>
        {helpOpen ? (
          <div className="c-sheet-open">
            <header className="c-sheet-head">
              <span className="c-grip" aria-hidden="true" />
              <h2>帮助</h2>
              <span className="c-dim">打开不会清掉你的草稿</span>
              <span className="spacer" />
              <Btn kind="ghost" size="sm" kbd="Esc" data-act="help-close" onClick={() => setHelpOpen(false)}>
                收起
              </Btn>
            </header>
            <div className="c-sheet-grid">
              <div className="c-sheet-col">
                <Judgement compact />
              </div>
              <div className="c-sheet-col">
                <HintCard id="h1" />
                <HintCard id="h2" />
              </div>
              <div className="c-sheet-col">
                <ExplainBlock />
                <form className="c-ask" onSubmit={(e) => e.preventDefault()}>
                  <input placeholder="问学习伙伴…" />
                  <Btn kind="secondary" size="sm" type="submit">
                    问
                  </Btn>
                </form>
              </div>
            </div>
          </div>
        ) : (
          <button type="button" className="c-peek" data-act="help" onClick={() => setHelpOpen(true)}>
            <span className="c-grip" aria-hidden="true" />
            <Icon name="bulb" size={16} />
            <span className="c-peek-label">帮助</span>
            <span className="c-peek-note">
              已看 {seen.join('、')} · 关于这一步，系统还不确定的地方
            </span>
            <span className="spacer" />
            <Kbd>H</Kbd>
          </button>
        )}
      </section>
    </div>
  );
}
