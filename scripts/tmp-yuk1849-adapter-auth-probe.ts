// YUK-1849 acceptance arc companion — P1-A proof through the REAL pi adapter.
// A local HTTPS endpoint stands in for a provider: a custom-provider definition
// points the real runTask + resolveTaskProvider + PiAgentAdapter at 127.0.0.1,
// so every classification below is decided by the adapter's own bound evidence
// (provider_failure.http_status + zero-output), never by string matching and
// never at a seam. No paid call can occur — the only reachable endpoint is
// this process's own listener. TLS is a throwaway self-signed cert; the probe
// is launched with NODE_TLS_REJECT_UNAUTHORIZED=0.
//
// Custom buckets are excluded from the catalog host allowlist by design, so
// the allowlist install seam admits this listener explicitly — the same seam
// refreshModelCatalog uses, applied to one extra host. The synthetic catalog
// bucket is injected into model_catalog_cache.payload and restored after.
//
// Cases: 401 → config error; 403 → config error; 429 → not; 500 → not;
// 200 then tool-turn then 401 (output already started) → NOT a config error.
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 pnpm exec tsx scripts/tmp-yuk1849-adapter-auth-probe.ts

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { AgentRunError, isProviderAuthConfigError } from '@/ai/agent-run-error';
import { piCustomTool } from '@/ai/pi-tool-mount';
import { installCustomProviders } from '@/core/config/custom-providers';
import {
  installModelEndpointHostAllowlist,
  modelEndpointHostAllowlist,
} from '@/core/config/model-endpoint-allowlist';
import { db } from '@/db/client';
import { model_catalog_cache } from '@/db/schema';
import { hydrateModelCatalog } from '@/server/ai/model-catalog';
import { runTask } from '@/server/ai/runner';

const PROVIDER = 'custom:arc-fake' as const;
const MODEL = 'arc-flash';
const ENV_KEY = 'ARC_FAKE_API_KEY';

type Mode = 401 | 403 | 429 | 500 | 'toolcall-then-401';
let mode: Mode = 401;
let wireRequests = 0;
let firstToolCallDone = false;

const sendJson = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

let server: https.Server;

const evidence: Array<Record<string, unknown>> = [];
function note(phase: string, data: Record<string, unknown>) {
  const row = { phase, ...data };
  evidence.push(row);
  console.log(`[arc] ${phase}`, JSON.stringify(data));
}

async function main() {
  // Throwaway self-signed cert for 127.0.0.1.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-tls-'));
  const keyPath = path.join(tmp, 'key.pem');
  const certPath = path.join(tmp, 'cert.pem');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -days 1 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 2>/dev/null`,
  );
  const sendSseToolCallTurn = (res: import('node:http').ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({
        id: 'cmpl-arc-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    res.write(chunk({ role: 'assistant', content: 'calling ' }, null));
    res.write(chunk({ content: 'the probe tool' }, null));
    res.write(
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'mcp__probe__ping', arguments: '{}' },
            },
          ],
        },
        'tool_calls',
      ),
    );
    res.write(
      `data: ${JSON.stringify({
        id: 'cmpl-arc-1',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  };
  server = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (_req, res) => {
      wireRequests += 1;
      if (mode === 'toolcall-then-401' && !firstToolCallDone) {
        firstToolCallDone = true;
        // Turn 1: real assistant output (tokens > 0) ending in a tool call.
        sendSseToolCallTurn(res);
        return;
      }
      if (mode === 'toolcall-then-401') {
        sendJson(res, 401, {
          error: { message: 'revoked', type: 'authentication_error', code: '401' },
        });
        return;
      }
      sendJson(res, mode, {
        error: { message: `fake ${mode}`, type: 'authentication_error', code: String(mode) },
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `https://127.0.0.1:${port}/v1`;
  process.env[ENV_KEY] = 'arc-fake-key';

  installCustomProviders([
    {
      id: PROVIDER,
      displayName: 'arc fake provider',
      baseUrl,
      apiKeyEnv: ENV_KEY,
      protocol: 'openai-completions',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ]);

  // Inject the synthetic custom bucket into the cache payload, hydrate, then
  // admit this listener's host: synthetic `custom:*` buckets are deliberately
  // excluded from endpointHostsOf, so the install seam adds it on top.
  const [cacheRow] = await db
    .select({ payload: model_catalog_cache.payload })
    .from(model_catalog_cache)
    .where(eq(model_catalog_cache.id, 1))
    .limit(1);
  const originalPayload = cacheRow?.payload;
  const doc = (originalPayload ?? {}) as Record<string, unknown>;
  const providers = { ...(doc.providers as Record<string, unknown>) };
  providers[PROVIDER] = {
    models: {
      [MODEL]: {
        id: MODEL,
        name: MODEL,
        provider: { api: baseUrl, npm: '@ai-sdk/openai-compatible' },
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 64_000, input: 60_000, output: 8_000 },
        reasoning: false,
        tool_call: true,
      },
    },
  };
  await db
    .update(model_catalog_cache)
    .set({ payload: { ...doc, providers } })
    .where(eq(model_catalog_cache.id, 1));
  await hydrateModelCatalog(db);
  installModelEndpointHostAllowlist(
    new Set([...modelEndpointHostAllowlist(), `127.0.0.1:${port}`]),
  );
  note('setup', { baseUrl, allowlisted: modelEndpointHostAllowlist().has(`127.0.0.1:${port}`) });

  const probeTool = piCustomTool('probe', 'ping', 'probe ping', {}, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  const run = (withTool = false) =>
    runTask(
      'SourceGroundingVerifyTask',
      {
        text: 'probe',
        images: [
          {
            data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
            mediaType: 'image/png',
          },
        ],
      },
      {
        db,
        modelBinding: { provider: PROVIDER, model: MODEL },
        ...(withTool
          ? {
              piToolMounts: [{ type: 'custom' as const, tools: [probeTool] }],
              allowedTools: ['mcp__probe__ping'],
              budgetOverride: { maxIterations: 3 },
            }
          : {}),
      },
    );

  const classify = async (label: string) => {
    const before = wireRequests;
    try {
      await run(label === 'output-then-401');
      note(label, { status: 'returned', wireCalls: wireRequests - before });
      return { expected: label, authConfigError: false };
    } catch (err) {
      note(label, {
        error: err instanceof Error ? err.name : String(err),
        message: err instanceof Error ? err.message.slice(0, 220) : null,
        subtype: err instanceof AgentRunError ? err.subtype : null,
        providerHttpStatus:
          err instanceof AgentRunError ? (err.providerFailure?.http_status ?? null) : null,
        providerZeroOutput: err instanceof AgentRunError ? (err.providerZeroOutput ?? null) : null,
        authConfigError: isProviderAuthConfigError(err),
        wireCalls: wireRequests - before,
      });
      return { expected: label, authConfigError: isProviderAuthConfigError(err) };
    }
  };

  const results: Array<{ expected: string; authConfigError: boolean }> = [];
  mode = 401;
  results.push(await classify('http-401'));
  mode = 403;
  results.push(await classify('http-403'));
  mode = 429;
  results.push(await classify('http-429'));
  mode = 500;
  results.push(await classify('http-500'));
  mode = 'toolcall-then-401';
  firstToolCallDone = false;
  results.push(await classify('output-then-401'));

  const expect: Record<string, boolean> = {
    'http-401': true,
    'http-403': true,
    'http-429': false,
    'http-500': false,
    'output-then-401': false,
  };
  for (const row of results) {
    const want = expect[row.expected];
    if (row.authConfigError !== want)
      throw new Error(`${row.expected}: authConfigError=${row.authConfigError}, expected ${want}`);
  }
  console.log('\n=== EVIDENCE JSON ===');
  console.log(JSON.stringify({ evidence }, null, 2));

  // restore the catalog cache row exactly as found
  if (originalPayload !== undefined) {
    await db
      .update(model_catalog_cache)
      .set({ payload: originalPayload })
      .where(eq(model_catalog_cache.id, 1));
    await hydrateModelCatalog(db);
  }
}

main()
  .catch((err) => {
    console.error('PROBE FAILED', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    installCustomProviders([]);
    server?.close();
  });
