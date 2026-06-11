// DEV demo driver — drive the full Layer-8 flywheel on the synthetic seed, with
// REAL LLM (XIAOMI), against a loopback sandbox DB. A manual smoke to SEE the
// flywheel turn end-to-end (added 2026-06-01; it surfaced YUK-189). Dev-only:
// targets a loopback DB you migrate + seed yourself; makes real LLM calls.
//
// Setup + run (loom_demo sandbox):
//   docker compose -f docker-compose.yml -f docker-compose.local.yml up postgres -d
//   docker exec <pg> psql -U loom -d loom -c 'CREATE DATABASE loom_demo;'
//   DATABASE_URL=postgres://loom:loom@127.0.0.1:5433/loom_demo pnpm exec drizzle-kit migrate
//   SEED_SYNTHETIC_OK=1 DATABASE_URL=postgres://loom:loom@127.0.0.1:5433/loom_demo pnpm seed:synthetic
//   DATABASE_URL=postgres://loom:loom@127.0.0.1:5433/loom_demo pnpm tsx scripts/demo-flywheel.ts
//
// load-env loads .env (XIAOMI_API_KEY) with override:false so the shell-set
// loopback DATABASE_URL wins; @/db/client then targets the sandbox DB.
//
// load-env loads .env (XIAOMI_API_KEY) with override:false so the shell-set
// loopback DATABASE_URL wins; @/db/client then targets loom_demo.
import './load-env';

import { runCoach } from '@/capabilities/agency/jobs/coach_daily';
import { runDreamingNightly } from '@/capabilities/agency/jobs/dreaming_nightly';
import { runGoalScopeProposeNightly } from '@/capabilities/agency/jobs/goal_scope_propose_nightly';
import { listActiveGoals } from '@/capabilities/agency/server/goals/queries';
import { runKnowledgeEdgeProposeNightly } from '@/capabilities/knowledge/jobs/knowledge_edge_propose_nightly';
import { db } from '@/db/client';
import { executeMemoryBrief } from '@/server/ai/tools/context-readers';
import { loadSubjectBriefEvents } from '@/server/memory/active-subjects';
import { regenerateMemoryBrief } from '@/server/memory/brief';
import { buildBriefGenerator } from '@/server/memory/brief-writer';
import { acceptAiProposal } from '@/server/proposals/actions';
import { listProposalInboxRows } from '@/server/proposals/inbox';

const NOW = new Date();
// biome-ignore lint/suspicious/noExplicitAny: demo-only loose typing
const toolCtx: any = {
  db,
  taskRunId: 'demo',
  callerActor: { kind: 'system', ref: 'demo-flywheel' },
};
const searchFacts = async () => []; // Mem0 degraded (no OPENAI_API_KEY) — brief still generates from events

function show(label: string, v: unknown) {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    s = String(v);
  }
  if (s && s.length > 1400) s = `${s.slice(0, 1400)}\n  …[truncated]`;
  console.log(`  ${label}: ${s}`);
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  console.log(`\n━━━━━━ ${name} ━━━━━━`);
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`  ✓ ok (${Date.now() - t0}ms)`);
    return r;
  } catch (e) {
    console.error(`  ✗ FAILED (${Date.now() - t0}ms):`, (e as Error)?.message ?? e);
    return null;
  }
}

async function main() {
  console.log(`\n#### Layer-8 flywheel demo — loom_demo, real LLM, ${NOW.toISOString()} ####`);

  const gen = buildBriefGenerator({ db });

  // 1) Brief writer (real LLM) — global + subject:wenyan
  await step('1. brief regen → global', async () => {
    const r = await regenerateMemoryBrief({ db, scopeKey: 'global', generate: gen, searchFacts });
    show('wrote', r.wrote);
    return r;
  });
  await step('1b. brief regen → subject:wenyan (knowledge-resolved events)', async () => {
    const events = await loadSubjectBriefEvents(db, 'wenyan', { lookbackDays: 30, now: NOW });
    show('subject events loaded', events.length);
    return regenerateMemoryBrief({
      db,
      scopeKey: 'subject:wenyan',
      loadEvents: async () => events,
      searchFacts,
      generate: gen,
    });
  });
  await step('2. read query_memory_brief(global) — what the orchestrator sees', async () => {
    const out = await executeMemoryBrief(toolCtx, { scopeKey: 'global', includeEvidence: true });
    show('recent_week_md', out.note?.recent_week_md);
    show('long_term_md', out.note?.long_term_md);
    show('long_term_freshness_score', out.note?.long_term_freshness_score);
    show('long_term_evidence_ids', out.evidence?.long_term_ids);
    return out.note ? 'NON-EMPTY' : 'null';
  });

  // 3) Goal cron (real LLM) → propose a goal-scope → accept → materialize
  await step('3. goal cron → runGoalScopeProposeNightly', async () => {
    const r = await runGoalScopeProposeNightly(db);
    show('result', r);
    return r;
  });
  await step('4. accept the goal_scope proposal → materialize goal', async () => {
    const inbox = await listProposalInboxRows(db);
    const goalProp = inbox.find((r) => r.kind === 'goal_scope' && r.status === 'pending');
    show('pending goal_scope proposal id', goalProp?.id ?? '<none>');
    if (!goalProp) return '<no goal proposal to accept>';
    await acceptAiProposal(db, goalProp.id, {});
    return 'accepted';
  });
  await step('5. listActiveGoals → goal-bias layer is now live', async () => {
    const goals = await listActiveGoals(db);
    show(
      'active goals',
      goals.map((g) => ({ title: g.title, subject: g.subject_id, scope: g.scope_knowledge_ids })),
    );
    return goals.length;
  });

  // 6) Dreaming (real LLM, manual) — goal-aware proposals
  await step('6. dreaming → runDreamingNightly (real agent loop, goal-aware)', async () => {
    const r = await runDreamingNightly(db);
    show('result', r);
    return r;
  });

  // 7) Coach (real LLM) — TodayPlan with goal_strand
  await step('7. coach → runCoach(daily) (real agent loop, goal_strand)', async () => {
    const r = await runCoach(db, 'daily');
    show('result', r);
    return r;
  });

  // 8) Edge-propose (real LLM)
  await step('8. edge-propose → runKnowledgeEdgeProposeNightly', async () => {
    const r = await runKnowledgeEdgeProposeNightly(db, {});
    show('result', r);
    return r;
  });

  // 9) Final inbox snapshot
  await step('9. proposal inbox snapshot', async () => {
    const inbox = await listProposalInboxRows(db);
    show(
      'inbox by kind',
      inbox.reduce<Record<string, number>>((a, r) => {
        a[`${r.kind}:${r.status}`] = (a[`${r.kind}:${r.status}`] ?? 0) + 1;
        return a;
      }, {}),
    );
    return inbox.length;
  });

  console.log('\n#### demo done ####');
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
