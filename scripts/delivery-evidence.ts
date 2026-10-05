// Delivery evidence collector — one command produces the paste-ready evidence block that
// PLAN.md delivery entries currently assemble by hand: exact-head git SHA + CI Gate run,
// compose container health/image/restart counts, API health + token contract, DB entity
// counts, pg-boss cron registrations, migration drift, retained-golden reaudit.
//
// Read-only: every probe is a query/fetch — no writes, no restarts, no paid provider calls.
// Fail-visible: a probe that can't run reports WARN/FAIL in the block instead of dying.
//
// CLI:
//   pnpm delivery:evidence           # human block; exit 1 on FAIL-level anomalies
//   pnpm delivery:evidence --json    # machine JSON (for delivery-note and tooling)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';
import postgres from 'postgres';

import { parseGolden, reauditGolden } from './golden-reaudit';
import { buildLocalDatabaseUrl } from './local-db-env';

// quiet: keep stdout clean for --json consumers (dotenv v17 prints inject banners otherwise).
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true }); // dotenv default: does not override already-set keys

export type EvidenceLevel = 'ok' | 'info' | 'warn' | 'fail';

export interface EvidenceCheck {
  label: string;
  level: EvidenceLevel;
  detail: string;
}

interface CiRun {
  databaseId: number;
  workflowName: string;
  status: string;
  conclusion: string | null;
  event: string;
}

interface ContainerInfo {
  name: string;
  service: string;
  image: string;
  status: string;
  health: string;
  restarts: number | null;
  publishedPort: number | null;
}

export interface DeliveryEvidence {
  collectedAt: string;
  checks: EvidenceCheck[];
  fields: {
    branch: string | null;
    sha: string | null;
    shortSha: string | null;
    dirtyFiles: number | null;
    gateRunId: number | null;
    gateConclusion: string | null;
    appImageTag: string | null;
    workerImageTag: string | null;
    counts: {
      event: number;
      task: number;
      attempt: number;
      queueActive: number;
      queueFailed: number;
    } | null;
    migrationsApplied: number | null;
    migrationFiles: number;
    cronNames: string[];
    goldenSummary: string;
  };
}

const LEVEL_RANK: Record<EvidenceLevel, number> = { ok: 0, info: 0, warn: 1, fail: 2 };

function sh(
  cmd: string,
  args: string[],
  timeoutMs = 20_000,
): { ok: boolean; out: string; err: string } {
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error) return { ok: false, out: '', err: String(r.error) };
    return {
      ok: r.status === 0,
      out: (r.stdout ?? '').trim(),
      err: (r.stderr ?? '').trim(),
    };
  } catch (e) {
    return { ok: false, out: '', err: String(e) };
  }
}

async function probe(url: string, headers: Record<string, string> = {}): Promise<string> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    return `${res.status}`;
  } catch (e) {
    return `ERR ${e instanceof Error ? e.message : String(e)}`;
  }
}

function parseComposePs(json: string): ContainerInfo[] {
  let raw: unknown[];
  try {
    const parsed = JSON.parse(json);
    raw = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    raw = json
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  return (raw as Record<string, unknown>[]).map((c) => {
    const publishers = (c.Publishers as { TargetPort?: number; PublishedPort?: number }[]) ?? [];
    const api = publishers.find((p) => p.TargetPort === 8787);
    return {
      name: String(c.Name ?? ''),
      service: String(c.Service ?? ''),
      image: String(c.Image ?? ''),
      status: String(c.Status ?? c.State ?? ''),
      health: String(c.Health ?? ''),
      restarts: null,
      publishedPort: api?.PublishedPort ?? null,
    };
  });
}

export async function collectDeliveryEvidence(): Promise<DeliveryEvidence> {
  const checks: EvidenceCheck[] = [];
  const fields: DeliveryEvidence['fields'] = {
    branch: null,
    sha: null,
    shortSha: null,
    dirtyFiles: null,
    gateRunId: null,
    gateConclusion: null,
    appImageTag: null,
    workerImageTag: null,
    counts: null,
    migrationsApplied: null,
    migrationFiles: 0,
    cronNames: [],
    goldenSummary: 'absent',
  };
  const check = (label: string, level: EvidenceLevel, detail: string) =>
    checks.push({ label, level, detail });

  // --- git ---
  const sha = sh('git', ['rev-parse', 'HEAD']);
  const branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = sh('git', ['status', '--porcelain']);
  fields.sha = sha.ok ? sha.out : null;
  fields.shortSha = fields.sha ? fields.sha.slice(0, 9) : null;
  fields.branch = branch.ok ? branch.out : null;
  fields.dirtyFiles = dirty.ok ? dirty.out.split('\n').filter(Boolean).length : null;
  check(
    'git',
    sha.ok ? 'ok' : 'fail',
    sha.ok
      ? `${fields.branch} @ ${fields.shortSha} dirty=${fields.dirtyFiles}`
      : `git rev-parse failed: ${sha.err}`,
  );

  // --- CI runs at exact head ---
  if (fields.sha) {
    const runs = sh('gh', [
      'run',
      'list',
      '--commit',
      fields.sha,
      '--limit',
      '40',
      '--json',
      'databaseId,workflowName,status,conclusion,event',
    ]);
    if (!runs.ok) {
      check('ci', 'warn', `gh run list failed: ${runs.err || 'gh unavailable'}`);
    } else {
      const list = JSON.parse(runs.out) as CiRun[];
      const gate = list.find((r) => r.workflowName === 'CI Gate') ?? null;
      fields.gateRunId = gate?.databaseId ?? null;
      fields.gateConclusion = gate ? (gate.conclusion ?? gate.status) : null;
      if (!gate) {
        check('ci', 'warn', `no CI Gate run for ${fields.shortSha} (${list.length} runs found)`);
      } else {
        check(
          'ci',
          gate.conclusion === 'success' ? 'ok' : gate.status !== 'completed' ? 'info' : 'fail',
          `CI Gate #${gate.databaseId} ${gate.conclusion ?? gate.status}`,
        );
      }
      const others = list
        .filter((r) => r.workflowName !== 'CI Gate')
        .map((r) => `${r.workflowName}=${r.conclusion ?? r.status}`);
      if (others.length > 0) check('ci-advisory', 'info', others.join('; '));
    }
  }

  // --- compose containers ---
  const ps = sh('docker', ['compose', 'ps', '--format', 'json']);
  let containers: ContainerInfo[] = [];
  if (ps.ok && ps.out) {
    try {
      containers = parseComposePs(ps.out);
    } catch (e) {
      check('compose', 'warn', `compose ps JSON parse failed: ${String(e)}`);
    }
  }
  if (containers.length > 0) {
    const names = containers.map((c) => c.name);
    const insp = sh('docker', ['inspect', '--format', '{{.Name}}|{{.RestartCount}}', ...names]);
    if (insp.ok) {
      const counts = new Map(
        insp.out.split('\n').map((l) => {
          const [n, c] = l.split('|');
          return [n.replace(/^\//, ''), Number(c)];
        }),
      );
      for (const c of containers) c.restarts = counts.get(c.name) ?? null;
    }
    const summary = containers
      .map(
        (c) =>
          `${c.service || c.name}=${c.image} ${c.status}${c.health ? `/${c.health}` : ''}` +
          ` restarts=${c.restarts ?? '?'}`,
      )
      .join(' | ');
    const core = containers.filter((c) => ['app', 'worker', 'postgres'].includes(c.service));
    const unhealthy = core.filter((c) => c.health && c.health !== 'healthy');
    const restarted = containers.filter((c) => (c.restarts ?? 0) > 0);
    check(
      'compose',
      unhealthy.length > 0 ? 'fail' : restarted.length > 0 ? 'warn' : 'ok',
      summary || 'no containers',
    );
    fields.appImageTag = containers.find((c) => c.service === 'app')?.image ?? null;
    fields.workerImageTag = containers.find((c) => c.service === 'worker')?.image ?? null;
  } else {
    check('compose', 'info', 'no compose containers running (dev topology or stack down)');
  }

  // --- API health + token contract ---
  const appPort =
    containers.find((c) => c.service === 'app')?.publishedPort ??
    Number(process.env.DELIVERY_API_PORT ?? 8787);
  const base = process.env.DELIVERY_API_BASE ?? `http://127.0.0.1:${appPort}`;
  const health = await probe(`${base}/api/health`);
  const appUp = containers.find((c) => c.service === 'app')?.health === 'healthy';
  check(
    'api-health',
    health.startsWith('2') ? 'ok' : appUp ? 'fail' : 'warn',
    `GET ${base}/api/health → ${health}`,
  );
  const noToken = await probe(`${base}/api/review/due?limit=1`);
  const token = process.env.INTERNAL_TOKEN;
  const withToken = token
    ? await probe(`${base}/api/review/due?limit=1`, { 'x-internal-token': token })
    : 'skipped (no INTERNAL_TOKEN)';
  check(
    'api-auth',
    noToken === '401' && withToken.startsWith('2')
      ? 'ok'
      : health.startsWith('2') || appUp
        ? 'fail'
        : 'warn',
    `protected route: no-token=${noToken} with-token=${withToken}`,
  );

  // --- DB counts + crons + migration drift (host port 5433 path; same for dev/prod on Mac) ---
  const sql = postgres(buildLocalDatabaseUrl(process.env), {
    max: 1,
    connect_timeout: 5,
    prepare: false,
  });
  try {
    const core = await sql<{ k: string; c: number }[]>`
      select 'event' k, count(*)::int c from event
      union all select 'task', count(*)::int from ai_task_runs
      union all select 'attempt', count(*)::int from provider_attempt`;
    const boss = await sql<{ k: string; c: number }[]>`
      select 'queue_active' k, count(*)::int c from pgboss.job
        where state in ('created', 'retry', 'active')
      union all select 'queue_failed', count(*)::int from pgboss.job where state = 'failed'`;
    const m = Object.fromEntries([...core, ...boss].map((r) => [r.k, r.c]));
    fields.counts = {
      event: m.event ?? 0,
      task: m.task ?? 0,
      attempt: m.attempt ?? 0,
      queueActive: m.queue_active ?? 0,
      queueFailed: m.queue_failed ?? 0,
    };
    check(
      'db-counts',
      fields.counts.queueFailed > 0 ? 'warn' : 'ok',
      `event=${m.event} task=${m.task} attempt=${m.attempt} ` +
        `queue_active=${m.queue_active} queue_failed=${m.queue_failed}`,
    );

    const schedules = await sql<Record<string, unknown>[]>`
      select row_to_json(s) as j from pgboss.schedule s order by s.name`;
    fields.cronNames = schedules.map((s) => {
      const j = s.j as { name?: string; cron?: string; timezone?: string };
      return `${j.name}(${j.cron ?? '?'}${j.timezone ? ` ${j.timezone}` : ''})`;
    });
    check(
      'crons',
      'ok',
      fields.cronNames.length > 0 ? fields.cronNames.join('; ') : 'no pgboss schedules',
    );

    const mig = await sql<
      { c: number }[]
    >`select count(*)::int c from drizzle.__drizzle_migrations`;
    fields.migrationsApplied = mig[0]?.c ?? null;
  } catch (e) {
    check(
      'db',
      containers.some((c) => c.service === 'postgres' && c.health === 'healthy') ? 'fail' : 'warn',
      `postgres query failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await sql.end({ timeout: 3 });
  }

  // migration files on disk
  try {
    fields.migrationFiles = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).length;
  } catch {
    check('migrations', 'warn', 'drizzle/ dir unreadable');
  }
  if (fields.migrationsApplied !== null) {
    check(
      'migrations',
      fields.migrationsApplied === fields.migrationFiles ? 'ok' : 'fail',
      `applied=${fields.migrationsApplied} files=${fields.migrationFiles} ` +
        `drift=${fields.migrationFiles - fields.migrationsApplied}`,
    );
  }

  // --- retained golden reaudit (pure in-memory; latest file per kind) ---
  const goldenDir = resolve(fileURLToPath(new URL('./golden', import.meta.url)));
  if (existsSync(goldenDir)) {
    const byKind = new Map<string, string>();
    for (const f of readdirSync(goldenDir).sort()) {
      const m = /^(.*)-\d{4}-\d{2}-\d{2}\.json$/.exec(f);
      if (m) byKind.set(m[1], f); // lexical sort ⇒ last wins = latest
    }
    if (byKind.size === 0) {
      fields.goldenSummary = 'no retained goldens';
      check('golden', 'info', 'scripts/golden/ has no snapshots');
    } else {
      const driftedKinds: string[] = [];
      let checkedKinds = 0;
      for (const [kind, file] of byKind) {
        try {
          const result = reauditGolden(parseGolden(readFileSync(resolve(goldenDir, file), 'utf8')));
          checkedKinds += 1;
          if (result.drifted.length > 0) driftedKinds.push(`${kind}(${result.drifted.length})`);
        } catch (e) {
          driftedKinds.push(`${kind}(ERR ${e instanceof Error ? e.message : String(e)})`);
        }
      }
      fields.goldenSummary =
        driftedKinds.length === 0
          ? `${checkedKinds}/${byKind.size} clean`
          : `drift: ${driftedKinds.join(',')}`;
      check(
        'golden',
        driftedKinds.length === 0 ? 'ok' : 'fail',
        `${checkedKinds} kinds re-folded — ${fields.goldenSummary}`,
      );
    }
  } else {
    check('golden', 'info', 'scripts/golden/ absent — no retained goldens on this machine');
  }

  return { collectedAt: new Date().toISOString(), checks, fields };
}

export function formatEvidence(ev: DeliveryEvidence): string {
  const lines = [`== delivery evidence — ${ev.collectedAt} ==`];
  for (const c of ev.checks) {
    lines.push(`${c.level.toUpperCase().padEnd(4)} ${c.label}: ${c.detail}`);
  }
  const worst = ev.checks.reduce<EvidenceLevel>(
    (w, c) => (LEVEL_RANK[c.level] > LEVEL_RANK[w] ? c.level : w),
    'ok',
  );
  const anomalies = ev.checks.filter((c) => LEVEL_RANK[c.level] >= LEVEL_RANK.warn);
  lines.push(
    `verdict: ${worst === 'ok' || worst === 'info' ? 'CLEAN' : worst.toUpperCase()}` +
      (anomalies.length > 0 ? ` — ${anomalies.map((a) => a.label).join(', ')}` : ''),
  );
  return lines.join('\n');
}

async function main() {
  const ev = await collectDeliveryEvidence();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(ev, null, 2));
  } else {
    console.log(formatEvidence(ev));
  }
  const hasFail = ev.checks.some((c) => c.level === 'fail');
  process.exit(hasFail ? 1 : 0);
}

// CLI-gate: same path-resolved idiom as the audit scripts — importing this module must not run probes.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
