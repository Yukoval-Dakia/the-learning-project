/**
 * Bounded, opt-in actual-provider acceptance for the Copilot root.
 *
 * This is deliberately a script rather than a Vitest suite: it starts a private
 * pgvector container, makes paid calls only behind ACTUAL_PROVIDER_ACCEPTANCE=1,
 * and leaves a redacted synthetic evidence record for human review. It is not a
 * production smoke test, queue E2E, or semantic-quality oracle.
 *
 * Examples (the named env file is read without printing its values):
 *   ACTUAL_PROVIDER_ENV_FILE=/path/to/.env.local pnpm acceptance:ai-pipeline --preflight
 *   ACTUAL_PROVIDER_ACCEPTANCE=1 ACTUAL_PROVIDER_ENV_FILE=/path/to/.env.local \
 *     pnpm acceptance:ai-pipeline --case read --baseline-record
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
];
const COST_CEILING_USD = 2;
const CASE_TIMEOUT_MS = 90_000;
const SHA256 = (value: unknown) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
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
  return file;
}

function preflight(): void {
  const source = loadProviderEnv();
  const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (docker.status !== 0) throw new Error('docker version preflight failed');
  console.log(
    JSON.stringify({
      ok: true,
      mode: 'preflight',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      credential_source: source,
      docker_server: docker.stdout.trim(),
      paid_calls: false,
    }),
  );
}

async function withTimeout<T>(label: string, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${CASE_TIMEOUT_MS}ms`)),
          CASE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function persistEvidence(evidence: Record<string, unknown>): string {
  const outputDir = resolve('.tmp/actual-provider-acceptance');
  mkdirSync(outputDir, { recursive: true });
  const outputPath = resolve(outputDir, `${Date.now()}-${randomUUID()}.json`);
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
  return outputPath;
}

async function main(): Promise<void> {
  if (process.argv.includes('--preflight')) return preflight();
  if (process.env.ACTUAL_PROVIDER_ACCEPTANCE !== '1') {
    throw new Error('ACTUAL_PROVIDER_ACCEPTANCE=1 is required before any provider call');
  }
  const source = loadProviderEnv();
  const requested = arg('--case');
  if (requested && !CASES.includes(requested as CaseName)) {
    throw new Error(`unknown --case ${requested}; expected ${CASES.join(', ')}`);
  }
  const selected = requested ? [requested as CaseName] : [...CASES];
  const baselineRecord = process.argv.includes('--baseline-record');
  if (baselineRecord && selected.length !== 1) {
    throw new Error('--baseline-record is intentionally limited to one --case invocation');
  }

  let container: StartedPostgreSqlContainer | undefined;
  let evidence: Record<string, unknown> | undefined;
  try {
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
    const [{ db }, schema, chat, durable, dispatch, cancellationRoute] = await Promise.all([
      import('@/db/client'),
      import('@/db/schema'),
      import('@/capabilities/copilot/server/chat'),
      import('@/capabilities/copilot/jobs/copilot_run'),
      import('@/capabilities/copilot/server/durable-dispatch'),
      import('@/capabilities/copilot/api/cancel-run'),
    ]);
    const { and, eq, inArray } = await import('drizzle-orm');
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

    const caseEvidence: Array<Record<string, unknown>> = [];
    evidence = {
      protocol_version: 1,
      exact_head: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
      dirty_diff_sha256: SHA256(
        spawnSync('git', ['diff', '--binary', 'HEAD'], { encoding: 'utf8' }).stdout,
      ),
      harness_sha256: SHA256(readFileSync(new URL(import.meta.url), 'utf8')),
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      credential_source: source,
      baseline_record: baselineRecord,
      cases: caseEvidence,
      limitations: [
        'direct durable handler is not pg-boss queue E2E',
        'structural assertions do not establish factual entailment or semantic correctness',
      ],
    };
    let knownCost = 0;
    const observedTaskRunIds = new Set<string>();
    const sessionId = `actual_acceptance_${randomUUID()}`;
    let priorTurnId: string | undefined;

    const snapshot = async (
      caseName: CaseName,
      input: unknown,
      result: { task_run_id?: string; reply?: string },
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
        })
        .from(schema.ai_task_runs);
      const rows = allRows.filter((row) => !observedTaskRunIds.has(row.id));
      for (const row of rows) observedTaskRunIds.add(row.id);
      const taskIds = rows.map((row) => row.id);
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
        task_runs: rows,
        tools,
      };
      caseEvidence.push(entry);
      for (const row of rows) {
        if (row.cost === null || row.cost === undefined || row.costBasis === 'unknown') {
          throw new Error(
            `${caseName}: unknown provider cost; refusing to continue under $${COST_CEILING_USD} ceiling`,
          );
        }
        knownCost += row.cost;
      }
      if (knownCost > COST_CEILING_USD) throw new Error(`cost ceiling exceeded: $${knownCost}`);
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
        !receipt ||
        receipt.root_task_run_id !== result.task_run_id ||
        receipt.reply_sha256 !== SHA256(result.reply)
      ) {
        throw new Error(`${caseName}: missing or mismatched root finalization receipt`);
      }
      return receipt;
    };

    for (const caseName of selected) {
      if (caseName === 'cancel') {
        const attemptsBefore = await db
          .select({ id: schema.ai_task_runs.id })
          .from(schema.ai_task_runs);
        const accepted = await dispatch.reserveCopilotDurableAcceptance(db, {
          sessionId: `${sessionId}_cancel`,
          userMessage: 'synthetic cancellation fixture; never execute',
          inputHash: SHA256({ caseName }),
          idempotencyKey: randomUUID(),
          queuedPayload: { session_id: `${sessionId}_cancel`, triggered_by: 'chat' },
        });
        const runId = accepted.acceptance.runId;
        const response = await cancellationRoute.POST(
          new Request(`http://acceptance/api/copilot/runs/${runId}/cancel`, { method: 'POST' }),
          { id: runId },
        );
        if (!response.ok) throw new Error('cancel: route failed');
        const attemptsAfter = await db
          .select({ id: schema.ai_task_runs.id })
          .from(schema.ai_task_runs);
        if (attemptsAfter.length !== attemptsBefore.length)
          throw new Error('cancel: pre-fence cancellation made a provider attempt');
        caseEvidence.push({
          name: caseName,
          paid_calls: 0,
          run_id: runId,
          status: await response.json(),
        });
        continue;
      }
      if (caseName === 'durable') {
        const durableSession = `${sessionId}_durable`;
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
          { task_run_id: result.task_run_id, reply: result.reply },
        );
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
        read: '必须调用 query_knowledge 查询「文言虚词之」，然后只报告工具返回的节点名称；不要出题，不得把空结果说成不存在。',
        proposal:
          '只调用 propose_knowledge_mutation，为「文言虚词之」提出一个新增子节点的提议；不得直接写入或声称已经执行，不要出题。',
        'native-task':
          '必须调用一次 Task，subagent_type 为 copilot-researcher，目标是只读总结「文言虚词之」；等 tool_result 后用一句话转述，禁止第二个 Task、出题和写入。',
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
      // The production root owns cancellation; this absolute session deadline is
      // passed through its existing dependency seam rather than relying only on
      // Promise.race (which would abandon a still-paid remote request).
      const result = await withTimeout(
        caseName,
        chat.runCopilotChat(db, request, {
          providerSessionDeadlineAt: Date.now() + CASE_TIMEOUT_MS,
        }),
      );
      if (!result.reply.trim()) throw new Error(`${caseName}: empty reply`);
      // correction contracts name prior *assistant* turn event ids, not asks.
      if (caseName === 'cold') priorTurnId = result.reply_event_id;
      if (caseName === 'correction' && !priorTurnId)
        throw new Error('correction: missing prior turn');
      const observed = await snapshot(caseName, request, result);
      const receipt = await assertFinalizationReceipt(caseName, result);
      if (!baselineRecord && observed.rows.some((row) => /^CopilotEvidence/.test(row.kind))) {
        throw new Error(`${caseName}: retired post-root evidence task was invoked`);
      }
      const latestEvidence = caseEvidence.at(-1);
      if (latestEvidence) latestEvidence.reply_finalization = receipt;
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
        const knowledgeAfter = await db.select({ id: schema.knowledge.id }).from(schema.knowledge);
        const actualIds = knowledgeAfter.map((row) => row.id).sort();
        const expectedIds = ['actual:classical-object', 'actual:classical-root'];
        if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
          throw new Error('proposal: proposal path mutated synthetic knowledge state');
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
        if (children.length !== 1 || children[0]?.continuation !== null)
          throw new Error('native-task: expected one child and no continuation');
      }
    }

    const outputPath = persistEvidence(evidence);
    console.log(
      JSON.stringify({ ok: true, evidence_path: outputPath, cumulative_cost_usd: knownCost }),
    );
  } catch (error) {
    if (evidence) {
      evidence.failure = {
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      };
      evidence.failure_evidence_path = persistEvidence(evidence);
    }
    throw error;
  } finally {
    await container?.stop();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
