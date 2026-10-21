// 发题编排：组根锁 → 生命周期校验 → 绑定推导 → 不可变 issuance（+ 可选 claim）。
// 不评分、不写学习状态、不创建 submission。
//
// in_progress 一旦写入即永久 serve 记录，绝不回取 latest revision；preselected
// 不等于 issued。挂起/撤回禁止新 issuance；container_only 必须带 occurrence ref。
// 所有新发题与重放都要求准入且自动可判，manual 不绕过。
//
// 幂等：同 issuance_id 且绑定逐字段一致 ⇒ replayed（不改 claim）；绑定不同 ⇒
// issuance_id_conflict。锁序：question 组根行 FOR UPDATE → 组快照读。

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, sql } from 'drizzle-orm';

// jsonb reorders keys, so binding equality must canonicalize; otherwise every
// retry would be misread as a conflict.
import { stableStringify } from '@/core/migration/canonical';
import type {
  PracticeIssuanceDtoT,
  PresentationT,
  PublishedQuestionRevisionT,
} from '@/core/schema/assessment';
import {
  type AssessmentIssuanceT,
  type IssuanceBindingT,
  Presentation,
  PublishedQuestionRevision,
  decideAutomaticServing,
  deriveIssuanceBinding,
  projectPracticeIssuance,
  validateIssuanceBinding,
} from '@/core/schema/assessment';
import type {
  AutomaticServingDecision,
  ServingUnavailableReason,
} from '@/core/schema/assessment/serving-admission';
import { InterventionDiagnosticQuestionMetadata } from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import {
  assessment_issuance,
  learning_session,
  question,
  question_block,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { getEvents, writeEvent } from '@/kernel/events';
import {
  type GroupSubjectLookup,
  lookupGroupSubjects,
  resolveModelAdmissionContext,
} from '@/server/assessment/model-slice-registry';

function subjectIdFromLookup(lookup: GroupSubjectLookup | undefined): string | null {
  return lookup?.kind === 'subject' ? lookup.subject : null;
}

/** 发题事件 action；receipt 即事件载荷。 */
export const ASSESSMENT_ISSUANCE_ACTION = 'experimental:assessment_issuance';
export const ASSESSMENT_ISSUANCE_VERSION = 1 as const;

type IssuanceRow = typeof assessment_issuance.$inferSelect;
type RevisionRow = typeof question_revision.$inferSelect;

/** 行 → 公开契约；事件与 wire 共用同一映射，坐标不平铺。 */
export function issuanceRowToContract(row: IssuanceRow): AssessmentIssuanceT {
  return {
    issuance_id: row.issuance_id,
    binding: {
      revision_id: row.revision_id,
      part_ids: row.part_ids,
      material_bindings: row.material_bindings,
      option_order: row.option_order,
    },
    issued_at: row.issued_at.toISOString(),
    claim: {
      policy: row.claim_policy,
      status: row.claim_status,
      claimed_by_ref: row.claimed_by_ref,
    },
  };
}

/** question_revision 行 → PublishedQuestionRevisionT（只映射契约列）。 */
export function revisionRowToContract(row: RevisionRow): PublishedQuestionRevisionT {
  return {
    revision_id: row.revision_id,
    group_id: row.group_id,
    revision_ordinal: row.revision_ordinal,
    integrity_digest: row.integrity_digest,
    structure: row.structure,
    response_spec: row.response_spec,
    scoring_basis: row.scoring_basis,
    execution_plan: row.execution_plan,
    // Pass a bad presentation through instead of dropping it (dropping would
    // silently downgrade rendering); consumers fail closed on the whole revision.
    ...(row.presentation != null
      ? {
          presentation: (() => {
            const shaped = Presentation.safeParse(row.presentation);
            return shaped.success ? shaped.data : (row.presentation as PresentationT);
          })(),
        }
      : {}),
    published_at: row.published_at.toISOString(),
    supersedes_revision_id: row.supersedes_revision_id,
  };
}

/** Current pool capability, using the same part binding as placement/solo issuance. No effects. */
export async function readAutomaticallyServableQuestionIds(
  db: Db | Tx,
  questionIds: readonly string[],
  options: { includeInterventionDiagnostics?: boolean } = {},
): Promise<Set<string>> {
  if (questionIds.length === 0) return new Set();
  const rows = await db
    .select({
      id: question.id,
      parentId: question.parent_question_id,
      revision: question_revision,
    })
    .from(question)
    .innerJoin(
      question_group_lifecycle,
      eq(
        question_group_lifecycle.group_id,
        sql`COALESCE(${question.parent_question_id}, ${question.id})`,
      ),
    )
    .innerJoin(
      question_revision,
      and(
        eq(question_revision.revision_id, question_group_lifecycle.current_revision_id),
        eq(question_revision.group_id, question_group_lifecycle.group_id),
      ),
    )
    .where(
      and(
        inArray(question.id, [...new Set(questionIds)]),
        notDraftPredicate(question.draft_status),
        eq(question_group_lifecycle.scoring_admission_state, 'admitted'),
        eq(question_group_lifecycle.suspended, false),
        eq(question_group_lifecycle.withdrawn, false),
        options.includeInterventionDiagnostics
          ? sql`(${question_group_lifecycle.availability} = 'general_pool' OR ${question.source} = 'intervention_diagnostic')`
          : eq(question_group_lifecycle.availability, 'general_pool'),
      ),
    );
  const admitted = new Set<string>();
  // Model-slice admission is read once; the serving decision stays pure.
  const admission = await resolveModelAdmissionContext(db);
  const subjects = await lookupGroupSubjects(
    db,
    rows.map((row) => row.parentId ?? row.id),
  );
  for (const row of rows) {
    const parsed = PublishedQuestionRevision.safeParse(revisionRowToContract(row.revision));
    if (!parsed.success) continue;
    const revision = parsed.data;
    const partIds = row.parentId ? [row.id] : revision.structure.parts.map((part) => part.part_id);
    const questionSubject = subjectIdFromLookup(subjects.get(row.parentId ?? row.id));
    if (decideAutomaticServing(revision, partIds, admission, questionSubject).kind === 'admitted')
      admitted.add(row.id);
  }
  return admitted;
}

/** Read-only preflight with the same admission inputs issueAssessment uses. */
export async function readAutomaticServingDecision(
  db: Db | Tx,
  revision: PublishedQuestionRevisionT,
  partIds: readonly string[],
): Promise<AutomaticServingDecision> {
  const admission = await resolveModelAdmissionContext(db);
  const subjects = await lookupGroupSubjects(db, [revision.group_id]);
  return decideAutomaticServing(
    revision,
    partIds,
    admission,
    subjectIdFromLookup(subjects.get(revision.group_id)),
  );
}

/** Recovery checks the immutable issued revision, never the current question version. */
export async function readAutomaticIssuanceServingDecisions(
  db: Db | Tx,
  issuanceIds: readonly string[],
): Promise<Map<string, AutomaticServingDecision>> {
  if (issuanceIds.length === 0) return new Map();
  const rows = await db
    .select({ issuance: assessment_issuance, revision: question_revision })
    .from(assessment_issuance)
    .innerJoin(
      question_revision,
      eq(question_revision.revision_id, assessment_issuance.revision_id),
    )
    .where(inArray(assessment_issuance.issuance_id, [...new Set(issuanceIds)]));
  const admission = await resolveModelAdmissionContext(db);
  const subjects = await lookupGroupSubjects(
    db,
    rows.map(({ revision: row }) => row.group_id),
  );
  return new Map(
    rows.map(({ issuance, revision: row }) => {
      const parsed = PublishedQuestionRevision.safeParse(revisionRowToContract(row));
      const questionSubject = subjectIdFromLookup(subjects.get(row.group_id));
      const decision: AutomaticServingDecision = parsed.success
        ? decideAutomaticServing(parsed.data, issuance.part_ids, admission, questionSubject)
        : row.presentation != null && !Presentation.safeParse(row.presentation).success
          ? {
              // Bad presentation gets its own typed reason, matching the shape gate.
              kind: 'unavailable',
              reason: 'invalid_presentation',
              detail: 'malformed frozen presentation',
            }
          : {
              kind: 'unavailable',
              reason: 'invalid_scoring_contract',
              detail: 'invalid frozen revision',
            };
      return [issuance.issuance_id, decision];
    }),
  );
}

/** Key-order-independent binding equality; claim is not part of replay identity. */
function issuanceBindingEquals(row: IssuanceRow, binding: IssuanceBindingT): boolean {
  return (
    row.revision_id === binding.revision_id &&
    stableStringify(row.part_ids) === stableStringify(binding.part_ids) &&
    stableStringify(row.material_bindings) === stableStringify(binding.material_bindings) &&
    stableStringify(row.option_order) === stableStringify(binding.option_order)
  );
}

async function loadIssuanceById(tx: Tx, issuanceId: string): Promise<IssuanceRow | null> {
  const [row] = await tx
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, issuanceId))
    .limit(1);
  return row ?? null;
}

/**
 * The issuance event, not the current lifecycle row, owns the generation observed
 * at issue time; the current value could bypass activation CAS. Fall back to the
 * caller's candidate when the event is absent.
 */
export async function readObservedAdmissionGeneration(
  db: Db | Tx,
  issuanceId: string,
  fallback: number | null,
): Promise<number | null> {
  const events = await getEvents(db, {
    action: ASSESSMENT_ISSUANCE_ACTION,
    subject_kind: 'issuance',
    subject_id: issuanceId,
    limit: 1,
  });
  const observed = (events[0]?.payload as { admission_generation_observed?: unknown } | undefined)
    ?.admission_generation_observed;
  if (typeof observed === 'number' && Number.isInteger(observed)) return observed;
  return fallback;
}

// ---------- 输入契约 ----------

export interface IssueAssessmentRequest {
  /** 组根 question id（单题 = 自身；复合题 = 父 id）。 */
  group_id: string;
  /** Explicit target revision; must belong to the group, never silently falls back. */
  revision_id?: string;
  /** Target part subset; partial issuance binds only these slots and materials. */
  part_ids?: string[];
  /** Slot display order; must be a permutation of the declared options. */
  option_order_overrides?: Record<string, readonly string[]>;
  /** auto_score (default) or manual; both still require admission. */
  mode?: 'auto_score' | 'manual';
  /** Container occurrence anchor; required for container_only groups. */
  container_occurrence_ref?: string | null;
  /** Request a one-time claim; another unreleased claim makes it unavailable. */
  claim?: { claimed_by_ref: string };
  /** 客户端可指定 issuance_id（重试幂等锚）；缺省服务端生成。 */
  issuance_id?: string;
  /** 调用方 provenance（事件 actor_ref；缺省 'assessment:issue'）。 */
  actorRef?: string;
  now?: Date;
}

// ---------- 结果 ----------

export type IssueAssessmentResult =
  | {
      status: 'issued' | 'replayed';
      issuance: AssessmentIssuanceT;
      practice_dto: PracticeIssuanceDtoT;
      /** 发题时观测到的 admission generation（激活 CAS 用；未发布组为 null）。 */
      admission_generation_observed: number | null;
    }
  | {
      status:
        | 'not_found' // 组根不存在 / 目标 revision 不存在
        | 'unpublished' // 组从未发布（无 lifecycle.current_revision_id）
        | 'revision_mismatch' // 显式指定的 revision 不属于该组
        | 'suspended' // verify/retraction 挂起 ⇒ 禁止新 issuance（§3.3）
        | 'withdrawn'
        | 'not_admitted' // 未获评分准入或冻结契约不可自动判分
        | 'container_ref_required' // container_only 缺 occurrence ref
        | 'claim_unavailable' // one_time 组已有未释放 claim
        | 'issuance_id_conflict' // 同 id 不同绑定载荷（不覆盖）
        | 'binding_invalid'; // 绑定与 revision 不一致（unknown part/material/...）
      issues?: string[]; // binding_invalid 时给出具体 issue 列表
      /** Typed reason when the automatic-scoring gate rejects. */
      serving_reason?: ServingUnavailableReason;
    };

// ---------- 编排主体 ----------

/**
 * Single transaction: root lock → lifecycle checks → binding → immutable issuance
 * (+ optional claim). Accepts Db or Tx; domain failures are returned, malformed
 * contract input throws.
 */
export async function issueAssessment(
  db: Db | Tx,
  request: IssueAssessmentRequest,
): Promise<IssueAssessmentResult> {
  return issueAssessmentInternal(db, request);
}

interface IngestionCaptureSource {
  session_id: string;
  block_id: string;
  block_version: number;
}

/** Capture receipt for already-existing work, not evidence of prior service or admission. */
export async function issueCapturedAssessment(
  db: Db | Tx,
  request: Pick<IssueAssessmentRequest, 'group_id' | 'now'> & {
    revision_id?: string;
    issuance_id: string;
    source: IngestionCaptureSource;
  },
): Promise<IssueAssessmentResult> {
  return db.transaction(async (tx) => {
    const [block] = await tx
      .select()
      .from(question_block)
      .where(eq(question_block.id, request.source.block_id))
      .for('update');
    const [session] = await tx
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, request.source.session_id));
    if (
      !block ||
      block.ingestion_session_id !== request.source.session_id ||
      block.version !== request.source.block_version ||
      block.status !== 'draft' ||
      session?.type !== 'ingestion' ||
      session.status !== 'extracted'
    ) {
      return { status: 'binding_invalid', issues: ['capture source is no longer available'] };
    }
    return issueAssessmentInternal(
      tx,
      {
        ...request,
        container_occurrence_ref: `ingestion:${request.source.session_id}:${block.id}:${block.version}`,
        actorRef: 'ingestion:capture',
      },
      request.source,
    );
  });
}

async function issueAssessmentInternal(
  db: Db | Tx,
  request: IssueAssessmentRequest,
  capture?: IngestionCaptureSource,
): Promise<IssueAssessmentResult> {
  if (request.part_ids != null && request.part_ids.length === 0) {
    throw new Error('issueAssessment: part_ids may not be an empty array');
  }
  const now = request.now ?? new Date();
  const actorRef = request.actorRef ?? 'assessment:issue';
  const mode = request.mode ?? 'auto_score';

  return await db.transaction(async (tx) => {
    // Lock order matches publish/verify: question root → lifecycle/snapshot reads.
    const [root] = await tx
      .select({
        id: question.id,
        source: question.source,
        draft_status: question.draft_status,
        metadata: question.metadata,
      })
      .from(question)
      .where(eq(question.id, request.group_id))
      .for('update')
      .limit(1);
    if (!root) return { status: 'not_found' };
    if (
      capture &&
      (root.metadata?.ingestion_session_id !== capture.session_id ||
        root.metadata?.question_block_id !== capture.block_id ||
        root.metadata?.capture_block_version !== capture.block_version)
    ) {
      return { status: 'binding_invalid', issues: ['question does not belong to this capture'] };
    }

    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, request.group_id))
      .limit(1);
    const existingIssuance = request.issuance_id
      ? await loadIssuanceById(tx, request.issuance_id)
      : null;
    const revisionId =
      request.revision_id ??
      existingIssuance?.revision_id ??
      lifecycle?.current_revision_id ??
      null;
    if (revisionId == null) {
      return { status: 'unpublished' };
    }
    const [revRow] = await tx
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, revisionId))
      .limit(1);
    if (revRow == null) return { status: 'not_found' };

    if (revRow.group_id !== request.group_id) {
      return { status: 'revision_mismatch' };
    }

    if (lifecycle != null) {
      if (lifecycle.withdrawn) return { status: 'withdrawn' };
      if (lifecycle.suspended) return { status: 'suspended' };
      if (lifecycle.availability === 'container_only' && request.container_occurrence_ref == null) {
        return { status: 'container_ref_required' };
      }
    }
    if (root.source === 'mind_probe') {
      if (mode !== 'auto_score') return { status: 'not_admitted' };
      if (request.container_occurrence_ref !== `probe:${root.id}`)
        return { status: 'container_ref_required' };
    }
    if (!capture && lifecycle?.scoring_admission_state !== 'admitted') {
      return { status: 'not_admitted' };
    }

    const revision = revisionRowToContract(revRow);
    const binding = deriveIssuanceBinding(revision, {
      part_ids: request.part_ids ?? existingIssuance?.part_ids,
      option_order_overrides:
        request.option_order_overrides ??
        (existingIssuance
          ? Object.fromEntries(
              existingIssuance.option_order.map((order) => [order.slot_id, order.option_ids]),
            )
          : undefined),
    });
    const bindingIssues = validateIssuanceBinding(binding, revision);
    if (bindingIssues.length > 0) {
      return {
        status: 'binding_invalid',
        issues: bindingIssues.map((issue) => `${issue.code}(${issue.detail})`),
      };
    }

    // Manual mode and replay never authorize another serve of an unsupported
    // contract; ingestion capture is a separate receipt.
    if (!capture) {
      const admission = await resolveModelAdmissionContext(tx);
      const subjects = await lookupGroupSubjects(tx, [request.group_id]);
      const questionSubject = subjectIdFromLookup(subjects.get(request.group_id));
      const decision = decideAutomaticServing(
        revision,
        binding.part_ids,
        admission,
        questionSubject,
      );
      if (decision.kind === 'unavailable') {
        return {
          status: 'not_admitted',
          issues: [`${decision.reason}: ${decision.detail}`],
          serving_reason: decision.reason,
        };
      }
    }

    // Resolve the idempotency anchor before the claim check, or a one_time retry
    // would hit its own claim and report claim_unavailable.
    const containerRef = request.container_occurrence_ref ?? null;
    if (request.issuance_id != null) {
      const existing = await loadIssuanceById(tx, request.issuance_id);
      if (existing != null) {
        if (
          !issuanceBindingEquals(existing, binding) ||
          (existing.container_occurrence_ref ?? null) !== containerRef
        ) {
          return { status: 'issuance_id_conflict' };
        }
        const issuance = issuanceRowToContract(existing);
        return {
          status: 'replayed',
          issuance,
          practice_dto: projectPracticeIssuance(revision, issuance),
          admission_generation_observed: await readObservedAdmissionGeneration(
            tx,
            existing.issuance_id,
            lifecycle?.scoring_admission_generation ?? null,
          ),
        };
      }
    }

    // The group-root lock serializes this recheck with publication/withdrawal.
    // New issuance must use the current revision; old explicit pins are rejected.
    if (!capture) {
      if (revisionId !== lifecycle?.current_revision_id) return { status: 'revision_mismatch' };
      if (lifecycle?.scoring_admission_state !== 'admitted') return { status: 'not_admitted' };
    }

    if (root.source === 'intervention_diagnostic') {
      if (mode !== 'auto_score') return { status: 'not_admitted' };
      const diagnostic = InterventionDiagnosticQuestionMetadata.safeParse(
        root.metadata?.intervention_diagnostic,
      );
      if (
        !diagnostic.success ||
        root.draft_status !== 'active' ||
        new Date(diagnostic.data.due_at) > now
      ) {
        return { status: 'claim_unavailable' };
      }
    }

    // A one_time group rejects a second unreleased claim; retries converged above.
    const claimPolicy = lifecycle?.claim_policy ?? 'unbounded';
    const claimRequested = claimPolicy === 'one_time' || request.claim != null;
    if (claimRequested && claimPolicy === 'one_time') {
      const [holder] = await tx
        .select({ issuance_id: assessment_issuance.issuance_id })
        .from(assessment_issuance)
        .innerJoin(
          question_revision,
          eq(assessment_issuance.revision_id, question_revision.revision_id),
        )
        .where(
          and(
            eq(question_revision.group_id, request.group_id),
            eq(assessment_issuance.claim_status, 'claimed'),
          ),
        )
        .limit(1);
      if (holder != null) return { status: 'claim_unavailable' };
    }

    const issuanceId = request.issuance_id ?? `iss_${createId()}`;
    const claimStatus: 'claimed' | 'unclaimed' = claimRequested ? 'claimed' : 'unclaimed';
    const claimedByRef = claimRequested ? (request.claim?.claimed_by_ref ?? issuanceId) : null;

    const insertPayload = {
      issuance_id: issuanceId,
      revision_id: revision.revision_id,
      part_ids: binding.part_ids,
      material_bindings: binding.material_bindings,
      option_order: binding.option_order,
      container_occurrence_ref: containerRef,
      claim_policy: claimPolicy,
      claim_status: claimStatus,
      claimed_by_ref: claimedByRef,
      issued_at: now,
    };

    const inserted = await tx
      .insert(assessment_issuance)
      .values(insertPayload)
      .onConflictDoNothing({ target: assessment_issuance.issuance_id })
      .returning({ issuance_id: assessment_issuance.issuance_id });

    if (inserted.length === 0) {
      // Concurrent insert with the same id: replay must use persisted state,
      // never request values, because the claim may already have been released.
      const existing = await loadIssuanceById(tx, issuanceId);
      if (existing == null) {
        // Conflicted but no visible row: fail loud.
        throw new Error(
          `issueAssessment: issuance '${issuanceId}' conflicted but no row is visible`,
        );
      }
      if (
        !issuanceBindingEquals(existing, binding) ||
        (existing.container_occurrence_ref ?? null) !== insertPayload.container_occurrence_ref
      ) {
        return { status: 'issuance_id_conflict' };
      }
      const issuance = issuanceRowToContract(existing);
      return {
        status: 'replayed',
        issuance,
        practice_dto: projectPracticeIssuance(revision, issuance),
        admission_generation_observed: await readObservedAdmissionGeneration(
          tx,
          existing.issuance_id,
          lifecycle?.scoring_admission_generation ?? null,
        ),
      };
    }

    await writeEvent(tx, {
      id: `evt_iss_${createId()}`,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: actorRef,
      action: ASSESSMENT_ISSUANCE_ACTION,
      subject_kind: 'issuance',
      subject_id: issuanceId,
      outcome: 'success',
      payload: {
        version: ASSESSMENT_ISSUANCE_VERSION,
        issuance_id: issuanceId,
        group_id: request.group_id,
        revision_id: revision.revision_id,
        part_ids: binding.part_ids,
        material_bindings: binding.material_bindings,
        option_order: binding.option_order,
        container_occurrence_ref: insertPayload.container_occurrence_ref,
        claim_policy: claimPolicy,
        claim_status: claimStatus,
        claimed_by_ref: claimedByRef,
        admission_generation_observed: lifecycle?.scoring_admission_generation ?? null,
        mode: capture ? 'capture_existing' : mode,
        ...(capture ? { capture_source: capture, scheduling_policy: 'preserve' } : {}),
      } satisfies Record<string, unknown>,
      created_at: now,
    });

    const issuance: AssessmentIssuanceT = {
      issuance_id: issuanceId,
      binding,
      issued_at: now.toISOString(),
      claim: {
        policy: claimPolicy,
        status: claimStatus,
        claimed_by_ref: claimedByRef,
      },
    };
    return {
      status: 'issued',
      issuance,
      practice_dto: projectPracticeIssuance(revision, issuance),
      admission_generation_observed: lifecycle?.scoring_admission_generation ?? null,
    };
  });
}
