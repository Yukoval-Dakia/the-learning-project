// YUK-921 P2 (YUK-1021) — pi-adapter TOOL-LOOP actual-output gate. Same
// evidence-regeneration pattern as the P1 gate (pi-adapter-actual.db.test.ts):
// a REAL run through the production entry point against opencode-go on a
// needsToolCall kind, real testcontainer Postgres for the durable rows, real
// network for provider + Exa calls, real PiAgentAdapter + pi-tools bridge for
// DomainTool→AgentTool and remote-MCP→AgentTool compilation. INERT wherever
// OPENCODE_API_KEY is unset — CI never carries that key, so the describe skips
// wholesale.
//
// Re-run locally:
//   OPENCODE_API_KEY=sk-... EXA_API_KEY=... pnpm vitest run \
//     --config vitest.db.config.ts src/server/ai/pi-tool-loop-actual.db.test.ts
// Evidence lands in docs/planning/evidence/2026-09-21-pi-tool-loop-<model>-actual.json.
//
// Kind pick: SourcingTask — needsToolCall=true and its output contract
// (per-candidate source_url + verbatim extract) cannot be satisfied without a
// real web_search_exa call, so a passing run is inherently a tool-loop proof.
// The run goes through runWebSourcingAgentDefault (the production entry), which
// mounts piDomainMount + piRemoteMcpMount and leaves modelBinding unset — the
// pi route comes from the explicit modelBinding on the task run — the only
// post-P4 routing surface (the ops rollout env pins were retired).

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilities } from '@/capabilities';
import { runWebSourcingAgentDefault } from '@/capabilities/practice/server/tools/web-fetch-candidates';
import { ai_task_runs, event, knowledge, tool_call_log } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';
import { testDb } from '../../../tests/helpers/db';
import { registerCapabilityTools } from './tools/register-capability-tools';
import { __resetRegistryForTests } from './tools/registry';

const HAS_KEY = Boolean(process.env.OPENCODE_API_KEY);
const KIND = 'SourcingTask' as const;
const MODEL = process.env.PI_ACTUAL_MODEL ?? 'glm-5.3-flash';
const EVIDENCE_DIR = join(process.cwd(), 'docs/planning/evidence');

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function seedKnowledge(db: ReturnType<typeof testDb>, id: string, parentId: string | null) {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: `K-${id}`,
      domain: 'math',
      parent_id: parentId,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

describe.skipIf(!HAS_KEY)('pi tool-loop actual-output gate (YUK-1021)', () => {
  beforeAll(async () => {
    __resetRegistryForTests();
    await registerCapabilityTools(capabilities);
  });

  it(`runs ${KIND} through opencode-go tool loop and reconciles tool_call_log`, {
    timeout: 300_000,
  }, async () => {
    const db = testDb();
    await seedKnowledge(db, 'k_p2_root', null);
    await seedKnowledge(db, 'k_p2_a', 'k_p2_root');

    // Tool-call evidence rows key on the mount ctx taskRunId — the correlation
    // id the caller threads through (same split the production callers use).
    const toolCtxRunId = `p2_evidence_tool_${createId()}`;
    const input = {
      subject: 'math',
      trigger: 'knowledge' as const,
      ref: {
        id: 'k_p2_a',
        name: 'K-k_p2_a',
        knowledge_node: { id: 'k_p2_a', name: 'K-k_p2_a', domain: 'math' },
      },
      knowledge_context: [{ id: 'k_p2_a', name: 'K-k_p2_a', domain: 'math' }],
      count: 1,
      whitelist: [],
    };

    let result:
      | { text: string; task_run_id?: string | null; cost_usd?: number | null }
      | null
      | undefined;
    let runError:
      | { name: string; subtype?: string; taskRunId?: string; message: string }
      | undefined;
    try {
      result = await runWebSourcingAgentDefault({
        db,
        input,
        subjectProfile: resolveSubjectProfile('math'),
        ctx: {
          taskRunId: toolCtxRunId,
          causedByEventId: '',
          modelBinding: { provider: 'opencode-go', model: MODEL, adapter: 'pi' },
        },
      });
    } catch (err) {
      runError = {
        name: (err as Error).name,
        subtype: (err as { subtype?: string }).subtype,
        taskRunId: (err as { taskRunId?: string }).taskRunId,
        message: (err as Error).message.slice(0, 400),
      };
    }

    const taskRunId = result?.task_run_id ?? runError?.taskRunId;
    if (runError) console.error('[pi-p2-actual] runError:', JSON.stringify(runError));
    if (result === null) console.error('[pi-p2-actual] exa unavailable — EXA_API_KEY missing?');
    expect(taskRunId).toBeTruthy();

    const [row] = await db
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, taskRunId as string))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.provider).toBe('opencode-go');
    expect(row.model).toBe(MODEL);

    // ── tool_call_log / tool_use 对账 ─────────────────────────────────────
    const logRows = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.task_run_id, toolCtxRunId));
    const mirroredIds = new Set(logRows.map((r) => r.mirrored_event_id).filter(Boolean));
    const mirrored = (await db.select().from(event).where(eq(event.action, 'tool_use'))).filter(
      (e) => mirroredIds.has(e.id),
    );

    const revision = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const evidence = {
      captured_at: new Date().toISOString(),
      code_revision: revision,
      ticket: 'YUK-1021',
      lane: {
        adapter: 'pi',
        provider: row.provider,
        model: row.model,
        task_kind: row.task_kind,
        needsToolCall: true,
        session_header: 'x-opencode-session=<ai_task_run.id>',
        tool_ctx_run_id: toolCtxRunId,
        pin: 'explicit ctx.modelBinding (post-P4: the env rollout pin is gone)',
      },
      task_run_id: taskRunId,
      status: row.status,
      finish_reason: row.finish_reason ?? runError?.subtype,
      usage: row.usage_json,
      cost: {
        basis: row.cost_basis,
        amount_usd: row.cost_usd,
        ref: row.cost_ref,
      },
      tool_call_log: logRows.map((r) => ({
        tool_name: r.tool_name,
        task_kind: r.task_kind,
        effect: r.effect,
        latency_ms: r.latency_ms,
        input_digest: `sha256:${sha256(JSON.stringify(r.input_json))}`,
        mirrored_event_id: r.mirrored_event_id,
      })),
      mirrored_tool_use_events: mirrored.map((e) => ({
        id: e.id,
        action: e.action,
        subject_kind: e.subject_kind,
      })),
      ...(runError ? { error: runError } : {}),
      input_digest: `sha256:${sha256(JSON.stringify(input))}`,
      ...(result?.text
        ? {
            output_digest: `sha256:${sha256(result.text)}`,
            output_excerpt: result.text.slice(0, 600),
          }
        : {}),
      provenance:
        'PiRunnerMessage frames carry source=pi; AgentTool names keep the ' +
        'mcp__<server>__<tool> wire so allowedTools/tool_call_log/tool_use ' +
        'semantics are byte-identical to the SDK lane. DomainTools execute via ' +
        'the shared executeDomainToolCall pipeline; the Exa remote tool is ' +
        'bridged over the official MCP SDK StreamableHTTP client. Cost stays ' +
        'catalog-estimated.',
    };
    const file = join(EVIDENCE_DIR, `2026-09-21-pi-tool-loop-${MODEL}-actual.json`);
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);

    if (runError) throw new Error(runError.message);
    expect(result?.text.length).toBeGreaterThan(0);
    expect(row.status).toBe('success');
    expect(row.cost_basis).toBe('estimated');
    expect(row.cost_ref).toBe(`pi-catalog:opencode-go/${MODEL}`);
    // The tool-loop gate itself: at least one bridged tool execution must have
    // logged evidence (the sourcing contract requires a real search call).
    expect(logRows.length).toBeGreaterThan(0);
    expect(logRows.every((r) => r.task_kind === KIND)).toBe(true);
  });
});
