import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildLegacySpa } from './frontdoor';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yuk1352-spa-'));
  await mkdir(join(root, 'assets'));
  await writeFile(
    join(root, 'index.html'),
    '<html lang="zh-CN"><div id="root">original SPA</div></html>',
  );
  await writeFile(join(root, 'assets/app.js'), 'export const original = true;');
});
afterEach(async () => {
  await rm(root, { recursive: true });
});

describe('P7-owned SPA fallback', () => {
  it.each(['/today', '/practice/attempt-1?return=%2Fquestions', '/admin/config'])(
    'serves the original document at %s',
    async (path) => {
      const response = await buildLegacySpa(root).request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
      expect(await response.text()).toContain('original SPA');
    },
  );

  it('serves JS bytes and never returns HTML for missing chunks', async () => {
    const app = buildLegacySpa(root);
    const asset = await app.request('/assets/app.js');
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(await asset.text()).toBe('export const original = true;');
    expect((await app.request('/assets/missing.js')).status).toBe(404);
    expect((await app.request('/_build/assets/missing.js')).status).toBe(404);
  });

  it('supports HEAD without bytes and refuses a page POST', async () => {
    const app = buildLegacySpa(root);
    const head = await app.request('/today', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await app.request('/today', { method: 'POST', body: 'not-a-command' })).status).toBe(
      404,
    );
  });
});
