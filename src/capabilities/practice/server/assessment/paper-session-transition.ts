import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { artifact, learning_session } from '@/db/schema';
import { isPaperIntentSource } from '../paper-intent-sources';
import { assertPaperOpenable, issuePaperAssessment } from './paper-issuance';

/**
 * A reopened paper is a new occurrence; state and all issuance bindings commit together.
 * `reopens` is false when the caller's target state cannot reopen an abandoned session.
 */
export async function withFrozenPaperReopen<T>(
  db: Db,
  sessionId: string,
  transition: (tx: Tx) => Promise<T>,
  reopens = true,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId))
      .for('update');
    const [paper] =
      before?.status === 'abandoned' && before.artifact_id
        ? await tx
            .select({ type: artifact.type, intent_source: artifact.intent_source })
            .from(artifact)
            .where(eq(artifact.id, before.artifact_id))
        : [];
    const isPaper = paper?.type === 'tool_quiz' && isPaperIntentSource(paper.intent_source);
    // YUK-1573 — read-only refusal before the transition writes the session row.
    if (reopens && isPaper && before?.artifact_id) {
      await assertPaperOpenable(tx, before.artifact_id);
    }
    const result = await transition(tx);
    if (before?.status === 'abandoned' && before.artifact_id) {
      const [after] = await tx
        .select({ status: learning_session.status })
        .from(learning_session)
        .where(eq(learning_session.id, sessionId));
      if (after?.status === 'started' && isPaper) {
        await issuePaperAssessment(tx, sessionId, before.artifact_id);
      }
    }
    return result;
  });
}
