// Phase 2 (Task #17) — async variant question generation.
//
// Triggered after a failure attempt has an effective cause. If the active
// SubjectProfile marks the cause's primary_category as targetable, generate
// one variant_question proposal AND insert a `mistake_variant` row at
// status='draft' to claim a slot in the per-parent in-flight ledger.
// Accepting the proposal materializes the question + flips the row to 'active'
// (see acceptAiProposal in src/server/proposals/actions.ts).
//
// YUK-17 (ADR-0018) added: variants_max=3 cap counting all in-flight rows
// (draft + active) and the VariantVerifyTask second pass — the verify handler
// runs after accept and may flip 'active' → 'broken' if the variant drifted
// off the original cause.
//
// Defense against "错题繁殖":
//   1. variant_depth >= 2 → skip (spec §3.4.4 cap)
//   2. parent question.source === 'mistake_variant' → skip (variants do not
//      themselves spawn variants — spec §3.4.4 chain termination)
//   3. SubjectProfile cause category can set variant_targetable=false.
//   4. variants_max=3 counts in-flight (draft + active) mistake_variant rows.
//   5. Per-(parent, attempt) cooldown via proposal cooldown_key — same attempt
//      retrying variant_gen never produces a second proposal.

import { createId } from '@paralleldrive/cuid2';
import { and, count, eq, inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { z } from 'zod';

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { event, knowledge, mistake_variant, question } from '@/db/schema';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import { getFailureAttemptById, writeEvent } from '@/server/events/queries';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
// YUK-471 W2 (critic A4) — mistake_variant creation seam. The creation tx ALWAYS writes the
// runtime BASE event (experimental:mistake_variant_create, carrying the fold-blind cause_category)
// + the materialized_id_index anchor so the SoT-flip guard resolves the variant O(1); the
// per-entity flag projectionIsWriter('mistake_variant') gates ONLY who writes the ROW (projection
// write-through when ON, the imperative INSERT when OFF). NOT genesis (A4: genesis is backfill-only).
import { projectMistakeVariant } from '@/server/projections/mistake_variant';
import {
  assertMistakeVariantParity,
  mistakeVariantLiveRowToSnapshot,
} from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { writeVariantQuestionProposal } from '@/server/proposals/producers';
import { resolveSubjectProfile } from '@/subjects/profile';

// YUK-17 / ADR-0018 — per-parent in-flight variant cap. Counts
// mistake_variant rows where status IN ('draft', 'active') so AI cannot flood
// the inbox even when the user defers review.
export const VARIANTS_MAX_IN_FLIGHT = 3;

export interface VariantGenJobData {
  attempt_event_id: string;
}

export type RunTaskFn = TaskTextRunFn;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<Awaited<ReturnType<RunTaskFn>>> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return result;
}

const VariantOutputSchema = z.object({
  prompt_md: z.string().min(1).max(2000),
  reference_md: z.string().min(1).max(2000),
  difficulty: z.number().int().min(1).max(5),
  reasoning: z.string().min(1).max(500),
});

function parseVariantOutput(text: string): z.infer<typeof VariantOutputSchema> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseVariantOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseVariantOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return VariantOutputSchema.parse(json);
}

export interface RunVariantGenParams {
  db: Db;
  attemptEventId: string;
  runTaskFn: RunTaskFn;
}

export interface RunVariantGenResult {
  status:
    | 'proposed'
    | 'skipped:attempt_not_found'
    | 'skipped:not_a_failure_attempt'
    | 'skipped:attempt_not_active'
    | 'skipped:no_judge_yet'
    | 'skipped:question_not_found'
    | 'skipped:max_depth'
    | 'skipped:variant_chain_terminus'
    | 'skipped:cause_not_targetable'
    | 'skipped:already_has_variant'
    | 'skipped:variants_max_reached';
  proposal_id?: string;
  mistake_variant_id?: string;
}

export async function runVariantGen(params: RunVariantGenParams): Promise<RunVariantGenResult> {
  const { db, attemptEventId, runTaskFn } = params;

  // Load the attempt event
  const attemptRows = await db
    .select({
      id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      outcome: event.outcome,
      payload: event.payload,
    })
    .from(event)
    .where(eq(event.id, attemptEventId))
    .limit(1);
  const attempt = attemptRows[0];
  if (!attempt) return { status: 'skipped:attempt_not_found' };
  if (
    attempt.action !== 'attempt' ||
    attempt.subject_kind !== 'question' ||
    attempt.outcome !== 'failure'
  ) {
    return { status: 'skipped:not_a_failure_attempt' };
  }

  const failure = await getFailureAttemptById(db, attemptEventId);
  if (!failure) return { status: 'skipped:attempt_not_active' };
  const cause = effectiveCauseForFailureAttempt(failure);
  if (!cause) return { status: 'skipped:no_judge_yet' };
  if (!cause.primary_category) return { status: 'skipped:cause_not_targetable' };

  // Load the parent question
  const qRows = await db
    .select({
      id: question.id,
      kind: question.kind,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
      source: question.source,
      variant_depth: question.variant_depth,
      root_question_id: question.root_question_id,
      difficulty: question.difficulty,
    })
    .from(question)
    .where(eq(question.id, attempt.subject_id))
    .limit(1);
  const parent = qRows[0];
  if (!parent) return { status: 'skipped:question_not_found' };
  if (parent.source === 'mistake_variant') {
    return { status: 'skipped:variant_chain_terminus' };
  }
  if (parent.variant_depth >= 1) {
    // depth=0 (原题) → can spawn depth=1; depth=1 cannot spawn depth=2 per
    // spec §3.4.4 ("不超过 2 代" — i.e. only depth 0 and 1 exist, and
    // depth 1 doesn't spawn depth 2).
    return { status: 'skipped:max_depth' };
  }

  // YUK-17 / ADR-0018 — per-parent in-flight cap. Counts both pending
  // proposals (status='draft') AND accepted-but-not-broken variants
  // (status='active'). This supersedes the MVP "1-per-parent" cap that
  // checked question.parent_variant_id alone, since mistake_variant is now
  // the canonical in-flight ledger.
  const inFlightCountRows = await db
    .select({ value: count() })
    .from(mistake_variant)
    .where(
      and(
        eq(mistake_variant.parent_question_id, parent.id),
        inArray(mistake_variant.status, ['draft', 'active']),
      ),
    );
  const inFlightCount = inFlightCountRows[0]?.value ?? 0;
  if (inFlightCount >= VARIANTS_MAX_IN_FLIGHT) {
    return { status: 'skipped:variants_max_reached' };
  }

  // Per-(parent, attempt) idempotency: same attempt re-triggering variant_gen
  // never spawns a second proposal — even if variants_max still has headroom.
  const cooldownKey = `variant_question:${parent.id}:${attemptEventId}`;
  const pendingProposals = await listProposalInboxRows(db, { status: 'pending' });
  if (
    pendingProposals.some(
      (proposal) =>
        proposal.kind === 'variant_question' && proposal.payload.cooldown_key === cooldownKey,
    )
  ) {
    return { status: 'skipped:already_has_variant' };
  }

  const payload = attempt.payload as { answer_md?: string | null };
  const firstKnowledgeId = parent.knowledge_ids[0];
  const knowledgeRows = firstKnowledgeId
    ? await db
        .select({ domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, firstKnowledgeId))
        .limit(1)
    : [];
  const subjectProfile = resolveSubjectProfile(knowledgeRows[0]?.domain);
  const causeCategory = subjectProfile.causeCategories.find(
    (category) => category.id === cause.primary_category,
  );
  if (!causeCategory || causeCategory.variant_targetable === false) {
    return { status: 'skipped:cause_not_targetable' };
  }

  const input = {
    original_question: {
      id: parent.id,
      kind: parent.kind,
      prompt_md: parent.prompt_md,
      reference_md: parent.reference_md,
      knowledge_ids: parent.knowledge_ids,
    },
    attempt: { wrong_answer_md: payload.answer_md ?? '' },
    cause: {
      primary_category: cause.primary_category,
      analysis_md: cause.analysis_md ?? cause.user_notes ?? '',
    },
    depth: parent.variant_depth,
  };

  const result = await runTaskFn('VariantGenTask', input, {
    db,
    subjectProfile,
  });
  const parsed = parseVariantOutput(result.text);

  const rootId = parent.root_question_id ?? parent.id;
  const now = new Date();

  let proposalId = '';
  const mistakeVariantId = createId();
  const flip = projectionIsWriter('mistake_variant');
  await db.transaction(async (tx) => {
    proposalId = await writeVariantQuestionProposal(tx, {
      source_question_id: parent.id,
      source_attempt_event_id: attemptEventId,
      prompt_md: parsed.prompt_md,
      reference_md: parsed.reference_md,
      difficulty: parsed.difficulty,
      knowledge_ids: parent.knowledge_ids,
      parent_variant_id: parent.id,
      root_question_id: rootId,
      variant_depth: parent.variant_depth + 1,
      reason_md: parsed.reasoning,
      task_run_id: result.task_run_id ?? null,
      cost_usd: result.cost_usd,
      created_at: now,
    });

    // YUK-471 W2 (critic A4) — the initial mistake_variant snapshot. cause_category is the
    // FOLD-BLIND field (computed here at INSERT, carried by NO downstream event), so the runtime
    // BASE event MUST snapshot the whole row so the fold can reproduce it. This is the ONE W2
    // entity that writes a base event at creation — but it is a CREATE event, NOT genesis (A4).
    const baseRow = {
      id: mistakeVariantId,
      parent_question_id: parent.id,
      variant_question_id: null,
      proposal_event_id: proposalId,
      status: 'draft' as const,
      failure_reasons: [],
      cause_category: cause.primary_category,
      created_at: now,
      updated_at: now,
    };

    // 1. ALWAYS write the runtime BASE event (experimental:mistake_variant_create) FIRST so the
    //    fold (when the flag is ON) sees it in the same tx — it is the row's ground truth incl.
    //    the fold-blind cause_category. ingest_at=now → outbox opt-out (a creation base is not a
    //    memory-worthy activity; mirrors the goal accept seam writing the event before the row).
    const createEventId = newId();
    await writeEvent(tx, {
      id: createEventId,
      actor_kind: 'agent',
      actor_ref: 'variant_gen',
      action: 'experimental:mistake_variant_create',
      subject_kind: 'mistake_variant',
      subject_id: mistakeVariantId,
      outcome: 'success',
      payload: { row: baseRow },
      caused_by_event_id: proposalId,
      ingest_at: now,
    });
    // 2. ALWAYS write the materialized_id_index anchor (mvId → the create event) regardless of the
    //    flag. The event log + anchor is the source of truth; the flag only switches the ROW writer.
    await upsertMaterializedIdIndex(tx, {
      materialized_id: mistakeVariantId,
      anchor_event_id: createEventId,
      subject_kind: 'mistake_variant',
    });
    // 3. ROW writer — gated on the per-entity flag (critic A1, defer-flip-not-build):
    //    ON  → the projection write-through folds (the create base) and writes the row;
    //    OFF → the imperative INSERT stays the writer (current behavior — claim the in-flight slot
    //          so variants_max=3 counting works while the proposal is pending, YUK-17/ADR-0018).
    if (flip) {
      await projectMistakeVariant(tx, mistakeVariantId);
    } else {
      await tx.insert(mistake_variant).values(baseRow);
      // write-time fold==row guard: the variant is event-sourced this tx (the create base + index
      // anchor), so the fold reproduces the draft row. dev/test throw on mismatch, prod warn.
      const [written] = await tx
        .select()
        .from(mistake_variant)
        .where(eq(mistake_variant.id, mistakeVariantId))
        .limit(1);
      await assertMistakeVariantParity(
        tx,
        mistakeVariantId,
        written ? mistakeVariantLiveRowToSnapshot(written) : null,
      );
    }
  });

  return {
    status: 'proposed',
    proposal_id: proposalId,
    mistake_variant_id: mistakeVariantId,
  };
}

export function buildVariantGenHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<VariantGenJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async (jobs) => {
    for (const job of jobs) {
      const attemptEventId = job.data?.attempt_event_id;
      if (!attemptEventId) {
        console.warn('[variant_gen] job missing attempt_event_id', job.id);
        continue;
      }
      try {
        const result = await runVariantGen({ db, attemptEventId, runTaskFn });
        console.log(`[variant_gen] ${attemptEventId} → ${result.status}`);
      } catch (err) {
        console.error(`[variant_gen] ${attemptEventId} failed`, err);
        throw err;
      }
    }
  };
}
