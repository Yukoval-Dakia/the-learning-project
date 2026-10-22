import { AskReply } from './AskReply';
import { ITEM_WORDS, holdWords, nowWords, stopWords } from './record-copy';
import type { AgentItem, Ask } from './recording-model';

const TONE: Record<AgentItem['status'], string> = {
  queued: 'neutral',
  structuring: 'working',
  solving: 'working',
  calibrating: 'working',
  admitted: 'positive',
  withheld: 'positive',
  failed: 'critical',
  draft: 'neutral',
  imported: 'positive',
  ignored: 'neutral',
  auto_enrolled: 'positive',
  unknown: 'neutral',
};

const MIDWAY = new Set(['queued', 'structuring', 'solving', 'calibrating']);

function byNumber(a: AgentItem, b: AgentItem) {
  const na = Number.parseInt(a.no ?? '', 10);
  const nb = Number.parseInt(b.no ?? '', 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return (a.page ?? 0) - (b.page ?? 0);
}

function noteOf(item: AgentItem): string | null {
  if (item.status === 'withheld') return holdWords(item.reason);
  if (item.status === 'failed') return stopWords(item.problem, 'item');
  return null;
}

/**
 * The helper's questions, one line each, in printed order. A question's status when the run
 * finished, the reason it was held back and the helper's question about it stay on that line;
 * today's state, when it says something new, is its own 「现在」 line underneath.
 */
export function AgentLines({
  sessionId,
  items,
  asks,
  onHoverPage,
  stopped = false,
}: {
  sessionId: string;
  items: AgentItem[];
  asks: Ask[];
  onHoverPage: (page: number | null) => void;
  /** The run is over: a question left mid-way reads as not finished, not as still working. */
  stopped?: boolean;
}) {
  if (items.length === 0 && asks.length === 0) return null;
  const known = new Set(items.map((i) => i.id));
  // When no line kept its at-finish state, the sheet says so once; each line only says it came in
  // (a durable link exists), instead of repeating "state not recorded" on every line.
  const allUnknown = items.every((i) => i.status === 'unknown');
  // Asks whose question is not among the lines (or about the whole material) still show, last.
  const loose = asks.filter((a) => a.itemId === null || !known.has(a.itemId));
  // Questions the helper is waiting on come first, so an answer is never buried in a long list.
  const waitingOn = new Set(asks.filter((a) => a.open).map((a) => a.itemId));
  const ordered = [...items].sort(
    (a, b) => Number(waitingOn.has(b.id)) - Number(waitingOn.has(a.id)) || byNumber(a, b),
  );
  return (
    <ol className="rc-lines" aria-label="找到的题">
      {ordered.map((item) => {
        const note = noteOf(item);
        const today = nowWords(item.now, item.status);
        const cut = stopped && MIDWAY.has(item.status);
        const held = item.status === 'withheld' && note !== null;
        const itemAsks = asks.filter((a) => a.itemId === item.id);
        const asking = itemAsks.some((a) => a.open);
        const label = asking
          ? '等你回答'
          : held
            ? '先不出'
            : cut
              ? '没做完'
              : allUnknown
                ? '收进来了'
                : ITEM_WORDS[item.status];
        const tone = asking || held ? 'caution' : cut ? 'neutral' : TONE[item.status];
        return (
          <li
            key={item.id}
            className="rc-line"
            data-asking={asking}
            onPointerEnter={() => onHoverPage(item.page)}
            onPointerLeave={() => onHoverPage(null)}
          >
            <span className="rc-line-no un-num">{item.no ?? '·'}</span>
            <div className="rc-line-main">
              <p className="rc-line-text">
                {item.preview
                  ? `${item.preview}${item.truncated ? '…' : ''}`
                  : '（这道题没有留下预览）'}
              </p>
              {(item.page !== null || note) && (
                <p className="rc-line-note">
                  {item.page !== null && <span className="rc-quiet">第 {item.page} 页</span>}
                  {note && <span>{note}</span>}
                </p>
              )}
              {today && <p className="rc-line-now">{today}</p>}
              {itemAsks.map((ask) => (
                <AskReply key={ask.id} sessionId={sessionId} ask={ask} />
              ))}
            </div>
            <span className="rc-state rc-line-state" data-tone={tone}>
              {label}
            </span>
          </li>
        );
      })}
      {loose.length > 0 && (
        <li className="rc-line">
          <span className="rc-line-no un-num">·</span>
          <div className="rc-line-main">
            {loose.map((ask) => (
              <AskReply key={ask.id} sessionId={sessionId} ask={ask} />
            ))}
          </div>
          <span />
        </li>
      )}
    </ol>
  );
}
