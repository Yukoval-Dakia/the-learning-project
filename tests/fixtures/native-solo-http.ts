import { createId } from '@paralleldrive/cuid2';
import { vi } from 'vitest';
import * as evaluations from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import type { Db } from '@/db/client';
import { knowledge, question, source_asset } from '@/db/schema';
import { issueSoloFixture } from './assessment-solo';

export const ORIGINAL_RESPONSE =
  '保持同一坡面和相同水量，分次改变坡度；记录每次流速并比较。不能同时改变水量，否则无法判断坡度的独立影响。';
export function nativeHttpRequest(body: unknown) {
  return new Request('http://local/api/attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Actual publish/issue/recorded evaluation; never a paid provider or supplied-result shortcut. */
export async function nativeSoloHttpFixture(
  db: Db,
  options: { model?: boolean; points?: number; knowledgeIds?: string[] } = {},
) {
  const id = createId();
  const now = new Date();
  const knowledgeIds = options.knowledgeIds ?? [`kc_${id}`];
  for (const kc of knowledgeIds)
    await db
      .insert(knowledge)
      .values({
        id: kc,
        name: '控制变量与证据推断',
        domain: 'math',
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing();
  await db
    .insert(question)
    .values({
      id,
      kind: options.model ? 'short_answer' : 'choice',
      prompt_md: '比较坡度与流速时如何控制变量？说明理由。',
      reference_md: options.model ? ORIGINAL_RESPONSE : 'A',
      choices_md: options.model
        ? null
        : ['固定水量，只改变坡度', '同时改变坡度与水量', '只看最后一次流速'],
      knowledge_ids: knowledgeIds,
      difficulty: 3,
      source: 'manual',
      version: 0,
      created_at: now,
      updated_at: now,
    });
  const issued = await issueSoloFixture(db, id, options.model);
  let outcome: number | 'pending' | 'throw' = options.points ?? 1;
  const execute = vi.fn(
    async (
      input: ModelExecutorRequest,
      _signal: AbortSignal | undefined,
      runId: string,
    ): Promise<ModelUnitOutcomeT> => {
      if (outcome === 'throw') throw new Error('offline provider failure');
      if (outcome === 'pending')
        return {
          kind: 'pending',
          pending: { reason: 'unjudgeable', detail: '原件无法确定，留待复核。' },
          run_refs: [runId],
          cost_usd_micros: 120,
        };
      if (input.unit.points === null) throw new Error('fixture expects a point-based scoring unit');
      return {
        kind: 'scored',
        points_awarded: input.unit.points * outcome,
        matched: {
          rule_id:
            input.unit.criterion.kind === 'rule_reference'
              ? input.unit.criterion.rule_id
              : 'fixture',
          option_ids: [],
        },
        feedback_md: '按冻结评分依据检查控制变量与解释。',
        confidence: 0.9,
        evidence_citations: input.group_evidence.length
          ? [{ evidence_id: input.group_evidence[0].evidence.evidence_id }]
          : [{ slot_id: input.response_slots[0].slot_id, quote: ORIGINAL_RESPONSE }],
        run_refs: [runId],
        cost_usd_micros: 120,
      };
    },
  );
  vi.spyOn(evaluations, 'createFormalModelExecutor').mockImplementation(() =>
    createRecordedModelExecutor(db, execute),
  );
  const assessment = issued.assessment(options.model ? ORIGINAL_RESPONSE : 'A');
  const body = (extra: Record<string, unknown> = {}) => ({
    question_id: id,
    rating: 'good',
    auto_rate: true,
    assessment,
    ...extra,
  });
  return {
    id,
    knowledgeIds,
    issued,
    assessment,
    body,
    execute,
    setOutcome: (value: typeof outcome) => {
      outcome = value;
    },
  };
}

export async function handwritingFixture(db: Db) {
  const id = `handwriting_${createId()}`;
  const now = new Date();
  const sha = 'b'.repeat(64);
  await db
    .insert(source_asset)
    .values({
      id,
      kind: 'image',
      storage_key: `test/${id}`,
      mime_type: 'image/png',
      byte_size: 120,
      sha256: sha,
      created_at: now,
    });
  return {
    evidence: {
      evidence_id: id,
      kind: 'image' as const,
      asset: { asset_id: id, digest: `sha256:${sha}` },
      mime_type: 'image/png',
      bytes: 120,
      uploaded_at: now.toISOString(),
    },
    target: { scope: 'all_units' as const },
  };
}
