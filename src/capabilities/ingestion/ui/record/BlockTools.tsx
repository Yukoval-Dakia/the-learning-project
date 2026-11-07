import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { randomId } from '@/ui/lib/random-id';
import { type Block, rescueBlock } from './record-api';
import { useRecordClient } from './record-client';
import { recordKeys } from './recording-read';

/** Takes a question the helper put in automatically back out, after one confirm. */
export function RevertButton({ sessionId, blockId }: { sessionId: string; blockId: string }) {
  const { revertBlock } = useRecordClient();
  const [asking, setAsking] = useState(false);
  const qc = useQueryClient();
  const undo = useMutation({
    mutationFn: () => revertBlock(sessionId, blockId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: recordKeys.blocks(sessionId) }),
  });
  if (undo.isError) {
    return (
      <span className="rc-problem">
        没撤回成功。
        <button
          type="button"
          className="rc-link"
          disabled={undo.isPending}
          onClick={() => undo.mutate()}
        >
          再撤回一次
        </button>
      </span>
    );
  }
  return (
    <button
      type="button"
      className="rc-link"
      disabled={undo.isPending}
      onClick={() => (asking ? undo.mutate() : setAsking(true))}
      onBlur={() => setAsking(false)}
    >
      {undo.isPending ? '正在撤回…' : asking ? '确定撤回？' : '撤回'}
    </button>
  );
}

/**
 * Reads one question again from its page, learner-pressed only. The first try uses the usual
 * reader; after it, a slower and more careful read is offered. One key per try: a retry after a
 * lost answer replays the same read, a try the server turned down gets a new key.
 */
export function RescueButton({ sessionId, block }: { sessionId: string; block: Block }) {
  const qc = useQueryClient();
  const [key, setKey] = useState(randomId);
  const [tier, setTier] = useState<2 | 3>(2);
  const read = useMutation({
    mutationFn: (t: 2 | 3) =>
      rescueBlock(sessionId, block.id, block.page_spans?.[0]?.page_index ?? 0, t, key),
    onSuccess: () => {
      setKey(randomId());
      setTier(3);
      void qc.invalidateQueries({ queryKey: recordKeys.blocks(sessionId) });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code !== 'operation_timeout') {
        setKey(randomId());
        setTier(3);
      }
    },
  });
  return (
    <>
      <button
        type="button"
        className="rc-link"
        disabled={read.isPending}
        onClick={() => read.mutate(tier)}
      >
        {read.isPending
          ? '正在重新认…'
          : tier === 3
            ? '认得更仔细些'
            : block.ingestion_enrollment.reason === 'needs_text'
              ? '再认一次'
              : '没认对？再认一次'}
      </button>
      {read.isError && <span className="rc-problem">这次没认出来，原来的文字没变。</span>}
    </>
  );
}
