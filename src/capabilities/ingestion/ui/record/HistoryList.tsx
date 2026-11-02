import { useQuery } from '@tanstack/react-query';
import { useAssetUrl } from '@/ui/lib/assets';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SectionHead } from '@/ui-next/primitives/SectionHead';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import type { SessionRow } from './record-api';
import { useRecordClient } from './record-client';
import { materialWords, whenWords } from './record-copy';
import { recordKeys, useRecordingList } from './recording-read';

const STATUS_WORDS: Record<string, { text: string; tone: string }> = {
  uploaded: { text: '还没开始', tone: 'neutral' },
  queued: { text: '整理中', tone: 'working' },
  extracting: { text: '整理中', tone: 'working' },
  extracted: { text: '整理好了', tone: 'caution' },
  partial: { text: '整理好了一部分', tone: 'caution' },
  reviewed: { text: '整理好了', tone: 'caution' },
  imported: { text: '已进题库', tone: 'positive' },
  failed: { text: '没整理完', tone: 'critical' },
};

function Thumb({ assetId }: { assetId: string | undefined }) {
  const { url } = useAssetUrl(assetId ?? null);
  return (
    <span className="rc-row-thumb" aria-hidden="true">
      {url && <img src={url} alt="" />}
    </span>
  );
}

function Row({ row, onOpen, now }: { row: SessionRow; onOpen: () => void; now: number }) {
  const state = STATUS_WORDS[row.status] ?? { text: '', tone: 'neutral' };
  const count = row.item_count ?? row.block_count ?? 0;
  const at = row.started_at ?? row.created_at;
  const when = whenWords(at ? at * 1000 : null, now);
  return (
    <li>
      <button type="button" className="rc-row un-hit" onClick={onOpen}>
        <Thumb assetId={row.source_asset_ids[0]} />
        <span className="rc-row-main">
          <span className="rc-row-title rc-row-clip">
            {[when, row.title].filter(Boolean).join(' · ')}
          </span>
          <span className="rc-quiet">
            {materialWords(row.entrypoint, row.source_asset_ids.length)}
            {row.path === 'agent' && ' · 录入助手整理'}
            {count > 0 && ` · ${count} 道题`}
          </span>
        </span>
        <span className="rc-state" data-tone={state.tone}>
          {state.text}
        </span>
      </button>
    </li>
  );
}

/**
 * A recording from this visit that the list leaves out: the list only carries sessions with
 * durable evidence, so one that has not started (or stopped before producing anything) is read
 * from its own facts until it does.
 */
function VisitRow({ id, onOpen, now }: { id: string; onOpen: () => void; now: number }) {
  const { getSession } = useRecordClient();
  const q = useQuery({ queryKey: recordKeys.session(id), queryFn: () => getSession(id) });
  const s = q.data?.session;
  if (!s) return null;
  const created = s.created_at ? Date.parse(s.created_at) / 1000 : undefined;
  return (
    <Row row={{ ...s, path: null, title: null, created_at: created }} now={now} onOpen={onOpen} />
  );
}

/** Earlier recordings. Opening one puts it back on top exactly as it was shown then. */
export function HistoryList({
  openId,
  visited,
  onOpen,
}: {
  openId: string | null;
  /** Recordings made or opened during this visit, newest first. */
  visited: string[];
  onOpen: (sessionId: string) => void;
}) {
  const q = useRecordingList();
  const rows = (q.data ?? []).filter((r) => r.id !== openId);
  const listed = new Set((q.data ?? []).map((r) => r.id));
  const extra = visited.filter((id) => id !== openId && !listed.has(id));
  const now = Date.now();
  if (q.isSuccess && rows.length === 0 && extra.length === 0) return null;
  return (
    <section className="rc-history" aria-labelledby="rc-history-h">
      <SectionHead id="rc-history-h" title="之前放进来的" />
      {q.isLoading && <SkeletonLines rows={3} label="正在载入之前的录入" />}
      {q.isError && <RetryLine message="之前的录入暂时没取到。" onRetry={() => void q.refetch()} />}
      {rows.length + extra.length > 0 && (
        <ol className="rc-rows">
          {extra.map((id) => (
            <VisitRow key={id} id={id} now={now} onOpen={() => onOpen(id)} />
          ))}
          {rows.map((row) => (
            <Row key={row.id} row={row} now={now} onOpen={() => onOpen(row.id)} />
          ))}
        </ol>
      )}
    </section>
  );
}
