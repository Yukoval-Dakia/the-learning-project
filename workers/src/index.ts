import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { tasks } from '../../src/ai/registry';
import { runTask, streamTask } from './ai/runner';
import { internalAuth } from './auth';
import { getDb } from './db';
import { seedKnowledge } from './knowledge/seed';
import { assets } from './routes/assets';
import { exportRoute } from './routes/export';
import { importRoute } from './routes/import';
import { ingestion } from './routes/ingestion';
import { knowledge } from './routes/knowledge';
import { learningItems } from './routes/learning_items';
import { logs } from './routes/logs';
import { mistakes } from './routes/mistakes';
import { review } from './routes/review';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use(
  '*',
  cors({
    origin: '*',
    allowHeaders: ['Content-Type', 'x-internal-token'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }),
);
app.use('/api/*', internalAuth);

app.route('/api/_/logs', logs);
app.route('/api/_/export', exportRoute);
app.route('/api/_/import', importRoute);
app.route('/api/assets', assets);
app.route('/api/knowledge', knowledge);
app.route('/api/mistakes', mistakes);
app.route('/api/ingestion', ingestion);
app.route('/api/learning-items', learningItems);
app.route('/api/review', review);

app.post('/api/_/seed', async (c) => {
  const result = await seedKnowledge(c.env.DB);
  return c.json(result);
});

app.get('/api/health', async (c) => {
  let db_ok = false;
  try {
    const result = await c.env.DB.prepare('SELECT 1 as ok').first<{ ok: number }>();
    db_ok = result?.ok === 1;
  } catch {
    db_ok = false;
  }
  return c.json({ ok: true, db_ok });
});

app.onError((err, c) => {
  console.error('worker error', err);
  return c.json({ error: 'internal_error', message: err.message }, 500);
});

app.post('/api/ai/:task', async (c) => {
  const taskKind = c.req.param('task');
  const body = (await c.req.json().catch(() => ({}))) as { input?: unknown };
  const def = (tasks as Record<string, { needsToolCall: boolean }>)[taskKind];
  if (!def) {
    return c.json({ error: 'unknown_task', task: taskKind }, 404);
  }

  if (def.needsToolCall) {
    // Multi-step tool calling → stream Response
    // Phase 1: tools registry not yet built; pass empty object to validate streaming pipeline
    const stream = streamTask(taskKind, body.input ?? {}, {
      env: c.env,
      tools: {},
    });
    return stream;
  }

  // Single-shot → JSON
  const result = await runTask(taskKind, body.input ?? {}, { env: c.env });
  return c.json(result);
});

export { getDb };
export default app;
