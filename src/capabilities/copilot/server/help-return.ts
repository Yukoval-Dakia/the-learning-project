import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DraftFocus } from '@/core/schema/assessment/draft-focus';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { COPILOT_USER_ASK_ACTION } from '@/kernel/events/copilot-actions';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import { COPILOT_RETRY_ACTION } from './run-retry-contract';

export interface CopilotHelpReturnTarget {
  kind: 'question';
  id: string;
}

/** Call only for visible failed terminal runs; identity and current permission stay server-owned. */
export async function readHelpReturnTargets(
  db: Db | Tx,
  sessionId: string,
  failedRunIds: readonly string[],
): Promise<Map<string, CopilotHelpReturnTarget>> {
  const targets = new Map<string, CopilotHelpReturnTarget>();
  if (failedRunIds.length === 0) return targets;
  const ask = alias(event, 'help_return_original_ask');
  const roots = await db
    .select({ runId: event.id, askId: ask.id, payload: ask.payload })
    .from(event)
    .innerJoin(
      ask,
      and(
        eq(
          ask.id,
          sql`case when ${event.action} = ${COPILOT_RETRY_ACTION}
            then ${event.payload}->>'original_ask_id' else ${event.id} end`,
        ),
        eq(ask.session_id, event.session_id),
        eq(ask.action, COPILOT_USER_ASK_ACTION),
        eq(ask.actor_kind, 'user'),
        eq(ask.actor_ref, 'user:self'),
      ),
    )
    .where(
      and(
        eq(event.session_id, sessionId),
        inArray(event.id, [...failedRunIds]),
        inArray(event.action, [COPILOT_USER_ASK_ACTION, COPILOT_RETRY_ACTION]),
        eventAllowsDerivationSql(),
        eventAllowsDerivationSql(ask),
      ),
    );
  const corrections = await getCorrectionStatuses(db, [
    ...new Set(roots.flatMap((root) => [root.runId, root.askId])),
  ]);
  for (const root of roots) {
    if (
      corrections.get(root.runId)?.state === 'retracted' ||
      corrections.get(root.askId)?.state === 'retracted' ||
      root.payload.surface !== 'copilot' ||
      root.payload.session_id !== sessionId ||
      root.payload.derivation_policy !== 'allow'
    )
      continue;
    const captured = root.payload.draft_focus;
    if (!captured || typeof captured !== 'object' || Array.isArray(captured)) continue;
    // The capture envelope also holds private provenance; validate only the original coordinate.
    const focus = DraftFocus.safeParse({
      question_id: 'question_id' in captured ? captured.question_id : undefined,
      issuance_id: 'issuance_id' in captured ? captured.issuance_id : undefined,
      revision_id: 'revision_id' in captured ? captured.revision_id : undefined,
      save_epoch: 'save_epoch' in captured ? captured.save_epoch : undefined,
    });
    if (focus.success) targets.set(root.runId, { kind: 'question', id: focus.data.question_id });
  }
  return targets;
}
