import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { COPILOT_USER_ASK_ACTION } from '@/kernel/events/copilot-actions';
import { COPILOT_RETRY_ACTION } from './run-retry-contract';

// INVARIANT: a copilot turn may expose a revert checkpoint anchor only when every
// effect of the turn is event-chain-compensable. These tools materialize state outside
// the ask's event chain (draft `question` rows, `artifact` rows, accepted answer
// originals) that cascade-revert cannot compensate: `classifyRow` marks
// `generate(artifact)` rows irreversible, and `copilotAskRevertAllows` refuses
// `question_draft` proposals; reverting would 409 or tombstone the turn while orphaning
// the materialized row. Pure-event tools (propose_*/rate) stay revertable; their
// materialization is the deferred accept. ask_check is handled via
// skill_turn.structured_question.
export const MATERIALIZING_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'submit_review_answer',
  'author_question',
  'write_quiz',
  // YUK-1769 — write_note INSERTs/UPDATEs an artifact row (create + append +
  // the generate handoff's pending row) — same irreversible domain write.
  'write_note',
  // Retired tools no live surface can call. Historical turns that used them wrote
  // artifact rows some of which have no create event, so a revert would succeed and
  // orphan the row; these names keep suppressing the anchor on replay.
  'author_artifact',
  'update_artifact',
]);

// Persisted tool mirrors and explicit originals keep live and replay policy aligned.
export async function selectAsksWithMaterializingToolCall(
  db: Db | Tx,
  askEventIds: readonly string[],
): Promise<Set<string>> {
  if (askEventIds.length === 0) return new Set();
  const toolNameList = sql.join(
    [...MATERIALIZING_TOOL_NAMES].map((name) => sql`${name}`),
    sql`, `,
  );
  const rows = await db
    .select({ askId: event.caused_by_event_id })
    .from(event)
    .where(
      and(
        eq(event.action, 'tool_use'),
        inArray(event.caused_by_event_id, [...askEventIds]),
        sql`${event.payload}->>'tool_name' in (${toolNameList})`,
      ),
    );
  // Explicit answer submissions can materialize originals outside the ask cascade.
  const attachments = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        inArray(event.id, [...askEventIds]),
        eq(event.action, COPILOT_USER_ASK_ACTION),
        or(
          sql`${event.payload} ? 'review_answer'`,
          sql`${event.payload}->'confirmation'->>'kind' = 'submit'`,
        ),
      ),
    );
  return new Set([
    ...rows.map((row) => row.askId).filter((id): id is string => id !== null),
    ...attachments.map((row) => row.id),
  ]);
}

/**
 * Revert-anchor policy shared by live output and repair: only an ask-only turn with
 * no materializing tool call gets `checkpoint_event_id`; a failed probe suppresses
 * the anchor instead of guessing.
 */
export async function durableCheckpointPayload(
  db: Db | Tx,
  runId: string,
): Promise<Record<string, string>> {
  let turnMaterialized: boolean;
  try {
    const [root] = await db
      .select({ action: event.action })
      .from(event)
      .where(eq(event.id, runId))
      .limit(1);
    if (root?.action !== COPILOT_USER_ASK_ACTION) return {};
    const [retry] = await db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.action, COPILOT_RETRY_ACTION), eq(event.caused_by_event_id, runId)))
      .limit(1);
    if (retry) return {};
    turnMaterialized = (await selectAsksWithMaterializingToolCall(db, [runId])).has(runId);
  } catch (probeErr) {
    console.error('[copilot_run] materializing-tool probe failed; suppressing revert anchor', {
      runId,
      error: probeErr,
    });
    turnMaterialized = true;
  }
  return turnMaterialized ? {} : { checkpoint_event_id: runId };
}
