import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  ANTHROPIC_API_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors({ origin: '*' }));

app.get('/api/health', (c) => c.json({ ok: true }));

// AI Task 调度入口（Phase 1 留壳）。
// 下一步：查 src/ai/registry.ts 拿 TaskDef → 调 Vercel AI SDK
//   (`generateText` / `generateObject` / 允许的 tool calling) → 写 ToolCallLog + CostLedger。
app.post('/api/ai/:task', async (c) => {
  const task = c.req.param('task');
  const body = await c.req.json().catch(() => ({}));
  return c.json({ error: 'not_implemented', task, received: body }, 501);
});

export default app;
