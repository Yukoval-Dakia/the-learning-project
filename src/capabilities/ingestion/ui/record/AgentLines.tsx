import { AskReply } from './AskReply';
import { ITEM_WORDS, holdWords, stopWords } from './record-copy';
import type { AgentItem, Ask } from './recording-model';

const TONE: Record<AgentItem['status'], string> = {
  queued: 'neutral',
  structuring: 'working',
  solving: 'working',
  calibrating: 'working',
  admitted: 'positive',
  withheld: 'caution',
  failed: 'critical',
};

function order(a: AgentItem, b: AgentItem) {
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
  return (
    <ol className="rc-lines" aria-label="找到的题">
      {[...items].sort(order).map((item) => {
        const note = noteOf(item);
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
              {item.page !== null && <p className="rc-quiet">第 {item.page} 页</p>}
              {note && (
                <p className="rc-line-note" data-tone={TONE[item.status]}>
                  {note}
                </p>
              )}
              {itemAsks.map((ask) => (
                <AskReply key={ask.id} sessionId={sessionId} ask={ask} />
              ))}
            </div>
            <span className="rc-state" data-tone={asking ? 'caution' : TONE[item.status]}>
              {asking ? '等你回答' : ITEM_WORDS[item.status]}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
