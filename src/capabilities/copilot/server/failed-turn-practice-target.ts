import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { COPILOT_REPLY_ACTION } from '@/kernel/events/copilot-actions';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import { ApiError } from '@/kernel/http';
import { loadIssuanceStudyCoordinate } from '@/kernel/records/study-reference';
import type { FailedTurnPracticeTargetT } from '../failed-turn-practice-target-contract';
import { getCopilotConversation } from './conversation-lifecycle';
import { readHelpPracticeFocuses } from './help-return';
import { readCopilotPublicProse } from './public-prose';
import { COPILOT_RETRY_ACTION, COPILOT_RUN_ROOT_ACTIONS } from './run-retry-contract';

/** Resolve only an original accepted coordinate; this GET never reveals or records assistance. */
export async function readFailedTurnPracticeTarget(
  db: Db,
  input: { run_id: string; session_id: string },
): Promise<FailedTurnPracticeTargetT> {
  return db.transaction(
    async (tx): Promise<FailedTurnPracticeTargetT> => {
      const session = await getCopilotConversation(tx, input.session_id);
      const [root] = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.id, input.run_id),
            eq(event.session_id, input.session_id),
            inArray(event.action, [...COPILOT_RUN_ROOT_ACTIONS]),
          ),
        )
        .limit(1);
      if (!session || !root) throw new ApiError('not_found', 'Copilot turn not found', 404);
      const [replacement] = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.session_id, session.id),
            eq(event.action, COPILOT_RETRY_ACTION),
            eq(event.caused_by_event_id, root.id),
          ),
        )
        .limit(1);
      if (replacement) return { status: 'unavailable', reason: 'revoked' };
      const prose = (await readCopilotPublicProse(tx, [root.id])).get(root.id);
      if (prose?.status !== 'failed')
        return {
          status: 'unavailable',
          reason:
            prose?.status === 'interrupted' && prose.failure?.kind !== 'cancelled'
              ? 'outcome_unknown'
              : 'not_failed',
        };
      const focus = (await readHelpPracticeFocuses(tx, session.id, [root.id])).get(root.id);
      if (!focus) return { status: 'unavailable', reason: 'no_saved_practice_target' };
      if (focus.status === 'unavailable') return focus;
      const replies = await tx
        .select({ id: event.id, allowed: eventAllowsDerivationSql() })
        .from(event)
        .where(
          and(
            eq(event.session_id, session.id),
            eq(event.action, COPILOT_REPLY_ACTION),
            eq(event.caused_by_event_id, root.id),
          ),
        );
      const corrections = await getCorrectionStatuses(
        tx,
        replies.map((reply) => reply.id),
      );
      if (
        replies.some(
          (reply) => reply.allowed !== true || corrections.get(reply.id)?.state === 'retracted',
        )
      )
        return { status: 'unavailable', reason: 'revoked' };
      const coordinate = await loadIssuanceStudyCoordinate(
        tx,
        focus.focus.issuance_id,
        focus.focus.question_id,
      );
      if (
        coordinate.status !== 'assistable' ||
        coordinate.revision.revision_id !== focus.focus.revision_id
      )
        return { status: 'unavailable', reason: 'revoked' };
      return {
        status: 'ready',
        question_id: focus.focus.question_id,
        issuance_id: focus.focus.issuance_id,
        revision_id: focus.focus.revision_id,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
