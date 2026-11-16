import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
const e = 'yuk1854r2515c-08';
const stages = await db.execute(sql`select * from paid_effect where entity_id = ${e} order by created_at`);
const runs = await db.execute(sql`select * from ai_task_runs where id in (
  select result_json->'result'->>'task_run_id' from paid_effect where entity_id = ${e}
  union select result_json->'fields'->>'taskRunId' from paid_effect where entity_id = ${e}) order by started_at`);
const coord = (stages as any[]).find((s) => s.family === 'question_admission_run');
const [cost] = await db.execute<any>(sql`select coalesce(sum(cost_usd),0)::float as total from ai_task_runs where started_at >= '2026-11-05 16:50'::timestamptz`);
const rec = {
  n: 8, cohort: 'control', id: e,
  status: coord.result_json?.result?.status,
  decision: coord.result_json?.result?.decision,
  coordinator_state: coord.state,
  last_application_error: coord.last_application_error,
  harvest_note: 'terminal receipt harvested: application write failed on canonical_content_hash dedup vs yuk1854r2515b-08 (same fixture); admission decision itself recorded normally',
  stages, runs, cumulative_cost_scope_beyond_c08: cost.total,
};
writeFileSync('/Volumes/YukovalSBak/yukoval-projects/tlp-audit-artifacts/yuk1854/recheck-2515/acceptance-c08-harvest.json', JSON.stringify(rec, null, 2));
console.log('harvested', rec.status, rec.decision, 'runs:', runs.length);
await db.$client.end();
