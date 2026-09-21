// YUK-921 P3 (YUK-1022) — pi-adapter COPILOT-LANE actual-output gate. Same
// evidence-regeneration pattern as the P2 gate
// (src/server/ai/pi-tool-loop-actual.db.test.ts) but one level up: the REAL
// durable worker path — runCopilotRun with no seam mocks → executeCopilotTurn
// → runTask → PiAgentAdapter. Every P3 surface is exercised by the production
// caller wiring, not a synthetic adapter call: piToolMounts (domain registry +
// Exa remote when EXA_API_KEY is present), piHooks (cancellation gate +
// finalizer evidence hooks), piSessionReplay (turn 2 resumes the pi:<uuid>
// cursor and seeds the real durable conversation_history projection),
// piSkillDocs (resolved SKILL.md bodies), piAgents (native research specs),
// nativeCompaction (transformContext), and the pi:-cursor fold in
// copilot_run.ts. INERT wherever OPENCODE_API_KEY is unset — CI never carries
// that key, so the describe skips wholesale.
//
// Re-run locally:
//   OPENCODE_API_KEY=sk-... EXA_API_KEY=... pnpm vitest run \
//     --config vitest.db.config.ts src/capabilities/copilot/jobs/copilot-pi-actual.db.test.ts
// Evidence lands in docs/planning/evidence/2026-09-21-pi-p3-copilot-<model>-actual.json.
//
// The user messages demand short declarative prose (no questions, no equations)
// so the learning-content reviewer short-circuits locally without an extra
// provider call — a blocked/marker verdict would still be recorded as evidence
// but is not what this gate measures.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilities } from '@/capabilities';
import { ai_task_runs, event, learning_session } from '@/db/schema';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { __resetRegistryForTests } from '@/server/ai/tools/registry';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { assembleCopilotRunInput } from '../server/copilot-run-input';
import { runCopilotRun } from './copilot_run';

const HAS_KEY = Boolean(process.env.OPENCODE_API_KEY);
const KIND = 'CopilotTask';
const MODEL = process.env.PI_ACTUAL_MODEL ?? 'deepseek-v4-pro';
const EVIDENCE_DIR = join(process.cwd(), 'docs/planning/evidence');

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function seedConversation(sessionId: string) {
  await testDb()
    .insert(learning_session)
    .values({
      id: sessionId,
      type: 'conversation',
      status: 'active',
      entrypoint: 'copilot',
      updated_at: new Date(),
    })
    .onConflictDoNothing();
}

async function seedInputRoot(runId: string, sessionId: string, userMessage: string) {
  // A dispatched worker job always has a committed input root — preserve the
  // real admission precondition (same insert the copilot_run harness uses).
  await testDb()
    .insert(event)
    .values({
      id: runId,
      session_id: sessionId,
      actor_kind: 'user',
      actor_ref: 'user:self',
      action: 'experimental:copilot_user_ask',
      subject_kind: 'query',
      subject_id: runId,
      payload: { surface: 'copilot', user_message: userMessage, session_id: sessionId },
      created_at: new Date(),
    })
    .onConflictDoNothing();
}

async function persistedCursor(sessionId: string) {
  const [row] = await testDb()
    .select({ sdkSessionId: learning_session.agent_sdk_session_id })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId));
  return row?.sdkSessionId ?? null;
}

describe.skipIf(!HAS_KEY)('pi copilot-lane actual-output gate (YUK-1022)', () => {
  beforeAll(async () => {
    __resetRegistryForTests();
    await registerCapabilityTools(capabilities);
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(() => {});

  it('runs two durable copilot turns on the pi lane and resumes the pi: cursor', {
    timeout: 600_000,
  }, async () => {
    const db = testDb();
    const sessionId = `sess_p3_actual_${createId()}`;
    await seedConversation(sessionId);

    // Wrap the REAL assembler so the durable-history projection that feeds
    // piSessionReplay is measured, not assumed.
    const historyDepth: number[] = [];
    const recordingAssembler: typeof assembleCopilotRunInput = async (d, params, deps) => {
      const input = await assembleCopilotRunInput(d, params, deps);
      historyDepth.push(input.conversation_history.length);
      return input;
    };

    const runTurn = async (runId: string, userMessage: string) => {
      await seedInputRoot(runId, sessionId, userMessage);
      return runCopilotRun({
        db,
        data: {
          run_id: runId,
          session_id: sessionId,
          user_message: userMessage,
          triggered_by: 'chat',
        },
        resolveCopilotRunInputFn: recordingAssembler,
        modelBinding: { provider: 'opencode-go', model: MODEL, adapter: 'pi' },
      });
    };

    const userMessages = [
      '用一句中文陈述句回答：水的化学式是什么。不要提问，不要列式，不要展开。',
      '继续用一句中文陈述句回答：氧气的化学式是什么。同样不要提问。',
    ] as const;
    const run1Id = `run_p3_t1_${createId()}`;
    const run2Id = `run_p3_t2_${createId()}`;
    const t1 = await runTurn(run1Id, userMessages[0]);
    const cursor1 = await persistedCursor(sessionId);
    const t2 = await runTurn(run2Id, userMessages[1]);
    const cursor2 = await persistedCursor(sessionId);

    const runs = await db.select().from(ai_task_runs).where(eq(ai_task_runs.task_kind, KIND));
    const replies = await db
      .select()
      .from(event)
      .where(and(eq(event.session_id, sessionId), eq(event.action, 'experimental:copilot_reply')));

    const revision = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const evidence = {
      captured_at: new Date().toISOString(),
      code_revision: revision,
      ticket: 'YUK-1022',
      lane: {
        adapter: 'pi',
        provider: 'opencode-go',
        model: MODEL,
        task_kind: KIND,
        pin: 'explicit modelBinding (post-P4: the env rollout pin is gone)',
        worker_path: 'runCopilotRun → executeCopilotTurn (no seam mocks)',
      },
      session: {
        session_id: sessionId,
        cursor_after_turn1: cursor1,
        cursor_after_turn2: cursor2,
        cursor_reused_verbatim: cursor1 !== null && cursor1 === cursor2,
      },
      turns: [
        {
          run_id: run1Id,
          status: t1.status,
          ...(t1.status === 'failed' ? { error: t1.error } : {}),
          conversation_history_turns: historyDepth[0] ?? null,
          input_digest: `sha256:${sha256(userMessages[0])}`,
        },
        {
          run_id: run2Id,
          status: t2.status,
          ...(t2.status === 'failed' ? { error: t2.error } : {}),
          conversation_history_turns: historyDepth[1] ?? null,
          input_digest: `sha256:${sha256(userMessages[1])}`,
        },
      ],
      reply_digests: replies.map((r) => ({
        event_id: r.id,
        task_run_id: (r.payload as { task_run_id?: string }).task_run_id ?? null,
        output_digest: `sha256:${sha256(
          String((r.payload as { reply_md?: string }).reply_md ?? ''),
        )}`,
        output_excerpt: String((r.payload as { reply_md?: string }).reply_md ?? '').slice(0, 400),
      })),
      ai_task_runs: runs.map((row) => ({
        id: row.id,
        provider: row.provider,
        model: row.model,
        status: row.status,
        finish_reason: row.finish_reason,
        error_message: row.error_message,
        cost_basis: row.cost_basis,
        cost_usd: row.cost_usd,
        cost_ref: row.cost_ref,
        usage_digest: `sha256:${sha256(JSON.stringify(row.usage_json))}`,
      })),
      provenance:
        'Turn 1 mints a pi:<uuid> cursor through notifySdkSessionId; ' +
        'copilot_run persists it and registers the worker-owned session. ' +
        'Turn 2 passes the piLanePinnedForKind fold (same id resumes verbatim ' +
        'instead of folding to cold), seeds piSessionReplay from the real ' +
        'assembleCopilotRunInput conversation_history projection, and the ' +
        'adapter replays it as user messages. piHooks/piSkillDocs/piAgents/' +
        'nativeCompaction all ride the same ctx as the SDK descriptors.',
    };
    const file = join(EVIDENCE_DIR, `2026-09-21-pi-p3-copilot-${MODEL}-actual.json`);
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);

    // The gate itself: both turns produced pi-lane task runs, the pi: cursor
    // persisted after turn 1, and the second turn's real assembly saw the
    // durable history that feeds piSessionReplay. The cursor is asserted
    // reused verbatim only when turn 2 completed — a failed/partial turn
    // clears the worker cursor by design (same as the SDK lane).
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((row) => row.provider === 'opencode-go')).toBe(true);
    expect(runs.every((row) => row.model === MODEL)).toBe(true);
    expect(runs.every((row) => row.status === 'success')).toBe(true);
    expect(runs.every((row) => row.cost_basis === 'estimated')).toBe(true);
    expect(runs.every((row) => row.cost_ref === `pi-catalog:opencode-go/${MODEL}`)).toBe(true);
    expect(cursor1?.startsWith('pi:')).toBe(true);
    expect(t1.status).toBe('done');
    expect(t2.status).toBe('done');
    expect(cursor2).toBe(cursor1);
    expect(historyDepth[1] ?? 0).toBeGreaterThan(0);
  });
});
