import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestConfig } from '@/core/config/store';
import { canonicalHash } from '@/core/migration/canonical';
import type { ResponseSetT } from '@/core/schema/assessment/response';
import {
  ai_task_runs,
  event,
  material_fsrs_state,
  question,
  source_asset,
  source_document,
} from '@/db/schema';
import { issueAssessment } from '@/kernel/records/assessment-issuance';
import {
  contractIntegrityDigest,
  normalizeQuestionGroupToContract,
} from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { admitHintSend, claimIssuedHint } from '@/kernel/records/hint-continuity';
import { type RunnerMessage, __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { saveResponseDraft } from '../grading/public';
import { type RunTaskFn, planSolveHint, startSolveSession } from './solve-session';

const r2 = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/kernel/object-storage', () => ({ getR2: () => r2 }));
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
  vi.fn<RunTaskFn>(async (_kind, _input, ctx) => {
    await (ctx as { beforeProviderQuery: () => Promise<void> }).beforeProviderQuery();
    return {
      text: JSON.stringify({ kind: 'explain', text_md: reply, suggested_next: 'continue' }),
    };
  });

async function seed(options: { inline?: string; unsupported?: boolean; reference?: string } = {}) {
  const now = new Date();
  await db.insert(source_document).values({
    id: 'media-source',
    body_md: 'Synthetic authorized worksheet',
    source_asset_ids: ['issued-diagram', 'unissued-diagram', 'private-diagram'],
    provenance: {
      usage_policy: { derivation_policy: 'allow' },
      usage_epoch: 'media-source-epoch',
    },
    created_at: now,
    updated_at: now,
  });
  const base = {
    kind: 'choice',
    reference_md: options.reference ?? 'B',
    choices_md: ['向上', `向下 ![选项图](${url})`],
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    metadata: { source_document_id: 'media-source' },
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
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: null,
      },
    },
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
  return {
    ...session,
    issuanceId: issued.issuance.issuance_id,
    issuance: issued.issuance,
    responseSpec: contract.response_spec,
  };
}

beforeEach(async () => {
  await resetDb();
  resetTestConfig();
  vi.stubEnv('OPENCODE_API_KEY', 'offline-fixture');
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
  // @invariant concurrency: autosave after claim preserves the authorized frozen answer and single-send identity
  // @fails-if admission requires the latest draft, replaces the frozen answer, or allows a changed focus or duplicate send
  it('admits the frozen saved answer after a newer autosave without reopening its claim', async () => {
    const s = await seed();
    const slot = s.responseSpec.slots.find((candidate) => candidate.part_id === 'issued-part');
    if (!slot || !('options' in slot)) throw new Error('fixture choice slot missing');
    const original: ResponseSetT = {
      entries: [{ slot_id: slot.slot_id, kind: 'choice', option_ids: [slot.options[0].option_id] }],
    };
    const saved = await saveResponseDraft(db, {
      issuance_id: s.issuanceId,
      response_set: original,
      expected_save_epoch: 0,
    });
    if (saved.status !== 'saved') throw new Error(saved.status);
    const focus = {
      question_id: 'media-root',
      issuance_id: s.issuanceId,
      revision_id: s.issuance.binding.revision_id,
      save_epoch: saved.save_epoch,
    };
    const request = {
      issuanceId: s.issuanceId,
      questionId: focus.question_id,
      rung: 0,
      requestId: 'hint-before-autosave',
    };
    const claim = await claimIssuedHint(db, { ...request, draftFocus: focus });
    if (!claim.frozenDraft) throw new Error('saved draft was not frozen');
    const admission = { ...request, draftSnapshotDigest: canonicalHash(claim.frozenDraft) };
    expect(
      await saveResponseDraft(db, {
        issuance_id: s.issuanceId,
        response_set: {
          entries: [
            { slot_id: slot.slot_id, kind: 'choice', option_ids: [slot.options[1].option_id] },
          ],
        },
        expected_save_epoch: saved.save_epoch,
      }),
    ).toMatchObject({ status: 'saved', save_epoch: saved.save_epoch + 1 });
    await admitHintSend(db, admission);
    expect(
      await db
        .select({ id: event.id, payload: event.payload })
        .from(event)
        .where(
          inArray(event.id, [
            claim.claimId,
            `${claim.claimId}:draft-read`,
            `${claim.claimId}:send`,
          ]),
        )
        .orderBy(event.dispatch_seq),
    ).toMatchObject([
      {
        id: claim.claimId,
        payload: {
          draft_snapshot: {
            focus,
            response_digest: canonicalHash(original),
            entries: original.entries,
          },
        },
      },
      { id: `${claim.claimId}:draft-read`, payload: { kind: 'chat_context' } },
      { id: `${claim.claimId}:send` },
    ]);
    await expect(
      claimIssuedHint(db, {
        ...request,
        draftFocus: { ...focus, save_epoch: saved.save_epoch + 1 },
      }),
    ).rejects.toMatchObject({ code: 'hint_request_conflict' });
    await expect(admitHintSend(db, admission)).rejects.toMatchObject({
      code: 'hint_outcome_unknown',
    });
  });

  // @invariant security: the vision runner receives only original issued image bytes
  // @fails-if private or unissued media reaches the provider or the vision route loses its image blocks
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
    expect(startup).toHaveBeenCalledExactlyOnceWith('deepseek-v4.1-flash');
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
        provider: 'opencode-go',
        model: 'deepseek-v4.1-flash',
        status: 'success',
      },
    ]);
  });

  // @invariant security: a solve hint receives only the issued figure bytes with their identity and learner-handwriting marker, never the reference answer, a mutated prompt or unissued media
  // @fails-if the hint input carries unissued or private media, the mutated prompt or the reference, or its image manifest drops an image's identity or marker
  it('passes original issued bytes, controls and image identity while preserving help digest and hint secrecy', async () => {
    const s = await seed();
    await db.update(question).set({
      prompt_md: 'MUTATED ![图](/api/assets/private-diagram/content)',
      reference_md: 'MUTATED ANSWER',
      figures: [figure('private-diagram')],
    });
    const runTaskFn = runner();
    await planSolveHint({ db, sessionId: s.sessionId, hintIndex: 0, runTaskFn });
    runTaskFn.mockClear();
    r2.get.mockClear();
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
      {
        index: 0,
        material_id: expect.any(String),
        asset_id: 'issued-diagram',
        contains_learner_handwriting: false,
      },
    ]);
    expect(wire.messages.at(-1).text_md).toContain('仍然不要直接说出最终答案');
    expect(wire.messages[0].text_md).toContain(reply);
    expect(input.text).not.toMatch(/MUTATED|UNISSUED|unissued-diagram|private-diagram/);
    expect(r2.get.mock.calls).toEqual([['frozen/issued-diagram']]);
    expect(result).toEqual({ text_md: reply });
    expect(result.text_md).not.toContain('向下');
    expect(
      await db.select().from(event).where(eq(event.action, 'experimental:assessment_assistance')),
    ).toMatchObject([
      { payload: { impact: 'unknown', content_digest: `sha256:${canonicalHash(reply)}` } },
      { payload: { impact: 'unknown', content_digest: `sha256:${canonicalHash(reply)}` } },
    ]);
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
  });
});
