// Active Teaching Session orchestrator: loads the LearningItem, its artifact and
// recent teach messages, runs TeachingTurnTask for a single turn, and returns the
// parsed agent turn. The caller persists the agent message event.
//
// Turn schemas and parsers live in tasks/teaching-turn.ts (the task owner); this
// module keeps the DB context loaders, the single-turn orchestration, and the
// re-exported parse surface so importers keep one entrypoint.

import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '@/db/client';
import { artifact, event, knowledge, learning_item } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  TeachingError,
  type TeachingStructuredQuestionT,
  type TeachingTurnOutputT,
  parseTurnOutput,
} from '../tasks/teaching-turn';
import { bodyBlocksToNoteSections } from './notes-integration';

export {
  TeachingError,
  type TeachingStructuredQuestionT,
  type TeachingTurnOutputT,
  type TurnKindT,
  parseTurnOutput,
} from '../tasks/teaching-turn';

const MessageInput = z.object({
  role: z.enum(['agent', 'user']),
  text_md: z.string(),
  turn_kind: z.enum(['explain', 'ask_check', 'end']).nullish(),
});

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

export interface PlanTeachingTurnParams {
  db: Db;
  sessionId: string;
  learningItemId: string;
  runTaskFn: RunTaskFn;
}

// Single context loader shared by planTeachingTurn and the teaching skill.
export async function loadTeachingContext(db: Db, learningItemId: string) {
  const liRows = await db
    .select({
      id: learning_item.id,
      title: learning_item.title,
      content: learning_item.content,
      knowledge_ids: learning_item.knowledge_ids,
      parent_learning_item_id: learning_item.parent_learning_item_id,
      primary_artifact_id: learning_item.primary_artifact_id,
    })
    .from(learning_item)
    .where(eq(learning_item.id, learningItemId))
    .limit(1);
  const li = liRows[0];
  if (!li) {
    throw new TeachingError('learning_item_not_found', `learning_item ${learningItemId} not found`);
  }

  let knowledgeNode: { id: string; name: string; domain: string | null } | null = null;
  const firstKnowledgeId = (li.knowledge_ids as string[])[0];
  if (firstKnowledgeId) {
    const kRows = await db
      .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
      .from(knowledge)
      .where(eq(knowledge.id, firstKnowledgeId))
      .limit(1);
    if (kRows[0]) knowledgeNode = kRows[0];
  }

  let atomicSections: unknown = null;
  if (li.primary_artifact_id) {
    const aRows = await db
      .select({ body_blocks: artifact.body_blocks })
      .from(artifact)
      .where(eq(artifact.id, li.primary_artifact_id))
      .limit(1);
    if (aRows[0]) atomicSections = bodyBlocksToNoteSections(aRows[0].body_blocks);
  }

  let parentHubSummary: string | null = null;
  if (li.parent_learning_item_id) {
    const hubRows = await db
      .select({ primary_artifact_id: learning_item.primary_artifact_id })
      .from(learning_item)
      .where(eq(learning_item.id, li.parent_learning_item_id))
      .limit(1);
    const hubArtifactId = hubRows[0]?.primary_artifact_id;
    if (hubArtifactId) {
      const haRows = await db
        .select({ attrs: artifact.attrs })
        .from(artifact)
        .where(eq(artifact.id, hubArtifactId))
        .limit(1);
      parentHubSummary =
        (haRows[0]?.attrs as { summary_md?: string } | undefined)?.summary_md ?? null;
    }
  }

  return {
    learning_item: {
      title: li.title,
      one_line_intent: li.content,
      knowledge_node: knowledgeNode ? { id: knowledgeNode.id, name: knowledgeNode.name } : null,
    },
    parent_hub_summary: parentHubSummary,
    atomic_sections: atomicSections,
    subjectProfile: resolveSubjectProfile(knowledgeNode?.domain),
  };
}

async function loadMessages(db: Db, sessionId: string) {
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.session_id, sessionId))
    .orderBy(asc(event.created_at));
  const messages: Array<z.infer<typeof MessageInput>> = [];
  for (const r of rows) {
    const p = r.payload as { role?: string; text_md?: string; turn_kind?: string } | null;
    if (!p?.role || !p.text_md) continue;
    const parsed = MessageInput.safeParse(p);
    if (parsed.success) messages.push(parsed.data);
  }
  return messages;
}

export async function planTeachingTurn(
  params: PlanTeachingTurnParams,
): Promise<TeachingTurnOutputT> {
  const { db, sessionId, learningItemId, runTaskFn } = params;
  const context = await loadTeachingContext(db, learningItemId);
  const messages = await loadMessages(db, sessionId);

  const input = {
    learning_item: context.learning_item,
    parent_hub_summary: context.parent_hub_summary,
    atomic_sections: context.atomic_sections,
    messages,
  };
  const result = await runTaskFn('TeachingTurnTask', input, {
    db,
    subjectProfile: context.subjectProfile,
  });
  return parseTurnOutput(result.text);
}
