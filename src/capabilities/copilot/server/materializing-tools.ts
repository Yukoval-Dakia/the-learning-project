import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { COPILOT_USER_ASK_ACTION } from '@/kernel/events/copilot-actions';

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
  // YUK-1769 — the interactive pair is off the copilot surface but stays here:
  // historical turns that called them still wrote domain rows the cascade
  // cannot compensate, so the revert-anchor guard must keep recognizing them.
  'author_artifact',
  'update_artifact',
  'write_quiz',
  // YUK-1769 — write_note INSERTs/UPDATEs an artifact row (create + append +
  // the generate handoff's pending row) — same irreversible domain write.
  'write_note',
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
