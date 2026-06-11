// YUK-203 P1 (ADR-0027) — notesForKnowledge + notesForItem label-read DB tests.
//
// notesForKnowledge: multi-note read by knowledge label — ordering (atomic → hub →
// long, newest within type), exclusion of tool_quiz / archived / non-labeled notes,
// all labels surface, empty case. notesForItem: a learning_item's referenced notes
// (primary + label material), deduped (primary wins), with archived/non-note guards.

import { beforeEach, describe, expect, it } from 'vitest';

import { artifact, knowledge } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { interactiveForKnowledge, notesForItem, notesForKnowledge } from './notes-read';

const A_BASE = {
  intent_source: 'test',
  source: 'test',
  verification_status: 'not_required',
  embedded_check_status: 'not_required',
};

async function seedKnowledge(id: string): Promise<void> {
  const now = new Date();
  await testDb().insert(knowledge).values({
    id,
    name: id,
    parent_id: null,
    archived_at: null,
    proposed_by_ai: false,
    approval_status: 'approved',
    merged_from: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedNote(
  id: string,
  type: 'note_atomic' | 'note_hub' | 'note_long' | 'tool_quiz' | 'interactive',
  knowledgeIds: string[],
  opts: { archived?: boolean; createdAt?: Date } = {},
): Promise<void> {
  const now = opts.createdAt ?? new Date('2026-05-29T00:00:00.000Z');
  await testDb()
    .insert(artifact)
    .values({
      id,
      type,
      title: `${type}-${id}`,
      knowledge_ids: knowledgeIds,
      generation_status: 'ready',
      archived_at: opts.archived ? now : null,
      created_at: now,
      updated_at: now,
      ...A_BASE,
    });
}

describe('notesForKnowledge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns all labeled notes ordered atomic → hub → long', async () => {
    await seedKnowledge('k1');
    await seedNote('long1', 'note_long', ['k1']);
    await seedNote('hub1', 'note_hub', ['k1']);
    await seedNote('atomic1', 'note_atomic', ['k1']);

    const notes = await notesForKnowledge(testDb(), 'k1');
    expect(notes.map((n) => n.id)).toEqual(['atomic1', 'hub1', 'long1']);
    expect(notes.map((n) => n.type)).toEqual(['note_atomic', 'note_hub', 'note_long']);
  });

  it('excludes tool_quiz, interactive, archived notes, and notes not labeled with the node', async () => {
    await seedKnowledge('k1');
    await seedNote('atomic1', 'note_atomic', ['k1']);
    await seedNote('quiz1', 'tool_quiz', ['k1']); // excluded: a quiz artifact, not a note
    // excluded: interactive is NOT a note (ADR-0033 D5 anti-leak regression —
    // it must only surface via interactiveForKnowledge).
    await seedNote('inter1', 'interactive', ['k1']);
    await seedNote('archived1', 'note_atomic', ['k1'], { archived: true }); // excluded
    await seedNote('other', 'note_atomic', ['k2']); // excluded: different node label

    const notes = await notesForKnowledge(testDb(), 'k1');
    expect(notes.map((n) => n.id)).toEqual(['atomic1']);
  });

  it('orders newest-first within a type and surfaces all labels', async () => {
    await seedKnowledge('k1');
    await seedNote('old', 'note_atomic', ['k1', 'k2'], {
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
    });
    await seedNote('new', 'note_atomic', ['k1'], {
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
    });

    const notes = await notesForKnowledge(testDb(), 'k1');
    expect(notes.map((n) => n.id)).toEqual(['new', 'old']);
    // every label surfaces so the caller can highlight the focal one.
    expect(notes.find((n) => n.id === 'old')?.knowledge_ids).toEqual(['k1', 'k2']);
  });

  it('returns [] for a node with no labeled notes', async () => {
    await seedKnowledge('k1');
    expect(await notesForKnowledge(testDb(), 'k1')).toEqual([]);
  });
});

// ADR-0033 D5 — the parallel interactive read. Kept separate from NOTE_TYPES on
// purpose: notesForKnowledge/notesForItem must never admit interactive rows.
describe('interactiveForKnowledge', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns labeled non-archived interactive artifacts, newest first', async () => {
    await seedKnowledge('k1');
    await seedNote('old', 'interactive', ['k1'], {
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
    });
    await seedNote('new', 'interactive', ['k1'], {
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
    });

    const rows = await interactiveForKnowledge(testDb(), 'k1');
    expect(rows.map((r) => r.id)).toEqual(['new', 'old']);
    expect(rows.every((r) => r.type === 'interactive')).toBe(true);
  });

  it('excludes archived, unlabeled, and note-type artifacts', async () => {
    await seedKnowledge('k1');
    await seedNote('inter1', 'interactive', ['k1']);
    await seedNote('arch', 'interactive', ['k1'], { archived: true }); // excluded
    await seedNote('other', 'interactive', ['k2']); // excluded: different node label
    await seedNote('atomic1', 'note_atomic', ['k1']); // excluded: a note, not interactive

    const rows = await interactiveForKnowledge(testDb(), 'k1');
    expect(rows.map((r) => r.id)).toEqual(['inter1']);
  });
});

describe('notesForItem', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns the primary note (relation=primary) + label-matched material', async () => {
    await seedNote('p1', 'note_hub', ['k1']);
    await seedNote('mat', 'note_atomic', ['k1']);
    await seedNote('other', 'note_atomic', ['k2']);

    const notes = await notesForItem(testDb(), {
      primary_artifact_id: 'p1',
      knowledge_ids: ['k1'],
    });
    // primary first, then label material (atomic-first); 'other' (k2) excluded.
    expect(notes.map((n) => n.id)).toEqual(['p1', 'mat']);
    expect(notes.find((n) => n.id === 'p1')?.relation).toBe('primary');
    expect(notes.find((n) => n.id === 'mat')?.relation).toBe('label');
  });

  it('dedupes a primary that is also a label match (primary wins)', async () => {
    await seedNote('p1', 'note_atomic', ['k1']);
    const notes = await notesForItem(testDb(), {
      primary_artifact_id: 'p1',
      knowledge_ids: ['k1'],
    });
    expect(notes.map((n) => n.id)).toEqual(['p1']);
    expect(notes[0]?.relation).toBe('primary');
  });

  it('ignores a primary_artifact_id that is a non-note or archived', async () => {
    await seedNote('quiz', 'tool_quiz', ['k1']);
    await seedNote('arch', 'note_atomic', ['k2'], { archived: true });
    expect(
      await notesForItem(testDb(), { primary_artifact_id: 'quiz', knowledge_ids: [] }),
    ).toEqual([]);
    expect(
      await notesForItem(testDb(), { primary_artifact_id: 'arch', knowledge_ids: [] }),
    ).toEqual([]);
  });

  it('returns label-only material (no primary) ordered atomic → hub → long', async () => {
    await seedNote('hub', 'note_hub', ['k1']);
    await seedNote('atom', 'note_atomic', ['k1']);
    await seedNote('long', 'note_long', ['k1']);
    const notes = await notesForItem(testDb(), {
      primary_artifact_id: null,
      knowledge_ids: ['k1'],
    });
    expect(notes.map((n) => n.id)).toEqual(['atom', 'hub', 'long']);
    expect(notes.every((n) => n.relation === 'label')).toBe(true);
  });

  it('returns [] for an item with no primary and no labels', async () => {
    expect(await notesForItem(testDb(), { primary_artifact_id: null, knowledge_ids: [] })).toEqual(
      [],
    );
  });
});
