import { AskReply } from './AskReply';
import { ITEM_WORDS, holdWords, stopWords } from './record-copy';
import type { AgentItem, Ask } from './recording-model';

const TONE: Record<AgentItem['status'], string> = {
  queued: 'neutral',
  structuring: 'working',
  solving: 'working',
  calibrating: 'working',
  admitted: 'positive',
  withheld: 'positive',
  failed: 'critical',
};

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
 * The helper's questions, one line each, in printed order. A question's status, the reason it
 * is held back and the helper's question about it all stay on that line.
 */
export function AgentLines({
  sessionId,
  items,
  asks,
  onHoverPage,
}: {
  sessionId: string;
  items: AgentItem[];
  asks: Ask[];
  onHoverPage: (page: number | null) => void;
}) {
  if (items.length === 0) return null;
  // Questions the helper is waiting on come first, so an answer is never buried in a long list.
  const waitingOn = new Set(asks.filter((a) => a.open).map((a) => a.itemId));
  const ordered = [...items].sort(
    (a, b) => Number(waitingOn.has(b.id)) - Number(waitingOn.has(a.id)) || byNumber(a, b),
  );
  return (
    <ol className="rc-lines" aria-label="找到的题">
      {ordered.map((item) => {
        const note = noteOf(item);
        const held = item.status === 'withheld' && note !== null;
        const itemAsks = asks.filter((a) => a.itemId === item.id);
        const asking = itemAsks.some((a) => a.open);
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
              <p className="rc-line-text">{item.preview ?? '（这道题还没有预览）'}</p>
              {(item.page !== null || note) && (
                <p className="rc-line-note">
                  {item.page !== null && <span className="rc-quiet">第 {item.page} 页</span>}
                  {note && <span>{note}</span>}
                </p>
              )}
              {itemAsks.map((ask) => (
                <AskReply key={ask.id} sessionId={sessionId} ask={ask} />
              ))}
            </div>
            <span className="rc-state" data-tone={asking || held ? 'caution' : TONE[item.status]}>
              {asking ? '等你回答' : held ? '先不出' : ITEM_WORDS[item.status]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
