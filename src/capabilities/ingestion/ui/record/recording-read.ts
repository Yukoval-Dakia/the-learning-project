// The one read module behind a recording (YUK-1473). A recording is read from:
// - the session facts (status, usage receipt), polled until the session settles;
// - GET /history (what each question was at the finish, what it is now, asks, earlier runs,
//   missing evidence), re-read whenever the status moves;
// - the event stream, only while a run is still going;
// - the recording's own blocks, the action surface for putting recognised questions in. They are
//   read whenever the status can have them, whichever lane ran: an agent start that was turned
//   down still marks the recording as an agent one, and the blocks of the reading that followed
//   must still show.

import { useQuery } from '@tanstack/react-query';
import { useIngestionSSE } from '@/ui/lib/sse';
import { getHistory, getSession, listBlocks, listKnowledge } from './record-api';
import { useRecordClient } from './record-client';
import { useStartState } from './record-start';
import { foldLive } from './recording-live';
import { type Recording, deriveRecording } from './recording-model';

const SETTLED = new Set(['extracted', 'partial', 'reviewed', 'imported', 'failed']);
const HAS_BLOCKS = new Set(['extracted', 'partial', 'reviewed', 'imported']);

export const recordKeys = {
  list: ['record', 'sessions'] as const,
  knowledge: ['record', 'knowledge'] as const,
  session: (id: string) => ['record', 'session', id] as const,
  history: (id: string) => ['record', 'history', id] as const,
  blocks: (id: string) => ['record', 'blocks', id] as const,
};

export interface RecordingRead {
  recording: Recording;
  detail: Awaited<ReturnType<typeof getSession>> | undefined;
  /** The server's title for this recording; null today for most material. */
  title: string | null;
  failedToLoad: boolean;
  retry: () => void;
}

export function useRecording(id: string): RecordingRead {
  const start = useStartState(id);
  const detailQ = useQuery({
    queryKey: recordKeys.session(id),
    queryFn: () => getSession(id),
    // Poll until settled, and again for a moment after a learner-pressed (re)start.
    refetchInterval: (q) =>
      !SETTLED.has(q.state.data?.session.status ?? '') ||
      (start !== null && q.state.dataUpdatedAt < start.at + 5000)
        ? 2500
        : false,
  });
  const status = detailQ.data?.session.status ?? '';
  const historyQ = useQuery({
    // The status is part of the key: every move (finished, imported, failed) re-reads the record.
    queryKey: [...recordKeys.history(id), status],
    queryFn: () => getHistory(id),
    enabled: status !== '',
    placeholderData: (prev) => prev,
  });
  const runState = SETTLED.has(status) ? null : (historyQ.data?.run?.run_state ?? null);
  const going =
    (status !== '' && status !== 'uploaded' && !SETTLED.has(status)) ||
    runState === 'in_progress' ||
    runState === 'waiting';
  const stream = useIngestionSSE(going ? id : null);
  const hasBlocks = HAS_BLOCKS.has(status);
  const blocksQ = useQuery({
    queryKey: recordKeys.blocks(id),
    queryFn: () => listBlocks(id),
    enabled: hasBlocks,
  });
  const blocksRead = !hasBlocks
    ? 'none'
    : blocksQ.data
      ? 'ready'
      : blocksQ.isError
        ? 'failed'
        : 'loading';
  const replayed = stream.status !== 'connecting' && stream.status !== 'idle';
  const live = going && replayed ? foldLive(stream.events) : null;
  // The helper's run state is about the helper's run: it is left out once the recording has
  // settled, and while a plain reading is what is running now (a run that failed earlier stays
  // in the record but no longer describes this recording).
  const runCounts =
    runState !== null && start?.lane !== 'extract' && (live === null || live.agent === true);
  const recording = deriveRecording({
    id,
    detail: detailQ.data,
    history: historyQ.data,
    historyFailed: historyQ.isError,
    live,
    runCounts,
    blocks: blocksQ.data ?? [],
    blocksRead,
    now: Date.now(),
  });
  return {
    recording,
    detail: detailQ.data,
    title: historyQ.data?.session.title ?? null,
    failedToLoad: detailQ.isError,
    retry: () => {
      void detailQ.refetch();
      void historyQ.refetch();
      void blocksQ.refetch();
    },
  };
}

export function useRecordingList() {
  const { listSessions } = useRecordClient();
  return useQuery({ queryKey: recordKeys.list, queryFn: listSessions });
}

export function useKnowledgeList() {
  return useQuery({ queryKey: recordKeys.knowledge, queryFn: listKnowledge, staleTime: 60_000 });
}
