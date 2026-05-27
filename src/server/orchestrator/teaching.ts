// Phase 2C — Active Teaching Session orchestrator.
//
// Given a conversation session_id, load the LearningItem + its artifact +
// recent teach_message events, call TeachingTurnTask, and return the parsed
// agent turn. Caller (route layer) writes the agent message event.
//
// MVP scope per docs/superpowers/brainstorms/2026-05-17-phase2c-active-teaching.md
//   - single turn, no streaming
//   - turn kinds: 'explain' | 'ask_check' | 'end'
//   - no tool calls; ask_check may carry one structured question for the route to persist
//   - reuses experimental:teach_message event shape

import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { JudgeKind, QuestionKind, Rubric } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { artifact, event, knowledge, learning_item } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';

// ---------- Schemas ----------

const TurnKind = z.enum(['explain', 'ask_check', 'end']);
export type TurnKindT = z.infer<typeof TurnKind>;

const TeachingStructuredQuestion = z.object({
  kind: QuestionKind,
  prompt_md: z.string().min(1).max(4000).optional(),
  reference_md: z.string().min(1).max(4000),
  choices_md: z.array(z.string().min(1)).nullable().optional(),
  judge_kind_override: JudgeKind.nullish(),
  rubric_json: Rubric.nullish(),
});
export type TeachingStructuredQuestionT = z.infer<typeof TeachingStructuredQuestion>;

const TeachingTurnBase = {
  text_md: z.string().min(1).max(2000),
  suggested_next: z.enum(['continue', 'end']),
};

const TeachingTurnOutput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explain'), ...TeachingTurnBase }),
  z.object({
    kind: z.literal('ask_check'),
    ...TeachingTurnBase,
    structured_question: TeachingStructuredQuestion,
  }),
  z.object({ kind: z.literal('end'), ...TeachingTurnBase }),
]);
export type TeachingTurnOutputT = z.infer<typeof TeachingTurnOutput>;

const MessageInput = z.object({
  role: z.enum(['agent', 'user']),
  text_md: z.string(),
  turn_kind: TurnKind.nullish(),
});

// ---------- Public types ----------

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

export interface PlanTeachingTurnParams {
  db: Db;
  sessionId: string;
  learningItemId: string;
  runTaskFn: RunTaskFn;
}

export class TeachingError extends Error {
  constructor(
    public code: 'learning_item_not_found' | 'llm_parse_failed',
    message: string,
  ) {
    super(message);
    this.name = 'TeachingError';
  }
}

// ---------- Helpers ----------

function parseTurnOutput(text: string): TeachingTurnOutputT {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new TeachingError('llm_parse_failed', 'TeachingTurnTask output had no JSON object');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new TeachingError(
      'llm_parse_failed',
      `TeachingTurnTask output JSON.parse failed: ${(e as Error).message}`,
    );
  }
  const parsed = TeachingTurnOutput.safeParse(raw);
  if (!parsed.success) {
    throw new TeachingError(
      'llm_parse_failed',
      `TeachingTurnTask output schema mismatch: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

async function loadTeachingContext(db: Db, learningItemId: string) {
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
      .select({ sections: artifact.sections })
      .from(artifact)
      .where(eq(artifact.id, li.primary_artifact_id))
      .limit(1);
    if (aRows[0]) atomicSections = aRows[0].sections;
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
        .select({ sections: artifact.sections })
        .from(artifact)
        .where(eq(artifact.id, hubArtifactId))
        .limit(1);
      const sections = haRows[0]?.sections as {
        sections?: Array<{ kind: string; body_md: string }>;
      } | null;
      if (sections?.sections) {
        const def = sections.sections.find((s) => s.kind === 'definition');
        parentHubSummary = def?.body_md ?? null;
      }
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
  // filter to experimental:teach_message in payload
  const messages: Array<z.infer<typeof MessageInput>> = [];
  for (const r of rows) {
    const p = r.payload as { role?: string; text_md?: string; turn_kind?: string } | null;
    if (!p?.role || !p.text_md) continue;
    const parsed = MessageInput.safeParse(p);
    if (parsed.success) messages.push(parsed.data);
  }
  return messages;
}

// ---------- planTeachingTurn ----------

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
