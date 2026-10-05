import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { canonicalHash } from '@/core/migration/canonical';
import { ai_task_runs, event, material_fsrs_state, question, source_asset } from '@/db/schema';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { type RunnerMessage, __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { normalizeQuestionGroupToContract } from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { issueAssessment } from './assessment/issue';
import { type RunTaskFn, planSolveHint, startSolveSession } from './solve-session';

const r2 = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/server/r2', () => ({ getR2: () => r2 }));
const db = testDb();
const bytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1WQAAAAASUVORK5CYII=',
  'base64',
);
const sha = createHash('sha256').update(bytes).digest('hex');
const url = '/api/assets/issued-diagram/content';
const figure = (asset_id: string) => ({
  asset_id,
  role: 'diagram' as const,
  source_page_index: 0,
  source_bbox: { x: 0, y: 0, width: 100, height: 100 },
  attached_to_index: '1',
  attach_confidence: 'manual' as const,
});
const reply = '先从图中找出保持不变的条件，再比较两组方向。';
const runner = () =>
  vi.fn<RunTaskFn>(async () => ({
    text: JSON.stringify({ kind: 'explain', text_md: reply, suggested_next: 'continue' }),
  }));

async function seed(options: { inline?: string; unsupported?: boolean; reference?: string } = {}) {
  const now = new Date();
  const base = {
    kind: 'choice',
    reference_md: options.reference ?? 'B',
    choices_md: ['向上', `向下 ![选项图](${url})`],
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    created_at: now,
    updated_at: now,
    version: 0,
  };
  await db.insert(question).values([
    {
      ...base,
      id: 'media-root',
      prompt_md: '同一斜面的两次实验，水量相同。\n请根据每题对应的图形与条件作答。',
    },
    {
      ...base,
      id: 'issued-part',
      parent_question_id: 'media-root',
      part_index: 0,
      prompt_md: options.inline ?? `比较方向。![原图][diagram]\n\n[diagram]: ${url}`,
      figures: [figure('issued-diagram')],
    },
    {
      ...base,
      id: 'unissued-part',
      parent_question_id: 'media-root',
      part_index: 1,
      prompt_md: 'UNISSUED PROMPT ![图](/api/assets/unissued-diagram/content)',
      figures: [figure('unissued-diagram')],
    },
  ]);
  const [root] = await db.select().from(question).where(eq(question.id, 'media-root'));
  const parts = await db.select().from(question).where(eq(question.parent_question_id, root.id));
  const contract = normalizeQuestionGroupToContract(
    { ...root, figureDigests: { 'issued-diagram': sha, 'unissued-diagram': sha } },
    parts,
  );
  const issuedPart = contract.structure.parts.find((part) => part.part_id === 'issued-part');
  if (!issuedPart) throw new Error('fixture issued part missing');
  contract.structure.materials.push({
    material_id: 'private-figure',
    kind: 'figure',
    visibility: 'private',
    asset: { asset_id: 'private-diagram', digest: `sha256:${sha}` },
  });
  issuedPart.material_ids.push('private-figure');
  if (options.unsupported) {
    contract.structure.materials.push({
      material_id: 'required-audio',
      kind: 'audio',
      asset: { asset_id: 'audio', digest: `sha256:${sha}` },
    });
    issuedPart.material_ids.push('required-audio');
  }
  await db.insert(source_asset).values(
    ['issued-diagram', 'unissued-diagram', 'private-diagram'].map((id) => ({
      id,
      kind: 'image',
      storage_key: `frozen/${id}`,
      mime_type: 'image/png',
      byte_size: bytes.length,
      sha256: sha,
      created_at: now,
    })),
  );
  contract.integrity_digest = contractIntegrityDigest(contract);
  const published = await publishQuestionGroup(db, {
    group_id: root.id,
    contract,
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    admission: { state: 'withheld', reason: 'owner_hold' },
    actorRef: 'test:frozen-media',
    now,
  });
  if (published.status !== 'published') throw new Error(published.status);
  const issued = await issueAssessment(db, {
    group_id: root.id,
    part_ids: ['issued-part'],
    mode: 'manual',
  });
  if (issued.status !== 'issued') throw new Error(issued.status);
  const session = await startSolveSession({
    db,
    questionId: root.id,
    issuanceId: issued.issuance.issuance_id,
  });
  return { ...session, issuanceId: issued.issuance.issuance_id };
}

beforeEach(async () => {
  await resetDb();
  resetTestConfig();
  vi.stubEnv('XIAOMI_API_KEY', 'offline-fixture');
  vi.stubEnv('AI_PROVIDER_OVERRIDE', '');
  vi.stubEnv('AI_PROVIDER_MODEL', '');
  r2.get.mockReset().mockResolvedValue(bytes);
});

afterEach(() => {
  __setPiAdapterForTests(undefined);
  resetTestConfig();
  vi.unstubAllEnvs();
});

describe('frozen solve image task payload', () => {
  it('sends base64 image blocks through the real task runner and logs the vision route offline', async () => {
    const s = await seed();
    const messages: unknown[] = [];
    const startup = vi.fn();
    __setPiAdapterForTests({
      id: 'pi',
      startup: async (args) => {
        startup(args.options.model);
        return {
          query: (prompt) =>
            (async function* () {
              if (typeof prompt === 'string') messages.push(prompt);
              else for await (const message of prompt) messages.push(message);
              yield {
                type: 'result',
                source: 'pi',
                subtype: 'success',
                result: JSON.stringify({
                  kind: 'explain',
                  text_md: reply,
                  suggested_next: 'continue',
                }),
                stop_reason: 'end_turn',
                usage: {
                  input_tokens: 100,
                  output_tokens: 20,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                },
                duration_ms: 1,
                duration_api_ms: 1,
                is_error: false,
                num_turns: 1,
                modelUsage: {},
                permission_denials: [],
                uuid: '00000000-0000-0000-0000-000000000001',
                session_id: 'offline-teaching',
                total_cost_usd: 0.001,
              } satisfies RunnerMessage;
            })(),
          close: async () => {},
        };
      },
    });
    expect(await planSolveHint({ db, sessionId: s.sessionId, hintIndex: 0 })).toEqual({
      text_md: reply,
    });
    expect(startup).toHaveBeenCalledExactlyOnceWith('mimo-v2.5');
    expect(messages).toMatchObject([
      {
        message: {
          content: [
            { type: 'text', text: expect.stringContaining('image_manifest') },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
            },
          ],
        },
      },
    ]);
    expect(JSON.stringify(messages)).not.toMatch(/private-diagram|UNISSUED/);
    expect(await db.select().from(ai_task_runs)).toMatchObject([
      {
        task_kind: 'TeachingTurnVisionTask',
        provider: 'xiaomi',
        model: 'mimo-v2.5',
        status: 'success',
      },
    ]);
  });

  it('rejects a configured text-only vision model before adapter startup', async () => {
    const s = await seed();
    setTestConfig({
      'task.TeachingTurnVisionTask.provider': 'xiaomi',
      'task.TeachingTurnVisionTask.model': 'mimo-v2.5-pro',
    });
    const startup = vi.fn(async () => {
      throw new Error('adapter must not start');
    });
    __setPiAdapterForTests({ id: 'pi', startup });
    await expect(planSolveHint({ db, sessionId: s.sessionId, hintIndex: 0 })).rejects.toThrow();
    expect(startup).not.toHaveBeenCalled();
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_assistance')),
    ).toHaveLength(0);
  });

  it('passes original issued bytes, controls and image identity while preserving help digest and hint secrecy', async () => {
    const s = await seed();
    await db.update(question).set({
      prompt_md: 'MUTATED ![图](/api/assets/private-diagram/content)',
      reference_md: 'MUTATED ANSWER',
      figures: [figure('private-diagram')],
    });
    const runTaskFn = runner();
    const result = await planSolveHint({ db, sessionId: s.sessionId, hintIndex: 1, runTaskFn });
    expect(runTaskFn).toHaveBeenCalledOnce();
    const [kind, input] = runTaskFn.mock.calls[0];
    expect(kind).toBe('TeachingTurnVisionTask');
    expect(input).toMatchObject({
      images: [{ data: bytes.toString('base64'), mediaType: 'image/png' }],
    });
    if (!input || typeof input !== 'object' || !('text' in input) || typeof input.text !== 'string')
      throw new Error('missing multimodal text');
    const wire = JSON.parse(input.text);
    expect(wire.frozen_question.faces).toHaveLength(1);
    expect(wire.frozen_question.response_spec.slots[0].options[1].text).toContain('向下');
    expect(wire.image_manifest).toEqual([
      { index: 0, material_id: expect.any(String), asset_id: 'issued-diagram' },
    ]);
    expect(wire.messages[0].text_md).toContain('仍然不要直接说出最终答案');
    expect(input.text).not.toMatch(/MUTATED|UNISSUED|unissued-diagram|private-diagram/);
    expect(r2.get.mock.calls).toEqual([['frozen/issued-diagram']]);
    expect(result).toEqual({ text_md: reply });
    expect(result.text_md).not.toContain('向下');
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_assistance')),
    ).toMatchObject([
      { payload: { impact: 'unknown', content_digest: `sha256:${canonicalHash(reply)}` } },
    ]);
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
  });

  it.each([
    ['external', 'https://example.com/a.png'],
    ['unissued', '/api/assets/unissued-diagram/content'],
    ['private', '/api/assets/private-diagram/content'],
    ['unbound', '/api/assets/missing/content'],
  ])('rejects %s inline images before asset reads or model calls', async (_name, src) => {
    const s = await seed({ inline: `条件 ![图](${src})` });
    const runTaskFn = runner();
    await expect(
      planSolveHint({ db, sessionId: s.sessionId, hintIndex: 0, runTaskFn }),
    ).rejects.toMatchObject({ code: 'study_media_unavailable' });
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(r2.get).not.toHaveBeenCalled();
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_assistance')),
    ).toHaveLength(0);
  });

  it('holds unsupported required media before model execution', async () => {
    const s = await seed({ unsupported: true });
    const runTaskFn = runner();
    await expect(
      planSolveHint({ db, sessionId: s.sessionId, hintIndex: 0, runTaskFn }),
    ).rejects.toMatchObject({ code: 'study_media_unavailable' });
    expect(runTaskFn).not.toHaveBeenCalled();
    expect(r2.get).not.toHaveBeenCalled();
  });

  it.each(['missing', 'corrupt', 'size', 'metadata', 'mime', 'storage-failure'])(
    'holds %s original bytes without a text fallback or help event',
    async (failure) => {
      const s = await seed();
      if (failure === 'missing') r2.get.mockResolvedValue(null);
      if (failure === 'corrupt') r2.get.mockResolvedValue(Buffer.alloc(bytes.length));
      if (failure === 'size') r2.get.mockResolvedValue(bytes.subarray(1));
      if (failure === 'metadata')
        await db
          .update(source_asset)
          .set({ sha256: 'a'.repeat(64) })
          .where(eq(source_asset.id, 'issued-diagram'));
      if (failure === 'mime')
        await db
          .update(source_asset)
          .set({ mime_type: 'application/pdf' })
          .where(eq(source_asset.id, 'issued-diagram'));
      if (failure === 'storage-failure') r2.get.mockRejectedValue(new Error('storage unavailable'));
      const runTaskFn = runner();
      await expect(
        planSolveHint({ db, sessionId: s.sessionId, hintIndex: 0, runTaskFn }),
      ).rejects.toMatchObject({ code: 'study_media_unavailable' });
      expect(runTaskFn).not.toHaveBeenCalled();
      expect(
        await db.select().from(event).where(eq(event.action, 'experimental:assessment_assistance')),
      ).toHaveLength(0);
    },
  );
});
