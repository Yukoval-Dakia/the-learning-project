import { Hono } from 'hono';
import { acceptProposal, dismissProposal } from '../knowledge/proposals';
import { streamReviewTask } from '../knowledge/review';
import { loadTreeSnapshot } from '../knowledge/tree';
import type { AppEnv } from '../types';

export const knowledge = new Hono<AppEnv>();

knowledge.get('/', async (c) => {
  const rows = await loadTreeSnapshot(c.env.DB);
  return c.json({ rows });
});

knowledge.get('/proposals', async (c) => {
  const status = c.req.query('status') ?? 'pending';
  const rows = await c.env.DB.prepare(
    `select id, kind, payload, reasoning, status, proposed_at, decided_at from dreaming_proposal where kind = 'knowledge' and status = ? order by proposed_at desc`,
  )
    .bind(status)
    .all<Record<string, unknown>>();
  return c.json({ rows: rows.results });
});

knowledge.post('/proposals/:id/decide', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { decision?: string };
  if (body.decision !== 'accept' && body.decision !== 'reject') {
    return c.json({ error: 'missing or invalid decision', allowed: ['accept', 'reject'] }, 400);
  }
  try {
    if (body.decision === 'accept') {
      const result = await acceptProposal(c.env.DB, id);
      return c.json(result);
    }
    await dismissProposal(c.env.DB, id);
    return c.json({ kind: 'dismissed' });
  } catch (e) {
    const msg = (e as Error).message;
    if (/PR A.*propose_new/i.test(msg)) {
      return c.json({ error: 'unsupported_mutation', message: msg }, 400);
    }
    if (/^unknown_mutation/i.test(msg)) {
      return c.json({ error: 'unknown_mutation', message: msg }, 400);
    }
    if (/not.*pending/i.test(msg)) {
      return c.json({ error: 'not_pending', message: msg }, 409);
    }
    if (/not found/i.test(msg)) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (/^stale/i.test(msg)) {
      return c.json({ error: 'stale', message: msg }, 409);
    }
    throw e;
  }
});

knowledge.post('/review', async (c) => {
  return streamReviewTask({ env: c.env });
});
