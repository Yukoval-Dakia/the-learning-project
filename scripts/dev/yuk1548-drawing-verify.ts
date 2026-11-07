// YUK-1548 slice 1 — drawing lane runtime verification on a scratch DB.
//
// Boots a throwaway pgvector testcontainer, migrates it, then drives the REAL
// admission → pg-boss → job → status path end to end. The pi execution adapter
// is swapped through the repo's own `__setPiAdapterForTests` seam, so task
// resolution, the Sol route assert, the provider wire assert, error binding,
// CAS transitions, waits and asset persistence all execute for real while no
// paid request leaves the process. Storage is an in-process S3 stub; the
// ChatGPT-login credential is a synthetic auth.json in TMPDIR — nothing here
// touches a real provider credential or real R2.
//
// Usage:
//   pnpm exec tsx scripts/dev/yuk1548-drawing-verify.ts [--out <evidence.json>]
//
// The container is stopped at the end regardless of outcome.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type {
  ExecutionAdapter,
  PreparedExecutionQuery,
  RunnerMessage,
} from '@/server/ai/execution-adapter';

const DEFAULT_OUT =
  '/Volumes/YukovalSBak/yukoval-projects/tlp-docs/audit/yuk1548-slice1/runtime-verification.json';

function ensureDockerHost() {
  if (process.env.DOCKER_HOST) return;
  const orbstack = join(homedir(), '.orbstack/run/docker.sock');
  if (existsSync(orbstack)) process.env.DOCKER_HOST = `unix://${orbstack}`;
}

// ─── in-process S3 stub ───────────────────────────────────────────────────
// R2Client only exercises PUT (If-None-Match:'*' conditional create), GET and
// DELETE under the bucket path. Errors are classified by status code, so the
// bodies only need a <Code> the SDK can map.
function startS3Stub(): Promise<{ url: string; close: () => Promise<void> }> {
  const objects = new Map<string, Buffer>();
  const server: Server = createServer((req, res) => {
    if (process.env.S3_STUB_DEBUG) console.log(`[s3-stub] ${req.method} ${req.url}`);
    const key = decodeURIComponent((req.url ?? '/').replace(/^\//, '').split('?')[0] ?? '');
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && objects.has(key)) {
          res
            .writeHead(412, { 'content-type': 'application/xml' })
            .end('<Error><Code>PreconditionFailed</Code></Error>');
          return;
        }
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200, { etag: '"stub-etag"' }).end();
        return;
      }
      if (req.method === 'GET') {
        const body = objects.get(key);
        if (!body) {
          res
            .writeHead(404, { 'content-type': 'application/xml' })
            .end('<Error><Code>NoSuchKey</Code></Error>');
          return;
        }
        res.writeHead(200).end(body);
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
        return;
      }
      res.writeHead(405).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

// ─── scripted execution adapter ───────────────────────────────────────────
// One script entry per run() cycle: 'frames' replays SDK-shaped messages;
// 'error' makes the query generator throw. `startups` counts how many times
// the runner reached a prepared transport — the zero-send proof for every
// failure scenario.
interface ScriptedAttempt {
  frames?: unknown[];
  error?: unknown;
}
const scriptQueue: ScriptedAttempt[] = [];
const adapterStats = { startups: 0, queries: 0 };

function pushFrames(...frames: unknown[]) {
  scriptQueue.push({ frames });
}
function pushSvgResult(svg: string) {
  pushFrames(
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: svg }] },
    },
    {
      type: 'result',
      subtype: 'success',
      result: svg,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  );
}
function pushApiError(status: number, text: string) {
  pushFrames({
    type: 'result',
    subtype: 'success',
    is_error: true,
    api_error_status: status,
    result: text,
    total_cost_usd: 0,
    usage: { input_tokens: 5, output_tokens: 7 },
  });
}

const GOOD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">' +
  '<rect x="280" y="40" width="20" height="160" fill="none" stroke="#334155" stroke-width="2"/>' +
  '<path d="M300 200 L300 260" fill="none" stroke="#334155" stroke-width="2"/>' +
  '<path d="M240 300 L360 300 L330 360 L270 360 Z" fill="none" stroke="#334155" stroke-width="2"/>' +
  '<text x="310" y="60" font-size="14" fill="#334155">滴定管</text>' +
  '<text x="240" y="390" font-size="14" fill="#334155">锥形瓶</text>' +
  '</svg>';

type Evidence = { name: string; ok: boolean; detail: Record<string, unknown> };
const evidence: Evidence[] = [];
function record(name: string, ok: boolean, detail: Record<string, unknown> = {}) {
  evidence.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`);
}

async function main() {
  const outPath = process.argv.includes('--out')
    ? (process.argv[process.argv.indexOf('--out') + 1] ?? DEFAULT_OUT)
    : DEFAULT_OUT;

  ensureDockerHost();
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'pgvector/pgvector:pg16',
  )
    .withTmpFs({ '/var/lib/postgresql/data': 'rw,size=1g' })
    .start();
  const dbUrl = container.getConnectionUri();
  const s3 = await startS3Stub();

  // Synthetic ChatGPT-login credential store — file shape per
  // src/server/ai/chatgpt-oauth-store.ts ({provider: cred}, openai oauth entry).
  const authPath = join(tmpdir(), `yuk1548-auth-${process.pid}.json`);
  writeFileSync(
    authPath,
    JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'synthetic-access-token',
        refresh: 'synthetic-refresh-token',
        expires: Date.now() + 3_600_000,
        accountId: 'synthetic-account',
      },
    }),
    { mode: 0o600 },
  );

  process.env.DATABASE_URL = dbUrl;
  process.env.TEST_DATABASE_URL = dbUrl;
  process.env.R2_ENDPOINT = s3.url;
  process.env.R2_ACCESS_KEY_ID = 'stub';
  process.env.R2_SECRET_ACCESS_KEY = 'stub';
  process.env.R2_BUCKET = 'stub-bucket';
  process.env.OPENAI_CHATGPT_AUTH_FILE = authPath;
  delete process.env.AI_PROVIDER_OVERRIDE;
  delete process.env.AI_PROVIDER_MODEL;
  delete process.env.OPENAI_API_KEY;

  const repoRoot = join(new URL('.', import.meta.url).pathname, '../..');
  const migrate = spawnSync('pnpm', ['db:migrate'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'inherit',
  });
  if (migrate.status !== 0) throw new Error('db:migrate failed on the scratch container');

  // All project imports are dynamic: DATABASE_URL / R2_* / auth file must be
  // set before the db client, object storage and credential store bind.
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const postgresMod = await import('postgres');
  const postgres = postgresMod.default;
  const schema = await import('@/db/schema');
  const { drawing, event } = schema;
  const { eq, sql } = await import('drizzle-orm');
  const { setTestConfig, resetTestConfig } = await import('@/core/config/store');
  const { __setPiAdapterForTests } = await import('@/server/ai/execution-adapter');
  const svc = await import('@/capabilities/drawing/server/drawing-service');
  const { buildDrawingGenerateHandler } = await import(
    '@/capabilities/drawing/jobs/drawing_generate'
  );
  const { TurnSourceLedger } = await import('@/kernel/tools/source-ledger');
  const { createJobQueue } = await import('@/server/boss/queue-config');
  const { EXPIRE_LLM } = await import('@/server/boss/queue-config');
  const { getStartedBoss } = await import('@/server/boss/client');
  const { newId } = await import('@/core/ids');

  const client = postgres(dbUrl, { max: 4 });
  const db = drizzle(client, { schema });

  const boss = await getStartedBoss();
  await createJobQueue(boss, 'drawing_generate', EXPIRE_LLM);

  // Dedicated Sol lane pinned via the test overlay — the four config keys the
  // migration line owns in production.
  setTestConfig({
    'task.DrawingTask.provider': 'openai',
    'task.DrawingTask.model': 'gpt-6.1-sol',
    'task.DrawingTask.reasoning': { level: 'high' },
    'task.DrawingTask.override_global_pin': true,
  });

  const fakeAdapter: ExecutionAdapter = {
    id: 'pi' as const,
    startup: async () => {
      adapterStats.startups += 1;
      const prepared: PreparedExecutionQuery = {
        query: () =>
          (async function* () {
            adapterStats.queries += 1;
            const next = scriptQueue.shift() ?? { error: new Error('no scripted attempt') };
            if (next.error) throw next.error;
            for (const frame of next.frames ?? []) yield frame as RunnerMessage;
          })(),
        close: async () => {},
      };
      return prepared;
    },
  };
  __setPiAdapterForTests(fakeAdapter);

  const runJob = async (drawingId: string) =>
    buildDrawingGenerateHandler(db)([{ data: { drawing_id: drawingId } }]);

  const pgbossJobCount = async (drawingId?: string) => {
    const rows = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'drawing_generate'
          ${drawingId ? sql`AND data->>'drawing_id' = ${drawingId}` : sql``}`,
    );
    return rows[0]?.n ?? 0;
  };

  const seedDerivableEvent = async () => {
    const id = `evt_${newId()}`;
    await db.insert(event).values({
      id,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'yuk1548-verify',
      action: 'experimental:drawing_test_source',
      subject_kind: 'event',
      subject_id: id,
      outcome: 'success',
      payload: {},
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(),
    });
    return id;
  };

  const admit = async (
    sessionId: string,
    input: { brief: string; alt: string; caption?: string },
    ledger?: InstanceType<typeof TurnSourceLedger>,
  ) => {
    const bound = ledger ?? new TurnSourceLedger();
    if (!ledger) bound.note({ kind: 'event', id: await seedDerivableEvent() });
    return svc.requestDrawing(
      {
        db,
        sessionId,
        taskRunId: `run_copilot_${newId()}`,
        actorRef: 'yuk1548-verify',
        ledger: bound,
      },
      input,
      { boss: () => Promise.resolve(boss) },
    );
  };

  let failures = 0;
  const expect = (name: string, cond: boolean, detail: Record<string, unknown> = {}) => {
    if (!cond) failures += 1;
    record(name, cond, detail);
  };

  try {
    // ── 1. happy path: admit → queued row + durable send; job → ready + asset
    const startupsBefore = adapterStats.startups;
    const out1 = await admit('sess_a', { brief: '画一个滴定实验装置', alt: '滴定实验装置示意' });
    expect(
      'admission returns a placeholder without a model call',
      out1.status === 'ready' && adapterStats.startups === startupsBefore,
      { outcome: out1.status, startups: adapterStats.startups - startupsBefore },
    );
    const id1 = (out1 as { drawing_id: string }).drawing_id;
    expect('admission enqueued exactly one durable job', (await pgbossJobCount(id1)) === 1, {
      jobs: await pgbossJobCount(id1),
    });

    pushSvgResult(GOOD_SVG);
    await runJob(id1);
    const view1 = await svc.readDrawingStatus(db, id1, 'sess_a');
    expect(
      'job transitions queued→ready with a persisted svg asset',
      view1?.status === 'ready' && view1.asset?.mime_type === 'image/svg+xml',
      { status: view1?.status, asset: view1?.asset },
    );

    // ── 2. same content dedupes, no second send
    const outDup = await admit('sess_a', {
      brief: '画一个滴定实验装置',
      alt: '滴定实验装置示意',
    });
    expect(
      'duplicate live request dedupes onto the same drawing',
      (outDup as { drawing_id?: string }).drawing_id === id1 && (await pgbossJobCount(id1)) === 1,
      {
        drawing_id: (outDup as { drawing_id?: string }).drawing_id,
        jobs: await pgbossJobCount(id1),
      },
    );

    // ── 3. cross-learner read/mutation is indistinguishable from not-found
    const cross = await svc.readDrawingStatus(db, id1, 'sess_b');
    const crossCancel = await svc.cancelDrawing(db, id1, 'sess_b');
    const stillReady = await svc.readDrawingStatus(db, id1, 'sess_a');
    expect(
      'cross-session status and cancel return null and change nothing',
      cross === null && crossCancel === null && stillReady?.status === 'ready',
      { cross, crossCancel, owner_status: stillReady?.status },
    );

    // ── 4. quota failure → waiting_quota + delayed rearm, adapter retried later
    const out2 = await admit('sess_a', { brief: '画电路图', alt: '电路图' });
    const id2 = (out2 as { drawing_id: string }).drawing_id;
    pushApiError(429, 'rate limit');
    await runJob(id2);
    const row2 = (await db.select().from(drawing).where(eq(drawing.id, id2)))[0];
    const rearm2 = await pgbossJobCount(id2);
    expect(
      'provider 429 → waiting_quota with a delayed rearm send',
      row2?.status === 'waiting_quota' && row2.error_kind === 'quota' && rearm2 === 2,
      { status: row2?.status, error_kind: row2?.error_kind, jobs: rearm2 },
    );

    // quota clears: force the rearm due, scripted success → ready
    await db
      .update(drawing)
      .set({ retry_at: new Date(Date.now() - 1000) })
      .where(eq(drawing.id, id2));
    pushSvgResult(GOOD_SVG);
    await runJob(id2);
    const view2 = await svc.readDrawingStatus(db, id2, 'sess_a');
    expect('quota wait recovers to ready on the rearmed run', view2?.status === 'ready', {
      status: view2?.status,
    });

    // ── 5. login failure → waiting_login + rearm, recovers on the next run
    const out3 = await admit('sess_a', { brief: '画受力分析', alt: '受力分析' });
    const id3 = (out3 as { drawing_id: string }).drawing_id;
    pushApiError(401, 'unauthorized');
    await runJob(id3);
    const row3 = (await db.select().from(drawing).where(eq(drawing.id, id3)))[0];
    expect(
      'bound 401 → waiting_login with a delayed rearm send',
      row3?.status === 'waiting_login' && row3.error_kind === 'login',
      { status: row3?.status, error_kind: row3?.error_kind, jobs: await pgbossJobCount(id3) },
    );
    await db
      .update(drawing)
      .set({ retry_at: new Date(Date.now() - 1000) })
      .where(eq(drawing.id, id3));
    pushSvgResult(GOOD_SVG);
    await runJob(id3);
    const view3 = await svc.readDrawingStatus(db, id3, 'sess_a');
    expect(
      'login wait recovers to ready once the credential lane is back',
      view3?.status === 'ready',
      {
        status: view3?.status,
      },
    );

    // ── 6. unprovable source closure refuses at admission (no row, no send)
    const jobsBefore6 = await pgbossJobCount();
    const incomplete = new TurnSourceLedger();
    incomplete.noteUnknown('learner_state_header');
    const refused = await svc.requestDrawing(
      {
        db,
        sessionId: 'sess_a',
        taskRunId: `run_copilot_${newId()}`,
        actorRef: 'yuk1548-verify',
        ledger: incomplete,
      },
      { brief: '画天平', alt: '天平' },
      { boss: () => Promise.resolve(boss) },
    );
    const refuseIssue = (refused as { issues?: { code: string }[] }).issues?.[0]?.code;
    expect(
      'incomplete source closure → typed restricted_source, no row, no send',
      refuseIssue === 'restricted_source' && (await pgbossJobCount()) === jobsBefore6,
      { issue: refuseIssue, jobs: await pgbossJobCount() },
    );

    // ── 7. cancel fences the live row; the armed job exits without a send
    const out7 = await admit('sess_a', { brief: '画几何构图', alt: '几何构图' });
    const id7 = (out7 as { drawing_id: string }).drawing_id;
    await svc.cancelDrawing(db, id7, 'sess_a');
    const startupsBefore7 = adapterStats.startups;
    await runJob(id7);
    const view7 = await svc.readDrawingStatus(db, id7, 'sess_a');
    expect(
      'cancelled drawing is not claimed and makes no provider call',
      view7?.status === 'cancelled' && adapterStats.startups === startupsBefore7,
      { status: view7?.status, startups: adapterStats.startups - startupsBefore7 },
    );

    // ── 8. redraw on a terminal row bumps the generation and re-runs
    const redraw = await svc.redrawDrawing(db, id7, 'sess_a', {
      boss: () => Promise.resolve(boss),
    });
    pushSvgResult(GOOD_SVG);
    await runJob(id7);
    const view8 = await svc.readDrawingStatus(db, id7, 'sess_a');
    expect(
      'redraw queues a new generation and lands ready again',
      (redraw as { status?: string }).status === 'queued' &&
        view8?.status === 'ready' &&
        view8.attempt === 2,
      { redraw_status: (redraw as { status?: string }).status, after: view8 },
    );

    // ── 9. source retraction expires a live drawing; asset is never served
    const out9 = await admit('sess_a', { brief: '画杠杆', alt: '杠杆' });
    const id9 = (out9 as { drawing_id: string }).drawing_id;
    const srcRow = (await db.select().from(drawing).where(eq(drawing.id, id9)))[0];
    const eventId = srcRow?.sources[0]?.id;
    if (eventId) {
      await db
        .update(event)
        .set({ payload: { derivation_policy: 'deny' } })
        .where(eq(event.id, eventId));
    }
    const startupsBefore9 = adapterStats.startups;
    await runJob(id9);
    const view9 = await svc.readDrawingStatus(db, id9, 'sess_a');
    expect(
      'retracted source expires the drawing before the provider call',
      view9?.status === 'expired' &&
        view9.asset === null &&
        adapterStats.startups === startupsBefore9,
      { status: view9?.status, asset: view9?.asset },
    );

    // ── 10. TTL expiry fences the row before any send
    const out10 = await admit('sess_a', { brief: '画斜面', alt: '斜面' });
    const id10 = (out10 as { drawing_id: string }).drawing_id;
    await db
      .update(drawing)
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where(eq(drawing.id, id10));
    const startupsBefore10 = adapterStats.startups;
    await runJob(id10);
    const view10 = await svc.readDrawingStatus(db, id10, 'sess_a');
    expect(
      'expired drawing is fenced without a provider call',
      view10?.status === 'expired' && adapterStats.startups === startupsBefore10,
      { status: view10?.status },
    );

    // ── 11. misconfigured route fails closed before any provider send
    // Variant A: the pair is legal but not the dedicated Sol pair.
    setTestConfig({
      'task.DrawingTask.provider': 'openai',
      'task.DrawingTask.model': 'gpt-6-astra',
      'task.DrawingTask.reasoning': { level: 'high' },
      'task.DrawingTask.override_global_pin': true,
    });
    const out11 = await admit('sess_a', { brief: '画烧杯', alt: '烧杯' });
    const id11 = (out11 as { drawing_id: string }).drawing_id;
    const startupsBefore11 = adapterStats.startups;
    await runJob(id11);
    const row11 = (await db.select().from(drawing).where(eq(drawing.id, id11)))[0];
    expect(
      'non-Sol pair fails at the route assert, zero adapter startups',
      row11?.status === 'failed' &&
        row11.error_kind === 'config' &&
        adapterStats.startups === startupsBefore11,
      { status: row11?.status, error_kind: row11?.error_kind },
    );
    // Variant B: lane unconfigured entirely.
    resetTestConfig();
    const out11b = await admit('sess_a', { brief: '画量筒', alt: '量筒' });
    const id11b = (out11b as { drawing_id: string }).drawing_id;
    await runJob(id11b);
    const row11b = (await db.select().from(drawing).where(eq(drawing.id, id11b)))[0];
    expect(
      'unconfigured lane fails closed before the provider call',
      row11b?.status === 'failed' &&
        row11b.error_kind === 'config' &&
        adapterStats.startups === startupsBefore11,
      { status: row11b?.status, error_kind: row11b?.error_kind },
    );
    // Restore the pinned lane for cleanliness.
    setTestConfig({
      'task.DrawingTask.provider': 'openai',
      'task.DrawingTask.model': 'gpt-6.1-sol',
      'task.DrawingTask.reasoning': { level: 'high' },
      'task.DrawingTask.override_global_pin': true,
    });
  } finally {
    __setPiAdapterForTests(undefined);
    resetTestConfig();
    await client.end().catch(() => undefined);
    await boss.stop().catch(() => undefined);
    await s3.close();
    await container.stop().catch(() => undefined);
  }

  mkdirSync(join(outPath, '..'), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        adapter: adapterStats,
        scenarios: evidence,
        failures,
      },
      null,
      2,
    ),
  );
  console.log(`evidence → ${outPath}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
