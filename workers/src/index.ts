import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { internalAuth } from './auth';
import { getDb } from './db';
import type { AppEnv } from './types';

const app = new Hono<AppEnv>();

app.use('*', cors({ origin: '*' }));
app.use('/api/*', internalAuth);

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

// AI Task 调度入口（Phase 1 留壳，PR 2 改进 6 实现）。
app.post('/api/ai/:task', async (c) => {
  const task = c.req.param('task');
  const body = await c.req.json().catch(() => ({}));
  return c.json({ error: 'not_implemented', task, received: body }, 501);
});

// 让 TS / wrangler 知道 db helper 存在（runtime 还没用，PR 2+ 启用）
export { getDb };

export default app;
