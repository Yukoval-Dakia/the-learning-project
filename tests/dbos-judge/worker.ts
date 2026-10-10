import { AsyncLocalStorage } from 'node:async_hooks';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { agentLoop } from '@earendil-works/pi-agent-core';
import { type Model, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { z } from 'zod';
import { setJudgeProcessObserverForTests } from '@/capabilities/practice/server/judge-process-observer';
import { enqueueJudgeRun } from '@/capabilities/practice/server/judge-run-dispatch';
import { readJudgeRunPermanent } from '@/capabilities/practice/server/judge-run-observation';
import { JudgeWorkflowInput } from '@/core/schema/event/judge-operational-events';
import { JudgePendingAttemptPayload } from '@/core/schema/event/judge-pending-events';
import * as schema from '@/db/schema';
import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { registerJudgeWorkflows } from '@/server/durable/judge-worker';
import { PRUNE_DBOS_SCHEMA } from '@/server/durable/prune-family';
import { startDurableWorker, stopDurableWorker } from '@/server/durable/prune-worker';
import { fixtureErrorMessage } from '../dbos-review-orphan/fixture-process';

let stage = 'preflight';
const secrets = [process.env.DATABASE_URL ?? ''];
const report = (value: unknown) => process.send?.(value);
async function main() {
  const url = new URL(z.url().parse(process.env.DATABASE_URL)),
    wire = new URL(z.url().parse(process.env.TLP_JUDGE_WIRE_URL));
  if (
    process.env.TLP_JUDGE_TEST_PROCESS !== '1' ||
    !/^\/test_fork_\d+$/.test(url.pathname) ||
    ![url.hostname, wire.hostname].every((host) =>
      ['localhost', '127.0.0.1', '[::1]'].includes(host),
    )
  )
    throw new Error('Disposable local judge fixture required');
  secrets.push(url.password, decodeURIComponent(url.password));
  const input = JudgeWorkflowInput.parse(JSON.parse(z.string().parse(process.env.TLP_JUDGE_INPUT)));
  const reconcileInput = process.env.TLP_JUDGE_RECONCILE
    ? z
        .object({ scheduledAt: z.coerce.date(), authorizationAt: z.coerce.date() })
        .parse(JSON.parse(process.env.TLP_JUDGE_RECONCILE))
    : null;
  const models = builtinModels();
  const model: Model<'openai-completions'> = {
    id: 'gpt-4.1-mini',
    name: 'Controlled judge',
    provider: 'openai',
    api: 'openai-completions',
    baseUrl: wire.toString(),
    reasoning: false,
    input: ['text'],
    contextWindow: 100000,
    maxTokens: 1000,
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  };
  models.setProvider(
    createProvider({
      id: model.provider,
      name: model.name,
      baseUrl: model.baseUrl,
      auth: { apiKey: envApiKeyAuth('OpenAI API key', ['OPENAI_API_KEY']) },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  const fetch = globalThis.fetch;
  const transportObservers = new Set<Promise<void>>();
  globalThis.fetch = async (resource, init) => {
    const target = new URL(
      typeof resource === 'string'
        ? resource
        : resource instanceof URL
          ? resource.href
          : resource.url,
    );
    if (target.origin !== wire.origin) throw new Error('Fixture blocked non-observer egress');
    const response = await fetch(resource, init);
    const mode = response.headers.get('x-controlled-mode');
    if (process.env.TLP_JUDGE_OBSERVE_TRANSPORT === '1' && mode && mode !== 'valid') {
      // Observe a clone; the installed Pi driver consumes the original response unchanged.
      const observation = (async () => {
        let body = '';
        try {
          const reader = response.clone().body?.getReader();
          if (!reader) throw new Error('Controlled response has no body');
          const decoder = new TextDecoder();
          let partialReported = false;
          try {
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) break;
              body += decoder.decode(chunk.value, { stream: true });
              if (mode === 'partial-break' && !partialReported && body.endsWith('\n\n')) {
                partialReported = true;
                report({ kind: 'transport-partial', mode, body, status: response.status });
              }
            }
            body += decoder.decode();
            report({ kind: 'transport-complete', mode, body, status: response.status });
          } finally {
            reader.releaseLock();
          }
        } catch (error) {
          report({ kind: 'transport-error', mode, body, error: String(error) });
        }
      })();
      transportObservers.add(observation);
      void observation.finally(() => transportObservers.delete(observation));
    }
    return response;
  };
  // Pi 1.0 dispatches through the registered provider, not model.api alone.
  // Register the installed Completions transport for this loopback SSE fixture.
  // Production runner, installed Pi transport,
  // unit claim/result, native scorer, activation, settlement, workflow and host remain real.
  __setPiAdapterForTests(new PiAgentAdapter({ models, agentLoop }));
  const actions = new AsyncLocalStorage<Set<string>>(),
    holds = new Set<() => void>();
  let paused = false;
  const pause = async (boundary: string) => {
    if (paused || process.env.TLP_JUDGE_PAUSE_AT !== boundary) return;
    paused = true;
    report({
      kind: 'boundary',
      boundary,
      pid: process.pid,
      workflowId: DBOS.workflowID ?? input.delivery_id,
      at: new Date().toISOString(),
    });
    await new Promise<void>((resolve) => holds.add(resolve));
  };
  setJudgeProcessObserverForTests(async (event) => {
    if (
      process.env.TLP_JUDGE_PAUSE_UNIT &&
      !event.unitId?.endsWith(process.env.TLP_JUDGE_PAUSE_UNIT)
    )
      return;
    await pause(event.kind);
  });
  const client = postgres(url.toString(), {
    max: 6,
    debug: (_connection, query, parameters) => {
      const labels = actions.getStore();
      if (query.startsWith('insert into "event"'))
        for (const parameter of parameters) {
          if (parameter === 'experimental:assessment_activation')
            labels?.add('activation-committed');
        }
      if (
        process.env.TLP_JUDGE_PAUSE_AT === 'settlement-uncommitted' &&
        query.toUpperCase() === 'COMMIT' &&
        labels?.has('activation-committed')
      ) {
        report({
          kind: 'boundary',
          boundary: 'settlement-uncommitted',
          pid: process.pid,
          workflowId: input.delivery_id,
        });
        process.kill(process.pid, 'SIGSTOP');
      }
    },
  });
  const database = drizzle(client, { schema }),
    transaction = database.transaction.bind(database);
  database.transaction = (body, config) =>
    actions.run(new Set<string>(), () =>
      transaction(body, config).then(async (result) => {
        return result;
      }),
    );
  const boss = new PgBoss({
    connectionString: url.toString(),
    max: 2,
    supervise: false,
    schedule: false,
  });
  boss.on('error', (error) => report({ kind: 'boss-error', error: String(error) }));
  const declarations = {
    pruneEvents: {
      name: 'prune_job_events',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: '0 4 * * *', tz: 'Asia/Shanghai' },
    },
    reviewOrphans: {
      name: 'prune_orphan_review_sessions',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: '15 4 * * *', tz: 'Asia/Shanghai' },
    },
    conversationOrphans: {
      name: 'prune_orphan_conversation_sessions',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: '25 4 * * *', tz: 'Asia/Shanghai' },
    },
    placementOrphans: {
      name: 'prune_orphan_placement_sessions',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: '35 4 * * *', tz: 'Asia/Shanghai' },
    },
    judgeRun: { name: 'judge_run', backend: 'dbos', queue: 'llm' },
    judgeReconcile: {
      name: 'judge_pending_reconcile',
      backend: 'dbos',
      queue: 'fast',
      schedule: { cron: '50 * * * *', tz: 'Asia/Shanghai' },
    },
  } satisfies Parameters<typeof startDurableWorker>[0]['declarations'];
  const stop = async () => {
    if (reconcileInput) await DBOS.shutdown();
    else {
      await stopDurableWorker();
      await boss.stop();
    }
    await client.end();
    await Promise.all(transportObservers);
    __setPiAdapterForTests(undefined);
  };
  process.on('message', (raw) => {
    const command = z.object({ kind: z.enum(['release', 'stop']) }).parse(raw);
    if (command.kind === 'release') {
      for (const release of holds) release();
      holds.clear();
      report({ kind: 'ack' });
    } else
      void stop()
        .then(() => process.exit(0))
        .catch((error) => {
          report({ kind: 'failure', error: String(error) });
          process.exit(1);
        });
  });
  try {
    if (reconcileInput) {
      stage = 'registered-reconcile-start';
      const workflows = registerJudgeWorkflows(database, async (event) => pause(event.kind), {
        authorizationClock: () => {
          if (!paused && process.env.TLP_JUDGE_PAUSE_AT === 'authorization-clock') {
            paused = true;
            report({
              kind: 'boundary',
              boundary: 'authorization-clock',
              pid: process.pid,
              workflowId: DBOS.workflowID,
              at: new Date().toISOString(),
            });
            // The immutable sweep is committed; R and the fresh permanent re-read precede this call.
            // SIGKILL now rolls back this admission transaction without saving the DBOS step.
            process.kill(process.pid, 'SIGSTOP');
          }
          return reconcileInput.authorizationAt;
        },
      });
      DBOS.setConfig({
        name: 'tlp-housekeeping',
        systemDatabaseUrl: url.toString(),
        systemDatabaseSchemaName: PRUNE_DBOS_SCHEMA,
        executorID: 'local',
        applicationVersion: 'prune-v1',
        systemDatabasePoolSize: 3,
        enableOTLP: false,
        tracingEnabled: false,
      });
      await DBOS.launch();
      const workflowId = `sched-judge_pending_reconcile-${reconcileInput.scheduledAt.toISOString()}`;
      report({ kind: 'ready', pid: process.pid, workflowId, node: process.version });
      if (process.env.TLP_JUDGE_RECOVER !== '1')
        await DBOS.startWorkflow(workflows.reconcile, { workflowID: workflowId })(
          reconcileInput.scheduledAt,
          {},
        );
      const handle = DBOS.retrieveWorkflow(workflowId);
      await handle.getResult();
      report({
        kind: 'done',
        status: await handle.getStatus(),
        steps: await DBOS.listWorkflowSteps(workflowId),
        permanent: await readJudgeRunPermanent(database, input.run_id),
      });
      return;
    }
    stage = 'host-start';
    await boss.start();
    await startDurableWorker({
      boss,
      db: database,
      declarations,
      reconcileIntervalMs: 100,
      judgeBoundary: async (event) => pause(event.kind),
    });
    report({
      kind: 'ready',
      pid: process.pid,
      workflowId: input.delivery_id,
      node: process.version,
    });
    if (process.env.TLP_JUDGE_RECOVER !== '1') {
      stage = 'fixed-id-send';
      const state = await readJudgeRunPermanent(database, input.run_id);
      if (state.kind !== 'pending' || !state.delivery)
        throw new Error('Fixture delivery is not pending');
      const payload = JudgePendingAttemptPayload.parse(state.pending.payload);
      if (payload.caller !== 'native_assessment')
        throw new Error('Fixture requires native pending');
      const send = state.delivery.sends.at(-1);
      if (!send) throw new Error('Fixture retained send missing');
      await enqueueJudgeRun(
        { run_id: input.run_id, caller: 'native_assessment', submit: payload.submit },
        {},
        {
          authorization: {
            database,
            reservation: state.delivery.reservation,
            sendId: `evt_judge_send_${(await import('@/core/migration/canonical')).canonicalHash([input.reservation_id, send.send_no])}`,
          },
        },
      );
    }
    stage = 'workflow-result';
    const handle = DBOS.retrieveWorkflow(input.delivery_id);
    await handle.getResult();
    report({
      kind: 'done',
      status: await handle.getStatus(),
      steps: await DBOS.listWorkflowSteps(input.delivery_id),
      permanent: await readJudgeRunPermanent(database, input.run_id),
    });
  } catch (error) {
    report(
      fixtureErrorMessage({
        kind: 'failure',
        error,
        pid: process.pid,
        stage,
        requestId: input.delivery_id,
        secrets,
      }),
    );
    await stop();
    process.exit(1);
  }
}
main().catch((error) => {
  report(fixtureErrorMessage({ kind: 'failure', error, pid: process.pid, stage, secrets }));
  process.exit(1);
});
