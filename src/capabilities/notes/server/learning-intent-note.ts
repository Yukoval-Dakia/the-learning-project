import type { Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { artifactRowToCreateSnapshot, emitArtifactCreateEvent } from './artifact-events';
import { summaryBodyBlocks } from './body-blocks';
import { aiAgentRef } from './note-ai-provenance';
import { writeNoteGenerationIntent } from './note-handoff';

interface LearningIntentNoteBase {
  id: string;
  title: string;
  knowledgeIds: string[];
  parentArtifactId: string | null;
  proposalId: string;
  rateEventId: string;
  taskRunId: string | null;
  createdAt: Date;
}

export type CreateLearningIntentNoteInput =
  | (LearningIntentNoteBase & {
      kind: 'hub';
      topic: string;
      summaryMd: string;
      linkedArtifactIds: string[];
      atomicArtifactIds: string[];
      longArtifactIds: string[];
    })
  | (LearningIntentNoteBase & {
      kind: 'atomic' | 'long';
      oneLineIntent: string;
    });

export type CreateLearningIntentNoteFn = (
  tx: Tx,
  input: CreateLearningIntentNoteInput,
) => Promise<void>;

export const createLearningIntentNote: CreateLearningIntentNoteFn = async (tx, input) => {
  const isHub = input.kind === 'hub';
  const [inserted] = await tx
    .insert(artifact)
    .values({
      id: input.id,
      type: isHub ? 'note_hub' : input.kind === 'atomic' ? 'note_atomic' : 'note_long',
      title: input.title,
      parent_artifact_id: input.parentArtifactId,
      knowledge_ids: input.knowledgeIds,
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: input.proposalId,
      body_blocks: isHub
        ? (summaryBodyBlocks(`${input.id}_summary`, input.summaryMd) as never)
        : null,
      attrs: (isHub
        ? {
            topic: input.topic,
            summary_md: input.summaryMd,
            linked_artifact_ids: input.linkedArtifactIds,
            atomic_artifact_ids: input.atomicArtifactIds,
            long_artifact_ids: input.longArtifactIds,
          }
        : { one_line_intent: input.oneLineIntent }) as never,
      tool_kind: null,
      tool_state: null,
      generation_status: isHub ? 'ready' : 'pending',
      generated_by: isHub
        ? ({
            ...aiAgentRef('LearningIntentOutlineTask', {
              text: '',
              ...(input.taskRunId ? { task_run_id: input.taskRunId } : {}),
            }),
          } as never)
        : null,
      history: [],
      created_at: input.createdAt,
      updated_at: input.createdAt,
      version: 0,
    })
    .returning();

  await emitArtifactCreateEvent(tx, {
    row: artifactRowToCreateSnapshot(inserted),
    actorKind: 'agent',
    actorRef: 'learning_intent',
    causedByEventId: input.rateEventId,
    taskRunId: input.taskRunId,
    createdAt: input.createdAt,
  });
  if (!isHub) await writeNoteGenerationIntent(tx, input.id);
};
