// One confirmation for the suggestions that can be taken back, and the way to take them back later.
// Which ones qualify is the server's word on each row; undoing goes through the same single-item
// retract as everywhere else, so what can't be undone any more says why.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { PROPOSAL_BATCH_ACCEPT_MAX_IDS } from '@/core/schema/proposal';
import {
  invalidateAfterProposalDecision,
  invalidateAfterProposalRetract,
  queryKeys,
} from '@/ui/lib/write-invalidation';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { Button } from '@/ui-next/public';
import type { ProposalBatchAcceptWire, ProposalBatchSummaryWire } from './inbox-api';
import { useWorkbenchClient } from './workbench-client';

const BATCHES_KEY = ['proposal-batch-accepts'] as const;
const dayFmt = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function acceptWords(s: ProposalBatchAcceptWire['summary']): string {
  const done = s.accepted + s.already_accepted;
  const left = s.rejected + s.failed;
  if (left === 0) return `确认了 ${done} 条，还能撤销。`;
  return done > 0 ? `确认了 ${done} 条，${left} 条没确认成。` : `这 ${left} 条没确认成。`;
}

function RecentBatch({ batch }: { batch: ProposalBatchSummaryWire }) {
  const { retractProposal } = useWorkbenchClient();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const revoked = new Set(batch.revoked_ids);
  const remaining = batch.proposal_ids.filter((id) => !revoked.has(id));
  const undo = useMutation({
    mutationFn: async () => {
      // One at a time: each goes through the single retract, and one refusal doesn't stop the rest.
      const results = [];
      for (const id of remaining) {
        results.push(
          await retractProposal(id).then(
            () => true,
            () => false,
          ),
        );
      }
      return { undone: results.filter(Boolean).length, tried: remaining.length };
    },
    onSettled: () => {
      setAsking(false);
      return Promise.all([
        invalidateAfterProposalRetract(queryClient),
        queryClient.invalidateQueries({ queryKey: queryKeys.workbenchSummary }),
        queryClient.invalidateQueries({ queryKey: BATCHES_KEY }),
      ]);
    },
  });
  const result = undo.data;
  return (
    <div className={asking ? 'ib-aa-confirm' : 'ib-batch-recent'}>
      <p>
        {dayFmt.format(new Date(batch.created_at))} 一起确认的，还有 {remaining.length} 条可以撤。
      </p>
      {asking ? (
        <div className="ib-acts">
          <Button size="sm" disabled={undo.isPending} onClick={() => undo.mutate()}>
            {undo.isPending ? '正在撤销…' : `确认撤销 ${remaining.length} 条`}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={undo.isPending}
            onClick={() => setAsking(false)}
          >
            先不撤
          </Button>
        </div>
      ) : (
        <div className="ib-acts">
          <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>
            <Undo2 size={14} aria-hidden="true" />
            撤销这批
          </Button>
        </div>
      )}
      {result && result.undone < result.tried ? (
        <p role="status">
          {result.undone > 0 ? `撤了 ${result.undone} 条，` : ''}
          {result.tried - result.undone} 条没撤成。已经被用到的撤不了，其余的可以再试一次。
        </p>
      ) : null}
    </div>
  );
}

/** Above the suggestions waiting for a decision: confirm the ones that can be taken back in one go. */
export function BatchConfirm({ eligibleIds }: { eligibleIds: readonly string[] }) {
  const { acceptProposalBatch, listProposalBatches } = useWorkbenchClient();
  const queryClient = useQueryClient();
  const batches = useQuery({ queryKey: BATCHES_KEY, queryFn: listProposalBatches });
  const accept = useMutation({
    mutationFn: (ids: readonly string[]) => acceptProposalBatch(ids),
    onSettled: (result) =>
      Promise.all([
        ...[...new Set(result?.items.map((item) => item.kind))].map((kind) =>
          invalidateAfterProposalDecision(queryClient, { kind }),
        ),
        // Unlike a single decision, the confirmed cards leave the list at once.
        queryClient.invalidateQueries({ queryKey: queryKeys.decisionProposals }),
        queryClient.invalidateQueries({ queryKey: BATCHES_KEY }),
      ]),
  });
  const ids = eligibleIds.slice(0, PROPOSAL_BATCH_ACCEPT_MAX_IDS);
  const list = batches.data?.batches ?? [];
  // Confirmed in a run that was cut off: sending the same set again finishes that batch.
  const unfinished = list.find((batch) => batch.state === 'open');
  const recent = list
    .filter((batch) => {
      const revoked = new Set(batch.revoked_ids);
      return batch.proposal_ids.some((id) => !revoked.has(id));
    })
    .slice(0, 3);
  return (
    <>
      {ids.length >= 2 ? (
        <div className="ib-aa-summary">
          <p className="ib-aa-banner">
            <Check size={16} aria-hidden="true" />
            <span>
              <b>这 {ids.length} 条可以一起确认。</b>确认后还能撤销。
            </span>
          </p>
          <div className="ib-acts">
            <Button size="sm" disabled={accept.isPending} onClick={() => accept.mutate(ids)}>
              {accept.isPending ? '正在确认…' : `一起确认 ${ids.length} 条`}
            </Button>
          </div>
        </div>
      ) : null}
      {unfinished ? (
        <div className="ib-aa-confirm">
          <p>上次一起确认没做完。</p>
          <div className="ib-acts">
            <Button
              size="sm"
              variant="secondary"
              disabled={accept.isPending}
              onClick={() => accept.mutate(unfinished.member_ids)}
            >
              接着确认
            </Button>
          </div>
        </div>
      ) : null}
      {accept.data ? (
        <p className="ib-aa-result" role="status">
          {acceptWords(accept.data.summary)}
        </p>
      ) : null}
      {accept.isError ? (
        <p className="ib-aa-result" role="alert">
          这次没确认成，可以再试一次。
        </p>
      ) : null}
      {batches.isError ? (
        <RetryLine
          message="一起确认过的记录暂时读不出来。"
          onRetry={() => void batches.refetch()}
        />
      ) : null}
      {recent.map((batch) => (
        <RecentBatch key={batch.batch_id} batch={batch} />
      ))}
    </>
  );
}
