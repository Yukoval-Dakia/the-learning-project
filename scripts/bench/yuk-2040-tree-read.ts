/** YUK-2040 measurement harness. Synthetic, owned dev corpus. Not committed. */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import postgres from 'postgres';

const OUT_ENV = process.env.YUK2040_OUT;
if (!OUT_ENV) throw new Error('YUK2040_OUT required');
const OUT: string = OUT_ENV;
mkdirSync(OUT, { recursive: true });

const url = new URL(process.env.DATABASE_URL ?? '');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.port !== '5434' ||
  !url.pathname.startsWith('/loom_dev_')
)
  throw new Error('Only an isolated local dev database is allowed');

const sql = postgres(process.env.DATABASE_URL as string, { max: 4 });
const DBNAME = url.pathname.slice(1);
const psql = (q: string) =>
  execSync(
    `docker exec loom-dev-postgres-dev-1 psql -U loom_dev -d ${DBNAME} -v ON_ERROR_STOP=1 -Atc ${JSON.stringify(q)}`,
    { encoding: 'utf8' },
  ).trim();

const now = () => performance.now();
const sha = (f: string) =>
  createHash('sha256')
    .update(readFileSync(new URL(`../../${f}`, import.meta.url)))
    .digest('hex');

const DAYS = (d: number) => new Date(Date.now() - d * 86400_000);

async function fixture(scale: '64' | 'add-640') {
  // Wipe only this harness's own id namespaces, never anything else.
  if (scale === '64')
    for (const q of [
      "delete from event where id like 'ev_%'",
      "delete from item_calibration where id like 'ic_perf_%'",
      "delete from question where id like 'qperf_%'",
      "delete from mastery_state where id like 'ms_perf_%'",
      "delete from knowledge where id like 'perf_%' or id like 'synthetic:perf_%'",
    ])
      await sql.unsafe(q);
  else
    for (const q of [
      "delete from event where id like 'ev_%perf_yw_%'",
      "delete from mastery_state where id like 'ms_perf_yw_%'",
      "delete from knowledge where id like 'perf_yw_%'",
    ])
      await sql.unsafe(q);

  if (scale === '64') {
    // Family A: 3 seeds exist already; add math (4 containers + 8 sections +
    // 32 leaves), physics (3 sections + 9 leaves), 1 goal, 4 synthetic probes,
    // 3 archived. Total ACTIVE = 3 + 44 + 12 + 1 + 4 = 64.
    const rows: object[] = [];
    const kc = (
      id: string,
      name: string,
      domain: string | null,
      parent: string | null,
      role: string,
      archived: Date | null = null,
    ) =>
      rows.push({
        id,
        name,
        domain,
        parent_id: parent,
        role,
        archived_at: archived,
        created_at: DAYS(90),
        updated_at: DAYS(1),
      });
    for (let c = 1; c <= 4; c++) {
      kc(`perf_math_ch${c}`, `math chapter ${c}`, null, 'seed:math:root', 'container');
      for (let s = 1; s <= 2; s++) {
        const sid = `perf_math_s${c}_${s}`;
        kc(sid, `math s${c}.${s}`, null, `perf_math_ch${c}`, 'kc');
        for (let l = 1; l <= 4; l++) kc(`${sid}_k${l}`, `math kc ${c}.${s}.${l}`, null, sid, 'kc');
      }
    }
    for (let s = 1; s <= 3; s++) {
      kc(`perf_phy_s${s}`, `physics s${s}`, null, 'seed:physics:root', 'kc');
      for (let l = 1; l <= 3; l++)
        kc(`perf_phy_s${s}_k${l}`, `physics kc ${s}.${l}`, null, `perf_phy_s${s}`, 'kc');
    }
    kc('perf_goal_1', 'goal node', 'math', null, 'goal');
    for (let i = 1; i <= 4; i++)
      kc(`synthetic:perf_probe_${i}`, `probe ${i}`, null, 'seed:math:root', 'kc');
    for (let i = 1; i <= 3; i++)
      kc(`perf_arch_${i}`, `archived ${i}`, null, 'seed:math:root', 'kc', DAYS(30));
    await sql`insert into knowledge ${sql(rows as never[])}`;

    const kcs = (
      await sql`select id from knowledge where id like 'perf_%' and role='kc' and archived_at is null order by id`
    ).map((r) => String(r.id));

    // ~80% of kcs attempted.
    const ms = [];
    for (let i = 0; i < kcs.length; i++) {
      if (i % 5 === 4) continue;
      const s = 2 + (i % 7);
      const f = i % 3;
      ms.push({
        id: `ms_${kcs[i]}`,
        subject_kind: 'knowledge',
        subject_id: kcs[i],
        theta_hat: (i % 9) / 10 - 0.4,
        evidence_count: s + f,
        success_count: s,
        fail_count: f,
        last_outcome_at: DAYS(i % 20),
        theta_precision: 1 + (i % 5) * 0.5,
      });
    }
    await sql`insert into mastery_state ${sql(ms as never[])}`;

    // 30 questions, each carrying 2 kcs; hard-track calibration (a few soft).
    const qs = [];
    const ics = [];
    for (let i = 0; i < 30; i++) {
      const k1 = kcs[(i * 2) % kcs.length];
      const k2 = kcs[(i * 2 + 1) % kcs.length];
      qs.push({
        id: `qperf_${i}`,
        kind: 'short_answer',
        prompt_md: `fixture stem ${i}`,
        source: 'perf_fixture',
        knowledge_ids: [k1, k2],
        created_at: DAYS(60),
        updated_at: DAYS(1),
      });
      ics.push({
        id: `ic_perf_${i}`,
        question_id: `qperf_${i}`,
        b: (i % 7) * 0.3 - 0.9,
        b_anchor: (i % 7) * 0.3 - 0.9,
        source: 'llm_prior',
        track: i % 6 === 5 ? 'soft' : 'hard',
      });
    }
    await sql`insert into question ${sql(qs as never[])}`;
    await sql`insert into item_calibration ${sql(ics as never[])}`;

    // Activity events per kc: subject events + payload knowledge_ids + referenced_knowledge_ids.
    const evs = [];
    for (let i = 0; i < kcs.length; i++) {
      const k = kcs[i];
      if (i % 3 === 0) continue; // no events -> last_active falls back to created_at
      evs.push({
        id: `ev_subj_${k}`,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'knowledge',
        subject_id: k,
        payload: {},
        created_at: DAYS((i % 15) + 1),
      });
      if (i % 2 === 0)
        evs.push({
          id: `ev_kids_${k}`,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'submit',
          subject_kind: 'question',
          subject_id: `qperf_${i % 30}`,
          payload: { knowledge_ids: [k, kcs[(i + 1) % kcs.length]] },
          created_at: DAYS(i % 10),
        });
      if (i % 4 === 0)
        evs.push({
          id: `ev_ref_${k}`,
          actor_kind: 'agent',
          actor_ref: 'KnowledgeReviewTask',
          action: 'review',
          subject_kind: 'artifact',
          subject_id: `art_${i}`,
          payload: { referenced_knowledge_ids: [k], note: 1 },
          created_at: DAYS(i % 8),
        });
    }
    await sql`insert into event ${sql(evs as never[])}`;

    // Bulk filler so one sequential scan of event costs tens of ms (TEST shape).
    // Server-side generate_series: one statement, no parameter-list blow-up.
    await sql.unsafe(
      `insert into event (id,actor_kind,actor_ref,action,subject_kind,subject_id,payload,created_at)
       select 'ev_fill_'||g,'system','cron','perf_filler','system','fill_'||(g%997),
         jsonb_build_object('blob',md5(g::text),'arr',(select jsonb_agg(x) from generate_series(1,24) x)),
         now() - (g||' seconds')::interval
       from generate_series(1,90000) g`,
    );
  }

  if (scale === 'add-640') {
    // Family B: 48 sections x 11 leaves = 576 actives under seed:yuwen:root.
    const rows: object[] = [];
    const kc = (id: string, name: string, parent: string) =>
      rows.push({
        id,
        name,
        domain: null,
        parent_id: parent,
        role: 'kc',
        archived_at: null,
        created_at: DAYS(80),
        updated_at: DAYS(1),
      });
    for (let c = 1; c <= 6; c++)
      for (let s = 1; s <= 8; s++) {
        const sid = `perf_yw_s${c}_${s}`;
        kc(sid, `yw s${c}.${s}`, 'seed:yuwen:root');
        for (let l = 1; l <= 11; l++) kc(`${sid}_k${l}`, `yw kc ${c}.${s}.${l}`, sid);
      }
    await sql`insert into knowledge ${sql(rows as never[])}`;

    const kcs = (
      await sql`select id from knowledge where id like 'perf_yw_%' and archived_at is null order by id`
    ).map((r) => String(r.id));
    const ms = kcs
      .filter((_, i) => i % 2 === 0)
      .map((k, i) => ({
        id: `ms_${k}`,
        subject_kind: 'knowledge',
        subject_id: k,
        theta_hat: 0.1,
        evidence_count: 3,
        success_count: 2,
        fail_count: 1,
        last_outcome_at: DAYS(i % 20),
        theta_precision: 1.5,
      }));
    for (let i = 0; i < ms.length; i += 300)
      await sql`insert into mastery_state ${sql(ms.slice(i, i + 300) as never[])}`;

    const evs = [];
    for (let i = 0; i < kcs.length; i++) {
      const k = kcs[i];
      if (i % 3 === 0) continue;
      evs.push({
        id: `ev_subj_${k}`,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'knowledge',
        subject_id: k,
        payload: {},
        created_at: DAYS(i % 15),
      });
      if (i % 5 === 1)
        evs.push({
          id: `ev_kids_${k}`,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'submit',
          subject_kind: 'question',
          subject_id: `qperf_x${i}`,
          payload: { knowledge_ids: [k] },
          created_at: DAYS(i % 10),
        });
      if (i % 7 === 2)
        evs.push({
          id: `ev_ref_${k}`,
          actor_kind: 'agent',
          actor_ref: 'KnowledgeReviewTask',
          action: 'review',
          subject_kind: 'artifact',
          subject_id: `art_b${i}`,
          payload: { referenced_knowledge_ids: [k] },
          created_at: DAYS(i % 8),
        });
    }
    for (let i = 0; i < evs.length; i += 300)
      await sql`insert into event ${sql(evs.slice(i, i + 300) as never[])}`;
  }

  for (const t of ['event', 'knowledge', 'mastery_state', 'question', 'item_calibration'])
    await sql.unsafe(`analyze ${t}`);
  console.log(
    JSON.stringify({
      knowledge_active: psql('select count(*) from knowledge where archived_at is null'),
      event: psql('select count(*) from event'),
      mastery_state: psql('select count(*) from mastery_state'),
      question: psql('select count(*) from question'),
      item_calibration: psql('select count(*) from item_calibration'),
    }),
  );
}

type Rec = { n: number; query: string; params: unknown[]; ms: number };

function seal() {
  return {
    head: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
    status: execSync('git status --short', { encoding: 'utf8' }).trim(),
    files: [
      'src/kernel/read-models/knowledge-activity.ts',
      'src/kernel/read-models/knowledge-graph.ts',
      'src/kernel/read-models/mastery-projection.ts',
      'src/capabilities/knowledge/server/learner-knowledge-request.ts',
      'server/start/workbench-adapters.ts',
    ].map((f) => ({ path: f, sha256: sha(f) })),
  };
}

async function measure(label: string, runs: number, subjects: Array<string | undefined>) {
  const { readLearnerKnowledgeTree } = await import(
    '@/capabilities/knowledge/server/learner-knowledge-request'
  );
  const { readStartKnowledgeTree } = await import('../../server/start/workbench-adapters');
  const { db } = await import('@/db/client');

  const client = (db as unknown as { $client: unknown }).$client as {
    unsafe: (...a: unknown[]) => Record<string, unknown>;
  };
  const origUnsafe = client.unsafe.bind(client);
  const recs: Rec[] = [];
  let counter = 0;
  client.unsafe = (...args: unknown[]) => {
    const n = ++counter;
    const t0 = now();
    const q = origUnsafe(...args);
    const mark = () => {
      if (!recs.some((r) => r.n === n))
        recs.push({
          n,
          query: String(args[0]),
          params: (args[1] as unknown[]) ?? [],
          ms: Math.round((now() - t0) * 100) / 100,
        });
    };
    for (const m of ['then', 'execute', 'values', 'simple']) {
      const fn = q[m];
      if (typeof fn !== 'function') continue;
      q[m] = (...a: unknown[]) =>
        (fn as (...x: unknown[]) => Promise<unknown>).apply(q, a).then((r) => {
          mark();
          return r;
        });
    }
    return q;
  };

  const report: Record<string, unknown> = {
    label,
    seal: seal(),
    db: DBNAME,
    counts: {
      knowledge_active: Number(psql('select count(*) from knowledge where archived_at is null')),
      event: Number(psql('select count(*) from event')),
      mastery_state: Number(psql('select count(*) from mastery_state')),
      question: Number(psql('select count(*) from question')),
    },
  };

  const results: Record<string, unknown> = {};
  for (const subject of subjects) {
    const key = subject ?? '__all__';
    const runRows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < runs; i++) {
      console.error(`[measure] ${label} ${key} run ${i} start`);
      recs.length = 0;
      const t0 = now();
      const startOut = await readStartKnowledgeTree(subject ? { subject } : undefined);
      const wall = now() - t0;
      const statements_start = recs.slice();
      recs.length = 0;
      const t1 = now();
      const apiRead = await readLearnerKnowledgeTree(db, subject ? { subject } : {});
      const apiWall = now() - t1;
      const statements_api = recs.slice();
      runRows.push({
        run: i,
        wall_ms: Math.round(wall * 100) / 100,
        api_wall_ms: Math.round(apiWall * 100) / 100,
        statements_start: statements_start.map((r) => ({
          n: r.n,
          ms: r.ms,
          query: r.query,
          n_params: r.params.length,
        })),
        statements_api: statements_api.map((r) => ({
          n: r.n,
          ms: r.ms,
          query: r.query,
          n_params: r.params.length,
        })),
        statements_full: [...statements_start, ...statements_api].map((r) => ({
          query: r.query,
          params: r.params,
        })),
        rows_start: startOut.rows.length,
        rows_api: apiRead.ok ? apiRead.rows.length : -1,
      });
      console.error(
        `[measure] ${label} ${key} run ${i} wall=${wall.toFixed(0)}ms api=${apiWall.toFixed(0)}ms`,
      );
      if (i === runs - 1)
        writeFileSync(
          join(OUT, `rows-${label}-${key}.json`),
          JSON.stringify({ start: startOut, api: apiRead.ok ? apiRead.rows : apiRead }),
        );
    }
    results[key] = runRows;
  }
  report.runs = results;
  writeFileSync(join(OUT, `measure-${label}.json`), JSON.stringify(report, null, 2));
  console.log(`wrote measure-${label}.json`);
}

async function explain(label: string) {
  // Re-run every DISTINCT statement text captured by `measure` under
  // EXPLAIN (ANALYZE, BUFFERS) with the first occurrence's real bound params.
  const m = JSON.parse(readFileSync(join(OUT, `measure-${label}.json`), 'utf8')) as {
    runs: Record<string, Array<{ statements_full?: Array<{ query: string; params: unknown[] }> }>>;
  };
  const seen = new Map<string, unknown[]>();
  for (const runs of Object.values(m.runs))
    for (const r of runs)
      for (const s of r.statements_full ?? []) if (!seen.has(s.query)) seen.set(s.query, s.params);
  let i = 0;
  const lines: string[] = [];
  for (const [query, params] of seen) {
    i++;
    const plan = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${query}`, params as never[]);
    const text = plan.map((r) => String((r as Record<string, unknown>)['QUERY PLAN'])).join('\n');
    lines.push(`── stmt ${i} (${params.length} params) ──\n${query}\n\n${text}\n`);
    const top = plan[0] as Record<string, unknown>;
    lines.push(`(top: ${String(top['QUERY PLAN'])})\n`);
  }
  writeFileSync(join(OUT, `explain-${label}.txt`), lines.join('\n'));
  console.log(`wrote explain-${label}.txt (${seen.size} distinct statements)`);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'fixture') await fixture((rest[0] ?? '64') as '64' | 'add-640');
else if (cmd === 'measure')
  await measure(
    rest[0] ?? 'run',
    Number(rest[1] ?? 3),
    (rest[2] ?? 'math,').split(',').map((s) => s || undefined),
  );
else if (cmd === 'explain') await explain(rest[0] ?? 'run');
else throw new Error(`unknown cmd ${cmd}`);
await sql.end();
