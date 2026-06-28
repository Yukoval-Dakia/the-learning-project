// YUK-503 (YUK-471 W3 test/audit hardening) — the legacy record_promotion → artifact branch.
//
// This dispatch shell (D11 tombstone domain; no active producer) had ZERO DB test coverage for its
// artifact materialization, and the body_blocks pass-through was an untyped `draft.body_blocks as never`
// cast. The fix validates a PRESENT body_blocks against the canonical ArtifactBodyBlocks schema at the
// INSERT seam (fail loud) instead of letting a malformed TipTap doc reach the materialized row. These
// tests pin that contract end-to-end through the real accept dispatch (writeAiProposal → acceptAiProposal
// → acceptRecordPromotionProposal):
//   - a VALID body_blocks lands on the artifact row verbatim,
//   - an ABSENT body_blocks leaves the column NULL (table default),
//   - a MALFORMED body_blocks throws validation_error and writes NO artifact (the tx rolls back).
//
// No module mocks: the record_promotion artifact branch only touches Postgres (artifact INSERT +
// artifact_create event + learning_record UPDATE + rate event); cooldown_key is omitted so the
// post-tx signal write is a no-op.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ArtifactBodyBlocksT } from '@/core/schema/business';
import { artifact, learning_record } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { acceptAiProposal } from './actions';
import { writeAiProposal } from './writer';

const VALID_DOC: ArtifactBodyBlocksT = {
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'text', text: 'promoted body' }] },
  ],
} as ArtifactBodyBlocksT;

/** Seed the active learning_record the promotion applier looks up + archives. */
async function seedRecord(db: ReturnType<typeof testDb>, id: string): Promise<void> {
  const now = new Date();
  await db.insert(learning_record).values({
    id,
    kind: 'note',
    title: 'Source record',
    content_md: 'record content',
    source: 'ingestion',
    capture_mode: 'text',
    activity_kind: 'capture',
    created_at: now,
    updated_at: now,
  });
}

/** Build + persist a record_promotion(target=artifact) proposal whose draft carries `body_blocks`. */
async function proposePromotion(
  db: ReturnType<typeof testDb>,
  opts: { proposalId: string; recordId: string; body_blocks?: unknown },
): Promise<void> {
  const draft: Record<string, unknown> = { title: 'Promoted note', content: 'note body' };
  if (opts.body_blocks !== undefined) draft.body_blocks = opts.body_blocks;
  await writeAiProposal(db, {
    id: opts.proposalId,
    payload: {
      kind: 'record_promotion',
      target: { subject_kind: 'record', subject_id: opts.recordId },
      reason_md: 'promote this record into a note artifact',
      evidence_refs: [],
      // proposed_change is a free-form NonEmptyObject at the schema level; the applier reads
      // record_id / target / draft from it.
      proposed_change: { record_id: opts.recordId, target: 'artifact', draft },
      // cooldown_key intentionally omitted → recordProposalDecisionSignal no-ops.
    },
  });
}

describe('acceptRecordPromotionProposal — artifact target body_blocks validation (YUK-503)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a valid body_blocks lands on the materialized artifact verbatim', async () => {
    const db = testDb();
    await seedRecord(db, 'rec_ok');
    await proposePromotion(db, {
      proposalId: 'prop_ok',
      recordId: 'rec_ok',
      body_blocks: VALID_DOC,
    });

    const result = await acceptAiProposal(db, 'prop_ok');
    expect(result.kind).toBe('record_promotion');
    if (result.kind !== 'record_promotion') throw new Error('unexpected result kind');
    expect(result.materialized_kind).toBe('artifact');

    const [row] = await db.select().from(artifact).where(eq(artifact.id, result.materialized_id));
    expect(row).toBeDefined();
    expect(row.type).toBe('note_long');
    expect(row.body_blocks).toEqual(VALID_DOC);
  });

  it('an absent body_blocks leaves the column NULL (table default)', async () => {
    const db = testDb();
    await seedRecord(db, 'rec_none');
    await proposePromotion(db, { proposalId: 'prop_none', recordId: 'rec_none' });

    const result = await acceptAiProposal(db, 'prop_none');
    if (result.kind !== 'record_promotion') throw new Error('unexpected result kind');
    const [row] = await db.select().from(artifact).where(eq(artifact.id, result.materialized_id));
    expect(row.body_blocks).toBeNull();
  });

  it('a malformed body_blocks throws validation_error and writes NO artifact (tx rolls back)', async () => {
    const db = testDb();
    await seedRecord(db, 'rec_bad');
    // A string is not a TipTap `doc` object → ArtifactBodyBlocks.safeParse fails.
    await proposePromotion(db, {
      proposalId: 'prop_bad',
      recordId: 'rec_bad',
      body_blocks: 'definitely not a tiptap doc',
    });

    await expect(acceptAiProposal(db, 'prop_bad')).rejects.toMatchObject({ status: 400 });

    // The promotion tx rolled back: no artifact row materialized, the record stays un-actioned.
    const artifacts = await db.select().from(artifact);
    expect(artifacts).toHaveLength(0);
    const [rec] = await db.select().from(learning_record).where(eq(learning_record.id, 'rec_bad'));
    expect(rec.processing_status).not.toBe('actioned');
  });
});
