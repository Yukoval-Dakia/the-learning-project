import { createServer } from 'node:http';
import { agentLoop } from '@earendil-works/pi-agent-core';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { capabilities } from '@/capabilities';
import { runAttributionFollowup } from '@/capabilities/practice/failure-learning/jobs/attribution_followup';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { knowledge, mastery_state, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { EvidenceDemandV1, type EvidenceDemandV1T } from '@/kernel/supply-contracts';
import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { createLoomPiModels } from '@/server/ai/pi-models';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { _resetBossForTests, getStartedBoss } from '@/server/boss/client';
import { EXPIRE_LLM, createJobQueue } from '@/server/boss/queue-config';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { buildQuestionPreparerTarget } from './preparer-target';
import { runQuestionPreparer } from './question-preparer';
import { enqueueQuestionPreparerTicket } from './question-preparer-ticket';

const ANSWER = "f'(x)=3x^2-3a，令f'(x)=0得x=±√a，所以f(x)在(-√a,√a)上单调递减，其余区间单调递增。";
const bodies: Record<string, unknown>[] = [];
/** The scripted model turns of the current run; after the last one it returns the final report. */
let script: { tool: string; args: unknown }[] = [];
let stop: () => Promise<void> = async () => {};

function chunk(delta: unknown, finish: string | null = null) {
  return `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } } : {}) })}\n\n`;
}
function toolCall(tools: { function: { name: string } }[], name: string, args: unknown) {
  const wire = tools.find((tool) => tool.function.name.endsWith(name))?.function.name;
  if (!wire) throw new Error(`${name} missing from the wire`);
  return chunk({
    role: 'assistant',
    tool_calls: [
      {
        index: 0,
        id: `call-${bodies.length}`,
        type: 'function',
        function: { name: wire, arguments: JSON.stringify(args) },
      },
    ],
  });
}

beforeAll(async () => {
  await registerCapabilityTools(capabilities);
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>;
    bodies.push(body);
    const tools = body.tools as { function: { name: string } }[];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const step = script[bodies.length - 1];
    response.write(
      step
        ? toolCall(tools, step.tool, step.args) + chunk({}, 'tool_calls')
        : chunk({ role: 'assistant', content: '{"outcome":"no_progress","summary":"stopped"}' }) +
            chunk({}, 'stop'),
    );
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stop = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  const models = await createLoomPiModels();
  const model = models.getModel('opencode-go', 'deepseek-v4.1-flash');
  if (!model) throw new Error('offline protocol model unavailable');
  vi.spyOn(models, 'getModel').mockReturnValue({
    ...model,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
  });
  __setPiAdapterForTests(new PiAgentAdapter({ models, agentLoop }));
  vi.stubEnv('OPENCODE_API_KEY', 'offline-invalid-key');
  setTestConfig({
    CLAUDE_CODE_MAX_RETRIES: 0,
    SUPPLY_NIGHTLY_SPEND_CAP_USD: 1,
    'lane.global.provider': 'opencode-go',
    'lane.global.model': 'deepseek-v4.1-flash',
  });
});
afterAll(async () => {
  await stop();
  resetTestConfig();
  __setPiAdapterForTests(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function seedLearner() {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values([
    {
      id: 'k_root',
      name: '数学',
      domain: 'math',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    },
    {
      id: 'k_param',
      name: '含参函数单调性讨论',
      domain: null,
      parent_id: 'k_root',
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: now,
      updated_at: now,
      version: 0,
    },
  ]);
  const prompt = '讨论函数 $f(x)=x^3-3ax$ 的单调性。';
  await db.insert(question).values({
    id: 'q1',
    kind: 'short_answer',
    prompt_md: prompt,
    reference_md: '分 a≤0、a>0 讨论',
    source: 'manual',
    knowledge_ids: ['k_param'],
    created_at: now,
    updated_at: now,
  });
  await writeEvent(db, {
    id: 'attempt1',
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'failure',
    created_at: now,
    payload: {
      answer_md: ANSWER,
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_param'],
      question_snapshot: {
        schema_version: 1,
        question: {
          question_id: 'q1',
          question_version: 0,
          parent_question_id: null,
          prompt_md: prompt,
          reference_md: null,
          choices_md: null,
          image_refs: [],
          figures: [],
          updated_at: now.toISOString(),
        },
        parent_question: null,
      },
    },
  });
  const cause = {
    primary_category: 'concept',
    secondary_categories: [],
    analysis_md: '没有对参数 a 分类讨论。',
    confidence: 0.9,
  };
  await runAttributionFollowup({
    db,
    attemptEventId: 'attempt1',
    runTaskFn: (async () => ({ text: JSON.stringify(cause) })) as never,
    enqueueVariantGen: async () => {},
  });
  await db.insert(mastery_state).values({
    id: 'm1',
    subject_kind: 'knowledge',
    subject_id: 'k_param',
    theta_hat: -0.6,
    evidence_count: 1,
    fail_count: 1,
    updated_at: now,
  });
}

// @invariant security: the preparer reads the learner's mistakes, but neither the ticket's learner state nor a new question can carry caller- or learner-authored text.
// @fails-if a caller-supplied theta_hat/observed cause survives enqueue, or a draft quoting the learner's answer verbatim is saved.
it('fills ticket learner state from the server and refuses drafts that copy a learner answer', async () => {
  await resetDb();
  await seedLearner();
  _resetBossForTests();
  const boss = await getStartedBoss();
  await createJobQueue(boss, 'question_preparer_run', EXPIRE_LLM);
  const forged: EvidenceDemandV1T = EvidenceDemandV1.parse({
    version: 1,
    demand_id: 'demand:test:k_param',
    policy_version: 'supply-v2-phase-a',
    subject_id: 'math',
    claim: {
      kind: 'knowledge_mastery',
      statement: '按参数分类讨论单调性',
      knowledge_ids: ['k_param'],
    },
    evidence: { observables: ['分类正确'], minimum_observations: 1 },
    task: { kinds: ['choice'], allowed_uses: ['practice'] },
    difficulty: {
      band: 'near',
      scale: 'loom_difficulty_1_5',
      target_value: null,
      theta_hat: [
        {
          knowledge_id: 'k_param',
          value: 3,
          evidence_count: 99,
          provenance: 'observed',
          as_of: new Date().toISOString(),
        },
      ],
    },
    inventory_goal: { eligible_count: 1, horizon_days: 7 },
    control: { needed_by: null, max_budget_micro_usd: 100000, max_attempts: 1 },
    causes: [
      {
        kind: 'observed_error',
        observed: {
          knowledge_id: 'k_param',
          category: 'forged',
          label: null,
          count: 9,
          last_at: '2026-01-01',
          source: 'caller',
        },
      },
    ],
  });
  await enqueueQuestionPreparerTicket(
    testDb(),
    forged,
    buildQuestionPreparerTarget(forged, { reason: 'test' }),
  );
  const [job] = await boss.fetch<{ ticket: EvidenceDemandV1T }>('question_preparer_run');
  if (!job) throw new Error('ticket job missing');
  expect(job.data.ticket.difficulty.theta_hat?.map((r) => [r.knowledge_id, r.value])).toEqual([
    ['k_param', -0.6],
  ]);
  expect(job.data.ticket.causes.map((c) => [c.kind, c.observed?.category])).toEqual([
    ['coverage_gap', undefined],
    ['observed_error', 'concept'],
  ]);

  bodies.length = 0;
  script = [
    {
      tool: 'query_knowledge',
      args: { subjectId: 'math', nodeId: 'k_param', include: ['recent_failures'] },
    },
    {
      tool: 'edit_question',
      args: {
        action: 'save',
        document: {
          schema_version: 2,
          parts: [{ part_id: 'p1', prompt_md: `判断下面的解答是否正确：${ANSWER}` }],
        },
      },
    },
  ];
  await runQuestionPreparer(testDb(), job.id, job.data);
  const sent = JSON.stringify(bodies[1]);
  expect(sent).toContain('单调递减，其余区间单调递增');
  expect(JSON.stringify(bodies[2])).toContain('learner_text_copied');
  expect(await testDb().select().from(question)).toHaveLength(1);
  await boss.stop({ graceful: false });
});

// @invariant security: a question the learner got wrong never comes back as the preparer's new prompt.
// @fails-if a draft whose prompt equals the missed question after spacing/LaTeX normalization is saved, or a changed parameter is refused.
it('refuses the missed question as a new prompt and allows a changed parameter', async () => {
  for (const row of [
    { prompt: '讨论函数  $f(x)=x^{3}-3ax$ 的单调性．', refused: true },
    { prompt: '讨论函数 $f(x)=x^3-12ax$ 的单调性。', refused: false },
  ]) {
    await resetDb();
    await seedLearner();
    _resetBossForTests();
    const boss = await getStartedBoss();
    await createJobQueue(boss, 'question_preparer_run', EXPIRE_LLM);
    const ticket = EvidenceDemandV1.parse({
      version: 1,
      demand_id: 'demand:test:reuse',
      policy_version: 'supply-v2-phase-a',
      subject_id: 'math',
      claim: { kind: 'knowledge_mastery', statement: '分类讨论', knowledge_ids: ['k_param'] },
      evidence: { observables: ['分类正确'], minimum_observations: 1 },
      task: { kinds: ['choice'], allowed_uses: ['practice'] },
      difficulty: { band: 'near', scale: 'loom_difficulty_1_5', target_value: null },
      inventory_goal: { eligible_count: 1, horizon_days: 7 },
      control: { needed_by: null, max_budget_micro_usd: 100000, max_attempts: 1 },
      causes: [{ kind: 'coverage_gap' }],
    });
    await enqueueQuestionPreparerTicket(
      testDb(),
      ticket,
      buildQuestionPreparerTarget(ticket, { reason: 'test' }),
    );
    const [job] = await boss.fetch<{ ticket: EvidenceDemandV1T }>('question_preparer_run');
    if (!job) throw new Error('ticket job missing');
    bodies.length = 0;
    script = [
      { tool: 'query_mistakes', args: { filter: { knowledgeId: 'k_param' } } },
      {
        tool: 'edit_question',
        args: {
          action: 'save',
          document: { schema_version: 2, parts: [{ part_id: 'p1', prompt_md: row.prompt }] },
        },
      },
    ];
    await runQuestionPreparer(testDb(), job.id, job.data);
    expect(JSON.stringify(bodies[2]).includes('learner_question_reused'), row.prompt).toBe(
      row.refused,
    );
    await boss.stop({ graceful: false });
  }
});
