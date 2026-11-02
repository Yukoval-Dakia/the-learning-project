import { eq, inArray } from 'drizzle-orm';
import { readDerivationPolicy } from '@/core/schema/derivation-policy';
import type { Tx } from '@/db/client';
import { event, learning_session, source_document } from '@/db/schema';
import {
  documentUsageEpoch,
  readDocumentDerivationPolicy,
} from '@/kernel/read-models/usage-policy';
import type { WriteEventInput } from './events';

/** Bind event birth under the INSERT transaction; never edit an existing event.
 * SHARE serializes birth with purpose changes, without external IO under the lock.
 */
export async function bindEventUsage(
  tx: Tx,
  inputs: WriteEventInput[],
): Promise<WriteEventInput[]> {
  const sessionIds = [
    ...new Set(inputs.flatMap((row) => (row.session_id ? [row.session_id] : []))),
  ];
  if (!sessionIds.length) return inputs;
  const existing = new Set(
    (
      await tx
        .select({ id: event.id })
        .from(event)
        .where(
          inArray(
            event.id,
            inputs.map((input) => input.id),
          ),
        )
    ).map((row) => row.id),
  );
  const sessions = await tx
    .select({ id: learning_session.id, doc: learning_session.source_document_id })
    .from(learning_session)
    .where(inArray(learning_session.id, sessionIds));
  const documents = new Map<string, typeof source_document.$inferSelect>();
  for (const id of [...new Set(sessions.flatMap((row) => (row.doc ? [row.doc] : [])))].sort()) {
    const [doc] = await tx
      .select()
      .from(source_document)
      .where(eq(source_document.id, id))
      .for('share');
    if (!doc) throw new Error('event source document unavailable');
    documents.set(id, doc);
  }
  return inputs.flatMap((input) => {
    const docId = sessions.find((row) => row.id === input.session_id)?.doc;
    const doc = docId ? documents.get(docId) : undefined;
    if (!doc || existing.has(input.id)) return [input];
    const payload = input.payload as Record<string, unknown>;
    const own = readDerivationPolicy(payload);
    const current = readDocumentDerivationPolicy(doc.provenance);
    // The original payload has a locked domain schema. Keep its bytes and put
    // the source binding in a companion control fact in this same INSERT.
    return [
      input,
      {
        id: `ingestion-usage:${input.id}`,
        actor_kind: 'system',
        actor_ref: 'ingestion-usage',
        action: 'experimental:ingestion_usage_binding',
        subject_kind: 'event',
        subject_id: input.id,
        payload: {
          version: 1,
          document_id: doc.id,
          epoch: documentUsageEpoch(doc.provenance),
          source_policy: own === 'allow' ? current : own,
          derivation_policy: 'answer_only',
        },
        affected_scopes: [],
        ingest_at: new Date(),
      },
    ];
  });
}
