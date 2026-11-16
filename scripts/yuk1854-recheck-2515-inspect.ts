import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { devDatabaseName } from '../scripts/dev-worktree-db';

const expectedDb = devDatabaseName();
const url = new URL(process.env.DATABASE_URL!);
if (url.port !== '5434' || url.pathname !== `/${expectedDb}`) throw new Error('Refusing non-owned dev database');

const entity = process.env.INSPECT_ENTITY ?? 'yuk1854r2515-13';
const paid = await db.execute(sql`select * from paid_effect where entity_id = ${entity} order by created_at`);
console.log('=== paid_effect rows (entity 13) ===');
for (const s of paid as any[]) {
  console.log(JSON.stringify({
    family: s.family, stage: s.stage, state: s.state, fence: s.fence,
    identity: s.identity, created_at: s.created_at, updated_at: s.updated_at,
    result: s.result_json ? JSON.stringify(s.result_json).slice(0, 900) : null,
    error_json: s.error_json ? JSON.stringify(s.error_json).slice(0, 900) : null,
  }, null, 1));
}
const runs = await db.execute(sql`select id, task_kind, provider, model, status, finish_reason,
  cost_usd, cost_basis, error_message, started_at, finished_at
  from ai_task_runs order by started_at desc limit 14`);
console.log('=== recent ai_task_runs ===');
for (const r of runs as any[]) console.log(JSON.stringify(r).slice(0, 700));
const tools = await db.execute(sql`select id, task_run_id, task_kind, tool_name, error_reason,
  iteration, occurred_at, left(input_json::text, 500) as input_head
  from tool_call_log order by occurred_at`);
console.log('=== tool_call_log ===');
for (const t of tools as any[]) console.log(JSON.stringify(t).slice(0, 1000));
await db.$client.end();
