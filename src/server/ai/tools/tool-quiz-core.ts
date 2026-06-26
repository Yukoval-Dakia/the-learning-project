// ADR-0032 RP-2 / ADR-0031 (YUK-304 lane B) — the shared tool_quiz artifact
// writer core.
//
// RP-2 (docs/adr/0032-domaintool-surface-redesign.md) scheduled this extraction
// for "when the second wrapper lands": write_review_plan (review-plan-tools.ts)
// and write_quiz (write-quiz.ts) now BOTH delegate their artifact INSERT here.
// The core owns ONLY the constant tool_quiz skeleton — type / parent / source /
// generation_status / verification_status / history / version / timestamps —
// plus the single ToolState Zod barrier (RL4: tool_state is jsonb, opaque to
// audit:schema; the parse is the load-bearing guard). Everything semantic
// (validation, idempotency/advisory locks, titles, attrs, intent_source /
// tool_kind values) stays in the wrappers, so write_review_plan's observable
// behavior is byte-identical to its pre-extraction INSERT.

import { type AgentRef, ToolState } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import {
  artifactRowToCreateSnapshot,
  emitArtifactCreateEvent,
} from '@/server/artifacts/create-event';
import type { z } from 'zod';

type DbLike = Db | Tx;
type AgentRefT = z.infer<typeof AgentRef>;

export interface ToolQuizArtifactParams {
  artifactId: string;
  title: string;
  knowledgeIds: string[];
  /** 'review_plan' | 'quiz_gen' — gates /practice runnability (practice-read.ts). */
  intentSource: string;
  /** artifact.tool_kind (nullable free text — no DDL for a new value). */
  toolKind: string;
  /** Parsed via ToolState.parse INSIDE the core — the single RL4 barrier. */
  toolState: unknown;
  attrs: Record<string, unknown>;
  sourceRef?: string | null;
  /**
   * Conditionally spread: when absent the column is NOT set, keeping
   * write_review_plan's row byte-identical (it never set generated_by).
   */
  generatedBy?: AgentRefT;
  /**
   * YUK-471 W3-C1β — the causing event for the same-tx artifact_create (e.g. the copilot turn's
   * caused_by event, threaded from ctx.causedByEventId). Optional: when absent the create event is
   * unchained (a free-standing AI tool_quiz creation).
   */
  causedByEventId?: string | null;
  now: Date;
}

/**
 * INSERT one tool_quiz artifact row. Caller owns the transaction scope (pass a
 * Tx to make the write atomic with sibling writes) and ALL semantic
 * validation — this core never rejects beyond the ToolState parse.
 *
 * YUK-471 W3-C1β — ALSO emits the self-sufficient artifact_create event on the SAME `dbOrTx`
 * (additive double-write, flag OFF). Both live callers (write_review_plan / write_quiz) pass a Tx, so
 * the INSERT + event are atomic; build the snapshot from the RETURNING row so all 22 columns are
 * materialized (rollback-safe — parseEvent throws on a bad snapshot, rolling back the paired INSERT).
 */
export async function writeToolQuizArtifact(
  dbOrTx: DbLike,
  p: ToolQuizArtifactParams,
): Promise<void> {
  const toolState = ToolState.parse(p.toolState);
  const [insertedArtifact] = await dbOrTx
    .insert(artifact)
    .values({
      id: p.artifactId,
      type: 'tool_quiz',
      title: p.title,
      parent_artifact_id: null,
      knowledge_ids: p.knowledgeIds,
      intent_source: p.intentSource,
      source: 'ai_generated',
      source_ref: p.sourceRef ?? null,
      body_blocks: null,
      attrs: p.attrs as never,
      tool_kind: p.toolKind,
      tool_state: toolState as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      ...(p.generatedBy ? { generated_by: p.generatedBy as never } : {}),
      history: [],
      created_at: p.now,
      updated_at: p.now,
      version: 0,
    })
    .returning();
  await emitArtifactCreateEvent(dbOrTx, {
    row: artifactRowToCreateSnapshot(insertedArtifact),
    actorKind: 'agent',
    // tool_kind is the producing tool ('review_plan' | 'quiz_gen') — the create event's provenance.
    actorRef: p.toolKind,
    causedByEventId: p.causedByEventId ?? null,
    createdAt: p.now,
  });
}
