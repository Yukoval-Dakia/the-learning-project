import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { installPracticeHost } from '@/capabilities/practice/public';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import {
  learning_session,
  question,
  question_block,
  source_asset,
  source_document,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { persistCapturedQuestionBlock } from '@/kernel/records/question-block-creation';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { memR2 } from '../../../../tests/helpers/r2';
import { runRescue } from './rescue';
import { enrollIngestionBlock } from './single-block-enroll';

const PAGE_ASSET = 'asset_page_1';
const PAGE_KEY = 'offline/page-1';

function structured(prompt: string): StructuredQuestionT {
  return { id: createId(), role: 'standalone', prompt_text: prompt, source: 'vlm_structure' };
}

async function seedSession(
  db: ReturnType<typeof testDb>,
  options: { prompt: string },
): Promise<{ sessionId: string; blockId: string }> {
  const now = new Date();
  const docId = createId();
  await db.insert(source_document).values({
    id: docId,
    source_asset_ids: [PAGE_ASSET],
    provenance: { usage_policy: { derivation_policy: 'allow' } },
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const sessionId = createId();
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    status: 'extracted',
    source_document_id: docId,
    source_asset_ids: [PAGE_ASSET],
    entrypoint: 'vision_paper',
    warnings: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(source_asset).values({
    id: PAGE_ASSET,
    kind: 'image',
    storage_key: PAGE_KEY,
    mime_type: 'image/png',
    byte_size: 8,
    sha256: 'a'.repeat(64),
    created_at: now,
  });
  const blockId = createId();
  await persistCapturedQuestionBlock(
    db,
    {
      origin: 'ocr',
      blockId,
      sessionId,
      sourceDocumentId: docId,
      ordinal: 0,
      layoutQuality: 'structured',
      structured: structured(options.prompt),
      figures: [],
      sourceAssetIds: [PAGE_ASSET],
      pageSpans: [],
      imageRefs: [],
      extractionConfidence: 1,
    },
    now,
  );
  return { sessionId, blockId };
}

const RESCUE_PROMPT = 'rescue 重识别出的题面';
const rescueVisionText = JSON.stringify({
  blocks: [
    {
      extracted_prompt_md: RESCUE_PROMPT,
      reference_md: null,
      wrong_answer_md: null,
      page_index: 0,
      bbox: { x: 0, y: 0, width: 1, height: 1 },
      role: 'prompt',
      visual_complexity: 'low',
      extraction_confidence: 0.9,
      knowledge_hint: null,
    },
  ],
});

describe('runRescue enrolled-block gate', () => {
  beforeAll(installPracticeHost);
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant data: a rescue never rewrites a block that already entered the
  //   bank — the enrolled question snapshot and the block's structured stay
  //   byte-identical, and the paid call is never reached
  // @invariant concurrency: a rescue and an enrollment racing on one block have
  //   exactly one winner — the status CAS refuses the loser instead of letting
  //   the second write silently desync block and question
  // @fails-if the rescue UPDATE matched on id alone, applyRescue skipped the
  //   status check, a paid vision result vanished without a receipt, or an
  //   enrolled block's question changed after a refused rescue
  it.each([
    { mode: 'already_enrolled' as const },
    { mode: 'draft_applies' as const },
    { mode: 'enroll_wins_race' as const },
  ])('handles block state %s', async ({ mode }) => {
    const db = testDb();
    const { sessionId, blockId } = await seedSession(db, { prompt: '原始识别题面' });
    const r2 = memR2();
    await r2.put(PAGE_KEY, new Uint8Array([1, 2, 3]), 'image/png');

    let paidCalls = 0;
    const runTaskFn = async () => {
      paidCalls += 1;
      if (mode === 'enroll_wins_race') {
        // A concurrent enrollment lands between the pre-flight check and the
        // rescue write — the window the status CAS exists for.
        const enrolled = await enrollIngestionBlock(db, {
          sessionId,
          blockId,
          expectedVersion: 0,
          source: 'user',
        });
        expect(enrolled.status).toBe('enrolled');
      }
      return { text: rescueVisionText };
    };

    if (mode === 'already_enrolled') {
      const enrolled = await enrollIngestionBlock(db, {
        sessionId,
        blockId,
        expectedVersion: 0,
        source: 'user',
      });
      expect(enrolled.status).toBe('enrolled');
    }

    let caught: ApiError | null = null;
    try {
      await runRescue({
        db,
        r2,
        sessionId,
        blockId,
        page: 0,
        tier: 2,
        runTaskFn,
      });
    } catch (err) {
      caught = err instanceof ApiError ? err : null;
      if (!caught) throw err;
    }

    const [block] = await db.select().from(question_block).where(eq(question_block.id, blockId));

    if (mode === 'draft_applies') {
      expect(caught).toBeNull();
      expect(paidCalls).toBe(1);
      expect(block?.status).toBe('auto_enrolled');
      expect((block?.structured as StructuredQuestionT | null)?.prompt_text).toBe(RESCUE_PROMPT);
      // rescue write bumps to 1; the follow-up enrollment bumps to 2.
      expect(block?.version).toBe(2);
      const [banked] = await db
        .select()
        .from(question)
        .where(eq(question.id, block?.imported_question_id ?? ''));
      expect(banked?.prompt_md).toContain(RESCUE_PROMPT);
      return;
    }

    expect(caught?.code).toBe('block_not_rescuable');
    expect(block?.status).toBe('auto_enrolled');
    expect((block?.structured as StructuredQuestionT | null)?.prompt_text).toBe('原始识别题面');
    const [banked] = await db
      .select()
      .from(question)
      .where(eq(question.id, block?.imported_question_id ?? ''));
    expect(banked?.prompt_md).toContain('原始识别题面');
    expect(banked?.prompt_md).not.toContain(RESCUE_PROMPT);

    if (mode === 'already_enrolled') {
      // Refused before any paid call: block and question keep the enrolled
      // snapshot, version untouched.
      expect(paidCalls).toBe(0);
      expect(block?.version).toBe(1);
      expect(caught?.details?.paid_result).toBeUndefined();
      return;
    }

    // enroll_wins_race: the paid call did run, so the result rides on the
    // refusal instead of being dropped.
    expect(paidCalls).toBe(1);
    expect(block?.version).toBe(1);
    const paid = caught?.details?.paid_result as { structured?: StructuredQuestionT } | undefined;
    expect(paid?.structured?.prompt_text).toBe(RESCUE_PROMPT);
  });
});
