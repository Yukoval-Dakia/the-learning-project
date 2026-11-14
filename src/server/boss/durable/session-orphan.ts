import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import type { DurableFamilyAdapter, MountedDurableFamily } from '@/kernel/manifest';
import { FAST_QUEUE_OPTS, createOrUpdateQueue } from '@/server/boss/queue-config';
import { installSessionOrphanProducerFence } from '@/server/durable/session-orphan-backend';
import type { SessionOrphanBoundaryHook } from '@/server/durable/session-orphan-family';
import {
  createSessionOrphanBackend,
  registerSessionOrphanWorkflows,
} from '@/server/durable/session-orphan-worker';

const CONVERSATION_FAMILY = 'prune_orphan_conversation_sessions';
const PLACEMENT_FAMILY = 'prune_orphan_placement_sessions';

export const sessionOrphanFamily: DurableFamilyAdapter = {
  label: 'session-orphan',
  required: true,
  requiredPeers: ['prune', 'review-orphan'],
  members: [
    {
      name: CONVERSATION_FAMILY,
      queue: 'fast',
      scheduled: true,
      singleton: 'forbidden',
      required: true,
    },
    {
      name: PLACEMENT_FAMILY,
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
    const conversationDecl = decls[CONVERSATION_FAMILY];
    const placementDecl = decls[PLACEMENT_FAMILY];
    if (!conversationDecl || !placementDecl) return undefined;
    const boundary = boundaries.sessionOrphan as SessionOrphanBoundaryHook | undefined;
    await createOrUpdateQueue(boss, conversationDecl.name, FAST_QUEUE_OPTS);
    await createOrUpdateQueue(boss, placementDecl.name, FAST_QUEUE_OPTS);
    await installSessionOrphanProducerFence(db);
    const workflows = registerSessionOrphanWorkflows(db, boundary);
    const backends = [
      createSessionOrphanBackend({
        boss,
        db,
        binding: {
          family: CONVERSATION_FAMILY,
          decl: conversationDecl,
          workflow: workflows.conversationOrphans,
        },
      }),
      createSessionOrphanBackend({
        boss,
        db,
        binding: {
          family: PLACEMENT_FAMILY,
          decl: placementDecl,
          workflow: workflows.placementOrphans,
        },
      }),
    ];
    // The two session members share one lifecycle handle: reconcile fans out so
    // one member's failure does not starve the other on the same tick.
    return {
      async reconcile() {
        const errors: unknown[] = [];
        for (const backend of backends) {
          try {
            await backend.reconcile();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, 'Session orphan reconcile failed');
      },
      async stop() {
        for (const backend of backends) await backend.stop();
      },
    };
  },
};
