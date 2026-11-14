import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import type { DurableFamilyAdapter, MountedDurableFamily } from '@/kernel/manifest';
import { FAST_QUEUE_OPTS, createOrUpdateQueue } from '@/server/boss/queue-config';
import {
  REVIEW_ORPHAN_FAMILY,
  type ReviewOrphanBoundaryHook,
  installReviewOrphanProducerFence,
} from '@/server/durable/review-orphan-family';
import {
  createReviewOrphanBackend,
  registerReviewOrphanWorkflow,
} from '@/server/durable/review-orphan-worker';

export const reviewOrphanFamily: DurableFamilyAdapter = {
  label: REVIEW_ORPHAN_FAMILY,
  required: true,
  requiredPeers: ['prune', 'session-orphan'],
  members: [
    {
      name: REVIEW_ORPHAN_FAMILY,
      queue: 'fast',
      scheduled: true,
      singleton: 'forbidden',
      required: true,
    },
  ],
  async mount(context): Promise<MountedDurableFamily | undefined> {
    const boss = context.boss as PgBoss;
    const db = context.db as Db;
    const decls = context.decls;
    const boundaries = context.boundaries;
    const decl = decls[REVIEW_ORPHAN_FAMILY];
    if (!decl) return undefined;
    const boundary = boundaries.reviewOrphan as ReviewOrphanBoundaryHook | undefined;
    await createOrUpdateQueue(boss, REVIEW_ORPHAN_FAMILY, FAST_QUEUE_OPTS);
    await installReviewOrphanProducerFence(db);
    const workflow = registerReviewOrphanWorkflow(db, boundary);
    return createReviewOrphanBackend({ boss, db, decl, workflow });
  },
};
