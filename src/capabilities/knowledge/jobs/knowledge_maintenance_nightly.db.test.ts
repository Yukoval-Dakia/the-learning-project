import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProviderTransportEvidence } from '@/ai/task-result';
import type { MaintenanceReviewTarget } from '@/capabilities/knowledge/server/review';
import {
  type KnowledgeMutationOutput,
  proposeKnowledgeMutationTool,
} from '@/capabilities/knowledge/server/tools/proposal-tools';
import { type Db, db } from '@/db/client';
import { ai_task_runs, knowledge } from '@/db/schema';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';
import { readProviderWaitRequest } from '@/server/ai/provider-wait';
import { resolveSubjectProfile } from '@/subjects/profile';
import { resetDb } from '../../../../tests/helpers/db';
import {
  buildKnowledgeMaintenanceNightlyHandler,
  runKnowledgeMaintenanceNightly,
} from './knowledge_maintenance_nightly';

function proposeNewChild(db: Db, parentId: string, name: string, reasoning: string) {
  return proposeKnowledgeMutationTool.execute(
    { db, taskRunId: '', callerActor: { kind: 'agent', ref: 'dreaming' } },
    {
      change: { mutation: 'propose_new', parent_id: parentId, name },
      learner_summary: `补充知识点：${name}`,
      reasoning,
    },
  );
}

async function seedParentKnowledge(id = createId()) {
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: 'Foundation',
    domain: 'math',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

function mathTarget(): MaintenanceReviewTarget {
  return {
    subject: 'math',
    subjectProfile: resolveSubjectProfile('math'),
    input: { tree: [], recent_mistakes: [], agent_notes: [] },
  };
}

function singleSubjectPlan() {
  return async () => ({ targets: [mathTarget()], skipped_subjects: [] });
}

describe('knowledge_maintenance_nightly handler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant concurrency: two maintenance runs racing one cooldown key leave exactly one pending proposal
  // @fails-if the proposal gate lock or pending-key check is skipped and both runs write a proposal
  it('does not create duplicate proposals when concurrent runs race the same cooldown key', async () => {
    const parentId = await seedParentKnowledge();
    let waiting = 0;
    let releaseBoth: (() => void) | null = null;
    const bothWaiting = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const waitForBoth = async () => {
      waiting += 1;
      if (waiting === 2) releaseBoth?.();
      await bothWaiting;
    };

    const run = () =>
      runKnowledgeMaintenanceNightly(db, {
        planFn: singleSubjectPlan(),
        runMaintenanceReviewFn: async ({ db }) => {
          await waitForBoth();
          await proposeNewChild(
            db,
            parentId,
            'Raced child',
            'same concurrent maintenance proposal',
          );
          return new Response('done');
        },
      });

    await Promise.all([run(), run()]);

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(
      rows.filter((row) => row.payload.cooldown_key === `knowledge_node:${parentId}:Raced child`),
    ).toHaveLength(1);
  });

  // @invariant concurrency: a pending proposal's cooldown key blocks a second proposal from a later run
  // @fails-if the duplicate-pending check is bypassed and the inbox holds two pending rows
  it('does not create a second proposal when the same cooldown key is already pending', async () => {
    const parentId = await seedParentKnowledge();
    const first = await proposeNewChild(db, parentId, 'Duplicate child', 'first pending proposal');
    expect(first.status).toBe('proposed');

    let second: KnowledgeMutationOutput | null = null;
    const result = await runKnowledgeMaintenanceNightly(db, {
      planFn: singleSubjectPlan(),
      runMaintenanceReviewFn: async ({ db }) => {
        second = await proposeNewChild(
          db,
          parentId,
          'Duplicate child',
          'same proposal should be skipped',
        );
        return new Response('done');
      },
    });

    expect(second).toMatchObject({
      status: 'skipped:duplicate_pending',
      proposal_id: first.proposal_id,
      cooldown_key: `knowledge_node:${parentId}:Duplicate child`,
    });
    expect(result.proposals_created).toBe(0);
    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows).toHaveLength(1);
  });

  // @invariant data: a settled unbilled provider refusal behind the real
  // [streamTask] marker yields a provider_wait ask instead of dead-lettering
  // the member and losing tonight's maintenance run.
  // @fails-if the run-id regex stops parsing the parenthesized marker, the
  // settled row's evidence stops being read, or the wait gate widens to
  // unproven outcomes
  it('the real [streamTask] marker on a proven unbilled 500 yields a provider_wait ask', async () => {
    const taskRunId = createId();
    const transport: ProviderTransportEvidence = {
      v: 1,
      budget: { task_timeout_ms: 60_000 },
      lane: 'undici_agent',
      send_state: 'response_received',
      totals: {
        requests: 1,
        dispatches: 1,
        by_state: {
          not_sent: 0,
          sent_without_response: 0,
          response_received: 1,
          unknown: 0,
          in_flight: 0,
        },
      },
      requests: [
        {
          seq: 1,
          loop: 'root',
          fetch_invoked_at: new Date().toISOString(),
          send_state: 'response_received',
          http_status: 500,
        },
      ],
      requests_seen: 1,
      requests_dropped: 0,
      captured_at: new Date().toISOString(),
    };
    await db.insert(ai_task_runs).values({
      id: taskRunId,
      task_kind: 'KnowledgeMaintenanceNightly',
      provider: 'opendesign',
      model: 'deepseek-v4.1-flash',
      input_hash: 'a'.repeat(64),
      status: 'failure',
      started_at: new Date(),
      finished_at: new Date(),
      usage_json: {
        inputTokens: 0,
        outputTokens: 0,
        transport,
      },
      cost_usd: 0,
      cost_basis: 'estimated',
      cost_ref: 'unbilled-provider-rejection:test',
      error_message: 'provider exploded',
    });

    // The exact frame runner.ts enqueues into the response body on failure:
    // `\n\n[streamTask] <message> (task_run_id=<id>)\n`.
    const handler = buildKnowledgeMaintenanceNightlyHandler(db, {
      planFn: singleSubjectPlan(),
      runMaintenanceReviewFn: async () =>
        new Response(`\n\n[streamTask] provider exploded (task_run_id=${taskRunId})\n`),
    });
    const output = await handler([]);

    const wait = readProviderWaitRequest(output);
    expect(wait?.retryClass).toBe('server_error');
    expect(wait?.detail).toContain(taskRunId);
  });
});
