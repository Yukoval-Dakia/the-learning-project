// YUK-203 P1 (ADR-0027) — loadNotePage aggregator DB test (GET /api/notes/[id]).
//
// Covers: null for unknown / archived / non-note artifacts; basic aggregation
// (resolved labels, version, history, verification); inbound backlink read-time
// filters; related learning_items (primary + label, deduped, primary wins).

import { beforeEach, describe, expect, it } from 'vitest';

import { artifact, artifact_block_ref, knowledge, learning_item } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { loadNotePage } from './note-page';

const A_BASE = {
  intent_source: 'test',
  source: 'test',
  embedded_check_status: 'not_required',
};

async function seedKnowledge(
  id: string,
  name: string,
  opts: { archived?: boolean } = {},
): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name,
      parent_id: null,
      archived_at: opts.archived ? now : null,
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
  type: 'note_atomic' | 'note_hub' | 'note_long' | 'tool_quiz',
  knowledgeIds: string[],
  opts: {
    archived?: boolean;
    version?: number;
    history?: { version: number; at: Date }[];
    verificationStatus?: string;
    verificationSummary?: unknown;
    genStatus?: string;
    bodyBlocks?: unknown;
  } = {},
): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type,
      title: `${type}-${id}`,
      knowledge_ids: knowledgeIds,
      body_blocks: opts.bodyBlocks as never,
      generation_status: opts.genStatus ?? 'ready',
      verification_status: opts.verificationStatus ?? 'not_required',
      verification_summary: (opts.verificationSummary ?? null) as never,
      history: (opts.history ?? []) as never,
      version: opts.version ?? 0,
      archived_at: opts.archived ? now : null,
      created_at: now,
      updated_at: now,
      ...A_BASE,
    });
}

// ADR-0033 — interactive artifact row, mirroring the author_artifact tool's
// insert shape (author-artifact.ts): attrs jsonb payload, body_blocks null,
// generation_status ready, verification not_required (defaults via A_BASE /
// schema). `attrs` is overridable to seed a malformed payload.
async function seedInteractive(id: string, knowledgeIds: string[], attrs?: unknown): Promise<void> {
  const now = new Date();
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'interactive',
      title: `interactive-${id}`,
      knowledge_ids: knowledgeIds,
      body_blocks: null,
      attrs: (attrs ?? {
        format: 'html',
        html: '<!doctype html><html><body><p>hi</p></body></html>',
        origin: 'copilot_author_artifact',
      }) as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [] as never,
      version: 0,
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...A_BASE,
    });
}

async function seedLearningItem(
  id: string,
  opts: {
    primaryArtifactId?: string | null;
    knowledgeIds?: string[];
    archived?: boolean;
    createdAt?: Date;
  } = {},
): Promise<void> {
  const now = opts.createdAt ?? new Date('2026-05-29T00:00:00.000Z');
  await testDb()
    .insert(learning_item)
    .values({
      id,
      source: 'learning_intent',
      title: `li-${id}`,
      content: '',
      knowledge_ids: opts.knowledgeIds ?? [],
      primary_artifact_id: opts.primaryArtifactId ?? null,
      status: 'pending',
      archived_at: opts.archived ? now : null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
}

async function seedCrossLink(from: string, to: string, blockId: string): Promise<void> {
  await testDb().insert(artifact_block_ref).values({
    from_artifact_id: from,
    from_block_id: blockId,
    to_artifact_id: to,
    to_block_id: null,
    ref_kind: 'cross_link',
  });
}

describe('loadNotePage', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null for unknown / archived / non-note artifacts', async () => {
    const db = testDb();
    expect(await loadNotePage(db, 'nope')).toBeNull();

    await seedNote('archived', 'note_atomic', [], { archived: true });
    expect(await loadNotePage(db, 'archived')).toBeNull();

    await seedNote('quiz', 'tool_quiz', []);
    expect(await loadNotePage(db, 'quiz')).toBeNull();
  });

  // ADR-0033 D5 — /notes/[id] doubles as the interactive artifact reader shell.
  it('loads an interactive artifact: html payload, null body, empty note machinery', async () => {
    const db = testDb();
    await seedKnowledge('k1', '之');
    const html = '<!doctype html><html><body><p>hi</p></body></html>';
    await seedInteractive('i1', ['k1'], { format: 'html', html });

    const page = await loadNotePage(db, 'i1');
    expect(page).not.toBeNull();
    expect(page?.type).toBe('interactive');
    expect(page?.interactive).toEqual({ html }); // attrs.html verbatim
    expect(page?.body_blocks).toBeNull();
    expect(page?.sections).toEqual([]);
    expect(page?.embedded_questions).toEqual([]);
    expect(page?.labels).toEqual([{ id: 'k1', name: '之' }]);
    expect(page?.verification_status).toBe('not_required');
  });

  it('degrades to interactive=null on malformed attrs (page still loads)', async () => {
    const db = testDb();
    await seedInteractive('bad', [], {}); // fails InteractiveArtifactAttrs

    const page = await loadNotePage(db, 'bad');
    expect(page).not.toBeNull(); // chrome (title/version) still renders — not a 404
    expect(page?.interactive).toBeNull();
  });

  it('keeps interactive=null for note types', async () => {
    const db = testDb();
    await seedNote('n1', 'note_atomic', []);
    const page = await loadNotePage(db, 'n1');
    expect(page?.interactive).toBeNull();
  });

  it('aggregates labels, sections, subject profile, version, and history', async () => {
    const db = testDb();
    await seedKnowledge('k1', '之');
    await seedKnowledge('k2', '其');
    await seedKnowledge('kArch', 'archived-node', { archived: true });
    await seedNote('n1', 'note_long', ['k1', 'k2', 'kArch'], {
      bodyBlocks: {
        type: 'doc',
        content: [
          {
            type: 'semanticBlock',
            attrs: {
              id: 's1',
              semantic_kind: 'definition',
              source_tier: 'user_verified',
              user_verified: true,
              version: 0,
              source_markdown: '「之」常见作结构助词。',
            },
            content: [],
          },
        ],
      },
      version: 2,
      history: [
        { version: 1, at: new Date('2026-05-01T00:00:00.000Z') },
        { version: 2, at: new Date('2026-05-02T00:00:00.000Z') },
      ],
      verificationStatus: 'pass',
      verificationSummary: { verdict: 'pass', summary_md: 'ok', issues: [], confidence: 0.9 },
    });

    const page = await loadNotePage(db, 'n1');
    expect(page).not.toBeNull();
    expect(page?.type).toBe('note_long');
    expect(page?.knowledge_ids).toEqual(['k1', 'k2', 'kArch']);
    // archived knowledge label dropped from the resolved names.
    expect(page?.labels.map((l) => l.id).sort()).toEqual(['k1', 'k2']);
    expect(page?.labels.find((l) => l.id === 'k1')?.name).toBe('之');
    expect(page?.sections.map((s) => [s.id, s.kind, s.body_md])).toEqual([
      ['s1', 'definition', '「之」常见作结构助词。'],
    ]);
    expect(page?.subject_profile.id).toBe('wenyan');
    expect(page?.version).toBe(2);
    expect(page?.history.map((h) => h.version)).toEqual([1, 2]);
    expect(page?.verification_status).toBe('pass');
    expect(page?.verification_summary?.verdict).toBe('pass');
    expect(page?.embedded_questions).toEqual([]);
  });

  it('surfaces inbound cross_link backlinks, dropping archived sources', async () => {
    const db = testDb();
    await seedNote('n1', 'note_atomic', ['k1']);
    await seedNote('src', 'note_hub', ['k9'], { genStatus: 'ready' });
    await seedNote('srcArch', 'note_hub', ['k9'], { archived: true });
    await seedCrossLink('src', 'n1', 'b1');
    await seedCrossLink('srcArch', 'n1', 'b2');

    const page = await loadNotePage(db, 'n1');
    expect(page?.backlinks.map((b) => b.from_artifact_id)).toEqual(['src']);
    expect(page?.backlinks_by_type.note_hub.map((b) => b.from_artifact_id)).toEqual(['src']);
  });

  it('groups inbound backlinks by source artifact type', async () => {
    const db = testDb();
    await seedNote('n1', 'note_atomic', ['k1']);
    await seedNote('srcAtomic', 'note_atomic', ['k2']);
    await seedNote('srcLong', 'note_long', ['k3']);
    await seedNote('srcQuiz', 'tool_quiz', []);
    await seedCrossLink('srcAtomic', 'n1', 'b1');
    await seedCrossLink('srcLong', 'n1', 'b2');
    await seedCrossLink('srcQuiz', 'n1', 'b3');

    const page = await loadNotePage(db, 'n1');
    expect(Object.keys(page?.backlinks_by_type ?? {}).sort()).toEqual([
      'note_atomic',
      'note_long',
      'tool_quiz',
    ]);
    expect(page?.backlinks_by_type.note_atomic.map((b) => b.from_artifact_id)).toEqual([
      'srcAtomic',
    ]);
    expect(page?.backlinks_by_type.note_long.map((b) => b.from_artifact_id)).toEqual(['srcLong']);
    expect(page?.backlinks_by_type.tool_quiz.map((b) => b.from_artifact_id)).toEqual(['srcQuiz']);
  });

  it('relates learning_items by primary + label, deduped (primary wins)', async () => {
    const db = testDb();
    await seedKnowledge('k1', '之');
    await seedNote('n1', 'note_atomic', ['k1']);
    await seedLearningItem('liP', { primaryArtifactId: 'n1' });
    await seedLearningItem('liL', { knowledgeIds: ['k1'] });
    await seedLearningItem('liBoth', { primaryArtifactId: 'n1', knowledgeIds: ['k1'] });
    await seedLearningItem('liArch', { primaryArtifactId: 'n1', archived: true });

    const page = await loadNotePage(db, 'n1');
    const byId = new Map(page?.related_learning_items.map((r) => [r.id, r.relation]));
    expect(byId.get('liP')).toBe('primary');
    expect(byId.get('liBoth')).toBe('primary'); // primary wins over label
    expect(byId.get('liL')).toBe('label');
    expect(byId.has('liArch')).toBe(false); // archived excluded
    // no duplicate entries
    expect(page?.related_learning_items.length).toBe(3);
  });
});
