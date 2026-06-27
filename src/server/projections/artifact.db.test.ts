// YUK-471 W3-C2 — DB tests for the artifact backfill + hoisted shared gather (testcontainer).
//
// Covers:
//   - genesis backfill (backfillArtifactGenesis): seeds an event-less artifact, SKIPS one already
//     event-sourced (a runtime artifact_create event), is idempotent (re-run seeds 0), and writes a
//     materialized_id_index entry (artifact ENTERS the index, design §5.3).
//   - shared gather (gatherAndFoldArtifact, hoisted from the B1 shell into gather.ts): reproduces the
//     live row byte-for-byte for a backfilled artifact.
//
// Hermetic: resetDb() in beforeEach. resetDb truncates `artifact` (in ALL_TABLES) but NOT
// materialized_id_index (no FK → not CASCADE-reached), so we truncate the index explicitly.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ArtifactRowSnapshotT } from '@/core/schema/event/genesis';
import { artifact, event, materialized_id_index } from '@/db/schema';
import { backfillArtifactGenesis } from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { gatherAndFoldArtifact } from './gather';

const T0 = new Date('2026-06-01T00:00:00.000Z');

async function resetIndex(): Promise<void> {
  await testDb().delete(materialized_id_index);
}

async function insertArtifact(
  id: string,
  over: Partial<typeof artifact.$inferSelect> = {},
): Promise<void> {
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: over.type ?? 'note',
      title: over.title ?? `Artifact ${id}`,
      parent_artifact_id: over.parent_artifact_id ?? null,
      knowledge_ids: over.knowledge_ids ?? [],
      intent_source: over.intent_source ?? 'manual',
      source: over.source ?? 'manual',
      source_ref: over.source_ref ?? null,
      body_blocks: over.body_blocks ?? null,
      attrs: over.attrs ?? {},
      tool_kind: over.tool_kind ?? null,
      tool_state: over.tool_state ?? null,
      generation_status: over.generation_status ?? 'ready',
      verification_status: over.verification_status ?? 'not_required',
      verification_summary: over.verification_summary ?? null,
      generated_by: over.generated_by ?? null,
      verified_by: over.verified_by ?? null,
      history: over.history ?? [],
      archived_at: over.archived_at ?? null,
      created_at: over.created_at ?? T0,
      updated_at: over.updated_at ?? T0,
      version: over.version ?? 0,
    });
}

// Seed a raw create event (the scoping check only reads subject_id, so a minimal payload suffices).
async function seedCreateEvent(id: string, artifactId: string): Promise<void> {
  await testDb().insert(event).values({
    id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'author_artifact',
    action: 'experimental:artifact_create',
    subject_kind: 'artifact',
    subject_id: artifactId,
    outcome: 'success',
    payload: {},
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: T0,
  });
}

async function liveArtifact(id: string): Promise<ArtifactRowSnapshotT | null> {
  const rows = await testDb().select().from(artifact).where(eq(artifact.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    parent_artifact_id: r.parent_artifact_id,
    knowledge_ids: r.knowledge_ids ?? [],
    intent_source: r.intent_source,
    source: r.source,
    source_ref: r.source_ref,
    body_blocks: r.body_blocks,
    attrs: r.attrs ?? {},
    tool_kind: r.tool_kind,
    tool_state: r.tool_state,
    generation_status: r.generation_status,
    verification_status: r.verification_status,
    verification_summary: r.verification_summary,
    generated_by: r.generated_by,
    verified_by: r.verified_by,
    history: r.history ?? [],
    archived_at: r.archived_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
    version: r.version,
  };
}

async function genesisCount(subjectId: string): Promise<number> {
  const rows = await testDb()
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.action, 'experimental:genesis'), eq(event.subject_id, subjectId)));
  return rows.length;
}

describe('backfillArtifactGenesis — scoped to truly event-less artifacts', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('anchors an event-less artifact but SKIPS one already event-sourced (artifact_create)', async () => {
    const db = testDb();
    await insertArtifact('art_eventless'); // event-less → must be anchored
    await insertArtifact('art_created'); // event-sourced via artifact_create → SKIPPED
    await seedCreateEvent('ev_create', 'art_created');

    const counts = await backfillArtifactGenesis(db, T0);

    expect(counts.seeded).toBe(1);
    expect(counts.skipped).toBe(1);
    expect(await genesisCount('art_eventless')).toBe(1);
    expect(await genesisCount('art_created')).toBe(0); // folds from its own create event
  });

  it('writes a materialized_id_index entry for the anchored artifact (artifact ENTERS the index)', async () => {
    const db = testDb();
    await insertArtifact('art_1');
    await backfillArtifactGenesis(db, T0);

    const idx = await db
      .select()
      .from(materialized_id_index)
      .where(eq(materialized_id_index.materialized_id, 'art_1'))
      .limit(1);
    expect(idx).toHaveLength(1);
    expect(idx[0]?.subject_kind).toBe('artifact');
  });

  it('is idempotent: a second backfill seeds 0', async () => {
    const db = testDb();
    await insertArtifact('art_1');
    const first = await backfillArtifactGenesis(db, T0);
    expect(first.seeded).toBe(1);
    const second = await backfillArtifactGenesis(db, T0);
    expect(second.seeded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await genesisCount('art_1')).toBe(1); // still exactly one genesis (no duplicate)
  });

  it('the backfilled genesis folds byte-equal to the live row (shared gatherAndFoldArtifact)', async () => {
    const db = testDb();
    await insertArtifact('art_1', {
      type: 'tool_quiz',
      title: 'Quiz on integrals',
      intent_source: 'copilot',
      source: 'author_artifact',
      generation_status: 'ready',
      verification_status: 'verified',
      version: 4,
    });
    await backfillArtifactGenesis(db, T0);
    const folded = await gatherAndFoldArtifact(db, 'art_1');
    expect(folded).toEqual(await liveArtifact('art_1'));
  });
});
