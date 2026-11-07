// YUK-2030 attempt_3 acceptance — TEMPORARY probe, not committed.
//
// Same harness as the stub run, but the member hits the REAL OpenDesign
// route. 500 → provider_wait → rearm; whatever the route answers at each
// redelivery is what the node settles on. Nothing simulated.
import { setTimeout as sleep } from 'node:timers/promises';

const MEMBER = 'yuk2030_probe';
const RUN_DATE = '2099-01-01';
const KIND = 'QuestionAdmissionSolveTask';
const ROUTE_URL = 'https://amr-link.open-design.ai/v1/chat/completions';

const { resolveLocalDbTarget } = await import('./local-db-env');
const t = resolveLocalDbTarget();
process.env.DATABASE_URL ??= `postgres://${t.user}:${t.password}@${t.host}:${t.port}/${t.database}`;
process.env.AI_PROVIDER_OVERRIDE ??= 'custom:opendesign';
process.env.AI_PROVIDER_MODEL ??= 'deepseek-v4.1-flash';

const { db } = await import('@/db/client');
const { and, eq } = await import('drizzle-orm');
const { AgentRunError } = await import('@/ai/agent-run-error');
const { buildJobDag } = await import('@/kernel/job-dag');
const { hydrateConfigFromDb } = await import('@/core/config/server/hydrate');
const { hydrateModelCatalog } = await import('@/server/ai/model-catalog');
const { hydrateCustomProviders } = await import('@/core/config/server/custom-providers-hydrate');
const { createBudgetedProviderFetch } = await import('@/server/ai/provider-transport');
const { planJobProviderWaitForRun, providerWaitOutput } = await import('@/server/ai/provider-wait');
const { createRunLifecycle } = await import('@/server/ai/run-lifecycle');
const { ai_task_runs, dag_orchestration_node, dag_orchestration_run } = await import('@/db/schema');
const { ORCHESTRATOR_QUEUE } = await import('@/server/orchestration/constants');
const { runOrchestratorStart, runOrchestratorTick } = await import(
  '@/server/orchestration/orchestrator'
);
const { toOrchestratorBoss } = await import('@/server/orchestration/register');
const { PgBoss } = await import('pg-boss');

const apiKey = process.env.OPENDESIGN_API_KEY;
if (!apiKey) throw new Error('OPENDESIGN_API_KEY not in env — source dev-secrets.env first');

const out = (ev: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ ev, t: new Date().toISOString(), ...data }));

// ── member handler: real wire → real OpenDesign ─────────────────────────────
const handler = async (): Promise<Record<string, unknown>> => {
  const lifecycle = createRunLifecycle({
    db,
    kind: KIND,
    timeoutMs: 30_000,
    logScope: 'yuk2030-acc',
  });
  try {
    await lifecycle.start({ probe: 'yuk2030' });
    lifecycle.transportEvidence.noteFetchLoop('root');
    const wire = createBudgetedProviderFetch({
      httpTimeoutMs: 15_000,
      secrets: [apiKey],
      collector: lifecycle.transportEvidence,
    });
    let status = 0;
    let body = '';
    try {
      const res = await wire.fetch(ROUTE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'deepseek-v4.1-flash',
          messages: [{ role: 'user', content: 'reply ok' }],
          max_tokens: 4,
        }),
      });
      status = res.status;
      body = (await res.text()).slice(0, 200);
    } finally {
      await wire.close();
    }
    if (status < 400) {
      out('member_ok', { http_status: status, run: lifecycle.taskRunId });
      // No SDK terminal exists in this wire-level probe; settle the row honestly.
      await db
        .update(ai_task_runs)
        .set({ status: 'success', finished_at: new Date() })
        .where(eq(ai_task_runs.id, lifecycle.taskRunId));
      return { ok: true, http_status: status };
    }
    out('member_rejected', { http_status: status, run: lifecycle.taskRunId });
    const err = new AgentRunError({
      kind: KIND,
      taskRunId: lifecycle.taskRunId,
      subtype: 'api_error_result',
      apiErrorStatus: status,
      errors: [body],
      providerFailure: { http_status: status },
    });
    await lifecycle.finishFailure(err);
    const plan = await planJobProviderWaitForRun(db, lifecycle.taskRunId, {
      errorEvidence: [body],
    });
    if (plan === null)
      return {
        ok: false,
        not_wait_eligible: true,
        http_status: status,
        task_run_id: lifecycle.taskRunId,
      };
    out('member_wait_decision', {
      run: lifecycle.taskRunId,
      class: plan.retryClass,
      http_status: status,
    });
    return providerWaitOutput({ retryClass: plan.retryClass, detail: `ev=${plan.evidenceRef}` });
  } finally {
    lifecycle.dispose();
  }
};

// ── boot ────────────────────────────────────────────────────────────────────
await hydrateConfigFromDb(db);
await hydrateModelCatalog(db);
await hydrateCustomProviders(db);
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  schema: 'pgboss',
  schedule: false,
  supervise: false,
  migrate: true,
});
await boss.start();
await boss.createQueue(MEMBER);
await boss.createQueue(ORCHESTRATOR_QUEUE);
await boss.work(MEMBER, async () => handler());
const oboss = toOrchestratorBoss(boss);
const dag = buildJobDag([{ name: MEMBER, owner: 'probe', dependsOn: [] }]);

const run = await runOrchestratorStart(
  { db, boss: oboss, dag, now: new Date(), localDate: () => RUN_DATE },
  'manual',
);
if (!run) throw new Error('start returned null');
out('run_started', { run_id: run.id });

const node = () =>
  db
    .select()
    .from(dag_orchestration_node)
    .where(
      and(eq(dag_orchestration_node.run_id, run.id), eq(dag_orchestration_node.job_name, MEMBER)),
    )
    .then((r) => r[0]);

// Drive ticks until the node settles (or 40min cap — waits 1..N all logged).
const deadline = Date.now() + 40 * 60_000;
let lastSeen = '';
while (Date.now() < deadline) {
  await runOrchestratorTick({ db, boss: oboss, dag, now: new Date(), localDate: () => RUN_DATE });
  const n = await node();
  const sig = `${n?.status}|waits=${n?.provider_waits}|job=${n?.boss_job_id}`;
  if (sig !== lastSeen) {
    lastSeen = sig;
    out('node_state', {
      status: n?.status,
      provider_waits: n?.provider_waits,
      boss_job_id: n?.boss_job_id,
      detail: n?.detail,
      enqueued_at: n?.enqueued_at,
    });
  }
  if (n?.status === 'succeeded' || n?.status === 'failed') break;
  await sleep(10_000);
}

const finalNode = await node();
const finalRun = (
  await db.select().from(dag_orchestration_run).where(eq(dag_orchestration_run.id, run.id))
)[0];
const runRows = await db
  .select({
    id: ai_task_runs.id,
    status: ai_task_runs.status,
    cost_usd: ai_task_runs.cost_usd,
    cost_basis: ai_task_runs.cost_basis,
    cost_ref: ai_task_runs.cost_ref,
  })
  .from(ai_task_runs);
out('final', {
  node: {
    status: finalNode?.status,
    provider_waits: finalNode?.provider_waits,
    detail: finalNode?.detail,
  },
  run_status: finalRun?.status,
  task_runs: runRows.map((r) => ({
    id: r.id,
    status: r.status,
    cost_usd: r.cost_usd,
    cost_basis: r.cost_basis,
    unbilled: r.cost_ref?.startsWith('unbilled-provider-rejection:') ?? false,
  })),
});

await boss.stop({ graceful: true });
process.exit(0);
