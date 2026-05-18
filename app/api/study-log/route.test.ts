import { describe, expect, it } from 'vitest';
import { DELETE } from './[id]/route';
import { GET, POST } from './route';

describe('/api/study-log retired route', () => {
  it('GET returns 410 Gone', async () => {
    const res = await GET();
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: string; replacement: string };
    expect(body.error).toBe('gone');
    expect(body.replacement).toBe('/api/records');
  });

  it('POST returns 410 Gone', async () => {
    const res = await POST();
    expect(res.status).toBe(410);
  });

  it('DELETE /api/study-log/[id] returns 410 Gone', async () => {
    const res = await DELETE(new Request('http://localhost/api/study-log/old'), {
      params: Promise.resolve({ id: 'old' }),
    });
    expect(res.status).toBe(410);
  });
});
