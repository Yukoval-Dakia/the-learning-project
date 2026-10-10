import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCK, readJson, requireValue, save, sql } from './lib.mjs';

export async function cleanup(ctx, runPath) {
  requireValue(runPath, 'Pass --run <crisis result directory>');
  const run = await readJson(join(runPath, 'run.json'));
  const sessions = await readJson(join(runPath, 'sessions.json'));
  const empty = await readJson(join(runPath, 'empty-identity.json'));
  requireValue(
    Object.values(empty).every((n) => n === 0),
    'Crisis must have started on an empty learner database',
  );
  requireValue(
    run.command === 'crisis' && run.live && sessions.length > 0,
    'Only a live crisis receipt can be cleaned',
  );
  requireValue(
    run.deployment.database === ctx.config.deployment.database &&
      run.deployment.base_url === ctx.config.deployment.base_url,
    'Cleanup target must match exact crisis deployment',
  );
  if (!ctx.live)
    return save(ctx.out, 'cleanup-plan.json', {
      sessions,
      mutex: LOCK,
      backup: 'Full memories/sessions/events/brief before deletion',
      scope: 'Dedicated crisis-only database; no other sessions allowed',
      execute: false,
    });
  requireValue(
    ctx.config.cleanup?.writers_stopped === true && ctx.config.cleanup.receipt_path,
    'Operator must stop app/worker writers under this mutex and seal container/process receipt',
  );
  const stop = await readJson(ctx.config.cleanup.receipt_path);
  requireValue(
    stop.database === run.deployment.database &&
      stop.writers_stopped === true &&
      stop.running_writers === 0 &&
      stop.operator &&
      stop.observed_at &&
      stop.lock_token,
    'Invalid stopped-writers receipt',
  );
  // Coordinator holds the same mutex while stopping writers. Adopt only its exact token,
  // or acquire an absent lock; never steal another owner or release its lock.
  let owned = false;
  const token = randomUUID();
  try {
    try {
      await mkdir(LOCK);
      owned = true;
      await save(LOCK, 'owner.json', {
        token,
        database: run.deployment.database,
        purpose: 'YUK-1388 crisis cleanup',
      });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = await readJson(join(LOCK, 'owner.json'));
      requireValue(
        owner.token === stop.lock_token && owner.database === run.deployment.database,
        'Deployment mutex held by another owner',
      );
    }
    const age = Date.now() - Date.parse(stop.observed_at);
    requireValue(age >= 0 && age < 600000, 'Stopped-writers receipt must be under ten minutes old');
    const active = await sql(
      ctx,
      "select count(*) as n from pgboss.job where state in ('created','retry','active')",
    );
    requireValue(
      Number(active[0].n) === 0,
      'Unsettled crisis-derived jobs remain; drain through existing recovery owner before cleanup',
    );
    const foreign = await sql(
      ctx,
      'select id from learning_session where not (id=any($1::text[]))',
      [sessions],
    );
    requireValue(
      foreign.length === 0,
      'Dedicated crisis database contains unrelated sessions; refusing broad cleanup',
    );
    for (const table of ['goal', 'question', 'artifact', 'learning_item']) {
      requireValue(
        Number((await sql(ctx, `select count(*) as n from ${table}`))[0].n) === 0,
        'Crisis database has non-crisis learner state; refusing cleanup',
      );
    }
    const workflows = await sql(
      ctx,
      "select table_schema from information_schema.tables where table_name='workflow_status'",
    );
    for (const { table_schema: schema } of workflows) {
      requireValue(/^[a-z0-9_]+$/.test(schema), 'Unexpected workflow schema');
      const pending = await sql(
        ctx,
        `select count(*) as n from ${schema}.workflow_status where status in ('PENDING','ENQUEUED')`,
      );
      requireValue(
        Number(pending[0].n) === 0,
        'Unsettled DBOS workflow remains; keep writers stopped',
      );
    }
    const backup = {
      sessions: await sql(ctx, 'select * from learning_session where id=any($1::text[])', [
        sessions,
      ]),
      events: await sql(ctx, 'select * from event'),
      memories: await sql(ctx, 'select * from learning_project_memories'),
      brief: await sql(ctx, 'select * from memory_brief_note'),
    };
    requireValue(
      backup.sessions.length === sessions.length,
      'Session count changed; cleanup receipt needs reconciliation',
    );
    // Database was empty before crisis. All resulting derived memories/briefs belong to this
    // disposable identity, including late C3/C4 non-crisis facts missed by text matching.
    await save(ctx.out, 'cleanup-backup.json', backup);
    await ctx.db.query('BEGIN');
    try {
      const removed = {};
      for (const [table, expected] of [
        ['learning_project_memories', backup.memories.length],
        ['memory_brief_note', backup.brief.length],
        ['event', backup.events.length],
        ['learning_session', backup.sessions.length],
      ]) {
        const r = await ctx.db.query(`DELETE FROM ${table}`);
        requireValue(r.rowCount === expected, `Exact deletion count changed: ${table}`);
        removed[table] = r.rowCount;
      }
      await ctx.db.query('COMMIT');
      await save(ctx.out, 'cleanup-receipt.json', {
        removed,
        verified_at: new Date().toISOString(),
        database: run.deployment.database,
        brief: 'Deleted for disposable isolated identity; no shared global brief to regenerate',
        retained: [
          'memory_reconciliation_log',
          'completed pgboss jobs',
          'job_events',
          'provider logs and Mem0 history if any',
          'sealed evidence',
        ],
      });
    } catch (e) {
      await ctx.db.query('ROLLBACK');
      throw e;
    }
    for (const table of [
      'learning_project_memories',
      'memory_brief_note',
      'event',
      'learning_session',
    ]) {
      requireValue(
        Number((await sql(ctx, `select count(*) as n from ${table}`))[0].n) === 0,
        `Cleanup residual in ${table}`,
      );
    }
    await save(ctx.out, 'cleanup-required.json', {
      required: true,
      status: 'CLEANED',
      run_id: run.id,
      verification: 'Writers remain stopped; recheck before any reuse',
    });
  } finally {
    if (owned) {
      const owner = JSON.parse(await readFile(join(LOCK, 'owner.json'), 'utf8'));
      requireValue(owner.token === token, 'Lock ownership changed; refusing release');
      await unlink(join(LOCK, 'owner.json'));
      await rmdir(LOCK);
    }
  }
}
