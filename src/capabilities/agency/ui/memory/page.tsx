// 记忆 (/memory; YUK-1776 §13): what the companion remembers about the learner, by topic. Changes are
// one sentence to a text box, carried out on the spot and undoable; a topic can be deleted in one
// click. The topic names are the curator's own: the page imposes no categories.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, History, MessageCircle, RotateCcw, Trash2, X } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, Chip, IconButton, UiNextRoot } from '@/ui-next/public';
import {
  MEMORY_KEY,
  type MemoryActionResult,
  type MemoryBoard,
  type MemoryChange,
  type MemoryEditResult,
  type MemoryTopic,
  editMemory,
  readMemoryBoard,
  undoMemoryChange,
  withdrawMemoryTopic,
} from './memory-api';
import { type TopicDiff, diffTopics, refusalText, whenText } from './memory-words';
import './memory.css';

const TALK_TOPIC = 'communication';
const CHANGES_SHOWN = 5;

/** The outcome shown beside what caused it. Undo appears only when a change really happened. */
interface Outcome {
  text?: string;
  diffs?: TopicDiff[];
  changeId?: string;
  /** What the correction asked for that is not saved. */
  remaining?: string[];
  /** Green only when something really changed; refused is the caution tone; otherwise neutral. */
  tone?: 'changed' | 'refused';
}

/** Only what was really saved is shown as saved; anything else is said plainly. */
function editOutcome(result: MemoryEditResult): Outcome {
  const saved = result.changes.filter((change) => change.status === 'changed');
  const diffs = saved.flatMap((change) => diffTopics(change.before, change.after));
  const changeId = saved.at(-1)?.change_id ?? undefined;
  if (result.status === 'partial') {
    // Nothing saved: the server's own sentence says so and why.
    if (saved.length === 0) return { text: result.reply, tone: 'refused' };
    return {
      text: '只改成了一部分。下面是已经保存的，可以撤销。',
      diffs,
      changeId,
      remaining: result.remaining_changes,
      tone: 'refused',
    };
  }
  // A crisis reply or a sentence that is not stored changes nothing: the reply is all there is.
  if (saved.length === 0) return { text: result.reply };
  return { diffs, changeId, tone: 'changed' };
}

/** Undo only claims success when the server says something changed. */
function undoOutcome(result: MemoryActionResult): Outcome {
  return result.status === 'changed'
    ? { text: '已撤销。', tone: 'changed' }
    : { text: '这一步没有内容变化，不用撤销。' };
}

function refusedOutcome(error: unknown): Outcome {
  return { text: refusalText(error), tone: 'refused' };
}

function useMemoryActions() {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: MEMORY_KEY });
  const undo = useMutation({ mutationFn: undoMemoryChange, onSettled: refresh });
  const withdraw = useMutation({ mutationFn: withdrawMemoryTopic, onSettled: refresh });
  const edit = useMutation({ mutationFn: editMemory, onSettled: refresh });
  return { undo, withdraw, edit };
}

function DiffLines({ diffs }: { diffs: readonly TopicDiff[] }) {
  return (
    <ul className="mm-diff">
      {diffs.map((diff) => (
        <li key={diff.key}>
          <p className="mm-diff-topic">
            {diff.name}
            {diff.kind === 'added' && <span className="mm-diff-state">新主题</span>}
            {diff.kind === 'removed' && <span className="mm-diff-state">已删除</span>}
            {diff.renamedFrom ? (
              <span className="mm-diff-state">原来叫「{diff.renamedFrom}」</span>
            ) : null}
          </p>
          {diff.added.length === 0 && diff.removed.length === 0 && !diff.renamedFrom ? (
            <p className="mm-diff-line">文字没变，记录更新了。</p>
          ) : null}
          {diff.added.map((body) => (
            <p key={`+${body}`} className="mm-diff-line" data-kind="added">
              {body}
            </p>
          ))}
          {diff.removed.map((body) => (
            <p key={`-${body}`} className="mm-diff-line" data-kind="removed">
              {body}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

function OutcomeNote({
  outcome,
  version,
  onUndone,
}: {
  outcome: Outcome;
  version: number;
  onUndone: (next: Outcome) => void;
}) {
  const { undo } = useMemoryActions();
  const changeId = outcome.changeId;
  return (
    <div className="mm-outcome" data-tone={outcome.tone} role="status">
      {outcome.text ? (
        <MathMarkdown className="mm-outcome-text">{outcome.text}</MathMarkdown>
      ) : null}
      {outcome.diffs && outcome.diffs.length > 0 ? <DiffLines diffs={outcome.diffs} /> : null}
      {outcome.remaining && outcome.tone === 'refused' && outcome.diffs ? (
        <ul className="mm-remaining">
          {outcome.remaining.length > 0 ? (
            outcome.remaining.map((item) => <li key={item}>还没保存：{item}</li>)
          ) : (
            <li>其余要求还没保存或没确认。</li>
          )}
        </ul>
      ) : null}
      {changeId ? (
        <Button
          variant="quiet"
          size="sm"
          disabled={undo.isPending}
          onClick={() =>
            undo.mutate(
              { change_id: changeId, expected_version: version },
              {
                onSuccess: (result) => onUndone(undoOutcome(result)),
                onError: (error) => onUndone(refusedOutcome(error)),
              },
            )
          }
        >
          <RotateCcw size={14} aria-hidden="true" />
          {undo.isPending ? '在撤销…' : '撤销'}
        </Button>
      ) : null}
    </div>
  );
}

function TellBox({
  version,
  topicKey,
  label,
  placeholder,
  floating = false,
}: {
  version: number;
  topicKey?: string;
  label: string;
  placeholder: string;
  /** The page's own box: a glass bar at the foot of the screen, its label read by screen readers only. */
  floating?: boolean;
}) {
  const inputId = useId();
  const { edit } = useMemoryActions();
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const instruction = text.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!instruction || edit.isPending) return;
    setOutcome(null);
    edit.mutate(
      {
        instruction,
        expected_version: version,
        ...(topicKey ? { topic_key: topicKey } : {}),
      },
      {
        onSuccess: (result) => {
          setText('');
          setOutcome(editOutcome(result));
        },
        // The sentence stays in the box so it can be sent again.
        onError: (error) => setOutcome(refusedOutcome(error)),
      },
    );
  };

  return (
    <div className={floating ? 'mm-tell mm-tell-floating un-glass' : 'mm-tell'}>
      {floating && outcome ? (
        <div className="mm-tell-result">
          <OutcomeNote outcome={outcome} version={version} onUndone={setOutcome} />
          {/* A reply with no change to review (a crisis reply among them) stays until the next
              sentence, so it can be read again. */}
          {outcome.tone ? (
            <IconButton label="收起" icon={<X size={15} />} onClick={() => setOutcome(null)} />
          ) : null}
        </div>
      ) : null}
      <form className="mm-tell-form" onSubmit={submit}>
        <label className={floating ? 'mm-visually-hidden' : 'mm-tell-label'} htmlFor={inputId}>
          {label}
        </label>
        <div className={floating ? 'mm-tell-bar-row' : 'mm-tell-row'}>
          <input
            id={inputId}
            className="mm-tell-input"
            value={text}
            maxLength={1000}
            placeholder={placeholder}
            disabled={edit.isPending}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={!instruction || edit.isPending}>
            {edit.isPending ? '在改…' : '改'}
          </Button>
        </div>
      </form>
      {!floating && outcome ? (
        <OutcomeNote outcome={outcome} version={version} onUndone={setOutcome} />
      ) : null}
    </div>
  );
}

function TopicCard({ topic, version }: { topic: MemoryTopic; version: number }) {
  const { withdraw } = useMemoryActions();
  const [telling, setTelling] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const isTalk = topic.key === TALK_TOPIC;
  const deleteTopic = () =>
    withdraw.mutate(
      { topic_key: topic.key, expected_version: version },
      {
        onSuccess: (result) => {
          // The card leaves with the refreshed board, so the undo moves to 最近的改动.
          if (result.status !== 'changed') {
            setOutcome({ text: '这个主题没有变化。' });
          }
        },
        onError: (error) => setOutcome(refusedOutcome(error)),
      },
    );
  return (
    <article className="mm-topic" data-talk={isTalk ? '' : undefined}>
      <header className="mm-topic-head">
        <div className="mm-topic-titles">
          <h2 className="mm-topic-name">
            {isTalk ? <MessageCircle size={16} aria-hidden="true" /> : null}
            {topic.name}
          </h2>
        </div>
        <IconButton
          label={`删除主题：${topic.name}`}
          icon={<Trash2 size={15} />}
          disabled={withdraw.isPending}
          onClick={deleteTopic}
        />
      </header>
      {topic.facts.length > 0 ? (
        <ul className="mm-facts">
          {topic.facts.map((fact) => (
            <li key={fact.id} className="mm-fact">
              <span>{fact.body}</span>
              {fact.kind === 'correction' ? <Chip tone="positive">你改过</Chip> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <footer className="mm-topic-foot">
        <span>{whenText(topic.updated_at)} 更新</span>
        {topic.stale ? <Chip tone="caution">有一阵没更新了</Chip> : null}
        <Button variant="quiet" size="sm" onClick={() => setTelling((open) => !open)}>
          {telling ? '收起' : '改这个主题'}
        </Button>
      </footer>
      {telling ? (
        <TellBox
          version={version}
          topicKey={topic.key}
          label={`告诉它「${topic.name}」要改什么`}
          placeholder="说一句就行"
        />
      ) : null}
      {outcome ? <OutcomeNote outcome={outcome} version={version} onUndone={setOutcome} /> : null}
    </article>
  );
}

function ChangeRow({ change, version }: { change: MemoryChange; version: number }) {
  const { undo } = useMemoryActions();
  const [note, setNote] = useState<Outcome | null>(null);
  const diffs = diffTopics(change.before, change.after);
  if (change.removed) {
    return (
      <li className="mm-change">
        <div className="mm-change-head">
          <span className="mm-change-when">{whenText(change.at)}</span>
          <span className="mm-diff-state">已移除</span>
        </div>
      </li>
    );
  }
  return (
    <li className="mm-change">
      <div className="mm-change-head">
        <span className="mm-change-when">{whenText(change.at)}</span>
        {change.undo_of === null ? (
          <Button
            variant="quiet"
            size="sm"
            disabled={undo.isPending}
            onClick={() =>
              undo.mutate(
                { change_id: change.id, expected_version: version },
                {
                  onSuccess: (result) => setNote(undoOutcome(result)),
                  onError: (error) => setNote(refusedOutcome(error)),
                },
              )
            }
          >
            <RotateCcw size={14} aria-hidden="true" />
            {undo.isPending ? '在撤销…' : '撤销'}
          </Button>
        ) : (
          <span className="mm-diff-state">撤销记录</span>
        )}
      </div>
      <DiffLines diffs={diffs} />
      {note ? (
        <p className="mm-outcome-text" data-tone={note.tone} role="status">
          {note.text}
        </p>
      ) : null}
    </li>
  );
}

function sortedTopics(board: MemoryBoard): MemoryTopic[] {
  const talk = board.topics.filter((topic) => topic.key === TALK_TOPIC);
  return [...talk, ...board.topics.filter((topic) => topic.key !== TALK_TOPIC)];
}

export default function MemoryPage() {
  const query = useQuery({ queryKey: MEMORY_KEY, queryFn: readMemoryBoard });
  const board = query.data;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [allChanges, setAllChanges] = useState(false);
  // Housekeeping rows change nothing a learner can read, and have nothing to undo.
  const changes = (board?.changes ?? []).filter(
    (change) => change.removed || diffTopics(change.before, change.after).length > 0,
  );
  const shownChanges = allChanges ? changes : changes.slice(0, CHANGES_SHOWN);
  return (
    <UiNextRoot className="mm-page">
      <main className="mm-main un-m3e-bridge">
        <div className="mm-content">
          <header className="mm-head">
            <h1 className="mm-title">记忆</h1>
            <p className="mm-lead">学习伙伴记得的关于你的事。不对的地方，说一句就能改。</p>
          </header>
          {query.isPending ? <SkeletonLines rows={4} label="正在读取记忆" /> : null}
          {query.isError && !board ? (
            <RetryLine message="记忆暂时读不出来。" onRetry={() => void query.refetch()} />
          ) : null}
          {board ? (
            <>
              {board.topics.length === 0 ? (
                <p className="mm-empty">
                  还没有记下什么。你在对话里说过的偏好和习惯，会慢慢出现在这里。
                </p>
              ) : (
                <section className="mm-topics" aria-label="记下的主题">
                  {sortedTopics(board).map((topic) => (
                    <TopicCard key={topic.key} topic={topic} version={board.version} />
                  ))}
                </section>
              )}
              {changes.length > 0 ? (
                <section className="mm-changes" aria-labelledby="mm-changes-title">
                  <h2 id="mm-changes-title" className="mm-history-title">
                    <button
                      type="button"
                      className="mm-history-toggle un-hit"
                      aria-expanded={historyOpen}
                      onClick={() => setHistoryOpen((open) => !open)}
                    >
                      <History size={15} aria-hidden="true" />
                      最近改过 {changes.length} 次
                      <span className="mm-history-last">
                        <Check size={13} aria-hidden="true" />
                        最后一次 {whenText(changes[0]?.at ?? '')}
                      </span>
                    </button>
                  </h2>
                  {historyOpen ? (
                    <>
                      <ul className="mm-change-list">
                        {shownChanges.map((change) => (
                          <ChangeRow key={change.id} change={change} version={board.version} />
                        ))}
                      </ul>
                      {changes.length > CHANGES_SHOWN ? (
                        <Button
                          variant="quiet"
                          size="sm"
                          onClick={() => setAllChanges((all) => !all)}
                        >
                          {allChanges ? '收起' : `看更早的 ${changes.length - CHANGES_SHOWN} 条`}
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </section>
              ) : null}
            </>
          ) : null}
        </div>
        {board ? (
          <TellBox
            floating
            version={board.version}
            label="告诉它要改什么"
            placeholder="告诉它要改什么，比如：叫我小林"
          />
        ) : null}
      </main>
    </UiNextRoot>
  );
}
