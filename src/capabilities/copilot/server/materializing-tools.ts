import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

// INVARIANT (YUK-497 wave-4): a copilot turn may expose a revert checkpoint anchor ⇔ EVERY effect of
// the turn is event-chain-compensable (a `correct` retract of the ask/reply/propose/rate/tool_use
// events fully undoes it). A "materializing" tool breaks that: it writes a DOMAIN ROW outside the
// ask's event chain — a draft `question` row (author_question knowledge/material seed), an `artifact`
// row + experimental:artifact_create/artifact_lifecycle events (author_artifact / update_artifact /
// write_quiz) — that cascade-revert cannot compensate (classifyRow marks generate(artifact) /
// question rows irreversible, and the copilotAskOnly allowlist admits neither). So a turn that called
// any of these must NOT surface the anchor: reverting would either 409 (artifact events irreversible)
// or "succeed" + tombstone while orphaning the materialized row (author_question). Pure-event write
// tools (propose_*/rate) stay revertable — their materialization is the DEFERRED accept, a separate
// event the cascade handles. The teaching ask_check materializer is handled separately via
// skill_turn.structured_question (chat.ts / turns.ts).
export const MATERIALIZING_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  'author_question',
  'author_artifact',
  'update_artifact',
  'write_quiz',
]);

// The persisted, replay-visible evidence: mcp-bridge mirrors every tool call as an
// action='tool_use' event with payload.tool_name, chained to the turn's ask via caused_by_event_id.
// Keying BOTH the live response (chat.ts) and the replay (turns.ts) on the SAME rows guarantees the
// anchor can't be shown live-then-hidden-on-refresh (or vice versa). Returns the subset of the given
// ask ids that emitted at least one materializing tool_use.
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
  return new Set(rows.map((row) => row.askId).filter((id): id is string => id !== null));
}
