import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const LOCK =
  '/Volumes/YukovalSBak/yukoval-projects/tlp-local-prod-20260907.sjUaCU/deployment-20261007/deployment.lock';
export const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
export const sha = (x) =>
  createHash('sha256')
    .update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x))
    .digest('hex');
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function save(out, name, value) {
  await writeFile(join(out, name), `${JSON.stringify(value, null, 2)}\n`);
}
export function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
export function cli() {
  const [command = 'dry-run', ...args] = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  return {
    command,
    live: args.includes('--live'),
    config: args.includes('--config') ? value('--config') : join(ROOT, 'config.example.json'),
    out: args.includes('--out')
      ? value('--out')
      : join(ROOT, 'results', `${Date.now()}-${randomUUID()}`),
    run: args.includes('--run') ? value('--run') : null,
  };
}
export async function context(options) {
  const config = await readJson(options.config);
  await mkdir(dirname(options.out), { recursive: true });
  await mkdir(options.out); // A lost paid outcome is never overwritten or silently retried.
  const ctx = {
    config,
    out: options.out,
    live: options.live,
    id: randomUUID(),
    started: new Date().toISOString(),
    requests: [],
    sessions: [],
  };
  await save(ctx.out, 'run.json', {
    id: ctx.id,
    started: ctx.started,
    command: options.command,
    live: ctx.live,
    config_digest: sha(config),
    deployment: config.deployment,
  });
  if (ctx.live) {
    const d = config.deployment;
    requireValue(
      d?.environment === 'TEST' && d.dedicated_synthetic === true && d.production === false,
      'Requires a dedicated synthetic TEST deployment receipt',
    );
    requireValue(/^acceptance_[a-z0-9_]+$/.test(d.database), 'Database name must be acceptance_*');
    requireValue(
      /^[a-f0-9]{40}$/.test(d.revision) &&
        d.image_id &&
        d.operator &&
        d.observed_at &&
        d.binding_evidence,
      'Seal exact deployed revision/image/operator/time',
    );
    const age = Date.now() - Date.parse(d.observed_at);
    requireValue(age >= 0 && age < 3600_000, 'Deployment witness must be less than one hour old');
    const url = new URL(d.base_url);
    requireValue(
      ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === '/' &&
        !url.search &&
        !url.hash,
      'Use an origin URL without credentials/path',
    );
    requireValue(
      process.env.ACCEPTANCE_INTERNAL_TOKEN && process.env.ACCEPTANCE_DATABASE_URL,
      'Set ACCEPTANCE_INTERNAL_TOKEN and ACCEPTANCE_DATABASE_URL',
    );
    if (!['census', 'cleanup'].includes(options.command))
      requireValue(
        config.approval?.paid_calls === true &&
          config.approval.cap_usd > 0 &&
          config.approval.max_requests > 0,
        'Separate paid batch approval and request cap required',
      );
    const binding = await readJson(d.binding_evidence);
    requireValue(
      binding.environment === 'TEST' &&
        binding.dedicated_synthetic === true &&
        binding.production === false &&
        binding.database === d.database &&
        binding.base_url === d.base_url &&
        binding.revision === d.revision &&
        binding.image_id === d.image_id &&
        binding.isolated_blob_storage === true &&
        binding.blob_namespace &&
        binding.observer_address &&
        binding.observer_port,
      'Deployment binding receipt disagrees or lacks isolated blob/database witness',
    );
    await save(ctx.out, 'deployment-binding.json', binding);
    const { default: pg } = await import('pg');
    ctx.db = new pg.Client({
      connectionString: process.env.ACCEPTANCE_DATABASE_URL,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    });
    try {
      await ctx.db.connect();
      const identity = await sql(
        ctx,
        'select current_database() as database, inet_server_addr() as address, inet_server_port() as port',
      );
      requireValue(
        identity[0].database === d.database,
        'Observer database disagrees with TEST receipt',
      );
      requireValue(
        String(identity[0].address) === String(binding.observer_address) &&
          Number(identity[0].port) === Number(binding.observer_port),
        'SQL endpoint disagrees with deployment binding',
      );
      await save(ctx.out, 'database-witness.json', identity);
      if (options.command !== 'cleanup') success(await api(ctx, 'GET', '/api/ready'));
    } catch (e) {
      await ctx.db.end();
      await save(ctx.out, 'failure.json', { error: e.message, stage: 'preflight' });
      throw e;
    }
  }
  return ctx;
}
export async function sql(ctx, query, values = []) {
  await ctx.db.query('BEGIN READ ONLY');
  try {
    const result = await ctx.db.query(query, values);
    await ctx.db.query('COMMIT');
    return result.rows;
  } catch (e) {
    await ctx.db.query('ROLLBACK');
    throw e;
  }
}
export async function api(
  ctx,
  method,
  path,
  body,
  { timeout = 30000, headers = {}, inputDigest = null, requestEvidence = null } = {},
) {
  requireValue(ctx.live, 'Dry-run must never use API');
  requireValue(
    path.startsWith('/api/') && !path.startsWith('/api/_/'),
    'Only product API paths; no restore/import-admin paths',
  );
  requireValue(
    ctx.requests.length < ctx.config.approval.max_requests,
    'Request cap reached; no retry',
  );
  const start = performance.now();
  const item = {
    ordinal: ctx.requests.length,
    method,
    path,
    started_at: new Date().toISOString(),
    request: body instanceof FormData ? requestEvidence : (body ?? null),
    input_digest: body instanceof FormData ? inputDigest : sha(body ?? null),
    idempotency_key: headers['Idempotency-Key'] ?? null,
  };
  ctx.requests.push(item);
  await appendFile(
    join(ctx.out, 'requests.jsonl'),
    `${JSON.stringify({ ...item, outcome: 'initiating' })}\n`,
  );
  try {
    const r = await fetch(new URL(path, ctx.config.deployment.base_url), {
      method,
      headers: {
        'x-internal-token': process.env.ACCEPTANCE_INTERNAL_TOKEN,
        ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeout))),
      redirect: 'error',
    });
    const raw = await r.text();
    Object.assign(item, {
      status: r.status,
      ms: performance.now() - start,
      finished_at: new Date().toISOString(),
      output_digest: sha(raw),
      body: JSON.parse(raw),
      location: r.headers.get('location'),
    });
    await appendFile(join(ctx.out, 'requests.jsonl'), `${JSON.stringify(item)}\n`);
    return item;
  } catch (e) {
    Object.assign(item, {
      ms: performance.now() - start,
      error: e.message,
      outcome: method === 'GET' ? 'read_failed' : 'unknown_external_outcome',
    });
    await appendFile(join(ctx.out, 'requests.jsonl'), `${JSON.stringify(item)}\n`);
    throw new Error(`${method} ${path}: ${item.outcome}; inspect journal before any replay`, {
      cause: e,
    });
  }
}
export function success(r) {
  requireValue(r.status >= 200 && r.status < 300, `${r.method} ${r.path}: HTTP ${r.status}`);
  return r.body;
}
export async function poll(ctx, path, done, deadline) {
  let last;
  while (performance.now() < deadline) {
    last = success(
      await api(ctx, 'GET', path, undefined, {
        timeout: Math.min(30000, deadline - performance.now()),
      }),
    );
    if (done(last)) return last;
    await pause(Math.min(1000, Math.max(0, deadline - performance.now())));
  }
  return last;
}
export function responses(dto, answer) {
  const slots = dto.response_spec.slots.filter((s) => s.kind !== 'table');
  const parts = answer.split('；');
  requireValue(
    slots.length === 1 || parts.length === slots.length,
    'Multi-slot answer needs explicit one-answer-per-slot; no guessing',
  );
  return {
    entries: slots.map((s, i) => {
      const a = slots.length === 1 ? answer : parts[i];
      const base = { slot_id: s.slot_id };
      if (s.kind === 'single_choice') {
        const option = s.options.find((x) => x.label === a);
        requireValue(option, 'Gold choice label absent from public DTO');
        return { ...base, kind: 'choice', option_ids: [option.option_id] };
      }
      if (s.kind === 'numeric') {
        requireValue(Number.isFinite(Number(a)), 'Numeric gold requires an explicit number');
        return { ...base, kind: 'numeric', value: Number(a), raw_input: a };
      }
      if (s.kind === 'formula') return { ...base, kind: 'formula', latex: a };
      if (s.kind === 'open_response') return { ...base, kind: 'open', text_md: a, evidence: [] };
      requireValue(
        s.kind === 'text',
        `Unsupported response slot ${s.kind}; human mapping required`,
      );
      return { ...base, kind: 'text', text_md: a };
    }),
  };
}
export async function grade(ctx, qid, issued, answer, { placement = null, timeout = 30000 } = {}) {
  const dto = issued.practice_dto ?? issued.state?.practice_dto;
  requireValue(dto, 'No pinned public DTO');
  const iid = dto.issuance_id;
  let identity = issued;
  let sid;
  if (!placement) {
    identity = success(
      await api(ctx, 'POST', '/api/solve-sessions', { question_id: qid, issuance_id: iid }),
    );
    sid = identity.session_id;
  }
  const assessment = {
    issuance_id: iid,
    evaluation_group_id: identity.evaluation_group_id,
    idempotency_key: identity.idempotency_key,
    response_set: responses(dto, answer),
    group_evidence: [],
  };
  requireValue(
    assessment.evaluation_group_id && assessment.idempotency_key,
    'Missing pinned submission identity',
  );
  const body = placement
    ? {
        question_id: qid,
        session_id: placement,
        rating: 'good',
        auto_rate: true,
        response_md: answer,
        referenced_knowledge_ids: [],
        assessment,
      }
    : { question_id: qid, assessment, student_final_answer_text: answer, hints_used: 0 };
  const r = await api(
    ctx,
    'POST',
    placement ? '/api/attempts' : `/api/solve-sessions/${sid}/submissions`,
    body,
    { timeout },
  );
  // Pending is not a grade; callers record failure to deliver, never self-report to force success.
  return { response: r, effective: r.status < 300 && r.body.status === 'effective', sid };
}
export async function ledger(ctx) {
  const runs = await sql(
    ctx,
    'select id,task_kind,provider,model,status,cost_usd,cost_basis,input_hash,result_digest,started_at,finished_at from ai_task_runs where started_at >= $1 order by started_at',
    [ctx.started],
  );
  const attempts = await sql(
    ctx,
    'select attempt_id,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json from provider_attempt where started_at >= $1 order by started_at',
    [ctx.started],
  );
  await save(ctx.out, 'provider-ledger.json', {
    runs,
    attempts,
    note: 'API digests are not model-output digests. Null receipts remain unknown. Includes background tail observed at this instant.',
  });
}
export async function report(ctx, name, metrics, extra = {}) {
  const baselines = await readJson(join(ROOT, 'baselines.json'));
  const rows = Object.entries(baselines.metrics).map(([key, baseline]) => ({
    metric: key,
    current: metrics[key] ?? null,
    baseline: baseline.value,
    unit: baseline.unit,
    source: baseline.source,
  }));
  await save(ctx.out, `${name}.json`, {
    run_id: ctx.id,
    live: ctx.live,
    deployment_revision: ctx.config.deployment.revision,
    metrics,
    comparison: rows,
    ...extra,
  });
  const selected = rows.filter((r) => {
    if (name === 'photo') return r.metric.startsWith('photo_') || r.metric === 'kc_auto_approved';
    if (name === 'copilot') return r.metric.startsWith('copilot_');
    if (name === 'crisis') return r.metric.startsWith('crisis_');
    if (name === 'census')
      return (
        r.metric.startsWith('long_task_') ||
        r.metric.startsWith('notes_') ||
        r.metric.startsWith('cold_starter_')
      );
    return [
      'first_item_ms',
      'grading_ms',
      'first_help_ms',
      'first_material_ms',
      'total_wait_ms',
      'journey_ms',
      'actions_to_first_item',
      'served_gradable',
      'self_rating_share',
      'photo_transcription_fields',
      'help_without_output',
      'wait_without_visible_progress',
      'kc_auto_approved',
    ].includes(r.metric);
  });
  const show = (x) =>
    x == null ? 'UNMEASURED' : typeof x === 'object' ? JSON.stringify(x) : String(x);
  await writeFile(
    join(ctx.out, `${name}.md`),
    `| Metric | Current | Audit baseline |\n| --- | --- | --- |\n${rows.map((r) => `| ${r.metric} | ${show(r.current)} | ${show(r.baseline)} |`).join('\n')}\n\nAPI outcomes alone do not close a delivery stage. See README for browser, observer and human gates.\n`,
  );
  console.log(`${name}: ${ctx.out}`);
  console.log('| Metric | Current | Audit baseline |');
  console.log('| --- | --- | --- |');
  for (const row of selected)
    console.log(`| ${row.metric} | ${show(row.current)} | ${show(row.baseline)} |`);
}
