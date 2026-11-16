import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { setConfigs } from '@/server/config/write';
import { devDatabaseName } from '../scripts/dev-worktree-db';

const root = '/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1854/recheck-2515';
const expectedDb = devDatabaseName();
const url = new URL(process.env.DATABASE_URL!);
if (url.hostname !== '127.0.0.1' || url.port !== '5434' || url.pathname !== `/${expectedDb}`)
  throw new Error('Refusing non-owned dev database');
const samplesFile = process.env.SAMPLES_FILE ?? `${root}/acceptance-samples.json`;
const resultsFile = process.env.RESULTS_FILE ?? `${root}/acceptance-results.json`;
const preStopUsd = Number(process.env.PRE_STOP_USD ?? '0.04');
const postStopUsd = Number(process.env.POST_STOP_USD ?? '0.045');
const kcPrefix = process.env.KC_PREFIX ?? 'yuk1854r2515-kc-';
const acceptanceTag = process.env.ACCEPTANCE_TAG ?? 'yuk1854-recheck-2515';
const rows = JSON.parse(readFileSync(samplesFile, 'utf8'));
const config = JSON.parse(readFileSync(`${root}/task-configuration.json`, 'utf8'));
const ADMISSION_KINDS = ['QuestionAdmissionSolveTask', 'QuestionAdmissionAdjudicateTask'];
await setConfigs(
  ADMISSION_KINDS.flatMap((kind) => [
    { key: `task.${kind}.provider`, value: config.provider },
    { key: `task.${kind}.model`, value: config.model },
    { key: `task.${kind}.override_global_pin`, value: true },
    { key: `task.${kind}.reasoning`, value: config.reasoning },
    { key: `task.${kind}.budget`, value: config.budget },
  ]),
  { actor: 'cli', note: 'YUK-1854 recheck-2515 public fixture acceptance; Flash sample only' },
  db,
);
await delay(15000);
// Pre-flight task resolution print over the real admin read face, sealed before
// the first paid send. The admission coordinator fences runs to these two kinds
// (question_admission_run.ts rejects any other kind), so they are the only tasks
// this product path can fire; every kind is still printed for residue review.
const adminUrl = process.env.ADMIN_CONFIG_URL;
const token = process.env.INTERNAL_TOKEN;
if (!adminUrl || !token) throw new Error('ADMIN_CONFIG_URL and INTERNAL_TOKEN required');
const cfgRes = await fetch(`${adminUrl}/api/admin/config`, {
  headers: { 'x-internal-token': token },
});
if (!cfgRes.ok) throw new Error(`admin config read failed: HTTP ${cfgRes.status}`);
const cfg = (await cfgRes.json()) as {
  tasks?: Array<{
    kind: string;
    label?: string | null;
    effective_binding?: {
      provider: string | null;
      model: string | null;
      error: string | null;
      selection_rule: string | null;
      reasoning: { requested: string | null; applied: string | null; error: string | null } | null;
      credential?: { lane: string; verified_in_process: boolean } | null;
    } | null;
  }>;
  global?: unknown;
};
const taskResolution = (cfg.tasks ?? []).map((t) => ({
  kind: t.kind,
  fires_in_admission_path: ADMISSION_KINDS.includes(t.kind),
  provider: t.effective_binding?.provider ?? null,
  model: t.effective_binding?.model ?? null,
  selection_rule: t.effective_binding?.selection_rule ?? null,
  reasoning: t.effective_binding?.reasoning ?? null,
  error: t.effective_binding?.error ?? null,
  credential_lane: t.effective_binding?.credential?.lane ?? null,
}));
writeFileSync(
  `${root}/task-resolution.json`,
  JSON.stringify({ at: new Date(), global: cfg.global ?? null, tasks: taskResolution }, null, 2),
);
for (const kind of ADMISSION_KINDS) {
  const b = taskResolution.find((t) => t.kind === kind);
  if (
    !b ||
    b.provider !== 'opencode-go' ||
    b.model !== 'deepseek-v4.1-flash' ||
    b.error ||
    b.reasoning?.requested !== 'high' ||
    b.reasoning?.applied !== 'high' ||
    b.reasoning?.error
  )
    throw new Error(`Pre-flight resolution mismatch for ${kind}: ${JSON.stringify(b)}`);
}
console.log(
  JSON.stringify({
    preflight: 'task-resolution printed; admission kinds = opencode-go/deepseek-v4.1-flash high',
  }),
);
const started = new Date();
const results: unknown[] = [];
const save = () =>
  writeFileSync(resultsFile, JSON.stringify({ started, expectedDb, config, results }, null, 2));
save();
const idPrefix = `${(rows[0] as { id: string }).id.replace(/-\d+$/, '')}-%`;
const unknownInBatch = sql`select count(*)::int as c from paid_effect
  where state = 'unknown' and entity_id like ${idPrefix}`;
for (const row of rows) {
  const [budget] = await db.execute<{ cost: number; unknown: number; active: number }>(sql`
    select coalesce(sum(cost_usd),0)::float as cost,
      count(*) filter (where status = 'running')::int as active,
      (${unknownInBatch}) as unknown
    from ai_task_runs where started_at >= ${started.toISOString()}::timestamptz`);
  const recordedUnknowns = results.filter(
    (r: unknown) => (r as { status?: string }).status === 'unknown',
  ).length;
  if (budget.unknown > recordedUnknowns || budget.active || budget.cost >= preStopUsd)
    throw new Error('Budget/unknown/active stop before next sample');
  const kc = `${kcPrefix}${row.fixture.subject}`;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .insert(knowledge)
      .values({
        id: kc,
        name: `Public fixture ${row.fixture.subject}`,
        domain: row.fixture.subject,
        parent_id: null,
        approval_status: 'approved',
        proposed_by_ai: false,
        created_at: now,
        updated_at: now,
        version: 0,
      })
      .onConflictDoNothing();
    await tx.insert(question).values(
      withAnswerClass({
        id: row.id,
        kind: row.fixture.kind,
        prompt_md: row.fixture.prompt_md,
        reference_md: row.fixture.reference_md,
        rubric_json: row.fixture.rubric_json ?? null,
        choices_md: row.fixture.choices_md ?? null,
        knowledge_ids: [kc],
        difficulty: row.fixture.difficulty ?? 1,
        source: 'quiz_gen',
        source_ref: kc,
        draft_status: 'active',
        variant_depth: 0,
        figures: [],
        image_refs: [],
        structured: null,
        created_by: { by: 'ai' },
        metadata: { dev_seed: true, acceptance: acceptanceTag, fixture_ref: row.fixture.ref },
        created_at: now,
        updated_at: now,
        version: 0,
      }),
    );
    row.contract.integrity_digest = contractIntegrityDigest(row.contract);
    const published = await publishQuestionGroup(tx, {
      group_id: row.id,
      contract: row.contract,
      expectedCurrentRevision: null,
      expectedAdmissionGeneration: null,
      availability: 'general_pool',
      admission: { state: 'withheld', reason: 'unverified_rules' },
      actorRef: 'quiz_gen:persist',
      now,
    });
    if (published.status !== 'published') throw new Error(`Publish failed: ${published.status}`);
  });
  // Only publication is seeded: the real event outbox and worker own purpose,
  // admission delivery, paid sends, schema/semantic checks and publication.
  const deadline = Date.now() + 12 * 60000;
  while (true) {
    const stages = await db.execute<any>(
      sql`select * from paid_effect where entity_id = ${row.id} order by created_at`,
    );
    const coordinator = stages.find((s: any) => s.family === 'question_admission_run');
    if (stages.some((s: any) => s.state === 'unknown')) {
      results.push({
        n: row.n,
        cohort: row.cohort,
        id: row.id,
        before: row.before,
        status: 'unknown',
        stages,
      });
      save();
      console.log(
        JSON.stringify({
          n: row.n,
          cohort: row.cohort,
          status: 'unknown_transient',
          fence: 'no-resend; moving to next fresh id',
        }),
      );
      break;
    }
    const coordStatus = coordinator?.result_json?.result?.status;
    const terminalReceipt =
      coordinator?.state === 'receipt_ready' && coordStatus && coordStatus !== 'waiting';
    if (coordinator?.state === 'applied' || terminalReceipt) {
      const runs = await db.execute<any>(sql`select * from ai_task_runs where id in (
        select result_json->'result'->>'task_run_id' from paid_effect where entity_id = ${row.id}
        union select result_json->'fields'->>'taskRunId' from paid_effect where entity_id = ${row.id}) order by started_at`);
      const [cost] = await db.execute<any>(
        sql`select coalesce(sum(cost_usd),0)::float as total from ai_task_runs where started_at >= ${started.toISOString()}::timestamptz`,
      );
      results.push({
        n: row.n,
        cohort: row.cohort,
        id: row.id,
        before: row.before,
        stages,
        runs,
        cumulative_cost: cost.total,
        coordinator_state: coordinator.state,
      });
      save();
      console.log(
        JSON.stringify({
          n: row.n,
          cohort: row.cohort,
          status: coordStatus,
          coordinator_state: coordinator.state,
          runs: runs.length,
          cost: cost.total,
        }),
      );
      if (cost.total >= postStopUsd) throw new Error('Stop inside $0.05 hard cap with reserve');
      break;
    }
    if (Date.now() > deadline) throw new Error(`No terminal for ${row.id}; stop without resend`);
    await delay(2000);
  }
}
await db.$client.end();
