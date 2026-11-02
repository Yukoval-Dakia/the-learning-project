// Aggregates everything the NoteReader page needs in one read. A note's knowledge
// association is its knowledge_ids, never learning_item ownership.

import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  type BacklinksByArtifactType,
  groupBacklinksByArtifactType,
} from '@/capabilities/notes/server/block-refs';
import {
  type NoteGenerationFailure,
  readNoteGenerationFailure,
} from '@/capabilities/notes/server/note-generation-failure';
import type {
  ArtifactBodyBlocksT,
  ArtifactHistoryEntryT,
  NoteVerificationResultT,
} from '@/core/schema/business';
import { InteractiveArtifactAttrs } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, knowledge, learning_item } from '@/db/schema';
import { bodyBlocksToNoteSections } from '@/kernel/read-models/note-sections';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import { type SlimSubjectProfile, toSlimSubjectProfile } from '@/subjects/profile';
import { readVisibleArtifactBacklinks } from './visible-artifact-backlinks';

const NOTE_TYPES = ['note_atomic', 'note_hub', 'note_long'] as const;
// The interactive artifact reads through this page too, but NOTE_TYPES stays
// narrow so note-only machinery never treats it as a note.
const READER_TYPES = [...NOTE_TYPES, 'interactive'] as const;
const RELATED_ITEMS_LIMIT = 30;

export type NotePageSection = ReturnType<typeof bodyBlocksToNoteSections>[number];

export interface NotePageLabel {
  id: string;
  name: string;
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
  // 'primary' references this note; 'label' only shares a knowledge label. Primary
  // wins on dedupe.
  relation: 'primary' | 'label';
}

export interface NotePage {
  id: string;
  type: string;
  title: string;
  knowledge_ids: string[];
  // Resolved non-archived label names.
  labels: NotePageLabel[];
  body_blocks: ArtifactBodyBlocksT | null;
  sections: NotePageSection[];
  generation_status: string;
  generation_failure: NoteGenerationFailure | null;
  verification_status: string;
  verification_summary: NoteVerificationResultT | null;
  // Only for interactive artifacts; a row whose attrs fail validation yields null
  // so the page can degrade instead of 404.
  interactive: { html: string } | null;
  subject_profile: SlimSubjectProfile;
  version: number;
  history: ArtifactHistoryEntryT[];
  backlinks: NotePageBacklink[];
  backlinks_by_type: BacklinksByArtifactType<NotePageBacklink>;
  related_learning_items: NotePageRelatedItem[];
  created_at: string;
  updated_at: string;
}

/**
 * Returns null for a missing, archived, or non-reader artifact so the route can
 * 404. Interactive artifacts read here but have no body, so they resolve to no
 * sections and no editor.
 */
export async function loadNotePage(db: Db, noteId: string): Promise<NotePage | null> {
  const rows = await db
    .select({
      id: artifact.id,
      type: artifact.type,
      title: artifact.title,
      knowledge_ids: artifact.knowledge_ids,
      body_blocks: artifact.body_blocks,
      attrs: artifact.attrs,
      generation_status: artifact.generation_status,
      verification_status: artifact.verification_status,
      verification_summary: artifact.verification_summary,
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
  if (!(READER_TYPES as readonly string[]).includes(note.type)) return null;

  const knowledgeIds = note.knowledge_ids ?? [];

  // Archived or missing knowledge is dropped, mirroring the node page.
  const labels: NotePageLabel[] =
    knowledgeIds.length === 0
      ? []
      : (
          await db
            .select({ id: knowledge.id, name: knowledge.name })
            .from(knowledge)
            .where(and(inArray(knowledge.id, knowledgeIds), isNull(knowledge.archived_at)))
        ).map((r) => ({ id: r.id, name: r.name }));

  // 3. sections — the five-section view; `check` remains the self-explanation anchor.
  const sections = bodyBlocksToNoteSections(note.body_blocks);

  // 4. backlinks — inbound cross_links with the same read-time filters as the panel.
  const backlinks = await readVisibleArtifactBacklinks(db, noteId);

  // 5. related items — primary references plus label overlap, deduped.
  const related = await loadRelatedLearningItems(db, noteId, knowledgeIds);
  const profile = await resolveSubjectProfileForKnowledgeIds(db, knowledgeIds);

  // 6. interactive payload — attrs is opaque jsonb, so this is the read barrier.
  let interactive: NotePage['interactive'] = null;
  if (note.type === 'interactive') {
    const parsed = InteractiveArtifactAttrs.safeParse(note.attrs);
    if (parsed.success) interactive = { html: parsed.data.html };
  }

  return {
    id: note.id,
    type: note.type,
    title: note.title,
    knowledge_ids: knowledgeIds,
    labels,
    body_blocks: note.body_blocks,
    sections,
    generation_status: note.generation_status,
    generation_failure: readNoteGenerationFailure(note.attrs),
    verification_status: note.verification_status,
    verification_summary: note.verification_summary,
    interactive,
    subject_profile: toSlimSubjectProfile(profile),
    version: note.version,
    history: note.history ?? [],
    backlinks,
    backlinks_by_type: groupBacklinksByArtifactType(backlinks),
    related_learning_items: related,
    created_at: note.created_at.toISOString(),
    updated_at: note.updated_at.toISOString(),
  };
}

async function loadRelatedLearningItems(
  db: Db,
  noteId: string,
  knowledgeIds: string[],
): Promise<NotePageRelatedItem[]> {
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

  // Label overlap uses @> per label (no ?| operator).
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
