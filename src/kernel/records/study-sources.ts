import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type { Tx } from '@/db/client';
import { event, learning_session, question, source_document } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { sourceAllowsDerivation } from '@/kernel/read-models/usage-policy';

const Sources = z.object({
  version: z.literal(1),
  assets: z.array(z.string()),
  questions: z.array(z.object({ id: z.string(), identity: z.string() })).min(1),
  documents: z.array(z.object({ id: z.string(), epoch: z.string(), digest: z.string() })).min(1),
});
export type StudySources = z.infer<typeof Sources>;

/** Called under the publication root lock. Only proven direct source sets qualify. */
export async function captureStudySources(
  tx: Tx,
  groupId: string,
  partIds: string[],
  assetIds: string[],
) {
  const ids = [...new Set([groupId, ...partIds])].sort();
  const rows = await tx
    .select()
    .from(question)
    .where(inArray(question.id, ids))
    .orderBy(question.id)
    .for('share');
  if (rows.length !== ids.length) return null;
  const root = rows.find((row) => row.id === groupId);
  const rootDocument = root?.metadata?.source_document_id;
  if (typeof rootDocument !== 'string' || !rootDocument) return null;
  const documents = new Set<string>();
  const sessionIds = rows
    .map((row) => row.metadata?.ingestion_session_id)
    .filter((id): id is string => typeof id === 'string');
  const sessions = sessionIds.length
    ? await tx
        .select()
        .from(learning_session)
        .where(inArray(learning_session.id, [...new Set(sessionIds)].sort()))
        .orderBy(learning_session.id)
        .for('share', { noWait: true })
    : [];
  const questions: StudySources['questions'] = [];
  for (const row of rows) {
    const m = row.metadata ?? {};
    // Derived graphs need their original immutable source receipt. A mutable
    // parent/latest lookup is not evidence of the frozen revision's source.
    if (
      row.parent_variant_id ||
      (row.root_question_id && row.root_question_id !== groupId) ||
      (row.parent_question_id && row.parent_question_id !== groupId) ||
      m.source_record_id ||
      m.source_attempt_event_id ||
      m.quiz_gen ||
      row.source === 'dreaming'
    )
      return null;
    const document = m.source_document_id ?? rootDocument;
    if (typeof document !== 'string' || !document) return null;
    if (
      m.ingestion_session_id !== undefined &&
      !sessions.some((s) => s.id === m.ingestion_session_id && s.source_document_id === document)
    )
      return null;
    documents.add(document);
    questions.push({
      id: row.id,
      identity: canonicalHash({
        source: row.source,
        source_ref: row.source_ref,
        parent: row.parent_question_id,
        document,
        session: m.ingestion_session_id ?? null,
        epochs: m.source_usage_epochs ?? null,
      }),
    });
    if (!(await sourceAllowsDerivation(tx, { kind: 'question', id: row.id }))) return null;
  }
  const docs = await tx
    .select()
    .from(source_document)
    .where(inArray(source_document.id, [...documents].sort()))
    .orderBy(source_document.id)
    .for('share');
  if (docs.length !== documents.size) return null;
  const allowedAssets = new Set(docs.flatMap((doc) => doc.source_asset_ids));
  if (assetIds.some((id) => !allowedAssets.has(id))) return null;
  const snapshots: StudySources['documents'] = [];
  for (const doc of docs) {
    const provenance = doc.provenance as Record<string, unknown>;
    const policy = provenance.usage_policy as Record<string, unknown> | undefined;
    if (policy?.derivation_policy !== 'allow') return null;
    const epoch = provenance.usage_epoch;
    if (typeof epoch !== 'string' || !epoch) return null;
    snapshots.push({
      id: doc.id,
      epoch,
      digest: canonicalHash({ body: doc.body_md, assets: doc.source_asset_ids, policy }),
    });
  }
  return {
    version: 1 as const,
    assets: [...new Set(assetIds)].sort(),
    questions,
    documents: snapshots,
  };
}

/** Revision publication seals provenance; legacy rows never acquire it by inference. */
export async function lockStudySources(
  tx: Tx,
  revisionId: string,
  groupId: string,
  partIds: string[],
  assetIds: string[],
) {
  const [publication] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_publish'),
        eq(event.subject_id, groupId),
        sql`${event.payload}->>'revision_id' = ${revisionId}`,
      ),
    )
    .limit(1);
  const parsed = Sources.safeParse(publication?.payload.study_sources);
  if (!parsed.success)
    throw new ApiError('study_source_unknown', 'frozen source permission is unavailable', 409);
  const current = await captureStudySources(tx, groupId, partIds, assetIds);
  if (!current || canonicalHash(current) !== canonicalHash(parsed.data)) {
    throw new ApiError(
      'study_source_restricted',
      'source permission or generation has changed',
      409,
    );
  }
  return parsed.data;
}
