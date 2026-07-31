import { createServer } from 'node:http';

import { Agent } from 'undici';
import { describe, expect, it } from 'vitest';

import { fetchWithPinnedDispatcher } from './pinned-fetch';

describe('fetchWithPinnedDispatcher', () => {
  it('uses an npm Undici dispatcher without changing the URL host', async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(req.headers.host ?? 'missing-host');
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind TCP');

    const dispatcher = new Agent({
      connect: {
        lookup(_hostname, options, callback) {
          if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
          else callback(null, '127.0.0.1', 4);
        },
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 250,
      },
    });

    try {
      const response = await fetchWithPinnedDispatcher(
        `http://validated-public-host.test:${address.port}/image.png`,
        { dispatcher, redirect: 'manual' },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`validated-public-host.test:${address.port}`);
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
