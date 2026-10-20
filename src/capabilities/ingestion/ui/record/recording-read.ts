// The one read module behind a recording (YUK-1473). Live and reopened recordings go through the
// same reads: session facts (polled until settled), the replayed event stream, and the blocks.
// The backend's extended history fields will replace these reads here, nowhere else.

import { useQuery } from '@tanstack/react-query';
import { useIngestionSSE } from '@/ui/lib/sse';
import { getSession, listBlocks, listKnowledge, listSessions } from './record-api';
import { useStartState } from './record-start';
import { type Recording, deriveRecording } from './recording-model';

const SETTLED = new Set(['extracted', 'partial', 'reviewed', 'imported', 'failed']);
const HAS_BLOCKS = new Set(['extracted', 'partial', 'reviewed', 'imported']);

export const recordKeys = {
  list: ['record', 'sessions'] as const,
  knowledge: ['record', 'knowledge'] as const,
  session: (id: string) => ['record', 'session', id] as const,
  blocks: (id: string) => ['record', 'blocks', id] as const,
};

export interface RecordingRead {
  recording: Recording;
  detail: Awaited<ReturnType<typeof getSession>> | undefined;
  failedToLoad: boolean;
  retry: () => void;
}

export function useRecording(id: string): RecordingRead {
  const stream = useIngestionSSE(id);
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
  const blocksQ = useQuery({
    queryKey: recordKeys.blocks(id),
    queryFn: () => listBlocks(id),
    enabled: HAS_BLOCKS.has(status),
  });
  const recording = deriveRecording({
    id,
    detail: detailQ.data,
    events: stream.events,
    replayed: stream.status !== 'connecting' && stream.status !== 'idle',
    blocks: blocksQ.data ?? [],
    now: Date.now(),
  });
  return {
    recording,
    detail: detailQ.data,
    failedToLoad: detailQ.isError,
    retry: () => {
      void detailQ.refetch();
      void blocksQ.refetch();
    },
  };
}

export function useRecordingList() {
  return useQuery({ queryKey: recordKeys.list, queryFn: listSessions });
}

export function useKnowledgeList() {
  return useQuery({ queryKey: recordKeys.knowledge, queryFn: listKnowledge, staleTime: 60_000 });
}
