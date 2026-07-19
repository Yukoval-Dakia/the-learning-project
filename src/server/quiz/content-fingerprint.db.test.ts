import { db } from '@/db/client';
import { question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../tests/helpers/db';
import { canonicalQuestionContentHash, findExactQuestionDuplicate } from './content-fingerprint';

async function seed(id: string, draftStatus: string | null) {
  const content = { promptMd: 'P', referenceMd: 'A', choicesMd: ['x', 'y'] };
  const hash = canonicalQuestionContentHash(content);
  await db.insert(question).values({
    id,
    kind: 'choice',
    prompt_md: content.promptMd,
    reference_md: content.referenceMd,
    choices_md: content.choicesMd,
    source: 'manual',
    draft_status: draftStatus,
    canonical_content_hash: hash,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return hash;
}

describe('findExactQuestionDuplicate', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it.each([
    ['active', null],
    ['draft', 'draft'],
  ] as const)('finds %s rows by canonical hash', async (_label, status) => {
    const hash = await seed(`q-${_label}`, status);
    expect(await findExactQuestionDuplicate(db, hash)).toMatchObject({
      id: `q-${_label}`,
      draftStatus: status,
    });
  });

  it('keeps legacy NULL-hash rows readable and outside exact identity lookup', async () => {
    await db.insert(question).values({
      id: 'q-legacy-null',
      kind: 'short_answer',
      prompt_md: 'legacy',
      source: 'manual',
      canonical_content_hash: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    expect(
      await findExactQuestionDuplicate(db, canonicalQuestionContentHash({ promptMd: 'legacy' })),
    ).toBeNull();
    expect(await db.select().from(question).where(eq(question.id, 'q-legacy-null'))).toHaveLength(
      1,
    );
  });
});
