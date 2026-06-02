// YUK-203 P1 (ADR-0027) — GET /api/notes/[id] aggregator (NoteReader backend).
//
// A note(artifact) is now a first-class knowledge-labeled entity with its own
// canonical reader page (/notes/[id], 2b brief §G2). This aggregates everything
// the NoteReader needs into one server call: content blocks + resolved labels +
// verification + version history + inbound backlinks + related learning_items +
// embedded-check questions. Mirrors loadKnowledgeNodePage's read patterns
// (block→embedded-question resolve, XC-5 backlink read-time filters) but is keyed
// on the note id, not a knowledge id. Label model only (ADR-0020 §3): a note's
// knowledge association is `knowledge_ids`, never learning_item ownership.

import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type {
  ArtifactBodyBlocksT,
  ArtifactHistoryEntryT,
  NoteVerificationResultT,
} from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, knowledge, learning_item, question } from '@/db/schema';
import { listBacklinks, resolveOwningLearningItemIds } from '@/server/artifacts/block-refs';
import { bodyBlocksToNoteSections } from '@/server/artifacts/body-blocks';
import { getArtifactCorrectionStates } from '@/server/events/artifact-corrections';

const CROSS_LINK_REF_KIND = 'cross_link';
const NOTE_TYPES = ['note_atomic', 'note_hub', 'note_long'] as const;
const RELATED_ITEMS_LIMIT = 30;

export interface NotePageLabel {
  id: string;
  name: string;
}

export interface NotePageEmbeddedQuestion {
  id: string;
  kind: string;
  prompt_md: string;
  choices_md: string[] | null;
}

export interface NotePageBacklink {
  from_artifact_id: string;
  from_learning_item_id: string | null;
  from_title: string;
  from_type: string;
  from_block_id: string;
}

export interface NotePageRelatedItem {
  id: string;
  title: string;
  status: string;
  // 'primary' = references this note via primary_artifact_id; 'label' = shares
  // ≥1 knowledge label with this note (study material). primary wins on dedupe.
  relation: 'primary' | 'label';
}

export interface NotePage {
  id: string;
  // note_atomic | note_hub | note_long
  type: string;
  title: string;
  knowledge_ids: string[];
  // resolved non-archived label names (archived/missing knowledge dropped).
  labels: NotePageLabel[];
  body_blocks: ArtifactBodyBlocksT | null;
  generation_status: string;
  verification_status: string;
  verification_summary: NoteVerificationResultT | null;
  embedded_check_status: string;
  embedded_questions: NotePageEmbeddedQuestion[];
  version: number;
  history: ArtifactHistoryEntryT[];
  backlinks: NotePageBacklink[];
  related_learning_items: NotePageRelatedItem[];
  created_at: string;
  updated_at: string;
}

/**
 * Aggregate every read the /notes/[id] NoteReader page needs into one server
 * call. Returns null when the note doesn't exist, is archived, or is not a note
 * type (tool_quiz / other artifact kinds are not NoteReader pages) so the route
 * can 404 instead of rendering an empty shell.
 */
export async function loadNotePage(db: Db, noteId: string): Promise<NotePage | null> {
  // 1. the note artifact (non-archived, note type only).
  const rows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      knowledge_ids: artifact.knowledge_ids,
      body_blocks: artifact.body_blocks,
      generation_status: artifact.generation_status,
      verification_status: artifact.verification_status,
      verification_summary: artifact.verification_summary,
      embedded_check_status: artifact.embedded_check_status,
      history: artifact.history,
      version: artifact.version,
      created_at: artifact.created_at,
      updated_at: artifact.updated_at,
    })
    .from(artifact)
    .where(and(eq(artifact.id, noteId), isNull(artifact.archived_at)))
    .limit(1);
  const note = rows[0];
  if (!note) return null;
  if (!(NOTE_TYPES as readonly string[]).includes(note.type)) return null;

  const knowledgeIds = note.knowledge_ids ?? [];

  // 2. resolved labels — non-archived knowledge names (archived/missing dropped,
  // mirroring the node page's archived-link avoidance).
  const labels: NotePageLabel[] =
    knowledgeIds.length === 0
      ? []
      : (
          await db
            .select({ id: knowledge.id, name: knowledge.name })
            .from(knowledge)
            .where(and(inArray(knowledge.id, knowledgeIds), isNull(knowledge.archived_at)))
        ).map((r) => ({ id: r.id, name: r.name }));

  // 3. embedded-check questions — resolve the check section's question_ids when
  // the embedded check is ready (mirrors loadKnowledgeNodePage).
  const sections = bodyBlocksToNoteSections(note.body_blocks);
  let embeddedQuestions: NotePageEmbeddedQuestion[] = [];
  if (note.embedded_check_status === 'ready') {
    const ids = sections.find((s) => s.kind === 'check')?.embedded_check?.question_ids ?? [];
    if (ids.length > 0) {
      const qRows = await db
        .select({
          id: question.id,
          kind: question.kind,
          prompt_md: question.prompt_md,
          choices_md: question.choices_md,
        })
        .from(question)
        .where(inArray(question.id, ids));
      const byId = new Map(qRows.map((r) => [r.id, r]));
      embeddedQuestions = ids
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined);
    }
  }

  // 4. backlinks — inbound cross_links pointing AT this note, with the same XC-5
  // read-time filters as the node page / backlink panel (archived / non-ready /
  // retracted sources dropped).
  const backlinks = await loadBacklinks(db, noteId);

  // 5. related learning_items — items referencing this note as primary + items
  // sharing ≥1 knowledge label (study material). Deduped, primary wins.
  const related = await loadRelatedLearningItems(db, noteId, knowledgeIds);

  return {
    id: note.id,
    type: note.type,
    title: note.title,
    knowledge_ids: knowledgeIds,
    labels,
    body_blocks: note.body_blocks,
    generation_status: note.generation_status,
    verification_status: note.verification_status,
    verification_summary: note.verification_summary,
    embedded_check_status: note.embedded_check_status,
    embedded_questions: embeddedQuestions,
    version: note.version,
    history: note.history ?? [],
    backlinks,
    related_learning_items: related,
    created_at: note.created_at.toISOString(),
    updated_at: note.updated_at.toISOString(),
  };
}

async function loadBacklinks(db: Db, noteId: string): Promise<NotePageBacklink[]> {
  const inbound = (await listBacklinks(db, { toArtifactId: noteId })).filter(
    (ref) => ref.ref_kind === CROSS_LINK_REF_KIND,
  );
  if (inbound.length === 0) return [];

  const sourceIds = Array.from(new Set(inbound.map((ref) => ref.from_artifact_id)));
  const sourceRows = await db
    .select({
      id: artifact.id,
      archived_at: artifact.archived_at,
      generation_status: artifact.generation_status,
    })
    .from(artifact)
    .where(inArray(artifact.id, sourceIds));
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const correctionStates = await getArtifactCorrectionStates(db, sourceIds);
  const owningByArtifact = await resolveOwningLearningItemIds(db, sourceIds);

  const out: NotePageBacklink[] = [];
  for (const ref of inbound) {
    const source = sourceById.get(ref.from_artifact_id);
    if (!source) continue;
    if (source.archived_at != null) continue;
    if (source.generation_status !== 'ready') continue;
    const correction = correctionStates.get(ref.from_artifact_id);
    if (correction) {
      if (correction.whole.state === 'retracted' || correction.whole.state === 'superseded') {
        continue;
      }
      const blockState = correction.blocks.get(ref.from_block_id);
      if (blockState && (blockState.state === 'retracted' || blockState.state === 'superseded')) {
        continue;
      }
    }
    out.push({
      from_artifact_id: ref.from_artifact_id,
      from_learning_item_id: owningByArtifact.get(ref.from_artifact_id) ?? null,
      from_title: ref.from_artifact_title,
      from_type: ref.from_artifact_type,
      from_block_id: ref.from_block_id,
    });
  }
  return out;
}

async function loadRelatedLearningItems(
  db: Db,
  noteId: string,
  knowledgeIds: string[],
): Promise<NotePageRelatedItem[]> {
  // primary: non-archived items referencing this note via primary_artifact_id.
  const primaryRows = await db
    .select({ id: learning_item.id, title: learning_item.title, status: learning_item.status })
    .from(learning_item)
    .where(and(eq(learning_item.primary_artifact_id, noteId), isNull(learning_item.archived_at)))
    .orderBy(asc(learning_item.created_at));
  const seen = new Set(primaryRows.map((r) => r.id));
  const out: NotePageRelatedItem[] = primaryRows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    relation: 'primary' as const,
  }));

  // label: non-archived items sharing ≥1 knowledge label (study material). OR of
  // `@>` per label reuses the established containment pattern (no `?|` operator).
  if (knowledgeIds.length > 0 && out.length < RELATED_ITEMS_LIMIT) {
    const overlap = knowledgeIds.map(
      (kid) => sql`${learning_item.knowledge_ids} @> ${JSON.stringify([kid])}::jsonb`,
    );
    const labelRows = await db
      .select({ id: learning_item.id, title: learning_item.title, status: learning_item.status })
      .from(learning_item)
      .where(and(or(...overlap), isNull(learning_item.archived_at)))
      .orderBy(desc(learning_item.updated_at))
      .limit(RELATED_ITEMS_LIMIT);
    for (const r of labelRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, title: r.title, status: r.status, relation: 'label' });
      if (out.length >= RELATED_ITEMS_LIMIT) break;
    }
  }
  return out;
}
