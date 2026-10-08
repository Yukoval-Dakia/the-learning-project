import { DBOS } from '@dbos-inc/dbos-sdk';
import { sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import type { JobDecl } from '@/kernel/manifest';
import { buildPruneOrphanConversationSessionsHandler } from '@/server/boss/handlers/prune_orphan_conversation_sessions';
import { buildPruneOrphanPlacementSessionsHandler } from '@/server/boss/handlers/prune_orphan_placement_sessions';
import { fenceAwareJobHandler } from '@/server/contract-epoch';
import {
  type SessionOrphanBoundaryHook,
  type SessionOrphanFamily,
  readSessionOrphanPhase,
  runSessionOrphanTick,
} from './session-orphan-family';

export function registerSessionOrphanWorkflows(
  db: Db,
  boundary: SessionOrphanBoundaryHook = async () => {},
) {
  const register = (
    family: SessionOrphanFamily,
    step: 'conversation-orphan-sweep-v1' | 'placement-orphan-sweep-v1',
  ) =>
    DBOS.registerWorkflow(
      async (scheduledAt: Date, _context: unknown): Promise<void> => {
        const workflowId = DBOS.workflowID;
        if (!workflowId) throw new Error('Session orphan requires a durable workflow identity');
        await DBOS.runStep(
          () =>
            runSessionOrphanTick(
              db,
              { family, source: { kind: 'dbos', workflowId, scheduledAt } },
              boundary,
            ),
          { name: step, retriesAllowed: false },
        );
        await boundary({ family, tickId: workflowId, kind: 'checkpoint-saved' });
      },
      { name: family },
    );
  return {
    conversationOrphans: register(
      'prune_orphan_conversation_sessions',
      'conversation-orphan-sweep-v1',
    ),
    placementOrphans: register('prune_orphan_placement_sessions', 'placement-orphan-sweep-v1'),
  };
}
export type SessionOrphanWorkflows = ReturnType<typeof registerSessionOrphanWorkflows>;
export type SessionOrphanBinding =
  | {
      family: 'prune_orphan_conversation_sessions';
      decl: JobDecl;
      workflow: SessionOrphanWorkflows['conversationOrphans'];
    }
  | {
      family: 'prune_orphan_placement_sessions';
      decl: JobDecl;
      workflow: SessionOrphanWorkflows['placementOrphans'];
    };
export function createSessionOrphanBackend({
  boss,
  db,
  binding,
}: {
  boss: PgBoss;
  db: Db;
  binding: SessionOrphanBinding;
}) {
  const { family, decl, workflow } = binding;
  const schedule = decl.schedule;
  if (
    !schedule ||
    decl.name !== family ||
    decl.backend !== 'dbos' ||
    decl.queue !== 'fast' ||
    decl.load ||
    schedule.singletonKey !== undefined ||
    schedule.singletonSeconds !== undefined
  )
    throw new Error('Invalid session orphan declaration');
  const handler =
    family === 'prune_orphan_conversation_sessions'
      ? buildPruneOrphanConversationSessionsHandler(db)
      : buildPruneOrphanPlacementSessionsHandler(db);
  let mounted = false;
  return {
    async reconcile(): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select phase from session_orphan_control where family = ${family} for share`,
        );
        const phase = await readSessionOrphanPhase(tx, family);
        if (phase === 'dbos') {
          await boss.unschedule(family);
          await DBOS.applySchedules([
            {
              scheduleName: family,
              workflowFn: workflow,
              schedule: schedule.cron,
              cronTimezone: schedule.tz,
              automaticBackfill: false,
            },
          ]);
          await DBOS.resumeSchedule(family);
        } else if (await DBOS.getSchedule(family)) await DBOS.pauseSchedule(family);
        if (phase === 'pg-boss' || phase === 'draining-pg-boss') {
          if (!mounted) {
            await boss.work(
              family,
              { pollingIntervalSeconds: 2, batchSize: 1 },
              fenceAwareJobHandler(db, family, handler),
            );
            mounted = true;
          }
        } else if (mounted) {
          await boss.offWork(family, { wait: false });
          mounted = false;
        }
        const [clock] = await tx.execute(
          sql`select coalesce(legacy_not_before <= clock_timestamp(), true) as ready from session_orphan_control where family = ${family}`,
        );
        if (phase === 'pg-boss' && clock?.ready === true)
          await boss.schedule(family, schedule.cron, {}, { tz: schedule.tz, missed: 'skip' });
        else await boss.unschedule(family);
      });
    },
    async stop(): Promise<void> {
      if (mounted) {
        await boss.offWork(family, { wait: false });
        mounted = false;
      }
    },
  };
}
