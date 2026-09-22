// YUK-346 — mimo vs GLM main-agent EVAL probe. Same evidence-regeneration
// pattern as pi-adapter-actual.db.test.ts / pi-tool-loop-actual.db.test.ts:
// REAL runTask / runWebSourcingAgentDefault calls through the production entry
// points against BOTH wired Anthropic-compat lanes (xiaomi mimo = the current
// registry default; zhipu = GLM coding plan), real testcontainer Postgres for
// the durable rows, real network for the provider calls. INERT wherever the
// keys are absent — CI never carries them, so the describes skip wholesale.
//
// Re-run locally:
//   XIAOMI_API_KEY=sk-... ZHIPU_API_KEY=... EXA_API_KEY=... \
//     pnpm vitest run --config vitest.db.config.ts \
//     src/server/ai/mimo-vs-glm-actual.db.test.ts
// Evidence lands in docs/planning/evidence/2026-09-22-yuk346-<kind>-<provider>-<model>.json.
//
// Coverage picks (ticket: judge / tool-calling / teaching / 中文文言文 domain):
//   - SemanticJudgeTask (judge; yuwen 文言文 translation item) — also runs
//     glm-5.3-flash as the cheap-tier candidate.
//   - AttributionTask (reasoning-heavy failure attribution; the known mimo
//     latency-pressure point — ~57-60s at the budget edge on the 2026-09-19
//     opencode-go evidence).
//   - TeachingTurnTask (copilot teaching turn; yuwen).
//   - SourcingTask (needsToolCall=true tool loop through the PRODUCTION
//     runWebSourcingAgentDefault entry — domain read tools + Exa remote MCP).
//
// Every run seals: task_run_id, status, finish_reason, wall_ms, usage, cost,
// input/output digests, and the spec's own parseText verdict (schema
// conformance = the tool/JSON stability metric the ticket asks for).

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { capabilities } from '@/capabilities';
import { teachingTurnTaskSpec } from '@/capabilities/copilot/tasks/teaching-turn';
import { runWebSourcingAgentDefault } from '@/capabilities/practice/server/tools/web-fetch-candidates';
import {
  type AttributionInput,
  attributionTaskSpec,
} from '@/capabilities/practice/tasks/attribution';
import { semanticJudgeTaskSpec } from '@/capabilities/practice/tasks/judges';
import { sourcingTaskSpec } from '@/capabilities/practice/tasks/sourcing';
import { ai_task_runs, knowledge, tool_call_log } from '@/db/schema';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { testDb } from '../../../tests/helpers/db';
import { runTask } from './runner';
import { registerCapabilityTools } from './tools/register-capability-tools';
import { __resetRegistryForTests } from './tools/registry';

const HAS_MIMO = Boolean(process.env.XIAOMI_API_KEY);
const HAS_GLM = Boolean(process.env.ZHIPU_API_KEY);
const HAS_EXA = Boolean(process.env.EXA_API_KEY);
const EVIDENCE_DIR = join(process.cwd(), 'docs/planning/evidence');
const DATE = '2026-09-22';

type Lane = { provider: 'xiaomi' | 'zhipu'; model: string };

const MIMO_PRO: Lane = { provider: 'xiaomi', model: 'mimo-v2.5-pro' };
const GLM_52: Lane = { provider: 'zhipu', model: 'glm-5.2' };
const GLM_53_FLASH: Lane = { provider: 'zhipu', model: 'glm-5.3-flash' };

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface RunOutcome {
  text?: string;
  task_run_id?: string | null;
  cost_usd?: number | null;
  error?: { name: string; subtype?: string; taskRunId?: string; message: string };
  wall_ms: number;
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ value?: T; error?: unknown; wall_ms: number }> {
  const started = Date.now();
  try {
    return { value: await fn(), wall_ms: Date.now() - started };
  } catch (error) {
    return { error, wall_ms: Date.now() - started };
  }
}

function sealEvidence(params: {
  kind: string;
  lane: Lane;
  outcome: RunOutcome;
  input: unknown;
  parseOk?: boolean;
  parseError?: string;
  extra?: Record<string, unknown>;
  /** Optional filename suffix before .json (e.g. '-asconfigured'). */
  nameSuffix?: string;
}): { file: string; evidence: Record<string, unknown> } {
  const { kind, lane, outcome, input } = params;
  const revision = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const evidence: Record<string, unknown> = {
    captured_at: new Date().toISOString(),
    code_revision: revision,
    ticket: 'YUK-346',
    lane: {
      adapter: 'pi',
      provider: lane.provider,
      model: lane.model,
      task_kind: kind,
      pin: 'explicit ctx.modelBinding (post-P4 routing surface)',
    },
    task_run_id: outcome.task_run_id ?? null,
    wall_ms: outcome.wall_ms,
    parse_ok: params.parseOk ?? null,
    ...(params.parseError ? { parse_error: params.parseError } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    input_digest: `sha256:${sha256(JSON.stringify(input))}`,
    ...(outcome.text
      ? {
          output_digest: `sha256:${sha256(outcome.text)}`,
          output_excerpt: outcome.text.slice(0, 800),
        }
      : {}),
    ...(params.extra ?? {}),
    provenance:
      'PiRunnerMessage frames carry source=pi; terminal evidence normalized ' +
      'from pi agentLoop agent_end + final assistant usage. Cost stays ' +
      'catalog-estimated (zhipu coding-plan catalog rates are 0 — flat ' +
      'subscription; mimo rates are the dated public per-token estimate).',
  };
  const file = join(
    EVIDENCE_DIR,
    `${DATE}-yuk346-${kind.toLowerCase()}-${lane.provider}-${lane.model}${params.nameSuffix ?? ''}.json`,
  );
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  return { file, evidence };
}

async function runPlainTask(
  kind: 'SemanticJudgeTask' | 'AttributionTask' | 'TeachingTurnTask',
  input: unknown,
  lane: Lane,
  subjectProfile: SubjectProfile,
  budgetOverride?: { maxIterations?: number; timeoutMs?: number },
): Promise<RunOutcome> {
  const db = testDb();
  const { value, error, wall_ms } = await timed(() =>
    runTask(kind, input, {
      db,
      subjectProfile,
      modelBinding: { adapter: 'pi', provider: lane.provider, model: lane.model },
      ...(budgetOverride ? { budgetOverride } : {}),
    }),
  );
  if (error) {
    return {
      error: {
        name: (error as Error).name,
        subtype: (error as { subtype?: string }).subtype,
        taskRunId: (error as { taskRunId?: string }).taskRunId,
        message: (error as Error).message.slice(0, 400),
      },
      wall_ms,
    };
  }
  return {
    text: value?.text,
    task_run_id: value?.task_run_id,
    cost_usd: value?.cost_usd,
    wall_ms,
  };
}

async function readRunRow(taskRunId: string | null | undefined) {
  if (!taskRunId) return undefined;
  const db = testDb();
  const [row] = await db.select().from(ai_task_runs).where(eq(ai_task_runs.id, taskRunId)).limit(1);
  return row;
}

function parseVerdict(
  kind: 'SemanticJudgeTask' | 'AttributionTask' | 'TeachingTurnTask' | 'SourcingTask',
  text: string | undefined,
  input: unknown,
  subjectProfile: SubjectProfile,
): { ok?: boolean; error?: string } {
  if (text === undefined) return {};
  try {
    // parseText arity is per-spec (judge/sourcing/teaching ignore the parse ctx
    // entirely; attribution needs subjectProfile for the candidate taxonomy), so
    // each branch calls with its declared signature — no uniform (text, ctx).
    if (kind === 'SemanticJudgeTask') semanticJudgeTaskSpec.parseText(text);
    else if (kind === 'AttributionTask')
      attributionTaskSpec.parseText(text, {
        input: input as AttributionInput,
        subjectProfile,
      });
    else if (kind === 'TeachingTurnTask') teachingTurnTaskSpec.parseText(text);
    else sourcingTaskSpec.parseText(text);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 300) };
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// 文言文 judge item (yuwen profile): the student answer is substantively
// correct — expected verdict correct/high-partial; the comparison surface is
// whether matched_points/evidence stay grounded in the required_points.
const YUWEN = () => resolveSubjectProfile('yuwen');
const MATH = () => resolveSubjectProfile('math');

const JUDGE_INPUT = {
  question: {
    question_id: 'yuk346_judge_yuwen_1',
    kind: 'translation',
    prompt_md: '把下列句子译成现代汉语：「吾尝终日而思矣，不如须臾之所学也。」（《荀子·劝学》）',
    reference_md: '我曾经整天思索，却不如片刻学习（得到的收获多）。',
    choices_md: [],
    rubric_json: {
      required_points: [
        '「尝」译为「曾经」',
        '「须臾」译为「片刻 / 一会儿」',
        '译出「终日而思」与「须臾所学」的对比关系，语句通顺',
      ],
      acceptable_answers: ['我曾经整天地思考，却不如片刻学习收获多'],
      keywords: [],
    },
    required_points: [
      '「尝」译为「曾经」',
      '「须臾」译为「片刻 / 一会儿」',
      '译出「终日而思」与「须臾所学」的对比关系，语句通顺',
    ],
    acceptable_answers: ['我曾经整天地思考，却不如片刻学习收获多'],
    keywords: [],
    subject_profile: { id: 'yuwen', display_name: '语文', language_style: '' },
    figures: [],
    image_refs: [],
    structured: null,
  },
  answer: { content: '我曾经一天到晚地思考，却不如学一会儿得到的东西多。' },
};

// Same underlying math miss as the 2026-09-19 opencode-go evidence (x=4 vs
// x=3) so this probe stays comparable with the sealed baseline — but in the
// real AttributionInput shape the production caller sends.
const ATTR_INPUT = {
  prompt_md: '解方程：x^2 - 5x + 6 = 0',
  reference_md: 'x = 2 或 x = 3',
  wrong_answer_md: 'x = 2 或 x = 4',
  knowledge_context: [{ id: 'k_yuk346_quad', name: '一元二次方程求解', effective_domain: 'math' }],
};

const TEACH_INPUT = {
  learning_item: {
    title: '文言虚词「而」的用法辨析',
    one_line_intent: '能区分「而」表并列、承接、转折、修饰四种常见关系',
    knowledge_node: { id: 'k_yuk346_er', name: '文言虚词·而' },
  },
  parent_hub_summary: '文言文虚词专题：以「而」「之」「其」高频虚词为核心。',
  atomic_sections: {
    definition: '「而」是文言中最常见的连词，连接词、短语或分句，表并列、承接、转折、修饰等关系。',
    mechanism:
      '判断「而」的用法要看前后两部分的逻辑关系：前后对等互换不改变语义→并列；有时间/动作先后→承接；语义相反（常可译「却」）→转折；前项修饰后项动作状态→修饰。',
    example:
      '「蟹六跪而二螯」（并列）；「学而时习之」（承接）；「青，取之于蓝，而青于蓝」（转折）；「吾尝终日而思矣」（修饰）。',
    pitfall:
      '把修饰关系误判为承接（如「终日而思」的「而」连接状语与谓语，表修饰而非先后两个动作）。',
    check: '辨析「人不知而不愠」中「而」的关系类型。',
  },
  messages: [],
};

async function seedKnowledge(
  db: ReturnType<typeof testDb>,
  id: string,
  parentId: string | null,
  name?: string,
) {
  const now = new Date();
  await db
    .insert(knowledge)
    .values({
      id,
      name: name ?? `K-${id}`,
      domain: 'math',
      parent_id: parentId,
      created_at: now,
      updated_at: now,
      version: 0,
    })
    .onConflictDoNothing();
}

// ── Gates ───────────────────────────────────────────────────────────────────

/**
 * Two-phase runner for maxIterations:1 kinds (SemanticJudgeTask /
 * TeachingTurnTask).
 *
 * Phase A — as-configured budget. On the pi lane `shouldStopAfterTurn` is
 * consulted after EVERY completed turn (pi-agent-core agent-loop.js:154),
 * and the adapter counts it unconditionally (pi-agent-adapter.ts:1155), so a
 * maxTurns=1 ceiling caps turn 1 → error_max_turns even when the model's
 * first response is a clean end_turn answer. That diverges from SDK maxTurns
 * semantics (1 turn was enough for a single-shot reply). Phase A seals this
 * as-configured regression record — its outcome is DATA, never asserted.
 *
 * Phase B — relaxed `budgetOverride.maxIterations:4`. Isolates the model's
 * actual text quality / parse conformance from the turn-ceiling interaction;
 * this is the signal the ticket's quality-regression question needs.
 */
async function runTwoPhase(
  kind: 'SemanticJudgeTask' | 'TeachingTurnTask',
  input: unknown,
  lane: Lane,
  subjectProfile: SubjectProfile,
  extraBase: Record<string, unknown>,
): Promise<{
  relaxed: RunOutcome;
  verdict: { ok?: boolean; error?: string };
  evidence: Record<string, unknown>;
}> {
  const asConfigured = await runPlainTask(kind, input, lane, subjectProfile);
  const rowA = await readRunRow(asConfigured.task_run_id ?? asConfigured.error?.taskRunId);
  sealEvidence({
    kind,
    lane,
    outcome: { ...asConfigured, task_run_id: rowA?.id ?? asConfigured.task_run_id },
    input,
    nameSuffix: '-asconfigured',
    extra: {
      ...extraBase,
      phase: 'as-configured',
      budget_override: null,
      status: rowA?.status,
      finish_reason: rowA?.finish_reason,
      usage: rowA?.usage_json,
      cost: { basis: rowA?.cost_basis, amount_usd: rowA?.cost_usd, ref: rowA?.cost_ref },
    },
  });

  const relaxed = await runPlainTask(kind, input, lane, subjectProfile, { maxIterations: 4 });
  const verdict = parseVerdict(kind, relaxed.text, input, subjectProfile);
  const row = await readRunRow(relaxed.task_run_id ?? relaxed.error?.taskRunId);
  const { evidence } = sealEvidence({
    kind,
    lane,
    outcome: { ...relaxed, task_run_id: row?.id ?? relaxed.task_run_id },
    input,
    parseOk: verdict.ok,
    parseError: verdict.error,
    extra: {
      ...extraBase,
      phase: 'relaxed-budget',
      budget_override: { maxIterations: 4 },
      as_configured: {
        status: rowA?.status ?? (asConfigured.error ? 'failure' : 'success'),
        error_subtype: asConfigured.error?.subtype ?? null,
        wall_ms: asConfigured.wall_ms,
      },
      status: row?.status,
      finish_reason: row?.finish_reason,
      usage: row?.usage_json,
      cost: { basis: row?.cost_basis, amount_usd: row?.cost_usd, ref: row?.cost_ref },
    },
  });
  return { relaxed, verdict, evidence };
}

describe.skipIf(!HAS_MIMO || !HAS_GLM)('YUK-346 mimo vs GLM eval probe', () => {
  beforeAll(async () => {
    __resetRegistryForTests();
    await registerCapabilityTools(capabilities);
  });
  afterAll(() => {});

  for (const lane of [MIMO_PRO, GLM_52, GLM_53_FLASH]) {
    it(`SemanticJudgeTask on ${lane.provider}/${lane.model} (yuwen 文言文)`, {
      timeout: 300_000,
    }, async () => {
      const { relaxed, verdict, evidence } = await runTwoPhase(
        'SemanticJudgeTask',
        JUDGE_INPUT,
        lane,
        YUWEN(),
        { subject: 'yuwen' },
      );
      expect(evidence.task_run_id).toBeTruthy();
      if (relaxed.error) throw new Error(relaxed.error.message);
      expect(verdict.ok).toBe(true);
    });
  }

  for (const lane of [MIMO_PRO, GLM_52]) {
    it(`AttributionTask on ${lane.provider}/${lane.model} (math)`, {
      timeout: 180_000,
    }, async () => {
      const outcome = await runPlainTask('AttributionTask', ATTR_INPUT, lane, MATH());
      const verdict = parseVerdict('AttributionTask', outcome.text, ATTR_INPUT, MATH());
      const row = await readRunRow(outcome.task_run_id ?? outcome.error?.taskRunId);
      const { evidence } = sealEvidence({
        kind: 'AttributionTask',
        lane,
        outcome: { ...outcome, task_run_id: row?.id ?? outcome.task_run_id },
        input: ATTR_INPUT,
        parseOk: verdict.ok,
        parseError: verdict.error,
        extra: {
          subject: 'math',
          status: row?.status,
          finish_reason: row?.finish_reason,
          usage: row?.usage_json,
          cost: { basis: row?.cost_basis, amount_usd: row?.cost_usd, ref: row?.cost_ref },
        },
      });
      expect(evidence.task_run_id).toBeTruthy();
      if (outcome.error) throw new Error(outcome.error.message);
      expect(verdict.ok).toBe(true);
    });
  }

  for (const lane of [MIMO_PRO, GLM_52]) {
    it(`TeachingTurnTask on ${lane.provider}/${lane.model} (yuwen)`, {
      timeout: 300_000,
    }, async () => {
      const { relaxed, verdict, evidence } = await runTwoPhase(
        'TeachingTurnTask',
        TEACH_INPUT,
        lane,
        YUWEN(),
        { subject: 'yuwen' },
      );
      expect(evidence.task_run_id).toBeTruthy();
      if (relaxed.error) throw new Error(relaxed.error.message);
      expect(verdict.ok).toBe(true);
    });
  }

  for (const lane of [MIMO_PRO, GLM_52]) {
    it.skipIf(!HAS_EXA)(
      `SourcingTask tool loop on ${lane.provider}/${lane.model} (needsToolCall)`,
      { timeout: 300_000 },
      async () => {
        const db = testDb();
        await seedKnowledge(db, 'k_yuk346_root', null, '一元二次方程');
        await seedKnowledge(db, 'k_yuk346_a', 'k_yuk346_root', '因式分解法解一元二次方程');

        const toolCtxRunId = `yuk346_tool_${createId()}`;
        // Semantic anchor KC (not a placeholder) — a nonsense name let GLM
        // legitimately refuse the loop in the first probe round; the eval needs
        // the full domain-read → Exa remote-MCP → structured-output chain.
        const input = {
          subject: 'math',
          trigger: 'knowledge' as const,
          ref: {
            id: 'k_yuk346_a',
            name: '因式分解法解一元二次方程',
            knowledge_node: { id: 'k_yuk346_a', name: '因式分解法解一元二次方程', domain: 'math' },
          },
          knowledge_context: [
            { id: 'k_yuk346_a', name: '因式分解法解一元二次方程', domain: 'math' },
          ],
          count: 1,
          whitelist: [],
        };

        const { value, error, wall_ms } = await timed(() =>
          runWebSourcingAgentDefault({
            db,
            input,
            subjectProfile: MATH(),
            ctx: {
              taskRunId: toolCtxRunId,
              causedByEventId: '',
              modelBinding: { provider: lane.provider, model: lane.model, adapter: 'pi' },
            },
          }),
        );
        const outcome: RunOutcome = {
          text: value?.text,
          task_run_id: value?.task_run_id,
          cost_usd: value?.cost_usd,
          wall_ms,
          ...(error
            ? {
                error: {
                  name: (error as Error).name,
                  subtype: (error as { subtype?: string }).subtype,
                  taskRunId: (error as { taskRunId?: string }).taskRunId,
                  message: (error as Error).message.slice(0, 400),
                },
              }
            : {}),
        };

        const verdict = parseVerdict('SourcingTask', outcome.text, input, MATH());
        const row = await readRunRow(outcome.task_run_id ?? outcome.error?.taskRunId);
        const logRows = await db
          .select()
          .from(tool_call_log)
          .where(eq(tool_call_log.task_run_id, toolCtxRunId));

        // tool_call_log under toolCtxRunId only captures the DOMAIN bridge
        // (piDomainMount → executeDomainToolCall). Remote Exa MCP calls go
        // through piRemoteMcpMount — a real MCP client, no tool_call_log row —
        // and runner-side recordToolCall only logs spawn tools on this path
        // (runner.ts:713). A lane that skips the domain read (GLM did when the
        // semantic anchor was already in knowledge_context) but calls Exa is
        // still a valid tool loop — detect it via the sourced output itself.
        const remoteSearchEvidence =
          typeof outcome.text === 'string' &&
          /"tool"\s*:\s*"exa"/.test(outcome.text) &&
          /"source_url"\s*:\s*"https?:/.test(outcome.text);

        const { evidence } = sealEvidence({
          kind: 'SourcingTask',
          lane,
          outcome: { ...outcome, task_run_id: row?.id ?? outcome.task_run_id },
          input,
          parseOk: verdict.ok,
          parseError: verdict.error,
          extra: {
            subject: 'math',
            status: row?.status,
            finish_reason: row?.finish_reason,
            usage: row?.usage_json,
            cost: { basis: row?.cost_basis, amount_usd: row?.cost_usd, ref: row?.cost_ref },
            tool_ctx_run_id: toolCtxRunId,
            domain_tool_calls: logRows.map((r) => ({
              tool_name: r.tool_name,
              effect: r.effect,
              latency_ms: r.latency_ms,
              input_digest: `sha256:${sha256(JSON.stringify(r.input_json))}`,
            })),
            remote_exa_evidence: remoteSearchEvidence,
          },
        });
        expect(evidence.task_run_id).toBeTruthy();
        if (outcome.error) throw new Error(outcome.error.message);
        // The tool-loop gate itself: the sourcing contract requires a real
        // search call — a bridged domain execution logged, OR the remote Exa
        // hop evidenced by a tool:"exa" + real source_url in the output.
        expect(logRows.length > 0 || remoteSearchEvidence).toBe(true);
      },
    );
  }
});
