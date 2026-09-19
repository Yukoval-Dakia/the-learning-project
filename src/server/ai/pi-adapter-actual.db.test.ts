// YUK-921 P1 (YUK-1014) — pi-adapter ACTUAL-OUTPUT gate. This file is the
// evidence-regeneration harness the ticket's acceptance calls for: a REAL
// runTask against opencode-go (real testcontainer Postgres for the durable
// rows, real network for the provider call, real PiAgentAdapter for the
// normalization). It is INERT wherever OPENCODE_API_KEY is unset — CI never
// carries that key, so the describe skips wholesale.
//
// Re-run locally:
//   OPENCODE_API_KEY=sk-... pnpm vitest run --config vitest.db.config.ts \
//     src/server/ai/pi-adapter-actual.db.test.ts
// Evidence lands in docs/planning/evidence/2026-09-19-pi-adapter-<model>-actual.json.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ai_task_runs } from '@/db/schema';
import { testDb } from '../../../tests/helpers/db';
import { runTask } from './runner';

const HAS_KEY = Boolean(process.env.OPENCODE_API_KEY);
const KIND = 'AttributionTask' as const;
const EVIDENCE_DIR = join(process.cwd(), 'docs/planning/evidence');

// PI_ACTUAL_MODELS=a,b,c narrows the sweep for a single-model rerun.
const ALL_MODELS = ['mimo-v2.5-pro', 'glm-5.3-flash', 'grok-4.6'] as const;
const MODELS = process.env.PI_ACTUAL_MODELS
  ? ALL_MODELS.filter((m) => process.env.PI_ACTUAL_MODELS?.split(',').includes(m))
  : ALL_MODELS;

const INPUT = {
  question: '解方程：x^2 - 5x + 6 = 0',
  student_answer: 'x = 2 或 x = 4',
  correct_answer: 'x = 2 或 x = 3',
  judge_outcome: 'incorrect',
  subject: 'math',
};

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe.skipIf(!HAS_KEY)('pi adapter actual-output gate (YUK-1014)', () => {
  beforeAll(() => {
    process.env.AI_ADAPTER_PI_KINDS = KIND;
  });
  afterAll(() => {
    delete process.env.AI_ADAPTER_PI_KINDS;
  });

  for (const model of MODELS) {
    it(`runs ${model} through opencode-go end-to-end and seals evidence`, {
      timeout: 180_000,
    }, async () => {
      const db = testDb();
      let result: Awaited<ReturnType<typeof runTask>> | undefined;
      let runError:
        | { name: string; subtype?: string; taskRunId?: string; message: string }
        | undefined;
      try {
        result = await runTask(KIND, INPUT, {
          db,
          modelBinding: { adapter: 'pi', provider: 'opencode-go', model },
        });
      } catch (err) {
        // Failure evidence is first-class: a model that misses the kind's
        // budget or breaks its wire contract still seals what it proved.
        runError = {
          name: (err as Error).name,
          subtype: (err as { subtype?: string }).subtype,
          taskRunId: (err as { taskRunId?: string }).taskRunId,
          message: (err as Error).message.slice(0, 400),
        };
      }

      const taskRunId = result?.task_run_id ?? runError?.taskRunId;
      expect(taskRunId).toBeTruthy();

      // Durable-row truth — the attempt row persists usage/cost either way.
      const [row] = await db
        .select()
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, taskRunId as string))
        .limit(1);
      expect(row).toBeTruthy();
      expect(row.provider).toBe('opencode-go');
      expect(row.model).toBe(model);

      const revision = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
      const evidence = {
        captured_at: new Date().toISOString(),
        code_revision: revision,
        ticket: 'YUK-1014',
        lane: {
          adapter: 'pi',
          provider: row.provider,
          model: row.model,
          task_kind: row.task_kind,
          session_header: 'x-opencode-session=<ai_task_run.id>',
        },
        task_run_id: taskRunId,
        status: row.status,
        finish_reason: row.finish_reason ?? result?.finishReason ?? runError?.subtype,
        usage: row.usage_json,
        cost: {
          basis: row.cost_basis,
          amount_usd: row.cost_usd,
          ref: row.cost_ref,
        },
        ...(runError ? { error: runError } : {}),
        input_digest: `sha256:${sha256(JSON.stringify(INPUT))}`,
        ...(result
          ? {
              output_digest: `sha256:${sha256(result.text)}`,
              output_excerpt: result.text.slice(0, 600),
            }
          : {}),
        provenance:
          'PiRunnerMessage frames carry source=pi; terminal evidence normalized ' +
          'from pi agentLoop agent_end + final assistant usage (catalog-estimated ' +
          'cost — never contractual per design §6 R1).',
      };
      const file = join(EVIDENCE_DIR, `2026-09-19-pi-adapter-${model}-actual.json`);
      writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);

      // The success contract only binds models that finish inside the
      // kind's budget — failures above are already sealed as evidence.
      if (runError) throw new Error(runError.message);
      expect(result?.text.length).toBeGreaterThan(0);
      expect(result?.cost_basis).toBe('estimated');
      expect(result?.cost_ref).toBe(`pi-catalog:opencode-go/${model}`);
      expect(row.status).toBe('success');
      expect(row.cost_basis).toBe('estimated');
      expect(row.cost_ref).toBe(`pi-catalog:opencode-go/${model}`);
      expect(row.usage_json.inputTokens).toBeGreaterThan(0);
      expect(row.usage_json.outputTokens).toBeGreaterThan(0);
    });
  }
});
