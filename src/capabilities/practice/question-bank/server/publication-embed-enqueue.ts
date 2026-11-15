// The event subscription retries failed sends; job insertion commits before delivery acknowledgement.
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { event } from '@/db/schema';
import type { EventSubscriptionDelivery, EventSubscriptionOutcome } from '@/kernel/manifest';
import { getStartedBoss } from '@/server/boss/client';

import {
  PUBLICATION_EMBED_JOB,
  type PublicationEmbedJobData,
  publicationEmbedJobId,
} from '../jobs/publication_embed';

const PublicationPayload = z.object({
  group_id: z.string().min(1),
  revision_id: z.string().min(1),
  admission: z.string(),
});

export async function enqueuePublicationEmbed(
  db: Db,
  delivery: EventSubscriptionDelivery,
): Promise<EventSubscriptionOutcome> {
  const boss = await getStartedBoss();
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(event).where(eq(event.id, delivery.sourceEventId));
    const payload = PublicationPayload.safeParse(source?.payload);
    if (
      source?.action !== 'experimental:assessment_publish' ||
      source.outcome !== 'success' ||
      source.subject_kind !== 'question' ||
      !payload.success ||
      payload.data.admission !== 'admitted' ||
      source.subject_id !== payload.data.group_id
    ) {
      return { status: 'skipped', reason: 'not an admitted question publication' };
    }
    const jobData: PublicationEmbedJobData = {
      group_id: payload.data.group_id,
      revision_id: payload.data.revision_id,
      source_event_id: source.id,
    };
    const sent = await boss.send(PUBLICATION_EMBED_JOB, jobData, {
      id: publicationEmbedJobId(payload.data.group_id, payload.data.revision_id),
      db: fromPgBossDrizzleTx(tx),
    });
    // A retained completed/failed job also conflicts. Recovery uses that job or nightly reconciliation.
    if (sent === null) {
      return {
        status: 'skipped',
        reason: 'publication embed job already exists',
        detail: { group_id: payload.data.group_id, revision_id: payload.data.revision_id },
      };
    }
    return {
      status: 'succeeded',
      detail: { group_id: payload.data.group_id, revision_id: payload.data.revision_id },
    };
  });
}

export const buildPublicationEmbedSubscriber = (db: Db) => (delivery: EventSubscriptionDelivery) =>
  enqueuePublicationEmbed(db, delivery);
