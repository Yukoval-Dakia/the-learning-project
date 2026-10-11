import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanup } from './cleanup.mjs';
import { copilot } from './copilot.mjs';
import { dayOne } from './day-one.mjs';
import { ROOT, cli, context, ledger, report, requireValue, save, sql } from './lib.mjs';
import { fixtures, photo } from './photo.mjs';

const options = cli();
let ctx;
try {
  requireValue(
    ['dry-run', 'photo', 'day-one', 'copilot', 'crisis', 'cleanup', 'census'].includes(
      options.command,
    ),
    'Commands: dry-run, photo, day-one, copilot, crisis, cleanup, census',
  );
  requireValue(!(options.command === 'dry-run' && options.live), 'dry-run never accepts --live');
  ctx = await context(options);
  await fixtures();
  if (options.command === 'dry-run') {
    await photo(ctx);
    await dayOne(ctx);
    await copilot(ctx);
    await copilot(ctx, true);
    await save(ctx.out, 'cleanup-plan.json', {
      execute: false,
      isolation: 'dedicated crisis-only empty TEST database',
      mutex: 'mkdir deployment.lock; token-checked release',
      backup: ['memories', 'sessions', 'events', 'brief'],
      verification:
        'exact counts and zero residual; writers stay stopped; completed audit ledgers retained',
    });
  } else if (options.command === 'photo') await photo(ctx);
  else if (options.command === 'day-one') await dayOne(ctx);
  else if (options.command === 'copilot' || options.command === 'crisis')
    await copilot(ctx, options.command === 'crisis');
  else if (options.command === 'cleanup') await cleanup(ctx, options.run);
  if (options.command === 'census') {
    const queries = (await readFile(join(ROOT, 'census/current.sql'), 'utf8'))
      .replace(/^--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const results = [];
    for (const query of queries) {
      if (!ctx.live) results.push({ query, execute: false });
      else {
        try {
          results.push({
            query,
            rows: await sql(ctx, query, query.includes('$1') ? [ctx.started] : []),
          });
        } catch (e) {
          results.push({
            query,
            error: e.message,
            verdict: 'SCHEMA_UNAVAILABLE; not an empty or passed result',
          });
        }
      }
    }
    await report(ctx, 'census', {}, { results });
  }
  if (ctx.live && options.command !== 'cleanup') await ledger(ctx);
} catch (e) {
  if (ctx)
    await save(ctx.out, 'failure.json', {
      error: e.message,
      paid_outcome: 'Inspect request journal; do not retry writes automatically',
      sessions: ctx.sessions,
    });
  if (ctx)
    await report(
      ctx,
      options.command,
      {},
      {
        failure: e.message,
        partial_evidence:
          'Requests and progress files remain sealed; missing final metrics are unmeasured',
      },
    );
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (ctx?.db) await ctx.db.end();
}
