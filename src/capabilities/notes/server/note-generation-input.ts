// Shared NoteGenerateTask input assembly for one note artifact: parent hub,
// knowledge nodes, one-line intent, and bounded reference artifacts. Consumers:
// the note_generate job and the long-note check revision round (YUK-1642).
import { eq, inArray } from 'drizzle-orm';

import type { NoteGenerationReference } from '@/capabilities/notes/server/note-generation-references';
import { loadNoteGenerationReferences } from '@/capabilities/notes/server/note-generation-references';
import type { Db } from '@/db/client';
import { artifact, knowledge } from '@/db/schema';

export interface NoteGenerateSourceRow {
  id: string;
  type: string;
  title: string;
  knowledge_ids: string[];
  parent_artifact_id: string | null;
  attrs: unknown;
}

export interface NoteGenerateTaskInput {
  artifact_id: string;
  artifact_type: string;
  atomic_title: string;
  title: string;
  one_line_intent: string | null;
  knowledge_node: { id: string; name: string; domain: string | null } | null;
  knowledge_nodes: Array<{ id: string; name: string; domain: string | null }>;
  parent_hub: { title: string; summary_md: string | null } | null;
  related_knowledge_ids: string[];
  reference_artifacts: NoteGenerationReference[];
}

export async function loadNoteGenerateTaskInput(
  db: Db,
  row: NoteGenerateSourceRow,
): Promise<{ input: NoteGenerateTaskInput; referenceArtifacts: NoteGenerationReference[] }> {
  let parentHub: { title: string; attrs: unknown } | null = null;
  if (row.parent_artifact_id) {
    const parentRows = await db
      .select({
        title: artifact.title,
        attrs: artifact.attrs,
      })
      .from(artifact)
      .where(eq(artifact.id, row.parent_artifact_id))
      .limit(1);
    parentHub = parentRows[0] ?? null;
  }

  let kNode: { id: string; name: string; domain: string | null } | null = null;
  let kNodes: Array<{ id: string; name: string; domain: string | null }> = [];
  if (row.knowledge_ids.length > 0) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(inArray(knowledge.id, row.knowledge_ids));
    const byId = new Map(kRows.map((node) => [node.id, node]));
    kNodes = row.knowledge_ids.map((id) => byId.get(id)).filter((node) => node !== undefined);
    kNode = kNodes[0] ?? null;
  }

  const oneLine = (row.attrs as { one_line_intent?: string } | null)?.one_line_intent ?? null;
  const parentSummary = (parentHub?.attrs as { summary_md?: string } | null)?.summary_md ?? null;
  const referenceArtifacts = await loadNoteGenerationReferences(db, row);

  const input: NoteGenerateTaskInput = {
    artifact_id: row.id,
    artifact_type: row.type,
    atomic_title: row.title,
    title: row.title,
    one_line_intent: oneLine,
    knowledge_node: kNode,
    knowledge_nodes: kNodes,
    parent_hub: parentHub ? { title: parentHub.title, summary_md: parentSummary } : null,
    related_knowledge_ids: row.knowledge_ids.slice(1),
    reference_artifacts: referenceArtifacts,
  };
  return { input, referenceArtifacts };
}
