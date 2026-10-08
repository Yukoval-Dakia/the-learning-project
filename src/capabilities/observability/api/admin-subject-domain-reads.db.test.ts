import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Db, type Tx, db as singleton } from '@/db/client';
import { subject, subject_trait, subject_trait_binding, subject_trait_journal } from '@/db/schema';
import { hydrateSubjectRegistryFromDb } from '@/server/subjects/hydrate';
import { reconcileBuiltinTraits } from '@/server/subjects/reconcile-builtin-traits';
import { getSubjectTraitResolutions } from '@/server/subjects/resolution-cache';
import {
  CharterTraitSchema,
  SUBJECT_TRAIT_KINDS,
  type SubjectTraitKind,
} from '@/subjects/trait-schemas';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  getAdminSubjectTraits,
  getTraitJournalPage,
  listAdminSubjects,
  listAdminTraits,
} from '../public';
import { GET as subjectTraitsGet } from './admin-subject-traits';
import { getSubject, GET as subjectsGet } from './admin-subjects';
import { GET as journalGet } from './admin-trait-journal';
import { GET as traitsGet } from './admin-traits';
import {
  AdminSubjectSchema,
  AdminSubjectTraitsResponseSchema,
  AdminSubjectsResponseSchema,
  AdminTraitJournalResponseSchema,
  AdminTraitsResponseSchema,
} from './subject-contracts';

const db = testDb();
const now = new Date('2026-10-08T12:34:56.789Z');
const subjectId = 'subj_yuk1387_retired';
const sharerId = 'subj_yuk1387_shared';
const emptySubjectId = 'subj_yuk1387_empty';
const journalId = 'trt_yuk1387_charter';
const emptyTraitId = 'trt_yuk1387_empty';

// Compare row contents in every public table, not only counts or the four read sources.
async function publicSnapshot(database: Db | Tx) {
  const tables = await database.execute<{ table_name: string }>(sql`
    select tablename as table_name from pg_tables where schemaname = 'public' order by tablename
  `);
  const snapshot: Record<string, string> = {};
  for (const { table_name } of tables) {
    const rows = await database.execute<{ digest: string }>(sql`
      select md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text, '[]')) as digest
      from ${sql.identifier(table_name)} t
    `);
    snapshot[table_name] = rows[0].digest;
  }
  return snapshot;
}

async function fixture(database: Db | Tx) {
  await database.insert(subject).values(
    [subjectId, sharerId, emptySubjectId].map((id, index) => ({
      id,
      display_name: `化学 ${index} 条件、歧义与失败证据`,
      display_name_norm: `yuk1387-${index}`,
      origin: 'custom' as const,
      revision: 41 + index,
      retired_at: id === subjectId ? now : null,
      created_at: now,
      updated_at: now,
    })),
  );
  const seeds = await database.select().from(subject_trait);
  const payloads = new Map<SubjectTraitKind, unknown>();
  for (const [index, kind] of SUBJECT_TRAIT_KINDS.entries()) {
    const seed = seeds.find((row) => row.id === `trt_seed_general_${kind}`);
    if (!seed) throw new Error(`missing seed ${kind}`);
    const payload =
      kind === 'charter'
        ? {
            ...CharterTraitSchema.parse(seed.payload),
            methodology: '核对长文本条件与歧义。'.repeat(150),
            rubricGuidance: '区分缺失证据、错误与失败。'.repeat(100),
          }
        : seed.payload;
    payloads.set(kind, payload);
    const id = `trt_yuk1387_${kind}`;
    await database.insert(subject_trait).values({
      ...seed,
      id,
      origin: 'custom',
      owner_subject_id: subjectId,
      seed_version: null,
      revision: 205 + index,
      payload,
      created_at: now,
      updated_at: now,
    });
    await database.insert(subject_trait_binding).values(
      [subjectId, sharerId].map((boundId) => ({
        subject_id: boundId,
        trait_kind: kind,
        trait_id: id,
      })),
    );
  }
  const charter = seeds.find((row) => row.id === 'trt_seed_general_charter');
  if (!charter) throw new Error('missing charter seed');
  await database.insert(subject_trait).values({
    ...charter,
    id: emptyTraitId,
    origin: 'custom',
    owner_subject_id: emptySubjectId,
    seed_version: null,
    revision: 9,
  });
  const actions = [
    'create',
    'edit',
    'rollback',
    'reconcile',
    'reset_to_seed',
    'fork_source',
  ] as const;
  await database.insert(subject_trait_journal).values(
    Array.from({ length: 205 }, (_, index) => ({
      trait_id: journalId,
      revision: index + 1,
      action: actions[index % actions.length],
      actor:
        index % actions.length === 0 || index % actions.length === 3
          ? ('migrate' as const)
          : ('owner' as const),
      payload: charter.payload,
      payload_schema_version: 1,
      seed_version: 'historical-1',
      source_trait_id: 'trt_seed_general_charter',
      source_revision: 0,
      rolled_back_from: index % actions.length === 2 ? index + 2 : null,
      change_seq: 10_000 + index,
      created_at: now,
    })),
  );
  // A known hydrated subject/trait now has a different DB revision. No hydration occurs here.
  await database.update(subject).set({ revision: 77 }).where(eq(subject.id, 'math'));
  await database
    .update(subject_trait)
    .set({ revision: 88 })
    .where(eq(subject_trait.id, 'trt_seed_math_charter'));
  return payloads;
}

beforeEach(async () => {
  await resetDb();
  await reconcileBuiltinTraits(db);
  await hydrateSubjectRegistryFromDb(db);
});

describe('public subject/trait reads over real Postgres', () => {
  it.each(['current', 'journal_fallback'] as const)(
    'uses the supplied Tx for all four nonzero reads with %s assembly facts, no writes and rollback',
    async (assembly) => {
      if (assembly === 'journal_fallback') {
        await db
          .update(subject_trait)
          .set({ revision: 10, payload: { invalid: 'broken live charter' } })
          .where(eq(subject_trait.id, 'trt_seed_math_charter'));
        await hydrateSubjectRegistryFromDb(db);
      }
      const outsideBefore = await publicSnapshot(db);
      const mathBefore = (await listAdminSubjects(db)).find((row) => row.id === 'math');
      const resolutions = getSubjectTraitResolutions();
      const resolutionContents = structuredClone(resolutions);
      const rollback = new Error('intentional fixture rollback');
      await expect(
        db.transaction(async (tx) => {
          const payloads = await fixture(tx);
          const before = await publicSnapshot(tx);
          const subjects = await listAdminSubjects(tx);
          expect(subjects.find((row) => row.id === subjectId)).toEqual({
            id: subjectId,
            displayName: '化学 0 条件、歧义与失败证据',
            origin: 'custom',
            retiredAt: now.toISOString(),
            isGeneralFallback: false,
            version: null,
            subjectRevision: 41,
            notation: null,
            capabilityCount: 0,
          });
          expect(subjects.find((row) => row.id === 'math')).toEqual({
            ...mathBefore,
            subjectRevision: 77,
          });
          const bindings = await getAdminSubjectTraits(tx, subjectId);
          expect(AdminSubjectTraitsResponseSchema.parse(bindings)).toEqual(bindings);
          expect(bindings?.subjectRevision).toBe(41);
          expect(bindings?.bindings.map((row) => row.kind)).toEqual([...SUBJECT_TRAIT_KINDS]);
          for (const [index, binding] of (bindings?.bindings ?? []).entries()) {
            expect(binding).toEqual({
              kind: SUBJECT_TRAIT_KINDS[index],
              traitId: `trt_yuk1387_${SUBJECT_TRAIT_KINDS[index]}`,
              origin: 'custom',
              ownerSubjectId: subjectId,
              seedVersion: null,
              revision: 205 + index,
              effectiveRevision: 205 + index,
              degraded: null,
              payload: payloads.get(binding.kind),
              sharedBy: [subjectId, sharerId].sort(),
            });
            expect(binding.payload).toBeTruthy();
          }
          const math = await getAdminSubjectTraits(tx, 'math');
          const cachedCharter = resolutions.get('math')?.find((row) => row.kind === 'charter');
          expect(cachedCharter).toMatchObject({
            effective: 0,
            degraded: assembly === 'current' ? null : 'journal_fallback',
          });
          expect(math?.bindings.find((row) => row.kind === 'charter')).toMatchObject({
            revision: 88,
            effectiveRevision: cachedCharter?.effective,
            degraded: cachedCharter?.degraded,
          });
          for (const [index, kind] of SUBJECT_TRAIT_KINDS.entries()) {
            expect(
              (await listAdminTraits(tx, kind)).find(
                (row) => row.traitId === `trt_yuk1387_${kind}`,
              ),
            ).toEqual({
              traitId: `trt_yuk1387_${kind}`,
              revision: 205 + index,
              origin: 'custom',
              ownerSubjectId: subjectId,
              seedVersion: null,
              boundBy: [subjectId, sharerId].sort(),
            });
          }
          const journal = await getTraitJournalPage(tx, journalId, { limit: 2 });
          expect(journal?.rows.map((row) => row.revision)).toEqual([205, 204]);
          expect(journal?.rows[0]).toEqual({
            revision: 205,
            action: 'create',
            actor: 'migrate',
            payloadSchemaVersion: 1,
            seedVersion: 'historical-1',
            sourceTraitId: 'trt_seed_general_charter',
            sourceRevision: 0,
            rolledBackFrom: null,
            changeSeq: 10204,
            createdAt: now.toISOString(),
          });
          expect(journal?.next_cursor).toBeTypeOf('string');
          expect((await getTraitJournalPage(tx, journalId, { limit: 999 }))?.rows).toHaveLength(
            200,
          );
          expect(
            (await getTraitJournalPage(tx, journalId, { limit: 0 }))?.rows.map(
              (row) => row.revision,
            ),
          ).toEqual([205]);
          for (const outside of [db, singleton]) {
            expect((await listAdminSubjects(outside)).some((row) => row.id === subjectId)).toBe(
              false,
            );
            expect(await getAdminSubjectTraits(outside, subjectId)).toBeNull();
            for (const kind of SUBJECT_TRAIT_KINDS) {
              expect(
                (await listAdminTraits(outside, kind)).some(
                  (row) => row.traitId === `trt_yuk1387_${kind}`,
                ),
              ).toBe(false);
            }
            expect(await getTraitJournalPage(outside, journalId, { limit: 2 })).toBeNull();
            expect((await getAdminSubjectTraits(outside, 'math'))?.subjectRevision).toBe(0);
          }
          expect(await publicSnapshot(tx)).toEqual(before);
          expect(await publicSnapshot(db)).toEqual(outsideBefore);
          expect(getSubjectTraitResolutions()).toBe(resolutions);
          expect(getSubjectTraitResolutions()).toEqual(resolutionContents);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await publicSnapshot(db)).toEqual(outsideBefore);
      expect(await getAdminSubjectTraits(db, subjectId)).toBeNull();
      expect(await getTraitJournalPage(db, journalId, { limit: 2 })).toBeNull();
    },
  );

  it('preserves complete public DTO and HTTP parity, all kinds, retirement, sharing and ISO timestamps without writes', async () => {
    await fixture(db);
    const before = await publicSnapshot(db);
    const subjects = await listAdminSubjects(db);
    const response = await subjectsGet();
    expect(response.status).toBe(200);
    expect(AdminSubjectsResponseSchema.parse(await response.json())).toEqual({ subjects });
    for (const id of ['general', 'math', subjectId, sharerId, emptySubjectId]) {
      const detail = await getSubject(new Request('http://x'), { id });
      expect(detail.status).toBe(200);
      expect(AdminSubjectSchema.parse(await detail.json())).toEqual(
        subjects.find((row) => row.id === id),
      );
      const bindings = await getAdminSubjectTraits(db, id);
      const traits = await subjectTraitsGet(new Request('http://x'), { id });
      expect(traits.status).toBe(200);
      expect(AdminSubjectTraitsResponseSchema.parse(await traits.json())).toEqual(bindings);
    }
    for (const kind of SUBJECT_TRAIT_KINDS) {
      const read = await listAdminTraits(db, kind);
      const result = await traitsGet(new Request(`http://x/api/admin/traits?kind=${kind}`));
      expect(result.status).toBe(200);
      expect(AdminTraitsResponseSchema.parse(await result.json())).toEqual({ traits: read });
    }
    const revisions: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await getTraitJournalPage(db, journalId, { limit: 37, cursor });
      if (!page) throw new Error('missing journal');
      const result = await journalGet(
        new Request(`http://x?limit=37${cursor ? `&cursor=${cursor}` : ''}`),
        { id: journalId },
      );
      expect(result.status).toBe(200);
      expect(AdminTraitJournalResponseSchema.parse(await result.json())).toEqual({
        data: page.rows,
        page: { limit: 37, next_cursor: page.next_cursor },
        journal: page.rows,
        next_cursor: page.next_cursor,
      });
      revisions.push(...page.rows.map((row) => row.revision));
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    expect(revisions).toEqual(Array.from({ length: 205 }, (_, index) => 205 - index));
    for (const [query, limit] of [
      ['', 100],
      ['?limit=999', 200],
    ] as const) {
      const result = await journalGet(new Request(`http://x${query}`), { id: journalId });
      expect(result.status).toBe(200);
      const body = AdminTraitJournalResponseSchema.parse(await result.json());
      const page = await getTraitJournalPage(db, journalId, { limit });
      expect(body).toEqual({
        data: page?.rows,
        journal: page?.rows,
        page: { limit, next_cursor: page?.next_cursor },
        next_cursor: page?.next_cursor,
      });
      expect(body.data).toHaveLength(limit);
    }
    expect(await publicSnapshot(db)).toEqual(before);
  });

  it('distinguishes existing empty subjects/journals from missing and preserves bound-cursor rejection and no writes', async () => {
    await fixture(db);
    const before = await publicSnapshot(db);
    expect(await getAdminSubjectTraits(db, emptySubjectId)).toEqual({
      subjectRevision: 43,
      bindings: [],
    });
    expect(await getTraitJournalPage(db, emptyTraitId, { limit: 100 })).toEqual({
      rows: [],
      next_cursor: null,
    });
    const empty = await journalGet(new Request('http://x'), { id: emptyTraitId });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      data: [],
      journal: [],
      next_cursor: null,
      page: { limit: 100, next_cursor: null },
    });
    expect(await getAdminSubjectTraits(db, 'missing')).toBeNull();
    expect(await getTraitJournalPage(db, 'missing', { limit: 100, cursor: 'invalid' })).toBeNull();
    expect((await subjectTraitsGet(new Request('http://x'), { id: 'missing' })).status).toBe(404);
    expect((await getSubject(new Request('http://x'), { id: 'missing' })).status).toBe(404);
    const missing = await journalGet(new Request('http://x?cursor=invalid'), { id: 'missing' });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'unknown trait "missing"' });
    const cursor = (await getTraitJournalPage(db, journalId, { limit: 1 }))?.next_cursor;
    if (!cursor) throw new Error('expected pagination cursor');
    for (const badCursor of [
      cursor,
      'not-a-cursor',
      Buffer.from(JSON.stringify({ trait_id: emptyTraitId, revision: 1.5 })).toString('base64url'),
    ]) {
      await expect(
        getTraitJournalPage(db, emptyTraitId, { limit: 1, cursor: badCursor }),
      ).rejects.toMatchObject({ code: 'invalid_cursor', status: 400 });
      const result = await journalGet(new Request(`http://x?cursor=${badCursor}`), {
        id: emptyTraitId,
      });
      expect(result.status).toBe(400);
      expect(await result.json()).toMatchObject({
        error: 'invalid_cursor',
        message: expect.stringContaining('invalid trait journal cursor:'),
      });
    }
    expect(await publicSnapshot(db)).toEqual(before);
  });
});
