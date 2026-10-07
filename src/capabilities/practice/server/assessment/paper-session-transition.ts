import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { artifact, learning_session } from '@/db/schema';
import { isPaperIntentSource } from '../paper-intent-sources';
import { issuePaperAssessment } from './paper-issuance';

/** A reopened paper is a new occurrence; state and all issuance bindings commit together. */
export async function withFrozenPaperReopen<T>(
  db: Db,
  sessionId: string,
  transition: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, sessionId))
      .for('update');
    const result = await transition(tx);
    if (before?.status === 'abandoned' && before.artifact_id) {
      const [after] = await tx
        .select({ status: learning_session.status })
        .from(learning_session)
        .where(eq(learning_session.id, sessionId));
      const [paper] = await tx
        .select({ type: artifact.type, intent_source: artifact.intent_source })
        .from(artifact)
        .where(eq(artifact.id, before.artifact_id));
      if (
        after?.status === 'started' &&
        paper?.type === 'tool_quiz' &&
        isPaperIntentSource(paper.intent_source)
      ) {
        await issuePaperAssessment(tx, sessionId, before.artifact_id);
      }
    }
    return result;
  });
}
