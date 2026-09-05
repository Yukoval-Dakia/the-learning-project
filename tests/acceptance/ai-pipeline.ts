/**
 * Test-only, bounded actual-provider acceptance for the Copilot root.
 *
 * This is deliberately a script rather than a Vitest suite: it starts a private
 * pgvector container, makes paid calls only behind ACTUAL_PROVIDER_ACCEPTANCE=1,
 * and leaves a redacted synthetic evidence record for human review. It is not a
 * production smoke test, queue E2E, or semantic-quality oracle.
 *
 * Examples (the named env file is read without printing its values):
 *   ACTUAL_PROVIDER_ENV_FILE=/path/to/.env.local pnpm acceptance:ai-pipeline --preflight
 *   ACTUAL_PROVIDER_ACCEPTANCE=1 ACTUAL_PROVIDER_ENV_FILE=/path/to/.env.local \
 *     pnpm acceptance:ai-pipeline --case read --baseline-record --cost-limit-usd 1.75
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { config } from 'dotenv';

type CaseName =
  | 'cold'
  | 'resume'
  | 'context-change'
  | 'correction'
  | 'read'
  | 'proposal'
  | 'semantic'
  | 'native-task'
  | 'durable'
  | 'cancel';

const CASES: readonly CaseName[] = [
  'cold',
  'resume',
  'context-change',
  'correction',
  'read',
  'proposal',
  'native-task',
  'durable',
  'cancel',
  // Negative fixture emission is model-dependent; do it after the core journey.
  'semantic',
];
const DEFAULT_COST_LIMIT_USD = 2;
const MAX_COST_LIMIT_USD = 2;
const CASE_TIMEOUT_MS = 90_000;
// Admission reserves are deliberately conservative campaign controls, not
// vendor pricing promises. They avoid beginning another case when the remaining
// owner-approved allowance is obviously too small to finish its expected shape.
const CASE_COST_RESERVE_USD: Readonly<Record<CaseName, number>> = {
  cold: 0.25,
  resume: 0.25,
  'context-change': 0.25,
  correction: 0.25,
  read: 0.25,
  proposal: 0.25,
  semantic: 0.75,
  'native-task': 0.5,
  durable: 0.25,
  cancel: 0,
};
// Derived from the current content-validation call graph: verify-framework's
// runQuestionContentValidation → QuizVerifyTask; non-vision computation
// solve-check → SolutionGenerateTask; runTeachingQualityCheck → TeachingQualityTask.
const SEMANTIC_VALIDATOR_TASK_KINDS = [
  'QuizVerifyTask',
  'SolutionGenerateTask',
  'TeachingQualityTask',
] as const;
const SHA256 = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function costLimitUsd(): number {
  const raw = arg('--cost-limit-usd');
  if (raw === undefined) return DEFAULT_COST_LIMIT_USD;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_COST_LIMIT_USD) {
    throw new Error(`--cost-limit-usd must be >0 and <=${MAX_COST_LIMIT_USD}`);
  }
  return parsed;
}

function assertLoopback(url: string): void {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `acceptance refused: DATABASE_URL must be loopback; got host ${host || '<empty>'}`,
    );
  }
}

function loadProviderEnv(): string {
  const file = process.env.ACTUAL_PROVIDER_ENV_FILE;
  if (!file) throw new Error('ACTUAL_PROVIDER_ENV_FILE is required (named credential source path)');
  if (!existsSync(file)) throw new Error(`ACTUAL_PROVIDER_ENV_FILE does not exist: ${file}`);
  config({ path: file, override: false, quiet: true });
  if (!process.env.XIAOMI_API_KEY)
    throw new Error('XIAOMI_API_KEY is absent from process/env source');
  // The acceptance lane is pinned so a developer shell override cannot silently
  // turn a comparable Xiaomi run into a subscription or another provider run.
  process.env.AI_PROVIDER_OVERRIDE = 'xiaomi';
  process.env.AI_PROVIDER_MODEL = 'mimo-v2.5-pro';
  // This fixture exercises only registered in-process DB tools. Do not let a
  // developer's shell silently attach optional remote MCP/search providers.
  delete process.env.TAVILY_API_KEY;
  delete process.env.MEM0_API_KEY;
  // The actual local Mem0 adapter uses these keys, not MEM0_API_KEY. Keep
  // synthetic research from issuing an unmetered embedding/provider request.
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.ZHIPU_API_KEY;
  return file;
}

function localSocketFromDockerHost(value: string): string | undefined {
  if (!value.startsWith('unix://')) return undefined;
  const socket = value.slice('unix://'.length);
  return socket.length > 0 && existsSync(socket) ? socket : undefined;
}

function configureLocalDockerHost(): string {
  const configured = process.env.DOCKER_HOST;
  if (configured) {
    const socket = localSocketFromDockerHost(configured);
    if (!socket)
      throw new Error('acceptance refused: DOCKER_HOST must name an existing local Unix socket');
    return socket;
  }
  const context = spawnSync(
    'docker',
    ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
    {
      encoding: 'utf8',
    },
  );
  if (context.status === 0 && context.stdout.trim()) {
    const fromContext = context.stdout.trim();
    const socket = localSocketFromDockerHost(fromContext);
    if (!socket)
      throw new Error('acceptance refused: active Docker context is not a local Unix socket');
    process.env.DOCKER_HOST = fromContext;
    return socket;
  }
  const fallbackSockets = [
    `${process.env.HOME ?? ''}/.orbstack/run/docker.sock`,
    `${process.env.HOME ?? ''}/.docker/run/docker.sock`,
  ];
  const socket = fallbackSockets.find((candidate) => existsSync(candidate));
  if (!socket) throw new Error('acceptance refused: no local Docker Unix socket found');
  process.env.DOCKER_HOST = `unix://${socket}`;
  return socket;
}

async function preflight(): Promise<void> {
  const source = loadProviderEnv();
  const dockerSocket = configureLocalDockerHost();
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (docker.status !== 0) throw new Error('docker version preflight failed');
  // Testcontainers does not necessarily inherit the Docker CLI context. Starting
  // and stopping this private container proves the exact API path used by the
  // acceptance run without a migration or any provider call.
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  try {
    assertLoopback(container.getConnectionUri());
  } finally {
    await container.stop();
  }
  console.log(
    JSON.stringify({
      ok: true,
      mode: 'preflight',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      credential_source: source,
      docker_socket: dockerSocket,
      docker_server: docker.stdout.trim(),
      testcontainers_api: 'ok',
      paid_calls: false,
    }),
  );
}

function persistEvidence(evidence: Record<string, unknown>, outputPath?: string): string {
  const outputDir = resolve('.tmp/actual-provider-acceptance');
  mkdirSync(outputDir, { recursive: true });
  const target = outputPath ?? resolve(outputDir, `${Date.now()}-${randomUUID()}.json`);
  writeFileSync(target, `${JSON.stringify(evidence, null, 2)}\n`);
  return target;
}

async function main(): Promise<void> {
  if (process.argv.includes('--preflight')) return await preflight();
  if (process.env.ACTUAL_PROVIDER_ACCEPTANCE !== '1') {
    throw new Error('ACTUAL_PROVIDER_ACCEPTANCE=1 is required before any provider call');
  }
  const source = loadProviderEnv();
  const requested = arg('--case');
  if (requested && !CASES.includes(requested as CaseName)) {
    throw new Error(`unknown --case ${requested}; expected ${CASES.join(', ')}`);
  }
  // These scenarios need real preceding turns; a standalone invocation must not
  // spend a call and only then discover that its prerequisite session is absent.
  const prerequisites: Partial<Record<CaseName, CaseName[]>> = {
    resume: ['cold', 'resume'],
    'context-change': ['cold', 'resume', 'context-change'],
    correction: ['cold', 'correction'],
  };
  const selected = requested
    ? (prerequisites[requested as CaseName] ?? [requested as CaseName])
    : [...CASES];
  const campaignCostLimitUsd = costLimitUsd();
  const baselineRecord = process.argv.includes('--baseline-record');
  if (baselineRecord && selected.length !== 1) {
    throw new Error('--baseline-record is intentionally limited to one --case invocation');
  }

  const caseEvidence: Array<Record<string, unknown>> = [];
  let container: StartedPostgreSqlContainer | undefined;
  // Create the evidence envelope before Testcontainers setup. A Docker/migrate
  // failure must still leave a safe phase marker, not only a bare process Error.
  const evidence: Record<string, unknown> | undefined = {
    protocol_version: 1,
    phase: 'container_setup',
    exact_head: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    dirty_diff_sha256: SHA256(
      spawnSync('git', ['diff', '--binary', 'HEAD'], { encoding: 'utf8' }).stdout,
    ),
    harness_sha256: SHA256(readFileSync(new URL(import.meta.url), 'utf8')),
    provider: 'xiaomi',
    model: 'mimo-v2.5-pro',
    credential_source: source,
    baseline_record: baselineRecord,
    campaign_cost_limit_usd: campaignCostLimitUsd,
    case_cost_reserves_usd: CASE_COST_RESERVE_USD,
    cases: caseEvidence,
  };
  let activeCase: CaseName | undefined;
  let captureFailureState: (() => Promise<Record<string, unknown>>) | undefined;
  try {
    configureLocalDockerHost();
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    const databaseUrl = container.getConnectionUri();
    assertLoopback(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    process.env.TEST_DATABASE_URL = databaseUrl;
    const migrate = spawnSync('pnpm', ['db:migrate'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'inherit',
    });
    if (migrate.status !== 0) throw new Error(`db:migrate failed (exit ${migrate.status})`);

    // Import only after DATABASE_URL and the pinned provider lane are installed.
    const [
      { db },
      schema,
      chat,
      durable,
      dispatch,
      cancellationRoute,
      { capabilities },
      { registerCapabilityTools },
      { Conversation },
      { getTool },
      { COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY },
    ] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/capabilities/copilot/server/chat'),
      import('@/capabilities/copilot/jobs/copilot_run'),
      import('@/capabilities/copilot/server/durable-dispatch'),
      import('@/capabilities/copilot/api/cancel-run'),
      import('@/capabilities'),
      import('@/server/ai/tools/register-capability-tools'),
      import('@/server/session'),
      import('@/server/ai/tools/registry'),
      import('@/capabilities/copilot/server/content-validation'),
    ]);
    const { and, eq, inArray } = await import('drizzle-orm');
    const runner = await import('@/server/ai/runner');
    const terminals = new Map<string, string>();
    const captureStream: typeof runner.streamTaskCollecting = async (...args) => {
      const result = await runner.streamTaskCollecting(...args);
      if (result.terminalText !== undefined) terminals.set(result.task_run_id, result.terminalText);
      return result;
    };
    const captureRun: typeof runner.runAgentTask = async (...args) => {
      const result = await runner.runAgentTask(...args);
      terminals.set(result.task_run_id, result.text);
      return result;
    };
    // Match the server/worker composition root before constructing a Copilot
    // MCP bridge. Directly importing chat.ts does not populate this registry.
    await registerCapabilityTools(capabilities);
    for (const name of ['query_knowledge', 'propose_knowledge_mutation']) {
      if (!getTool(name)) throw new Error(`fixture bootstrap missing registered tool: ${name}`);
    }
    captureFailureState = async () => ({
      active_case: activeCase,
      // Only SDK terminal text for our synthetic fixture, never thinking blocks.
      terminal_outputs: Object.fromEntries(terminals),
      subagent_runs: await db
        .select({
          id: schema.subagent_run.id,
          status: schema.subagent_run.status,
          parent_task_run_id: schema.subagent_run.parent_task_run_id,
        })
        .from(schema.subagent_run),
      task_runs: await db
        .select({
          id: schema.ai_task_runs.id,
          kind: schema.ai_task_runs.task_kind,
          provider: schema.ai_task_runs.provider,
          model: schema.ai_task_runs.model,
          usage: schema.ai_task_runs.usage_json,
          cost: schema.ai_task_runs.cost_usd,
          cost_basis: schema.ai_task_runs.cost_basis,
        })
        .from(schema.ai_task_runs),
      tools: await db
        .select({
          task_run_id: schema.tool_call_log.task_run_id,
          name: schema.tool_call_log.tool_name,
          effect: schema.tool_call_log.effect,
          error: schema.tool_call_log.error_reason,
        })
        .from(schema.tool_call_log),
    });
    const now = new Date();
    await db.insert(schema.knowledge).values([
      {
        id: 'actual:classical-root',
        name: '文言虚词「之」',
        domain: 'yuwen',
        parent_id: null,
        approval_status: 'approved',
        proposed_by_ai: false,
        created_at: now,
        updated_at: now,
        version: 0,
      },
      {
        id: 'actual:classical-object',
        name: '代词宾语用法',
        domain: null,
        parent_id: 'actual:classical-root',
        approval_status: 'approved',
        proposed_by_ai: false,
        created_at: now,
        updated_at: now,
        version: 0,
      },
    ]);
    const seededKnowledgeState = (
      await db
        .select({
          id: schema.knowledge.id,
          name: schema.knowledge.name,
          parent_id: schema.knowledge.parent_id,
          version: schema.knowledge.version,
          archived_at: schema.knowledge.archived_at,
        })
        .from(schema.knowledge)
    ).sort((left, right) => left.id.localeCompare(right.id));

    evidence.phase = 'running';
    evidence.limitations = [
      'direct durable handler is not pg-boss queue E2E',
      'structural assertions do not establish factual entailment or semantic correctness',
    ];
    let knownCost = 0;
    const observedTaskRunIds = new Set<string>();
    const createCopilotSession = async () =>
      (await Conversation.findOrCreateCopilotConversation(db, { now: new Date() })).sessionId;
    const sessionId = await createCopilotSession();
    evidence.fixture_readiness = {
      registered_tools: ['query_knowledge', 'propose_knowledge_mutation'],
      foreground_session_id: sessionId,
    };
    let priorTurnId: string | undefined;
    let coldSdkSessionId: string | undefined;
    let resumeCompiledPromptHash: string | null | undefined;

    const snapshot = async (
      caseName: CaseName,
      input: unknown,
      result: { task_run_id?: string; reply?: string; session_id?: string },
    ) => {
      // A root may synchronously invoke a native child or a retained semantic
      // validator. Capture every new attempt, not only the root id, so the $2
      // guard cannot undercount a paid descendant.
      const allRows = await db
        .select({
          id: schema.ai_task_runs.id,
          kind: schema.ai_task_runs.task_kind,
          provider: schema.ai_task_runs.provider,
          model: schema.ai_task_runs.model,
          usage: schema.ai_task_runs.usage_json,
          cost: schema.ai_task_runs.cost_usd,
          costBasis: schema.ai_task_runs.cost_basis,
          compiledPromptHash: schema.ai_task_runs.compiled_prompt_hash,
          promptCodecMode: schema.ai_task_runs.prompt_codec_mode,
          promptContextDigest: schema.ai_task_runs.prompt_context_digest,
        })
        .from(schema.ai_task_runs);
      const rows = allRows.filter((row) => !observedTaskRunIds.has(row.id));
      for (const row of rows) observedTaskRunIds.add(row.id);
      const taskIds = rows.map((row) => row.id);
      const sessionRows = result.session_id
        ? await db
            .select({ agent_sdk_session_id: schema.learning_session.agent_sdk_session_id })
            .from(schema.learning_session)
            .where(eq(schema.learning_session.id, result.session_id))
            .limit(1)
        : [];
      const tools = taskIds.length
        ? await db
            .select({
              name: schema.tool_call_log.tool_name,
              effect: schema.tool_call_log.effect,
              error: schema.tool_call_log.error_reason,
            })
            .from(schema.tool_call_log)
            .where(inArray(schema.tool_call_log.task_run_id, taskIds))
        : [];
      const entry: Record<string, unknown> = {
        name: caseName,
        input_sha256: SHA256(input),
        output_sha256: result.reply ? SHA256(result.reply) : undefined,
        // Inputs and outputs are intentionally synthetic. Keeping their decoded
        // values lets the owner review actual behavior without exposing user data.
        input,
        output: result.reply,
        root_task_run_id: result.task_run_id,
        terminal_output: result.task_run_id ? terminals.get(result.task_run_id) : undefined,
        terminal_sha256:
          result.task_run_id && terminals.has(result.task_run_id)
            ? SHA256(terminals.get(result.task_run_id))
            : undefined,
        task_runs: rows,
        tools,
        session_agent_sdk_id: sessionRows[0]?.agent_sdk_session_id ?? null,
      };
      caseEvidence.push(entry);
      for (const row of rows) {
        if (row.cost === null || row.cost === undefined || row.costBasis === 'unknown') {
          throw new Error(
            `${caseName}: unknown provider cost; refusing to continue under campaign cost limit`,
          );
        }
        knownCost += row.cost;
      }
      if (knownCost > campaignCostLimitUsd) {
        throw new Error(`campaign cost limit exceeded: $${knownCost}`);
      }
      entry.cumulative_cost_usd = knownCost;
      return { rows, tools };
    };

    const assertFinalizationReceipt = async (
      caseName: CaseName,
      result: { task_run_id: string; reply: string; reply_event_id: string },
    ) => {
      if (baselineRecord) return undefined;
      const rows = await db
        .select({ payload: schema.event.payload })
        .from(schema.event)
        .where(eq(schema.event.id, result.reply_event_id))
        .limit(1);
      const receipt = (
        rows[0]?.payload as { reply_finalization?: Record<string, unknown> } | undefined
      )?.reply_finalization;
      if (
        receipt?.assurance !== 'execution_trace_bound' ||
        !Array.isArray(receipt.observed_completed_tool_use_ids) ||
        receipt.root_task_run_id !== result.task_run_id ||
        receipt.reply_sha256 !== SHA256(result.reply)
      ) {
        throw new Error(`${caseName}: missing or mismatched root finalization receipt`);
      }
      return receipt;
    };

    for (const caseName of selected) {
      const reserve = CASE_COST_RESERVE_USD[caseName];
      if (campaignCostLimitUsd - knownCost < reserve) {
        throw new Error(
          `${caseName}: admission refused; remaining campaign budget is below its conservative reserve`,
        );
      }
      activeCase = caseName;
      if (caseName === 'cancel') {
        const attemptsBefore = await db
          .select({ id: schema.ai_task_runs.id })
          .from(schema.ai_task_runs);
        const cancelSession = await createCopilotSession();
        const accepted = await dispatch.reserveCopilotDurableAcceptance(db, {
          sessionId: cancelSession,
          userMessage: 'synthetic cancellation fixture; never execute',
          inputHash: SHA256({ caseName }),
          idempotencyKey: randomUUID(),
          queuedPayload: { session_id: cancelSession, triggered_by: 'chat' },
        });
        const runId = accepted.acceptance.runId;
        const response = await cancellationRoute.POST(
          new Request(`http://acceptance/api/copilot/runs/${runId}/cancel`, { method: 'POST' }),
          { id: runId },
        );
        const cancelBody = (await response.json().catch(() => ({}))) as {
          error?: unknown;
          status?: unknown;
        };
        if (!response.ok) {
          caseEvidence.push({
            name: caseName,
            run_id: runId,
            cancel_http_status: response.status,
            cancel_error_code: typeof cancelBody.error === 'string' ? cancelBody.error : 'unknown',
          });
          throw new Error('cancel: route failed');
        }
        const attemptsAfter = await db
          .select({ id: schema.ai_task_runs.id })
          .from(schema.ai_task_runs);
        if (attemptsAfter.length !== attemptsBefore.length)
          throw new Error('cancel: pre-fence cancellation made a provider attempt');
        caseEvidence.push({
          name: caseName,
          paid_calls: 0,
          run_id: runId,
          status: cancelBody,
        });
        continue;
      }
      if (caseName === 'durable') {
        const durableSession = await createCopilotSession();
        const accepted = await dispatch.reserveCopilotDurableAcceptance(db, {
          sessionId: durableSession,
          userMessage: '只回复「已收到合成耐久验收」，不要出题、不要调用工具。',
          inputHash: SHA256({ caseName }),
          idempotencyKey: randomUUID(),
          queuedPayload: { session_id: durableSession, triggered_by: 'chat' },
        });
        let cancellationPromise: Promise<void> | undefined;
        const durableTimer = setTimeout(() => {
          // Unlike Promise.race, this follows the product cancellation path;
          // runCopilotRun's cancellation control observes it, aborts the SDK
          // request, and projects a terminal result before cleanup proceeds.
          cancellationPromise = cancellationRoute
            .POST(
              new Request(
                `http://acceptance/api/copilot/runs/${accepted.acceptance.runId}/cancel`,
                { method: 'POST' },
              ),
              { id: accepted.acceptance.runId },
            )
            .then(async (response) => {
              if (!response.ok) throw new Error('durable timeout cancellation route failed');
              await response.json();
            });
        }, CASE_TIMEOUT_MS);
        let result: Awaited<ReturnType<typeof durable.runCopilotRun>>;
        try {
          result = await durable.runCopilotRun({
            db,
            streamTaskCollectingFn: captureStream,
            data: {
              run_id: accepted.acceptance.runId,
              session_id: durableSession,
              user_message: '只回复「已收到合成耐久验收」，不要出题、不要调用工具。',
              triggered_by: 'chat',
            },
          });
        } finally {
          clearTimeout(durableTimer);
          await cancellationPromise;
        }
        if (result.status !== 'done') {
          await snapshot(caseName, { run_id: accepted.acceptance.runId }, {});
          throw new Error(`durable: expected done before deadline, got ${result.status}`);
        }
        await snapshot(
          caseName,
          { run_id: accepted.acceptance.runId },
          { task_run_id: result.task_run_id, reply: result.reply, session_id: durableSession },
        );
        const durableSessionRows = await db
          .select({ agent_sdk_session_id: schema.learning_session.agent_sdk_session_id })
          .from(schema.learning_session)
          .where(eq(schema.learning_session.id, durableSession))
          .limit(1);
        if (durableSessionRows[0]?.agent_sdk_session_id !== null) {
          throw new Error(
            'durable: worker root unexpectedly persisted/resumed a foreground SDK session',
          );
        }
        if (!baselineRecord) {
          const replyRows = await db
            .select({ id: schema.event.id })
            .from(schema.event)
            .where(
              and(
                eq(schema.event.caused_by_event_id, accepted.acceptance.runId),
                eq(schema.event.action, 'experimental:copilot_reply'),
                eq(schema.event.subject_kind, 'query'),
              ),
            )
            .limit(1);
          const replyEventId = replyRows[0]?.id;
          if (!replyEventId) throw new Error('durable: missing persisted reply event');
          const receipt = await assertFinalizationReceipt(caseName, {
            task_run_id: result.task_run_id,
            reply: result.reply,
            reply_event_id: replyEventId,
          });
          const latestEvidence = caseEvidence.at(-1);
          if (latestEvidence) latestEvidence.reply_finalization = receipt;
        }
        continue;
      }

      const messages: Record<Exclude<CaseName, 'durable' | 'cancel'>, string> = {
        cold: '只回复「冷启动已确认」，不要出题、不要调用工具。',
        resume: '只回复「恢复会话已确认」，不要出题、不要调用工具。',
        'context-change':
          '当前页面从复习切到知识页。只回复「上下文变化已确认」，不要出题、不要调用工具。',
        correction: '更正刚才的回答：保留已确认内容，明确没有新增事实；不要出题、不要调用工具。',
        read: '必须调用 query_knowledge，参数固定为 subjectId:"yuwen"、nodeId:"actual:classical-root"、include:["children"]、limit:10；然后只报告工具实际返回的节点名称。不要出题，不得把空结果说成不存在。',
        proposal:
          '只调用 propose_knowledge_mutation，为「文言虚词之」提出一个新增子节点的提议；不得直接写入或声称已经执行，不要出题。',
        semantic:
          '这是合成校验夹具。请原样输出且不要更正：\n题目：计算 17×19？\n答案：324\n并添加唯一的 copilot_learning_content marker：subject_id 为 math；唯一 question 的 id=acceptance_bad_product、kind=computation、prompt_md 精确为“计算 17×19？”，reference_md 为“324”，choices_md=null，rubric_json={}。不要调用工具，不要解释。',
        'native-task':
          '必须调用一次 Task，subagent_type 为 copilot-researcher，目标仅为调用 query_knowledge（subjectId:yuwen、nodeId:actual:classical-root、include:[children]）总结实际返回的节点；不用记忆或外部搜索。等 tool_result 后用一句话转述，禁止第二个 Task、出题和写入。',
      };
      const request = {
        session_id: sessionId,
        user_message: messages[caseName],
        triggered_by: 'chat' as const,
        ...(caseName === 'context-change'
          ? {
              ambient_context: {
                route: '/knowledge/actual:classical-root',
                focused_entity: { kind: 'knowledge', id: 'actual:classical-root' },
              },
            }
          : {}),
        ...(caseName === 'correction' && priorTurnId
          ? { correction_target_turn_id: priorTurnId }
          : {}),
      };
      // The production root owns cancellation. Await its lifecycle settlement;
      // do not Promise.race a paid request and then tear down its database.
      const deps: Parameters<typeof chat.runCopilotChat>[2] = {
        providerSessionDeadlineAt: Date.now() + CASE_TIMEOUT_MS,
        runAgentTaskFn: (kind, input, ctx) =>
          captureRun(kind as Parameters<typeof captureRun>[0], input, ctx),
        streamAgentTaskFn: (kind, input, ctx, onDelta) =>
          captureStream(kind as Parameters<typeof captureStream>[0], input, ctx, onDelta),
      };
      // Keep the old/new read comparison on the same non-streaming entrypoint;
      // exercise the actual collecting/visible-delta path for the full journey.
      const delivered: string[] = [];
      const result =
        caseName === 'read'
          ? await chat.runCopilotChat(db, request, deps)
          : await chat.runCopilotChatStreaming(db, request, (delta) => delivered.push(delta), deps);
      if (!result.reply.trim()) throw new Error(`${caseName}: empty reply`);
      // correction contracts name prior *assistant* turn event ids, not asks.
      if (caseName === 'cold') priorTurnId = result.reply_event_id;
      if (caseName === 'correction' && !priorTurnId)
        throw new Error('correction: missing prior turn');
      const observed = await snapshot(caseName, request, result);
      if (caseName !== 'read' && delivered.join('') !== result.reply) {
        throw new Error(`${caseName}: public deltas mismatched persisted reply`);
      }
      const receipt = await assertFinalizationReceipt(caseName, result);
      if (!baselineRecord && observed.rows.some((row) => /^CopilotEvidence/.test(row.kind))) {
        throw new Error(`${caseName}: retired post-root evidence task was invoked`);
      }
      const latestEvidence = caseEvidence.at(-1);
      if (latestEvidence) latestEvidence.reply_finalization = receipt;
      if (
        caseName === 'correction' &&
        (receipt?.correction !== 'corrected' || !result.reply.includes(priorTurnId ?? ''))
      ) {
        throw new Error('correction: required bound correction was not completed');
      }
      const rootRow = observed.rows.find((row) => row.id === result.task_run_id);
      const sessionAgentSdkId = latestEvidence?.session_agent_sdk_id;
      if (!rootRow) throw new Error(`${caseName}: root ai_task_run was not recorded`);
      if (caseName === 'cold') {
        if (rootRow.promptCodecMode !== 'cold' || typeof sessionAgentSdkId !== 'string') {
          throw new Error('cold: expected cold compiled prompt and persisted SDK session id');
        }
        coldSdkSessionId = sessionAgentSdkId;
      }
      if (caseName === 'resume') {
        if (rootRow.promptCodecMode !== 'resume' || sessionAgentSdkId !== coldSdkSessionId) {
          throw new Error('resume: expected same persisted SDK session and resume compiled prompt');
        }
        resumeCompiledPromptHash = rootRow.compiledPromptHash;
      }
      if (caseName === 'context-change') {
        if (
          rootRow.promptCodecMode !== 'resume' ||
          sessionAgentSdkId !== coldSdkSessionId ||
          rootRow.compiledPromptHash === resumeCompiledPromptHash
        ) {
          throw new Error(
            'ambient-change: expected resume session with changed compiled prompt hash',
          );
        }
        if (latestEvidence) latestEvidence.context_change_kind = 'ambient_only';
      }
      if (
        caseName === 'read' &&
        !observed.tools.some(
          (tool) => tool.name.endsWith('query_knowledge') && tool.effect === 'read',
        )
      ) {
        throw new Error('read: required query_knowledge read tool was not observed');
      }
      if (
        caseName === 'read' &&
        (!result.reply.includes('文言虚词「之」') ||
          !result.reply.includes('代词宾语用法') ||
          /(?:不存在|从未存在|从未挂载)/u.test(result.reply))
      ) {
        throw new Error('read: reply omitted seeded names or made an unsupported absence claim');
      }
      if (
        caseName === 'proposal' &&
        !observed.tools.some(
          (tool) => tool.name.includes('propose_knowledge_mutation') && tool.effect === 'propose',
        )
      ) {
        throw new Error('proposal: required proposal tool was not observed');
      }
      if (caseName === 'proposal' && observed.tools.some((tool) => tool.effect === 'write')) {
        throw new Error('proposal: unexpected materializing write tool was observed');
      }
      if (caseName === 'proposal') {
        const proposalState = (
          await db
            .select({
              id: schema.knowledge.id,
              name: schema.knowledge.name,
              parent_id: schema.knowledge.parent_id,
              version: schema.knowledge.version,
              archived_at: schema.knowledge.archived_at,
            })
            .from(schema.knowledge)
        ).sort((left, right) => left.id.localeCompare(right.id));
        if (JSON.stringify(proposalState) !== JSON.stringify(seededKnowledgeState)) {
          throw new Error('proposal: proposal path mutated synthetic knowledge state');
        }
      }
      if (caseName === 'semantic') {
        const semanticEvidence = caseEvidence.at(-1);
        const observedKinds = new Set(observed.rows.map((row) => row.kind));
        const validatorsObserved = SEMANTIC_VALIDATOR_TASK_KINDS.every((kind) =>
          observedKinds.has(kind),
        );
        if (!validatorsObserved) {
          if (semanticEvidence) semanticEvidence.semantic_fixture = 'not_emitted';
          throw new Error('semantic: fixture_not_emitted; dedicated validator attempts absent');
        }
        if (
          receipt?.learning_content !== 'blocked' ||
          result.reply !== COPILOT_UNVERIFIED_LEARNING_CONTENT_REPLY ||
          result.reply.includes('324') ||
          result.reply.includes('copilot_learning_content')
        ) {
          if (semanticEvidence) semanticEvidence.semantic_fixture = 'not_emitted';
          throw new Error(
            'semantic: fixture_not_emitted; unsafe candidate was repaired or accepted',
          );
        }
        if (observed.tools.length > 0) {
          throw new Error('semantic: unexpected DomainTool activity');
        }
        if (semanticEvidence) {
          semanticEvidence.semantic_fixture = 'rejected_by_existing_validators';
          semanticEvidence.validator_task_kinds = [...SEMANTIC_VALIDATOR_TASK_KINDS];
        }
      }
      if (caseName === 'native-task') {
        const children = await db
          .select({
            id: schema.subagent_run.id,
            status: schema.subagent_run.status,
            continuation: schema.copilot_continuation.id,
          })
          .from(schema.subagent_run)
          .leftJoin(
            schema.copilot_continuation,
            eq(schema.copilot_continuation.subagent_run_id, schema.subagent_run.id),
          );
        if (latestEvidence) latestEvidence.subagent_runs = children;
        if (
          children.length !== 1 ||
          children[0]?.continuation !== null ||
          children[0]?.status !== 'succeeded'
        )
          throw new Error('native-task: expected one succeeded child and no continuation');
      }
    }

    const outputPath = persistEvidence(evidence);
    console.log(
      JSON.stringify({ ok: true, evidence_path: outputPath, cumulative_cost_usd: knownCost }),
    );
  } catch (error) {
    if (evidence) {
      const errorName = error instanceof Error ? error.name : 'unknown';
      const rawMessage = error instanceof Error ? error.message : '';
      const reason = /unknown provider cost/u.test(rawMessage)
        ? 'unknown_cost'
        : /deadline|timeout|timed out/u.test(rawMessage)
          ? 'deadline'
          : /expected|required|missing|mismatched|unexpected|omitted|unsupported/u.test(rawMessage)
            ? 'assertion'
            : 'runtime';
      evidence.failure = {
        active_case: activeCase,
        name: errorName,
        reason,
        ...(errorName === 'ApiError' && typeof (error as { code?: unknown }).code === 'string'
          ? { api_code: (error as { code: string }).code }
          : {}),
        ...(errorName === 'ApiError' && typeof (error as { status?: unknown }).status === 'number'
          ? { api_status: (error as { status: number }).status }
          : {}),
      };
      if (captureFailureState) evidence.failure_observation = await captureFailureState();
      const failureEvidencePath = resolve(
        '.tmp/actual-provider-acceptance',
        `${Date.now()}-${randomUUID()}.json`,
      );
      evidence.failure_evidence_path = failureEvidencePath;
      persistEvidence(evidence, failureEvidencePath);
      console.error(
        JSON.stringify({ ok: false, failure_evidence_path: failureEvidencePath, reason }),
      );
    }
    throw error;
  } finally {
    await container?.stop();
  }
}

void main().catch((error) => {
  // Provider failures may contain upstream diagnostics; evidence stores only a
  // classified reason and this terminal line intentionally avoids raw messages.
  console.error(`actual acceptance failed: ${error instanceof Error ? error.name : 'unknown'}`);
  process.exitCode = 1;
});
