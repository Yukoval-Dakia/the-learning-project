// Today's 当前安排 card (YUK-1770 slice 2): every active goal, including the ones the learner
// said to the companion (「11月20日期中考，范围数列和导数」). Changing or withdrawing one goes back
// through the companion with the sentence already typed, so there is one way to change them.
import { openCopilot, setCompanionFocus } from '@/ui/lib/use-copilot-dwell';
import { Button } from '@/ui-next/public';
import type { WorkbenchSummary } from '../workbench-api';

type ActiveGoal = WorkbenchSummary['active_goals'][number];
type PastSteering = WorkbenchSummary['past_steerings'][number];

const SCOPE_NAME_LIMIT = 4;
const SHOWN_LIMIT = 3;
const PAST_LIMIT = 10;

/** 2026-11-20 → 11月20日 */
function monthDay(day: string): string {
  const [, month, date] = day.split('-');
  return `${Number(month)}月${Number(date)}日`;
}

function whenWords({ window }: ActiveGoal): string | null {
  const { from, until, days_left: left, starts_in_days: startsIn } = window;
  const start = from !== null && startsIn !== null && startsIn > 0 ? `${monthDay(from)}开始` : null;
  if (until === null || left === null) return start;
  const end =
    left < 0
      ? `${monthDay(until)}，已经过了`
      : left === 0
        ? `${monthDay(until)}，就是今天`
        : `${monthDay(until)}，还有 ${left} 天`;
  return start ? `${start}，${end}` : end;
}

function scopeWords({ scope }: ActiveGoal): string | null {
  const { names } = scope;
  if (names.length === 0) return null;
  const shown = names.slice(0, SCOPE_NAME_LIMIT).join('、');
  return names.length > SCOPE_NAME_LIMIT
    ? `范围：${shown} 等 ${names.length} 个`
    : `范围：${shown}`;
}

function GoalRow({ goal }: { goal: ActiveGoal }) {
  const label = goal.instruction_md ?? goal.title;
  const when = whenWords(goal);
  const scope = scopeWords(goal);
  const unresolved = goal.scope.unresolved;
  const said = goal.instruction_md !== null;
  return (
    <li className="td-plan">
      <div className="td-plan-main">
        <p className="td-plan-what">{label}</p>
        {(when || scope) && (
          <p className="un-today-meta">{[when, scope].filter(Boolean).join(' · ')}</p>
        )}
        {unresolved.length > 0 && (
          <p className="un-today-meta">还没对上知识点：{unresolved.join('、')}</p>
        )}
        {goal.learner_words && goal.learner_words !== label && (
          <p className="un-today-meta td-plan-words">你的原话：「{goal.learner_words}」</p>
        )}
      </div>
      {/* The companion changes only what was said to it; a typed goal has no way to change here. */}
      {said && (
        <div className="un-today-actions td-plan-actions">
          <Button
            variant="ghost"
            aria-label={`改「${label}」`}
            onClick={() => handOver(goal, label, goal.revise_prompt)}
          >
            改
          </Button>
          <Button
            variant="ghost"
            aria-label={`撤回「${label}」`}
            onClick={() => handOver(goal, label, goal.end_prompt)}
          >
            撤回
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * The sentence names the goal for the learner; the focus names it for the companion, so with
 * several arrangements it changes the one tapped, not whichever it guesses.
 */
function handOver(goal: ActiveGoal, label: string, sentence: string) {
  setCompanionFocus({ kind: 'goal', id: goal.id, title: label });
  openCopilot(sentence, { send: false });
}

function endedWords(past: PastSteering): string {
  if (past.ended === 'expired') {
    return past.until ? `${monthDay(past.until)}已过，自动结束` : '已到期，自动结束';
  }
  return `${monthDay(past.ended_on)}撤回`;
}

function PastRow({ past }: { past: PastSteering }) {
  return (
    <li className="td-plan td-plan-past">
      <div className="td-plan-main">
        <p className="td-plan-what">{past.instruction_md}</p>
        <p className="un-today-meta">{endedWords(past)}</p>
        {past.learner_words !== past.instruction_md && (
          <p className="un-today-meta td-plan-words">你的原话：「{past.learner_words}」</p>
        )}
      </div>
    </li>
  );
}

export function SteeringList({ goals, past }: { goals: ActiveGoal[]; past: PastSteering[] }) {
  if (goals.length === 0 && past.length === 0) return null;
  // Newest first; older ones fold away so a long list doesn't push today's work down.
  const shown = goals.slice(0, SHOWN_LIMIT);
  const rest = goals.slice(SHOWN_LIMIT);
  return (
    <section className="un-today-panel" aria-labelledby="td-plans-title">
      <h2 id="td-plans-title">当前安排</h2>
      {goals.length === 0 && <p className="un-today-meta">现在没有生效的安排。</p>}
      {goals.some((goal) => goal.instruction_md !== null) && (
        <p className="un-today-meta">
          对学习伙伴说过的安排可以改和撤回：会打开学习伙伴并填好一句话，你补完再发，它来改。
        </p>
      )}
      {shown.length > 0 && (
        <ul className="td-plans">
          {shown.map((goal) => (
            <GoalRow key={goal.id} goal={goal} />
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <details className="td-plans-more">
          <summary>另外 {rest.length} 个</summary>
          <ul className="td-plans">
            {rest.map((goal) => (
              <GoalRow key={goal.id} goal={goal} />
            ))}
          </ul>
        </details>
      )}
      {past.length > 0 && (
        <details className="td-plans-more">
          <summary>
            {/* The server sends at most ten, so a full list is the latest ten, not all of them. */}
            {past.length >= PAST_LIMIT
              ? `以前说过的（最近 ${PAST_LIMIT} 条）`
              : `以前说过的 ${past.length} 条`}
          </summary>
          <ul className="td-plans">
            {past.map((item) => (
              <PastRow key={item.id} past={item} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
