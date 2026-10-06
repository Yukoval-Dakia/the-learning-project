// Explicit opt-in, four single-shot synthetic cases, $0.75 reserved per case.
// Unique capture id + exclusive artifact writes prevent overwriting prior evidence.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { Memory } from 'mem0ai/oss';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestConfig } from '@/core/config/store';
import { ai_task_runs, cost_ledger, provider_attempt } from '@/db/schema';
import { createPiModelExecutor } from '@/server/assessment/pi-model-executor';
import { createMemoryClient } from '@/server/memory/client';
import { resolveMemoryLlmConfig } from '@/server/memory/llm-config';
import { judgeReconciliation } from '@/server/memory/reconcile-llm';
import {
  assessmentDigest as digest,
  nativeAssessmentFixture,
} from '../../../tests/fixtures/assessment-native-model';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { createDirectProviderOperationContext } from './direct-provider-attempt';
import { createMem0OpaqueOperationContext } from './opaque-provider-operation';

vi.hoisted(() => vi.stubEnv('MEM0_TELEMETRY', 'false'));
const enabled = process.env.YUK1341_PRODUCT_ACTUAL === '1';
const captureId = process.env.YUK1341_ACTUAL_CAPTURE_ID;
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: process.cwd(),
  encoding: 'utf8',
}).trim();
const cases = ['native-math', 'native-vision', 'mem0-extraction', 'memory-reconcile'] as const;
const artifact = (name: string) =>
  join(
    process.cwd(),
    `docs/planning/evidence/2026-10-07-yuk1341-product-${captureId}-${name}.json`,
  );

beforeEach(async () => {
  await resetDb();
  resetTestConfig();
});
afterEach(() => resetTestConfig());

describe.skipIf(!enabled)('product routing actual output, no retries', () => {
  it.each(cases)('%s', { timeout: 180_000 }, async (name) => {
    if (!captureId || !/^[a-zA-Z0-9-]+$/.test(captureId))
      throw new Error('Unique capture id required');
    if (cases.some((entry) => existsSync(artifact(entry))) && existsSync(artifact(name))) {
      throw new Error('Capture already sealed; do not reburn');
    }
    if (!process.env.OPENCODE_API_KEY) throw new Error('Go key required');
    if (
      process.env.AI_PROVIDER_OVERRIDE !== 'opencode-go' ||
      process.env.AI_PROVIDER_MODEL !== 'mimo-v2.6-pro'
    )
      throw new Error('Product pair must be pinned');
    const id = randomUUID();
    const evidence: Record<string, unknown> = {
      code_revision: revision,
      captured_at: new Date().toISOString(),
      capture_id: captureId,
      case: name,
      synthetic_only: true,
      reserved_usd: 0.75,
      max_total_reserve_usd: 3,
      provider: 'opencode-go',
      model: 'mimo-v2.6-pro',
      task_run_id: null,
      provider_attempt_id: null,
      cost: { basis: 'unknown', amount_usd: null },
    };
    try {
      if (name === 'native-math' || name === 'native-vision') {
        const request = nativeAssessmentFixture();
        let image: Buffer | undefined;
        if (name === 'native-vision') {
          image = await sharp(
            Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="200"><rect width="240" height="200" fill="white"/><path d="M50 30 L50 150 L210 150 Z" fill="none" stroke="black" stroke-width="3"/><path d="M50 138 L62 138 L62 150" fill="none" stroke="black"/><text x="25" y="95" font-size="24">3</text><text x="125" y="180" font-size="24">4</text></svg>',
            ),
          )
            .png()
            .toBuffer();
          request.materials = [
            {
              material_id: 'diagram',
              kind: 'figure',
              asset: { asset_id: 'synthetic-diagram', digest: digest(image) },
            },
          ];
          request.unit.material_refs = ['diagram'];
          request.question_parts = [
            {
              part_id: 'p1',
              prompt_md: '求图中直角三角形的斜边和面积。',
              material_ids: ['diagram'],
            },
          ];
          request.slot_responses = [{ slot_id: 's1', kind: 'text', text_md: '斜边5，面积6。' }];
          request.unit.criterion = {
            kind: 'rule_reference',
            rule_id: 'r1',
            source: 'official',
            statement_md:
              '依据原图独立计算，两者均正确5分，否则0分。反馈必须写出读到的两条直角边和计算过程；原始图不可用必须pending。',
          };
          evidence.image_digest = digest(image);
        }
        evidence.input_digest = digest(JSON.stringify(request));
        evidence.input = request;
        const executor = createPiModelExecutor({
          db: testDb(),
          taskRunId: id,
          deadlineAt: Date.now() + 120_000,
          maxCostUsdMicros: 20_000,
          loadAsset: async () =>
            image
              ? { bytes: image, mime_type: 'image/png' }
              : {
                  bytes: Buffer.from(request.materials[0].content_md ?? ''),
                  mime_type: 'text/plain',
                },
        });
        const output = await executor(request);
        evidence.output = output;
        evidence.output_digest = digest(JSON.stringify(output));
        evidence.task_run_id = id;
        const [run] = await testDb().select().from(ai_task_runs).where(eq(ai_task_runs.id, id));
        const costs = await testDb()
          .select()
          .from(cost_ledger)
          .where(eq(cost_ledger.task_run_id, id));
        evidence.run = run;
        evidence.cost_ledger = costs;
        evidence.cost = {
          basis: costs[0]?.cost_basis ?? 'unknown',
          amount_usd: costs[0]?.cost ?? null,
          ref: costs[0]?.cost_ref ?? null,
        };
        expect(run).toMatchObject({
          provider: 'opencode-go',
          model: 'mimo-v2.6-pro',
          status: 'success',
        });
        expect(output).toMatchObject({ kind: 'scored', points_awarded: 5 });
        if (name === 'native-vision') {
          expect(JSON.stringify(output)).toMatch(/3/);
          expect(JSON.stringify(output)).toMatch(/4/);
        }
      } else if (name === 'mem0-extraction') {
        const llm = resolveMemoryLlmConfig();
        const wire: Array<{ input_digest: string; output_digest: string; body: unknown }> = [];
        const server = createServer(async (req, res) => {
          let raw = '';
          for await (const chunk of req) raw += chunk;
          if (req.url === '/embeddings') {
            const input = JSON.parse(raw).input;
            const items = Array.isArray(input) ? input : [input];
            res.setHeader('content-type', 'application/json');
            res.end(
              JSON.stringify({
                data: items.map((_, index) => ({ index, embedding: [0.2, 0.4, 0.6, 0.8] })),
              }),
            );
            return;
          }
          try {
            const header = req.headers['x-opencode-session'];
            if (typeof header !== 'string') throw new Error('SDK session header missing');
            const response = await fetch(`${llm.baseURL}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${llm.apiKey}`,
                'x-opencode-session': header,
              },
              body: raw,
              signal: AbortSignal.timeout(60_000),
            });
            const body = await response.text();
            wire.push({
              input_digest: digest(raw),
              output_digest: digest(body),
              body: JSON.parse(body),
            });
            res.writeHead(response.status, { 'content-type': 'application/json' }).end(body);
          } catch {
            res.writeHead(503).end('{"error":{"message":"single-shot synthetic proxy failed"}}');
          }
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Synthetic port unavailable');
        const endpoint = `http://127.0.0.1:${address.port}`;
        try {
          const client = createMemoryClient({
            memoryFactory: (config) =>
              new Memory({
                ...config,
                llm: { ...config.llm, config: { ...config.llm.config, baseURL: endpoint } },
                embedder: {
                  provider: 'openai',
                  config: { apiKey: 'synthetic-only', baseURL: endpoint, embeddingDims: 4 },
                },
                vectorStore: {
                  provider: 'memory',
                  config: { collectionName: id, dimension: 4, dbPath: ':memory:' },
                },
                disableHistory: true,
              }),
          });
          const input = {
            id,
            action: 'reflect',
            actor_kind: 'user',
            subject_kind: 'synthetic',
            subject_id: id,
            affected_scopes: ['synthetic'],
            created_at: new Date('2026-10-07T00:00:00Z'),
            kind: 'preference',
            payload: {
              note: '学习椭圆时，我希望先画图并保留反例。一次答对不代表稳定掌握。不记住账户、密钥或猜测性诊断。',
            },
          };
          evidence.input = input;
          evidence.input_digest = digest(JSON.stringify(input));
          const output = await client.addEventMemoryOnce(
            input,
            createMem0OpaqueOperationContext({
              db: testDb(),
              caller: 'worker',
              operationAnchor: id,
              deadlineAt: new Date(Date.now() + 90_000),
              mode: 'off',
            }),
            async () => {
              evidence.add_started = true;
            },
          );
          evidence.output = output;
          evidence.output_digest = digest(JSON.stringify(output));
          evidence.wire = wire;
          evidence.provider_attempt = await testDb().select().from(provider_attempt);
          evidence.boundary =
            'Real Mem0 extraction LLM; synthetic local vectors and in-memory store, no DashScope paid call';
          expect(wire).toHaveLength(1);
          expect(output.result.results.length).toBeGreaterThan(0);
          expect(JSON.stringify(output)).toMatch(/椭圆|画图|反例/);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      } else {
        const input = [
          {
            index: 0,
            memory_id: id,
            created_ms: 2000,
            kind: 'preference',
            text: '学习椭圆时先画图，保留反例；不要把一次答对解释为稳定掌握。',
          },
        ];
        const candidates = new Map([
          [
            0,
            [
              {
                index: 0,
                memory_id: 'synthetic-old',
                created_ms: 1000,
                score: 0.9,
                text: '学习椭圆时喜欢直接看代数公式，不画图。',
              },
            ],
          ],
        ]);
        evidence.input = { memories: input, candidates: [...candidates] };
        evidence.input_digest = digest(JSON.stringify(evidence.input));
        const output = await judgeReconciliation(input, candidates, {
          providerAttempt: createDirectProviderOperationContext({
            db: testDb(),
            caller: 'worker',
            operationAnchor: id,
            deadlineAt: new Date(Date.now() + 90_000),
            mode: 'off',
          }),
          fetchImpl: async (url, init) => {
            const response = await fetch(url, init);
            evidence.raw_response = await response.clone().json();
            return response;
          },
        });
        evidence.output = output;
        evidence.output_digest = digest(JSON.stringify(output));
        evidence.provider_attempt = await testDb().select().from(provider_attempt);
        expect(output[0]).toMatchObject({ new_index: 0, action: 'SUPERSEDE', old_index: 0 });
      }
    } catch (error) {
      evidence.failure = { name: error instanceof Error ? error.name : 'unknown' };
      throw error;
    } finally {
      writeFileSync(artifact(name), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    }
  });
});
