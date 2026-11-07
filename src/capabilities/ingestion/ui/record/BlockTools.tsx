import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { randomId } from '@/ui/lib/random-id';
import { type Block, enrollBlock, rescueBlock } from './record-api';
import { useRecordClient } from './record-client';
import { enrollProblemWords } from './record-copy';
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

/** One question into the library: as it is, or with the text the learner typed. */
function useEnroll(sessionId: string, block: Block) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prompt?: string) => {
      if (typeof block.version !== 'number') throw new Error('no version');
      return enrollBlock(sessionId, block.id, {
        expected_version: block.version,
        ...(prompt === undefined ? {} : { prompt_md: prompt }),
      });
    },
    // Either way the line's state and version may have moved.
    onSettled: () => qc.invalidateQueries({ queryKey: recordKeys.blocks(sessionId) }),
  });
}

function problemOf(err: unknown): string {
  return enrollProblemWords(err instanceof ApiError ? err.code : undefined);
}

/** 「再试一次」 after a failed try, 「再收进去」 after the learner took it back. */
export function EnrollButton({
  sessionId,
  block,
  label,
}: {
  sessionId: string;
  block: Block;
  label: string;
}) {
  const enroll = useEnroll(sessionId, block);
  return (
    <>
      <button
        type="button"
        className="rc-link"
        disabled={enroll.isPending}
        onClick={() => enroll.mutate(undefined)}
      >
        {enroll.isPending ? '正在收…' : label}
      </button>
      {enroll.isError && <span className="rc-problem">{problemOf(enroll.error)}</span>}
    </>
  );
}

const PROMPT_MAX = 20_000;

/** Types in the text of a question that was read without any, which takes it in. */
export function PromptFill({ sessionId, block }: { sessionId: string; block: Block }) {
  const enroll = useEnroll(sessionId, block);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  if (!open) {
    return (
      <button type="button" className="rc-link" onClick={() => setOpen(true)}>
        补上题目文字
      </button>
    );
  }
  const words = text.trim();
  return (
    <div className="rc-fill">
      <textarea
        className="rc-area rc-area-sm"
        rows={3}
        value={text}
        maxLength={PROMPT_MAX}
        aria-label="这道题的文字"
        placeholder="对照原页把题目打进来"
        disabled={enroll.isPending}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="rc-line-tools">
        <button
          type="button"
          className="rc-link"
          disabled={enroll.isPending || words === ''}
          onClick={() => enroll.mutate(words)}
        >
          {enroll.isPending ? '正在收…' : '补好，收进题库'}
        </button>
        <button
          type="button"
          className="rc-link"
          disabled={enroll.isPending}
          onClick={() => setOpen(false)}
        >
          先不补
        </button>
        {enroll.isError && <span className="rc-problem">{problemOf(enroll.error)}</span>}
      </div>
    </div>
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
