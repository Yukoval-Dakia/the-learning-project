import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

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
  'author_artifact',
  'update_artifact',
  'write_quiz',
]);

// Keyed on the persisted tool_use mirror rows so the live response and replay agree.
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
  // Authenticated answer attachments already materialize an immutable original at acceptance.
  const attachments = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        inArray(event.id, [...askEventIds]),
        eq(event.action, 'experimental:copilot_user_ask'),
        sql`${event.payload} ? 'review_answer'`,
      ),
    );
  return new Set([
    ...rows.map((row) => row.askId).filter((id): id is string => id !== null),
    ...attachments.map((row) => row.id),
  ]);
}
