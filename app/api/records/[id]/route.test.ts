import { createLearningRecord } from '@/server/records/queries';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { DELETE, GET, PATCH } from './route';

async function createInsight() {
  return createLearningRecord(testDb(), {
    kind: 'insight',
    title: '截面提示',
    content_md: '截面图先补全隐藏边',
    source: 'manual',
    capture_mode: 'text',
    activity_kind: 'annotate',
    knowledge_ids: [],
    payload: {},
    create_capture_event: true,
  });
}

describe('/api/records/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('GET returns one record', async () => {
    const created = await createInsight();

    const res = await GET(new Request(`http://localhost/api/records/${created.record.id}`), {
      params: Promise.resolve({ id: created.record.id }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string | null };
    expect(body.id).toBe(created.record.id);
    expect(body.title).toBe('截面提示');
  });

  it('PATCH updates editable fields with optimistic version', async () => {
    const created = await createInsight();

    const res = await PATCH(
      new Request(`http://localhost/api/records/${created.record.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 0,
          title: '更新后的提示',
          content_md: '先找共面点，再连线。',
          processing_status: 'linked',
        }),
      }),
      { params: Promise.resolve({ id: created.record.id }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title: string;
      content_md: string;
      processing_status: string;
      version: number;
    };
    expect(body.title).toBe('更新后的提示');
    expect(body.content_md).toBe('先找共面点，再连线。');
    expect(body.processing_status).toBe('linked');
    expect(body.version).toBe(1);
  });

  it('DELETE archives instead of deleting', async () => {
    const created = await createInsight();

    const res = await DELETE(new Request(`http://localhost/api/records/${created.record.id}`), {
      params: Promise.resolve({ id: created.record.id }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const getRes = await GET(new Request(`http://localhost/api/records/${created.record.id}`), {
      params: Promise.resolve({ id: created.record.id }),
    });
    const archived = (await getRes.json()) as { processing_status: string; archived_at: string };
    expect(archived.processing_status).toBe('archived');
    expect(archived.archived_at).toBeTruthy();
  });
});
