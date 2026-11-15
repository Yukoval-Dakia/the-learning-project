// Publication delivery shares the nightly question embed operation and its paid receipt.
import { createHash } from 'node:crypto';
import type { Job } from 'pg-boss';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { type EmbedProviderAttemptOptions, embedMany } from '@/server/ai/embed';
import { runQuestionEmbedding } from './embed_backfill';

export const PUBLICATION_EMBED_JOB = 'question_publication_embed' as const;

export const PublicationEmbedJobData = z.object({
  group_id: z.string().min(1),
  revision_id: z.string().min(1),
  source_event_id: z.string().min(1),
});
export type PublicationEmbedJobData = z.infer<typeof PublicationEmbedJobData>;

export function publicationEmbedJobId(groupId: string, revisionId: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify([PUBLICATION_EMBED_JOB, groupId, revisionId]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function runPublicationEmbed(
  db: Db,
  data: PublicationEmbedJobData,
  providerAttempt: EmbedProviderAttemptOptions,
  embedFn: typeof embedMany = embedMany,
): Promise<'embedded' | 'skipped'> {
  const parsed = PublicationEmbedJobData.parse(data);
  const result = await runQuestionEmbedding(
    db,
    parsed.group_id,
    providerAttempt,
    embedFn,
    parsed.revision_id,
  );
  if (result === 'held') throw new Error('publication embedding awaits paid-effect reconciliation');
  return result;
}

export function buildPublicationEmbedHandler(
  db: Db,
): (jobs: Job<PublicationEmbedJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const outcome = await runPublicationEmbed(db, job.data, {
        db,
        caller: 'worker',
        deadlineAt: new Date(Date.now() + 20_000),
        operationAnchor: job.id,
      });
      console.log('[publication_embed]', { ...job.data, outcome });
    }
  };
}
