import type { PgBoss } from 'pg-boss';
import type { Db } from '@/db/client';
import type { DurableFamilyAdapter, MountedDurableFamily } from '@/kernel/manifest';
import { JUDGE_FAMILY, JUDGE_RECONCILE_FAMILY } from '@/server/durable/judge-family';
import {
  type JudgeWorkerBoundary,
  createJudgeBackend,
  prepareJudgeBackend,
  registerJudgeWorkflows,
} from '@/server/durable/judge-worker';

export const judgeFamily: DurableFamilyAdapter = {
  label: JUDGE_FAMILY,
  required: false,
  requiredPeers: ['prune', 'review-orphan', 'session-orphan'],
  members: [
    {
      name: JUDGE_FAMILY,
      queue: 'llm',
      scheduled: false,
      singleton: 'forbidden',
      required: false,
      pairedWith: JUDGE_RECONCILE_FAMILY,
    },
    {
      name: JUDGE_RECONCILE_FAMILY,
      queue: 'fast',
      scheduled: true,
      singleton: 'allowed',
      required: false,
      pairedWith: JUDGE_FAMILY,
    },
  ],
  async mount(context): Promise<MountedDurableFamily | undefined> {
    const boss = context.boss as PgBoss;
    const db = context.db as Db;
    const decls = context.decls;
    const boundaries = context.boundaries;
    const runDecl = decls[JUDGE_FAMILY];
    const reconcileDecl = decls[JUDGE_RECONCILE_FAMILY];
    if (!runDecl || !reconcileDecl) return undefined;
    const boundary = boundaries.judge as JudgeWorkerBoundary | undefined;
    await prepareJudgeBackend(boss, db);
    const workflows = registerJudgeWorkflows(db, boundary);
    return createJudgeBackend({ boss, db, runDecl, reconcileDecl, workflows });
  },
};
