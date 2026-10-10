import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { MAX_IMAGE_UPLOAD_BYTES } from '@/core/limits';
import { canonicalHash } from '@/core/migration/canonical';
import { validateExecutionPlan } from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import * as schema from '@/db/schema';
import {
  ai_task_runs,
  job_events,
  learning_session,
  question,
  question_block,
  question_group_lifecycle,
  question_revision,
  source_asset,
} from '@/db/schema';
import { withinSessionAdvisoryLock } from '@/db/session-advisory-lock';
import { ApiError } from '@/kernel/http';
import {
  createAssessmentVerificationTaskRunner,
  defaultImageFetch,
  runSolveCheck,
} from '@/kernel/judge';
import { resolveSubjectProfileForKnowledgeIdsStrict } from '@/kernel/read-models/subject-profile';
import { normalizeQuestionRowToContract } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import type { IngestionAssessmentReviewResult } from '../api/contracts';
import { readIngestionAssessmentReceipts } from './assessment-receipt';
import { withinAssessmentReviewExecutionClient } from './assessment-review-client';
import {
  ASSESSMENT_REVIEW_POLICY,
  AssessmentReviewBinding,
  type AssessmentReviewBindingT,
  AssessmentReviewEvidence,
  type AssessmentReviewEvidenceT,
  assessmentReviewOperationId,
  matchesAssessmentReviewBinding,
  projectAssessmentReviewMedia,
  projectAssessmentReviewQuestion,
  readAssessmentReviewStage,
} from './assessment-review-evidence';
import { ingestionCaptureIdentity } from './capture-identity';
import {
  INGESTION_OPERATION_TABLE,
  isTerminalIngestionOperation,
  readIngestionOperation,
  writeIngestionOperationEvent,
} from './operation-store';

type TaskTextRunFn = Parameters<typeof runSolveCheck>[1]['runTaskFn'];
const EXECUTION_LOCK_NAMESPACE = 'ingestion-assessment-execution';
const EXECUTION_LOCK_WAIT_MS = 30_000;

interface ReviewDeps {
  runTaskFn?: TaskTextRunFn;
  loadImages?: (assets: Array<typeof source_asset.$inferSelect>) => ReturnType<typeof loadImages>;
  lockWaitMs?: number;
}

async function readTarget(
  db: Db | Tx,
  input: { sessionId: string; blockId: string },
  lock = false,
) {
  const blocks = db.select().from(question_block).where(eq(question_block.id, input.blockId));
  const [block] = await (lock ? blocks.for('update') : blocks);
  const [session] = await db
    .select()
    .from(learning_session)
    .where(and(eq(learning_session.id, input.sessionId), eq(learning_session.type, 'ingestion')));
  if (!block || block.ingestion_session_id !== input.sessionId || !session)
    throw new ApiError('not_found', 'Assessment review block does not belong to this session', 404);
  if (!['extracted', 'partial', 'reviewed', 'imported'].includes(session.status))
    throw new ApiError('conflict', 'Session is unavailable for assessment review', 409);
  const questionId = block.imported_question_id ?? ingestionCaptureIdentity(block).questionId;
  const [supplied] = await db.select().from(question).where(eq(question.id, questionId));
  if (
    !supplied ||
    supplied.metadata?.ingestion_session_id !== input.sessionId ||
    supplied.metadata?.question_block_id !== block.id ||
    (!block.imported_question_id && supplied.metadata?.capture_block_version !== block.version)
  )
    throw new ApiError(
      'assessment_not_saved',
      'No associated saved question for this block version',
      409,
    );
  const groupId = supplied.parent_question_id ?? supplied.id;
  // Ingestion writers lock blocks before the canonical question group.
  const roots = db.select().from(question).where(eq(question.id, groupId));
  const [root] = await (lock ? roots.for('update') : roots);
  const [lifecycle] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, groupId));
  const [revision] = lifecycle?.current_revision_id
    ? await db
        .select()
        .from(question_revision)
        .where(
          and(
            eq(question_revision.group_id, groupId),
            eq(question_revision.revision_id, lifecycle.current_revision_id),
          ),
        )
    : [];
  if (!root || !lifecycle || !revision)
    throw new ApiError('publication_missing', 'Saved question has no canonical publication', 409);
  // Re-read a supplied child after acquiring its group's lock.
  const [row] = await db.select().from(question).where(eq(question.id, questionId));
  if (!row) throw new ApiError('assessment_not_saved', 'Saved question is missing', 409);
  if (
    (row.parent_question_id ?? row.id) !== groupId ||
    row.metadata?.ingestion_session_id !== input.sessionId ||
    row.metadata?.question_block_id !== block.id
  )
    throw new ApiError('conflict', 'Saved question association changed', 409);
  const binding: AssessmentReviewBindingT = {
    session_id: input.sessionId,
    block_id: block.id,
    block_version: block.version,
    question_id: row.id,
    question_version: row.version,
    group_id: groupId,
    revision_id: revision.revision_id,
    revision_digest: revision.integrity_digest,
    admission_generation: lifecycle.scoring_admission_generation,
    policy_id: ASSESSMENT_REVIEW_POLICY,
  };
  return { block, session, row, lifecycle, revision, binding };
}

/** Server-owned identity, before reservation; the worker repeats the frozen comparisons. */
export async function prepareIngestionAssessmentReview(
  db: Db,
  input: { sessionId: string; blockId: string },
) {
  const target = await db.transaction((tx) => readTarget(tx, input, true));
  return { operationId: assessmentReviewOperationId(target.binding), binding: target.binding };
}

async function reviewEvents(db: Db | Tx, operationId: string) {
  return db
    .select({ eventType: job_events.event_type, payload: job_events.payload })
    .from(job_events)
    .where(
      and(
        eq(job_events.business_table, INGESTION_OPERATION_TABLE),
        eq(job_events.business_id, operationId),
      ),
    )
    .orderBy(asc(job_events.id));
}

async function lockOperation(tx: Tx, operationId: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('ingestion-assessment-settlement'), hashtext(${operationId}))`,
  );
}

async function finish(
  tx: Tx,
  operationId: string,
  target: Awaited<ReturnType<typeof readTarget>> | null,
  status: IngestionAssessmentReviewResult['status'],
  reason: string,
  evidence?: AssessmentReviewEvidenceT,
) {
  const assessment = target
    ? ((await readIngestionAssessmentReceipts(tx, [target.block])).get(target.block.id) ?? null)
    : null;
  const result: IngestionAssessmentReviewResult = {
    status,
    reason,
    assessment,
    ...(evidence
      ? {
          verification: {
            policy_id: ASSESSMENT_REVIEW_POLICY,
            subject_id: evidence.subject_id,
            result_digest: canonicalHash(evidence),
            task_runs: evidence.task_runs,
          },
        }
      : {}),
  };
  await writeIngestionOperationEvent(tx, {
    operationId,
    eventType: 'operation.completed',
    payload: { result },
  });
}

async function preflight(db: Db | Tx, target: Awaited<ReturnType<typeof readTarget>>) {
  const { row, block, session, lifecycle, revision } = target;
  if (lifecycle.withdrawn || lifecycle.suspended) return { reason: 'lifecycle_hold' } as const;
  if (lifecycle.scoring_admission_withheld_reason === 'owner_hold')
    return { reason: 'owner_hold' } as const;
  if (lifecycle.scoring_admission_state === 'admitted')
    return { reason: 'already_admitted' } as const;
  const parts = await db
    .select({ id: question.id })
    .from(question)
    .where(eq(question.parent_question_id, row.id));
  if (row.parent_question_id || parts.length || revision.structure.parts.length !== 1)
    return { reason: 'unsupported_group_contract' } as const;
  // Original source pages can contain printed answers or learner work. A legacy
  // page-backed row has no contract proving its text/figures are a complete prompt.
  if (row.image_refs.length && !row.structured)
    return { reason: 'unsupported_legacy_image_contract' } as const;
  const media = projectAssessmentReviewMedia(revision.structure);
  if (media.reason !== undefined) return { reason: media.reason } as const;
  const imageIds = [...new Set(media.figures.map((figure) => figure.asset_id))];
  const owned = new Set([
    ...session.source_asset_ids,
    ...block.figures.map((figure) => figure.asset_id),
  ]);
  if (imageIds.some((id) => !owned.has(id))) return { reason: 'unowned_prompt_image' } as const;
  const foundAssets = imageIds.length
    ? await db.select().from(source_asset).where(inArray(source_asset.id, imageIds))
    : [];
  if (
    foundAssets.length !== imageIds.length ||
    foundAssets.some(
      (asset) =>
        !asset.mime_type.startsWith('image/') ||
        !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
        asset.byte_size < 1 ||
        asset.byte_size > MAX_IMAGE_UPLOAD_BYTES,
    )
  )
    return { reason: 'prompt_image_unavailable' } as const;
  const assets = foundAssets.sort((a, b) => imageIds.indexOf(a.id) - imageIds.indexOf(b.id));
  if (
    media.figures.some(
      (figure) =>
        assets.find((asset) => asset.id === figure.asset_id)?.sha256.toLowerCase() !==
        figure.digest,
    )
  )
    return { reason: 'prompt_image_digest_changed' } as const;
  const contract = normalizeQuestionRowToContract({
    ...row,
    figureDigests: Object.fromEntries(assets.map((asset) => [asset.id, asset.sha256])),
  });
  if (contract.conversion_issues.length)
    return { reason: contract.conversion_issues[0].code } as const;
  if (contract.integrity_digest !== revision.integrity_digest)
    return { reason: 'unpublished_question_change' } as const;
  const questionProjection = projectAssessmentReviewQuestion(revision);
  if (!questionProjection) return { reason: 'unsupported_scoring_contract' } as const;
  if (!questionProjection.prompt_md.trim()) return { reason: 'missing_prompt' } as const;
  const planIssues = validateExecutionPlan(revision.execution_plan, revision.scoring_basis);
  if (planIssues.length)
    return {
      reason: planIssues.some((issue) => issue.code === 'unadmitted_model_executor')
        ? 'no_admitted_executor'
        : 'unsupported_execution_plan',
    } as const;
  if (!row.knowledge_ids.length) return { reason: 'missing_subject' } as const;
  // Never use the read-side general subject fallback for release.
  const profiles = await Promise.all(
    row.knowledge_ids.map((id) =>
      resolveSubjectProfileForKnowledgeIdsStrict(db, [id]).catch(() => null),
    ),
  );
  const profile = profiles[0];
  if (!profile || profiles.some((candidate) => candidate?.id !== profile.id))
    return { reason: 'unresolved_subject' } as const;
  const figuresHint = media.figures.map((figure) => ({
    asset_id: figure.asset_id,
    role: 'diagram',
  }));
  return { profile, assets, imageIds, figuresHint, questionProjection } as const;
}

async function loadImages(db: Db, assets: Array<typeof source_asset.$inferSelect>) {
  if (!assets.length) return [];
  const images = await defaultImageFetch(
    assets.map((asset) => asset.id),
    db,
  );
  if (images.length !== assets.length) throw new Error('Prompt images are unavailable');
  for (const [index, asset] of assets.entries()) {
    const image = images[index];
    const bytes = Buffer.from(image.data, 'base64');
    if (
      image.mediaType !== asset.mime_type ||
      bytes.length !== asset.byte_size ||
      createHash('sha256').update(bytes).digest('hex') !== asset.sha256.toLowerCase()
    )
      throw new Error('Prompt image bytes do not match their owned asset');
  }
  return images;
}

/** A committed start can never be reclaimed for a second paid call. */
export async function completeIngestionAssessmentReview(
  poolDb: Db,
  input: { operationId: string; sessionId: string },
  deps: ReviewDeps = {},
): Promise<void> {
  return withinAssessmentReviewExecutionClient(poolDb.$client, (client) =>
    withinSessionAdvisoryLock(
      drizzle(client, { schema }),
      {
        namespace: EXECUTION_LOCK_NAMESPACE,
        key: input.operationId,
        busy: () =>
          new ApiError(
            'assessment_review_busy',
            'Assessment review is running; retry delivery',
            503,
          ),
      },
      new Date(Date.now() + (deps.lockWaitMs ?? EXECUTION_LOCK_WAIT_MS)),
      async (lockedDb) => {
        const [owner] = await lockedDb.execute<{ pid: number }>(
          sql`SELECT pg_backend_pid() AS pid`,
        );
        let ownershipLost = false;
        const assertOwned = async (db: Db | Tx) => {
          if (ownershipLost) throw new Error('Assessment review execution ownership was lost');
          try {
            const [witness] = await db.execute<{ pid: number; owned: boolean }>(sql`
            SELECT pg_backend_pid() AS pid, EXISTS (
              SELECT 1 FROM pg_locks
              WHERE locktype = 'advisory' AND pid = pg_backend_pid()
                AND mode = 'ExclusiveLock' AND granted AND objsubid = 2
                AND classid = (hashtext(${EXECUTION_LOCK_NAMESPACE})::bigint & 4294967295)::oid
                AND objid = (hashtext(${input.operationId})::bigint & 4294967295)::oid
            ) AS owned
          `);
            if (!owner || witness?.pid !== owner.pid || !witness.owned)
              throw new Error('Assessment review execution ownership was lost');
          } catch (error) {
            ownershipLost = true;
            throw error;
          }
        };
        await assertOwned(lockedDb);
        await completeOwnedAssessmentReview(lockedDb, poolDb, input, deps, assertOwned);
      },
    ),
  );
}

async function completeOwnedAssessmentReview(
  db: Db,
  poolDb: Db,
  input: { operationId: string; sessionId: string },
  deps: ReviewDeps,
  assertOwned: (db: Db | Tx) => Promise<void>,
): Promise<void> {
  const claimed = await db.transaction(async (tx) => {
    await assertOwned(tx);
    await lockOperation(tx, input.operationId);
    const operation = await readIngestionOperation(tx, input.operationId);
    if (!operation || isTerminalIngestionOperation(operation)) return null;
    if (
      operation.operation_kind !== 'assessment_review' ||
      operation.session_id !== input.sessionId
    )
      throw new ApiError('conflict', 'Review delivery does not match its reserved operation', 409);
    const events = await reviewEvents(tx, input.operationId);
    const accepted = events.find((event) => event.eventType === 'operation.accepted');
    const binding = AssessmentReviewBinding.parse(accepted?.payload.review_binding);
    if (assessmentReviewOperationId(binding) !== input.operationId)
      throw new Error('Assessment review operation identity mismatch');
    let target: Awaited<ReturnType<typeof readTarget>>;
    try {
      target = await readTarget(
        tx,
        { sessionId: binding.session_id, blockId: binding.block_id },
        true,
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await finish(tx, input.operationId, null, 'superseded', error.code);
      return null;
    }
    if (!matchesAssessmentReviewBinding(binding, target.binding)) {
      await finish(tx, input.operationId, target, 'superseded', 'binding_changed');
      return null;
    }
    const stage = readAssessmentReviewStage(events);
    if (stage.state === 'unknown_result') {
      await finish(tx, input.operationId, target, 'withheld', 'unknown_result');
      return null;
    }
    if (stage.state === 'saved') return { binding, target, stage };
    const ready = await preflight(tx, target);
    if (ready.reason !== undefined) {
      await finish(
        tx,
        input.operationId,
        target,
        ready.reason === 'already_admitted' ? 'admitted' : 'withheld',
        ready.reason,
      );
      return null;
    }
    await writeIngestionOperationEvent(tx, {
      operationId: input.operationId,
      eventType: 'operation.running',
    });
    await writeIngestionOperationEvent(tx, {
      operationId: input.operationId,
      eventType: 'operation.review_started',
    });
    return { binding, target, stage, ready };
  });
  if (!claimed) return;

  let evidence: AssessmentReviewEvidenceT;
  if (claimed.stage.state === 'saved') evidence = claimed.stage.evidence;
  else {
    if (!('ready' in claimed) || !claimed.ready)
      throw new Error('Missing assessment review preflight');
    // The canonical runner starts heartbeat transactions. It needs the pooled
    // handle; only domain writes use the pinned execution-owner connection.
    const runTask = deps.runTaskFn ?? createAssessmentVerificationTaskRunner(poolDb);
    const runIds = new Set<string>();
    let unknownCall = false;
    const recordingRunTask: TaskTextRunFn = async (kind, taskInput, ctx) => {
      try {
        await assertOwned(db);
        if (
          !['SolutionGenerateTask', 'SolutionGenerateVisionTask', 'SemanticJudgeTask'].includes(
            kind,
          )
        )
          throw new Error('Unsupported assessment review task');
        const taskKind =
          kind === 'SolutionGenerateTask'
            ? 'SolutionGenerateTask'
            : kind === 'SolutionGenerateVisionTask'
              ? 'SolutionGenerateVisionTask'
              : 'SemanticJudgeTask';
        const result = await runTask(taskKind, taskInput, {
          ...ctx,
          beforeProviderQuery: async (invocation) => {
            // The runner provides the actual durable attempt identity and lane
            // before submitting a prompt, including calls that never return.
            await ctx?.beforeProviderQuery?.(invocation);
            await assertOwned(db);
            await db.transaction(async (tx) => {
              await assertOwned(tx);
              await lockOperation(tx, input.operationId);
              const current = await readIngestionOperation(tx, input.operationId);
              if (!current || isTerminalIngestionOperation(current))
                throw new Error('Assessment review is no longer callable');
              await writeIngestionOperationEvent(tx, {
                operationId: input.operationId,
                eventType: 'operation.review_invocation',
                payload: {
                  task_run_id: invocation.taskRunId,
                  provider: invocation.provider,
                  model: invocation.model,
                  task_kind: kind,
                },
              });
            });
            runIds.add(invocation.taskRunId);
          },
        });
        if (result.task_run_id) runIds.add(result.task_run_id);
        else unknownCall = true;
        return result;
      } catch (error) {
        unknownCall = true;
        throw error;
      }
    };
    let result: Awaited<ReturnType<typeof runSolveCheck>>;
    let images: Awaited<ReturnType<typeof loadImages>>;
    try {
      images = await (deps.loadImages ?? ((assets) => loadImages(poolDb, assets)))(
        claimed.ready.assets,
      );
    } catch {
      images = [];
    }
    try {
      if (images.length !== claimed.ready.assets.length) {
        result = {
          verdict: 'unsupported',
          reason: 'prompt_image_unavailable',
          compared_by: 'none',
        };
      } else {
        const row = claimed.target.row;
        result = await runSolveCheck(
          {
            id: row.id,
            kind: row.kind,
            ...claimed.ready.questionProjection,
            knowledge_ids: row.knowledge_ids,
            metadata: null,
            image_refs: claimed.ready.imageIds,
            figures: claimed.ready.figuresHint,
          },
          {
            validationMode: 'release_strict',
            db: poolDb,
            runTaskFn: recordingRunTask,
            profile: { id: claimed.ready.profile.id, full: claimed.ready.profile },
            imageFetchFn: async () => images,
          },
        );
      }
    } catch {
      unknownCall = true;
      result = {
        verdict: 'unsupported',
        reason: 'Review did not produce a saved result',
        compared_by: 'none',
      };
    }
    // Detect a replaced backend before issuing BEGIN on the reserved wrapper.
    // A loss after any witness is still an uncertain external outcome.
    await assertOwned(db);
    const runs = runIds.size
      ? await db
          .select({
            id: ai_task_runs.id,
            task_kind: ai_task_runs.task_kind,
            provider: ai_task_runs.provider,
            model: ai_task_runs.model,
            status: ai_task_runs.status,
            input_hash: ai_task_runs.input_hash,
            result_digest: ai_task_runs.result_digest,
            cost_usd: ai_task_runs.cost_usd,
            cost_basis: ai_task_runs.cost_basis,
            cost_ref: ai_task_runs.cost_ref,
          })
          .from(ai_task_runs)
          .where(inArray(ai_task_runs.id, [...runIds]))
      : [];
    const incompleteProvenance =
      runs.length !== runIds.size ||
      (result.verdict === 'pass' && (!runs.length || runs.some((run) => run.status !== 'success')));
    evidence = AssessmentReviewEvidence.parse({
      subject_id: claimed.ready.profile.id,
      verdict: unknownCall || incompleteProvenance ? 'unknown_result' : result.verdict,
      reason: (unknownCall || incompleteProvenance
        ? 'Review result or runner provenance is unknown'
        : result.reason
      ).slice(0, 4096),
      compared_by: result.compared_by,
      ...(result.solver_final_answer
        ? { solver_final_answer: result.solver_final_answer.slice(0, 16000) }
        : {}),
      task_runs: runs,
    });
    // Store the parsed result before attempting the local publication transaction.
    await assertOwned(db);
    await db.transaction(async (tx) => {
      await assertOwned(tx);
      await lockOperation(tx, input.operationId);
      await writeIngestionOperationEvent(tx, {
        operationId: input.operationId,
        eventType: 'operation.review_result',
        payload: { evidence, digest: canonicalHash(evidence) },
      });
    });
  }

  await assertOwned(db);
  await db.transaction(async (tx) => {
    await assertOwned(tx);
    await lockOperation(tx, input.operationId);
    const operation = await readIngestionOperation(tx, input.operationId);
    if (!operation || isTerminalIngestionOperation(operation)) return;
    let target: Awaited<ReturnType<typeof readTarget>>;
    try {
      target = await readTarget(
        tx,
        { sessionId: claimed.binding.session_id, blockId: claimed.binding.block_id },
        true,
      );
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      await finish(tx, input.operationId, null, 'superseded', error.code, evidence);
      return;
    }
    if (!matchesAssessmentReviewBinding(claimed.binding, target.binding)) {
      await finish(tx, input.operationId, target, 'superseded', 'binding_changed', evidence);
      return;
    }
    if (evidence.verdict !== 'pass') {
      await finish(
        tx,
        input.operationId,
        target,
        'withheld',
        evidence.verdict === 'unsupported' ? evidence.reason : evidence.verdict,
        evidence,
      );
      return;
    }
    const ready = await preflight(tx, target);
    if (ready.reason !== undefined) {
      await finish(tx, input.operationId, target, 'withheld', ready.reason, evidence);
      return;
    }
    if (ready.profile.id !== evidence.subject_id) {
      await finish(tx, input.operationId, target, 'superseded', 'subject_changed', evidence);
      return;
    }
    const now = new Date();
    const publication = await publishQuestionGroup(tx, {
      group_id: target.binding.group_id,
      contract: target.revision,
      expectedCurrentRevision: claimed.binding.revision_id,
      expectedAdmissionGeneration: claimed.binding.admission_generation,
      availability: target.lifecycle.availability,
      actorRef: `ingestion-assessment-review:${input.operationId}`,
      now,
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'system_verified',
          model_slice: null,
          verification: {
            structural_check_passed: true,
            independent_verification: {
              passed: true,
              verifier: 'independent_model',
              verified_at: now.toISOString(),
            },
          },
        },
      },
      verification: {
        policy_id: ASSESSMENT_REVIEW_POLICY,
        outcome: 'passed',
        evidence: {
          operation_id: input.operationId,
          frozen_binding: claimed.binding,
          result_digest: canonicalHash(evidence),
          ...evidence,
        },
      },
    });
    if (publication.status === 'conflict') {
      await finish(tx, input.operationId, target, 'superseded', publication.reason, evidence);
      return;
    }
    const [final] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, target.binding.group_id));
    const admitted =
      final?.scoring_admission_state === 'admitted' && !final.suspended && !final.withdrawn;
    await finish(
      tx,
      input.operationId,
      target,
      admitted ? 'admitted' : 'withheld',
      admitted
        ? 'verification_passed'
        : (final?.scoring_admission_withheld_reason ?? 'publication_declined'),
      evidence,
    );
  });
}
