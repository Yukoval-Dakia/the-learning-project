// Whether the learner is mid-practice: any practice session type in its open state.
// Copilot's interrupt-sensitive nudges stay silent while this holds.
import { sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';

export async function isInActivePracticeSession(db: Db | Tx): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(learning_session)
    .where(
      sql`(${learning_session.type} = 'tutor' AND ${learning_session.status} = 'active')
        OR (${learning_session.type} = 'review' AND ${learning_session.status} = 'started')
        OR (${learning_session.type} = 'placement' AND ${learning_session.status} = 'started')`,
    )
    .limit(1);
  return rows.length > 0;
}
