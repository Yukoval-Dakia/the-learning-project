// cause_category 提议的 accept / retract applier（错因词表扩张）。accept 经
// kernel 裁决模板：校验在 prepare，overlay INSERT + 证据事件 canonical
// supersede 与唯一 rate 写在 effect，信号 after_commit。这是
// cause_category_overlay 的唯一写边界（audit:schema 的 write path）；行落地后
// 进入 attribution 合并词表（listActiveCauseCategoryOverlays）。
//
// Accept supersedes still-effective 'other' evidence without mutating originals;
// deterministic event ids preserve replay identity. The recurrence watermark is
// decision time, so older unlisted evidence cannot immediately buy another naming.
import { and, eq, inArray } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { CauseCategoryT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { cause_category_overlay, event } from '@/db/schema';
import {
  getCorrectionStatuses,
  getCorrectionStatusesWithReceipts,
  writeEvent,
} from '@/kernel/events';
import {
  lockEventCorrectionSource,
  lockEventCorrectionsAll,
} from '@/kernel/events/correction-lock';
import { ApiError } from '@/kernel/http';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalRetractApplier,
} from '@/kernel/proposals';
import { requireLaterProposalCorrection } from '@/kernel/proposals';
import {
  asPlainRecord,
  ensureAcceptOnly,
  findExistingRateEvent,
  requiredString,
} from '@/kernel/proposals/applier-helpers';
import {
  type ProposalAcceptEffectOutcome,
  type RecordedProposalRate,
  runProposalAccept,
} from '@/kernel/proposals/decision-protocol';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import { CAUSE_OVERLAY_ID_PREFIX } from '@/kernel/read-models/cause-overlay';

export interface CauseCategoryAcceptResult {
  kind: 'cause_category';
  rate_event_id: string;
  category_id: string;
  /** 本次裁决事务里 canonical supersede 到新类目的证据事件 id（重放=空）。 */
  relabelled_event_ids?: string[];
  idempotent?: boolean;
}

function inboxView(input: { proposal: ProposalAcceptInput['proposal'] }): ProposalInboxRow {
  const { proposal } = input;
  return {
    ...proposal,
    kind: proposal.payload.kind,
    target: proposal.payload.target,
  } as ProposalInboxRow;
}

interface PreparedCauseCategoryAccept {
  categoryId: string;
  label: string;
  description: string | null;
  source: 'owner' | 'llm_propose';
  subjectId: string;
  evidenceEventIds: string[];
}

/**
 * 每条 evidence ref 在 accept 时刻的实际回标结果。
 * `skipped` 记一句机器可读的缘由——重放/审计/测试不靠日志猜。
 */
type RelabelOutcome =
  | {
      status: 'relabelled';
      original_event_id: string;
      replacement_event_id: string;
      correction_event_id: string;
      question_id: string;
      effective_created_at: string;
    }
  | { status: 'skipped'; event_id: string; reason: string };

// 确定性 id（重放/重试重复写入时 writeEvent 按 id 幂等，不产生第二行）。
function relabelReplacementId(proposalId: string, originalEventId: string): string {
  return `evt_cause_relabel_${canonicalHash({ proposal: proposalId, original: originalEventId }).slice(0, 24)}`;
}
function relabelCorrectionId(proposalId: string, originalEventId: string): string {
  return `evt_cause_relabel_correction_${canonicalHash({ proposal: proposalId, original: originalEventId }).slice(0, 24)}`;
}

/**
 * 把仍是 effective 'other' 的 evidence 事件逐个 canonical supersede 到
 * `categoryId`。返回每条的处置（含被回标行的原 effective created_at 审计
 * 元数据；决策水位由调用方用 accept 时刻记）。
 *
 * 原 event 行不动（append-only）：新建一条同形事件（judge → judge /
 * user_cause → user_cause）把 primary_category 换成新类目，再写
 * correct(supersede) 指向它。effective-truth 链上的消费方——mistakes /
 * weakpoints / tally——自动读替代事件，原判保留在 correction_state 里。
 *
 * Canonical correction locks keep concurrent learner corrections from being
 * overwritten by a supersede based on stale correction state.
 */
async function relabelOtherEvidenceToCategory(
  tx: Tx,
  input: {
    proposalId: string;
    categoryId: CauseCategoryT;
    evidenceEventIds: string[];
    reasonMd: string;
    now: Date;
  },
): Promise<{ outcomes: RelabelOutcome[] }> {
  const outcomes: RelabelOutcome[] = [];
  const ids = [...new Set(input.evidenceEventIds)];
  if (ids.length === 0) return { outcomes };

  // Use the canonical correction lock order before inspecting effective state.
  await lockEventCorrectionsAll(tx);
  for (const targetId of [...ids].sort()) {
    await lockEventCorrectionSource(tx, targetId);
  }

  const rows = await tx.select().from(event).where(inArray(event.id, ids));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const statuses = await getCorrectionStatuses(tx, ids);

  // affected_refs 只能放 ActivityRef（'event' 不在枚举内）。correct 的 subject
  // 是 judge/user_cause 事件，它的 subject_id 指向 attempt 事件——回查 attempt
  // 拿 question id，correct 才有合规的活动引用。
  const attemptIds = [
    ...new Set(
      rows
        .filter((row) => row.subject_kind === 'event')
        .map((row) => row.subject_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  const attemptRows =
    attemptIds.length === 0
      ? []
      : await tx
          .select({ id: event.id, subject_id: event.subject_id })
          .from(event)
          .where(inArray(event.id, attemptIds));
  const questionIdByAttemptId = new Map(attemptRows.map((row) => [row.id, row.subject_id]));

  for (const originalId of ids) {
    const original = rowById.get(originalId);
    if (!original) {
      outcomes.push({ status: 'skipped', event_id: originalId, reason: 'missing' });
      continue;
    }
    if (original.action !== 'judge' && original.action !== 'experimental:user_cause') {
      outcomes.push({ status: 'skipped', event_id: originalId, reason: 'not_a_cause_event' });
      continue;
    }
    const status = statuses.get(originalId);
    if (status === undefined || status.state !== 'active') {
      outcomes.push({
        status: 'skipped',
        event_id: originalId,
        reason: `correction_state:${status?.state ?? 'unknown'}`,
      });
      continue;
    }
    const questionId = questionIdByAttemptId.get(original.subject_id);
    if (typeof questionId !== 'string') {
      outcomes.push({ status: 'skipped', event_id: originalId, reason: 'attempt_missing' });
      continue;
    }

    const replacementId = relabelReplacementId(input.proposalId, originalId);
    const correctionId = relabelCorrectionId(input.proposalId, originalId);

    if (original.action === 'judge') {
      const cause = (original.payload as { cause?: { primary_category?: unknown } }).cause;
      if (cause?.primary_category !== 'other') {
        outcomes.push({ status: 'skipped', event_id: originalId, reason: 'not_other' });
        continue;
      }
      await writeEvent(tx, {
        id: replacementId,
        session_id: original.session_id,
        actor_kind: original.actor_kind,
        actor_ref: original.actor_ref,
        action: 'judge',
        subject_kind: original.subject_kind,
        subject_id: original.subject_id,
        outcome: original.outcome,
        payload: {
          ...(original.payload as Record<string, unknown>),
          cause: { ...cause, primary_category: input.categoryId },
          relabelled_from_event_id: originalId,
        },
        // Canonical anchor is the attempt (subject_id == caused_by keeps the
        // failure-attempts anchorKeyFor lookup symmetric for chained reads).
        caused_by_event_id: original.caused_by_event_id ?? original.subject_id,
        // Reclassification is not a new paid execution: leave run/cost unset so
        // the weekly cost sum does not double-count and no second receipt is
        // forged for the original task run. Origin provenance stays via
        // relabelled_from_event_id + the deterministic correction chain.
        task_run_id: null,
        cost_micro_usd: null,
        created_at: input.now,
      });
    } else {
      const primaryCategory = (original.payload as { primary_category?: unknown }).primary_category;
      if (primaryCategory !== 'other') {
        outcomes.push({ status: 'skipped', event_id: originalId, reason: 'not_other' });
        continue;
      }
      await writeEvent(tx, {
        id: replacementId,
        session_id: original.session_id,
        actor_kind: original.actor_kind,
        actor_ref: original.actor_ref,
        action: 'experimental:user_cause',
        subject_kind: original.subject_kind,
        subject_id: original.subject_id,
        outcome: original.outcome,
        payload: {
          ...(original.payload as Record<string, unknown>),
          primary_category: input.categoryId,
          relabelled_from_event_id: originalId,
        },
        caused_by_event_id: original.caused_by_event_id ?? original.subject_id,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: input.now,
      });
    }

    await writeEvent(tx, {
      id: correctionId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: originalId,
      outcome: 'success',
      payload: {
        correction_kind: 'supersede',
        replacement_event_id: replacementId,
        reason_md: input.reasonMd,
        affected_refs: [{ kind: 'question', id: questionId }],
      },
      caused_by_event_id: input.proposalId,
      created_at: input.now,
    });

    outcomes.push({
      status: 'relabelled',
      original_event_id: originalId,
      replacement_event_id: replacementId,
      correction_event_id: correctionId,
      question_id: questionId,
      effective_created_at: original.created_at.toISOString(),
    });
  }
  return { outcomes };
}

// 防绕过：生产者契约是 ov_ 命名空间；applier 也守住——非 ov_ id 会在合并词表
// 里与 profile 声明撞名。裸前缀（空 slug）同样显式拒绝（收紧）。
function parseCauseCategoryChange(input: ProposalAcceptInput): PreparedCauseCategoryAccept {
  const { proposalId, proposal } = input;
  const change = asPlainRecord(proposal.payload.proposed_change);
  const categoryId = requiredString(change.category_id, 'category_id', proposalId);
  const label = requiredString(change.label, 'label', proposalId);
  if (!categoryId.startsWith(CAUSE_OVERLAY_ID_PREFIX)) {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} category_id ${categoryId} must use the ${CAUSE_OVERLAY_ID_PREFIX} namespace`,
      400,
    );
  }
  if (categoryId === CAUSE_OVERLAY_ID_PREFIX) {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} category_id is the bare '${CAUSE_OVERLAY_ID_PREFIX}' prefix — empty slug`,
      400,
    );
  }
  const description =
    typeof change.description === 'string' && change.description.trim().length > 0
      ? change.description.trim()
      : null;
  const source = change.source === 'owner' ? 'owner' : 'llm_propose';
  const subjectId = proposal.payload.target.subject_id;
  if (!subjectId) {
    throw new ApiError(
      'validation_error',
      `proposal ${proposalId} is missing target.subject_id (subject profile id)`,
      400,
    );
  }
  const evidenceEventIds = (proposal.payload.evidence_refs ?? [])
    .filter((ref) => ref.kind === 'event')
    .map((ref) => ref.id);
  return { categoryId, label, description, source, subjectId, evidenceEventIds };
}

// Shown to the learner as is; programs branch on the `conflict` code, never on this text.
const CATEGORY_ID_TAKEN_MESSAGE = '已经有同样的错因类别了，这张可以忽略。';
const CATEGORY_ID_RETRACTED_MESSAGE = '这个错因类别之前撤销过，这张可以忽略。';

// Rate was written but the row did not materialize — caller should retract +
// re-run, not silently fix up (variant_question precedent).
async function loadActiveOverlayRowOrThrow(
  dbLike: Db | Tx,
  proposalId: string,
  categoryId: string,
) {
  const existing = (
    await dbLike
      .select()
      .from(cause_category_overlay)
      .where(eq(cause_category_overlay.id, categoryId))
      .limit(1)
  )[0];
  if (!existing || existing.archived_at !== null || existing.status !== 'active') {
    throw new ApiError(
      'inconsistent_state',
      `proposal ${proposalId} has an accept rate event but overlay row ${categoryId} is ${
        existing ? 'not active' : 'missing'
      }; retract + retry`,
      500,
    );
  }
  return existing;
}

export const causeCategoryProposalAcceptApplier: ProposalAcceptApplier = async (db, input) => {
  ensureAcceptOnly('cause_category', input);
  const run = await runProposalAccept(db as Db, input.proposalId, {
    proposal: inboxView(input),
    userNote: input.user_note,
    ...(input.actor ? { actor: input.actor } : {}),
    signal: 'after_commit',
    replay: async (rate: RecordedProposalRate): Promise<CauseCategoryAcceptResult> => {
      const { categoryId } = parseCauseCategoryChange(input);
      await loadActiveOverlayRowOrThrow(db as Db, input.proposalId, categoryId);
      const relabelled = (rate.payload as { relabelled_event_ids?: unknown }).relabelled_event_ids;
      return {
        kind: 'cause_category',
        rate_event_id: rate.id,
        category_id: categoryId,
        ...(Array.isArray(relabelled)
          ? {
              relabelled_event_ids: relabelled.filter((id): id is string => typeof id === 'string'),
            }
          : {}),
        idempotent: true,
      };
    },
    prepare: async () => parseCauseCategoryChange(input),
    // id 防撞：行已存在 = 另一个 proposal/路径已占用该 id。一律 409——归档行
    // 复活是另一个语义决定，v1 不做（owner 可换 slug 或人工恢复）。
    // 竞态收口：decision lock 按 proposalId 取，不同 proposal 撞同一
    // categoryId 时两个 tx 可同过下方 SELECT。onConflictDoNothing 让并发 INSERT
    // 优雅落空（阻塞至对方提交后再判），空 returning = 撞上 → 同一个 409。
    effect: async (
      { tx, writeRate },
      prepared,
    ): Promise<ProposalAcceptEffectOutcome<CauseCategoryAcceptResult>> => {
      const now = new Date();
      const existing = (
        await tx
          .select({ archived_at: cause_category_overlay.archived_at })
          .from(cause_category_overlay)
          .where(eq(cause_category_overlay.id, prepared.categoryId))
          .limit(1)
      )[0];
      if (existing) {
        throw new ApiError(
          'conflict',
          existing.archived_at === null ? CATEGORY_ID_TAKEN_MESSAGE : CATEGORY_ID_RETRACTED_MESSAGE,
          409,
        );
      }
      const inserted = await tx
        .insert(cause_category_overlay)
        .values({
          id: prepared.categoryId,
          subject_id: prepared.subjectId,
          label: prepared.label,
          description: prepared.description,
          source: prepared.source,
          status: 'active',
          proposal_event_id: input.proposalId,
          evidence_event_ids: prepared.evidenceEventIds,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing({ target: cause_category_overlay.id })
        .returning({ id: cause_category_overlay.id });
      if (inserted.length === 0) {
        throw new ApiError('conflict', CATEGORY_ID_TAKEN_MESSAGE, 409);
      }

      // YUK-2130 —— 在同一张裁决事务里把仍是 effective 'other' 的证据事件
      // canonical supersede 到新类目（replacement + correct 按确定性 id 幂等，
      // 重试/并发不会产生第二行）。
      const relabel = await relabelOtherEvidenceToCategory(tx, {
        proposalId: input.proposalId,
        categoryId: prepared.categoryId,
        evidenceEventIds: prepared.evidenceEventIds,
        reasonMd: `accepted cause_category proposal ${input.proposalId} → ${prepared.categoryId}`,
        now,
      });
      // 决策水位 = accept 时刻本身（不是被回标样本的最晚 created_at）。否则
      // evidence T0 < 未列 other T1,T2 < accept T3 时，T1/T2 越过水位与 accept
      // 后一条新 other 一起凑满 floor，立刻再触发一次付费命名。accept 之前的
      // other 一律不算「新复发」；是否回标只影响样本自身的 effective 类目。
      const otherWatermark = now;

      const rateEventId = await writeRate({
        created_at: now,
        payload: {
          ...(input.proposal.payload.cooldown_key !== undefined
            ? { cooldown_key: input.proposal.payload.cooldown_key }
            : {}),
          other_watermark: otherWatermark.toISOString(),
          relabelled_event_ids: relabel.outcomes
            .filter((outcome) => outcome.status === 'relabelled')
            .map((outcome) => outcome.original_event_id),
          relabel_outcomes: relabel.outcomes,
        },
      });
      return {
        status: 'accepted',
        result: {
          kind: 'cause_category',
          rate_event_id: rateEventId,
          category_id: prepared.categoryId,
          relabelled_event_ids: relabel.outcomes
            .filter((outcome) => outcome.status === 'relabelled')
            .map((outcome) => outcome.original_event_id),
        },
      };
    },
  });
  return { kind: 'cause_category', result: { ...run.result } };
};

// retract 语义：accept 已落 overlay 行 → 置 archived_at（唯一回退
// 维度）。行按 proposal_event_id 归属限定——同 slug 两张 pending proposal 并存
// 时，retract 未落地那张不许归档别人 accept 的活行（mistake_variant 同款归属
// 语义）。proposal 从未被 accept（pending 即 retract，行不存在）、行非本
// proposal 所立、或已归档时幂等 no-op。
//
// Canonical restore/retract receipts undo this accept's supersede chain while
// retaining append-only originals and deterministic replay identities.
export const causeCategoryProposalRetractApplier: ProposalRetractApplier = async (db, input) => {
  const tx = db as Tx;
  const change = asPlainRecord(input.proposal.payload.proposed_change);
  const categoryId =
    typeof change.category_id === 'string' && change.category_id.length > 0
      ? change.category_id
      : null;
  if (!categoryId) return;
  const ownedRow = and(
    eq(cause_category_overlay.id, categoryId),
    eq(cause_category_overlay.proposal_event_id, input.proposalId),
  );
  const [row] = await tx
    .select({
      id: cause_category_overlay.id,
      updated_at: cause_category_overlay.updated_at,
      archived_at: cause_category_overlay.archived_at,
    })
    .from(cause_category_overlay)
    .where(ownedRow)
    .for('update')
    .limit(1);
  if (!row || row.archived_at !== null) return;
  requireLaterProposalCorrection(input.correction_at, row.updated_at);
  await tx
    .update(cause_category_overlay)
    .set({ archived_at: input.correction_at, updated_at: input.correction_at })
    .where(ownedRow);

  // Undo both sides of the recorded supersede, through the correction owner.
  const rate = await findExistingRateEvent(tx, input.proposalId);
  const relabelOutcomes = (rate?.payload as { relabel_outcomes?: unknown } | undefined)
    ?.relabel_outcomes;
  if (Array.isArray(relabelOutcomes)) {
    // Lock the correction stream before re-reading it, in the same order the
    // accept and writeEvents use. A learner correction committed after the
    // accept is visible to the recheck below; one in flight waits on these
    // locks instead of racing the restore.
    const undoTargets = [
      ...new Set(
        relabelOutcomes.flatMap((outcome) => {
          if (
            !outcome ||
            typeof outcome !== 'object' ||
            (outcome as { status?: unknown }).status !== 'relabelled'
          ) {
            return [] as string[];
          }
          return (['original_event_id', 'replacement_event_id'] as const)
            .map((key) => (outcome as Record<string, unknown>)[key])
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        }),
      ),
    ].sort();
    if (undoTargets.length > 0) {
      await lockEventCorrectionsAll(tx);
      for (const targetId of undoTargets) {
        await lockEventCorrectionSource(tx, targetId);
      }
    }
    // Canonical fold, under the locks: the winning receipt id per target. A
    // learner mark_wrong/retract (or restore) committed after the accept is the
    // current correction truth — the recheck below never overwrites it.
    const receipts = await getCorrectionStatusesWithReceipts(tx, undoTargets);
    for (const outcome of relabelOutcomes) {
      if (
        !outcome ||
        typeof outcome !== 'object' ||
        (outcome as { status?: unknown }).status !== 'relabelled'
      ) {
        continue;
      }
      const { replacement_event_id, original_event_id } = outcome as {
        replacement_event_id?: unknown;
        original_event_id?: unknown;
      };
      const affectedRefs =
        typeof (outcome as { question_id?: unknown }).question_id === 'string'
          ? [{ kind: 'question' as const, id: (outcome as { question_id: string }).question_id }]
          : [{ kind: 'open_inquiry' as const, id: input.proposalId }];
      if (typeof original_event_id === 'string') {
        // Restore only when this accept's supersede is still the original's
        // winning correction. Any later learner mutation — mark_wrong, retract,
        // or a restore of someone else's correction — makes a different receipt
        // the winner; restoring over it would erase that learner truth.
        const acceptCorrectionId =
          typeof (outcome as { correction_event_id?: unknown }).correction_event_id === 'string'
            ? (outcome as { correction_event_id: string }).correction_event_id
            : null;
        const originalReceipt = receipts.get(original_event_id);
        if (
          originalReceipt?.status.state === 'superseded' &&
          originalReceipt.status.correction_event_id === acceptCorrectionId &&
          originalReceipt.winning_correction_event_id === acceptCorrectionId
        ) {
          // Restore the original first: its latest correction becomes 'restore',
          // so it returns to 'active' — before the replacement is retracted the
          // chain would otherwise keep resolving to the (now-retracted) leaf.
          await writeEvent(tx, {
            id: `evt_cause_relabel_restore_${canonicalHash({ proposal: input.proposalId, original: original_event_id }).slice(0, 24)}`,
            actor_kind: 'user',
            actor_ref: 'self',
            action: 'correct',
            subject_kind: 'event',
            subject_id: original_event_id,
            outcome: 'success',
            payload: {
              correction_kind: 'restore',
              reason_md: `retract cause_category accept ${input.proposalId} — restore original label`,
              affected_refs: affectedRefs,
            },
            caused_by_event_id: input.proposalId,
            created_at: input.correction_at,
          });
        }
      }
      if (typeof replacement_event_id === 'string') {
        // Retract the replacement only while it has no winning correction —
        // still in this accept's materialized state. A learner mark_wrong /
        // retract / restore on it is the current truth and must not be
        // cancelled by a stale revert.
        const replacementReceipt = receipts.get(replacement_event_id);
        if (
          replacementReceipt?.status.state === 'active' &&
          replacementReceipt.winning_correction_event_id === null
        ) {
          await writeEvent(tx, {
            id: `evt_cause_relabel_revert_${canonicalHash({ proposal: input.proposalId, replacement: replacement_event_id }).slice(0, 24)}`,
            actor_kind: 'user',
            actor_ref: 'self',
            action: 'correct',
            subject_kind: 'event',
            subject_id: replacement_event_id,
            outcome: 'success',
            payload: {
              correction_kind: 'retract',
              reason_md: `retract cause_category accept ${input.proposalId} — undo relabel replacement`,
              affected_refs: affectedRefs,
            },
            caused_by_event_id: input.proposalId,
            created_at: input.correction_at,
          });
        }
      }
    }
  }
};
