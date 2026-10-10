import { describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { question_generation_binding, question_generation_plan } from '@/db/schema';
import { resetDb } from '../../../tests/helpers/db';
import {
  bindGeneratedQuestion,
  canonicalSourceContentHash,
  markQuestionGenerationFailed,
  prepareQuestionGeneration,
} from './question-generation-grounding';

// '北京' is 6 UTF-8 bytes; the locator is a HALF-OPEN [0, 6) byte range.
const authoritativeBytes = new TextEncoder().encode('北京');
const source = {
  artifact_kind: 'source_document',
  artifact_id: 'doc_1',
  version: 3,
  // content_hash is byte-bound to the authoritative source (Finding M4): it must
  // equal the canonical hash of authoritativeBytes or prepare fails closed.
  content_hash: canonicalSourceContentHash(authoritativeBytes),
  locator: { kind: 'text_span' as const, start: 0, end: 6, exact_text: '北京' },
};

const baseInput = {
  source,
  authoritativeBytes,
  canonicalAnswer: { kind: 'text', value: '北京' } as const,
  anchorProvenance: { kind: 'ai_extracted' as const, task_run_id: 'anchor_run' },
  demand: { kind: 'knowledge', ref_id: 'k_1' },
  knowledgeIds: ['k_1'],
  requestedKind: 'fill_blank',
  requestedAnswerClass: 'exact',
  constraints: {},
  planProvenance: { kind: 'ai_planned' as const, task_run_id: 'plan_run' },
};

describe('question generation grounding persistence (YUK-350)', () => {
  // Finding 3 — the transition race. A concurrent failure marker must never
  // leave a failed plan with a committed binding, and it must never be able to
  // flip a plan the binding transaction already claimed.
  describe('plan transition race (Finding 3)', () => {
    it('a failure marker that wins first forces the binding transaction to roll back entirely', async () => {
      await resetDb();
      const prepared = await prepareQuestionGeneration(db, {
        ...baseInput,
        generate: async () => 'generated',
      });

      // Failure marker wins the race first.
      await markQuestionGenerationFailed(db, prepared.plan);

      // The binding transaction now cannot commit any partial artifact.
      await expect(
        db.transaction(async (tx) => {
          await bindGeneratedQuestion(tx, {
            questionId: 'q_loser',
            plan: prepared.plan,
            anchor: prepared.anchor,
            generated: { kind: 'fill_blank' },
          });
        }),
      ).rejects.toThrow();

      const [plan] = await db.select().from(question_generation_plan);
      expect(plan?.status).toBe('failed');
      expect(await db.select().from(question_generation_binding)).toEqual([]);
    });

    it('a binding transaction that locks first wins; the concurrent failure marker no-ops', async () => {
      await resetDb();
      const prepared = await prepareQuestionGeneration(db, {
        ...baseInput,
        generate: async () => 'generated',
      });

      let failMarker: Promise<void> | undefined;
      await db.transaction(async (tx) => {
        // FOR UPDATE lock + generated transition, all still uncommitted.
        await bindGeneratedQuestion(tx, {
          questionId: 'q_winner',
          plan: prepared.plan,
          anchor: prepared.anchor,
          generated: { kind: 'fill_blank' },
        });
        // Concurrent failure marker on a separate connection: it must block on
        // the locked row until this transaction commits.
        failMarker = markQuestionGenerationFailed(db, prepared.plan);
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      await failMarker;

      const [plan] = await db.select().from(question_generation_plan);
      expect(plan?.status).toBe('generated');
      const [binding] = await db.select().from(question_generation_binding);
      expect(binding?.question_id).toBe('q_winner');
    });
  });
});
