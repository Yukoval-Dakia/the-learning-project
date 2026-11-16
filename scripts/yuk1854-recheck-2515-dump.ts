import { readFileSync, writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { devDatabaseName } from '../scripts/dev-worktree-db';

const root = '/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1854/recheck-2515';
const expectedDb = devDatabaseName();
const url = new URL(process.env.DATABASE_URL!);
if (url.hostname !== '127.0.0.1' || url.port !== '5434' || url.pathname !== `/${expectedDb}`)
  throw new Error('Refusing non-owned dev database');
const results = JSON.parse(readFileSync(`${root}/acceptance-results.json`, 'utf8'));
const started = results.started as string;
const ids = (results.results as Array<{ id: string }>).map(r => r.id);
const runIds = (results.results as Array<{ runs?: Array<{ id: string }> }>)
  .flatMap(r => (r.runs ?? []).map(x => x.id));

const runs = await db.execute(sql`
  select id, task_kind, provider, model, status, finish_reason, cost_usd, cost_basis,
         error_message, started_at, finished_at
  from ai_task_runs where started_at >= ${started}::timestamptz order by started_at`);
const ledger = await db.execute(sql`
  select * from cost_ledger where occurred_at >= ${started}::timestamptz order by occurred_at`);
const paid = ids.length
  ? await db.execute(sql`select * from paid_effect where entity_id in ${sql`(${sql.join(ids.map(i => sql`${i}`), sql`,`))})`} order by created_at`)
  : [];
const tools = runIds.length
  ? await db.execute(sql`select id, task_run_id, task_kind, tool_name, error_reason, iteration,
         latency_ms, occurred_at, input_json
      from tool_call_log where task_run_id in ${sql`(${sql.join(runIds.map(i => sql`${i}`), sql`,`))})`} order by occurred_at`)
  : [];
const [idle] = await db.execute<{ active_ai: number; active_admission: number; unresolved_paid: number }>(sql`
  select count(*) filter (where status = 'running')::int as active_ai,
    (select count(*)::int from paid_effect where state in ('sending','waiting')),
    (select count(*)::int from paid_effect where state = 'unknown')
  from ai_task_runs`);
const coerced = (tools as Array<{ error_reason: string | null; tool_name: string }>)
  .filter(t => t.error_reason === 'tool_args_coerced');
const contractFailed = (tools as Array<{ error_reason: string | null }>)
  .filter(t => t.error_reason === 'tool_args_contract_failed');
const submitRejected = (tools as Array<{ error_reason: string | null }>)
  .filter(t => t.error_reason === 'structured_output_submit_arguments_rejected');
const summary = {
  head: process.env.RUN_HEAD ?? null,
  database: expectedDb,
  run_rows: (runs as unknown[]).length,
  distinct_kinds: [...new Set((runs as Array<{ task_kind: string }>).map(r => r.task_kind))],
  provider_model_pairs: [...new Set((runs as Array<{ provider: string; model: string }>).map(r => `${r.provider}/${r.model}`))],
  non_flash_runs: (runs as Array<{ provider: string; model: string; id: string }>)
    .filter(r => !(r.provider === 'opencode-go' && r.model === 'deepseek-v4.1-flash'))
    .map(r => r.id),
  catalog_estimate_total: (runs as Array<{ cost_usd: number | null }>)
    .reduce((a, r) => a + (r.cost_usd ?? 0), 0),
  tool_args_coerced_on_submit: coerced
    .filter(t => t.tool_name === 'mcp__structured_output__submit').length,
  tool_args_coerced_total: coerced.length,
  tool_args_contract_failed: contractFailed.length,
  submit_args_rejected: submitRejected.length,
  idle,
};
writeFileSync(`${root}/finance-and-runtime.json`,
  JSON.stringify({ runs, ledger, paid, tools, idle }, null, 2));
writeFileSync(`${root}/runtime-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
await db.$client.end();
