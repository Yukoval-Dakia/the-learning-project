import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { question } from '@/db/schema';

/** Resolve a question hero only while its owned row exists and is not soft-archived. */
export async function isLiveQuestionReference(db: Db | Tx, questionId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: question.id })
    .from(question)
    .where(and(eq(question.id, questionId), isNull(sql`${question.metadata}->>'archived_at'`)))
    .limit(1);
  return row !== undefined;
}
