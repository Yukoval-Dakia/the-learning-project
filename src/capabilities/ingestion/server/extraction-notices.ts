import { and, desc, eq, sql } from 'drizzle-orm';
import { IngestionExtractionNotices } from '@/core/schema/ingestion-extraction';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';

/** Read the durable extraction receipt, never infer missing content from prose warnings. */
export async function readExtractionNotices(db: Db | Tx, sessionId: string) {
  const [latest] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.session_id, sessionId),
        eq(event.action, 'extract'),
        eq(event.subject_kind, 'source_document'),
        // Only the extraction receipt carries notices. Rescue, failure, and DOCX
        // events also use action='extract' but must not erase the durable receipt.
        sql`jsonb_exists(${event.payload}, ${'notices'})`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  const parsed = IngestionExtractionNotices.safeParse(latest?.payload.notices);
  return parsed.success
    ? parsed.data
    : {
        figures_withheld: null,
        content_lost: null,
        figure_handwriting_unverified: null,
      };
}
