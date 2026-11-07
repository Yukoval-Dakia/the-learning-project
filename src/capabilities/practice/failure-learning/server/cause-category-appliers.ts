// cause_category 提议的 accept / retract applier（错因词表扩张）。accept 经
// kernel 裁决模板：校验在 prepare，overlay INSERT 与唯一 rate 写在 effect，
// 信号 after_commit。这是 cause_category_overlay 的唯一写边界
// （audit:schema 的 write path）；行落地后进入 attribution 合并词表
// （listActiveCauseCategoryOverlays）。
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { cause_category_overlay } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalRetractApplier,
} from '@/kernel/proposals';
import { requireLaterProposalCorrection, toProposalLifecycleResult } from '@/kernel/proposals';
import {
  asPlainRecord,
  ensureAcceptOnly,
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
      return {
        kind: 'cause_category',
        rate_event_id: rate.id,
        category_id: categoryId,
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
      const rateEventId = await writeRate({ created_at: now });
      return {
        status: 'accepted',
        result: {
          kind: 'cause_category',
          rate_event_id: rateEventId,
          category_id: prepared.categoryId,
        },
      };
    },
  });
  return { kind: 'cause_category', result: toProposalLifecycleResult(run.result) };
};

// retract 语义：accept 已落 overlay 行 → 置 archived_at（唯一回退
// 维度）。行按 proposal_event_id 归属限定——同 slug 两张 pending proposal 并存
// 时，retract 未落地那张不许归档别人 accept 的活行（mistake_variant 同款归属
// 语义）。proposal 从未被 accept（pending 即 retract，行不存在）、行非本
// proposal 所立、或已归档时幂等 no-op。
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
};
