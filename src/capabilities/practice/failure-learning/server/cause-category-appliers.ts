// cause_category 提议的 accept / retract applier（错因词表扩张）。accept 的
// overlay 写入体仍在题库侧 proposal-appliers.ts，随知识变更协议段由迁移线处理。
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { cause_category_overlay } from '@/db/schema';
import type {
  ProposalAcceptApplier,
  ProposalAcceptInput,
  ProposalRetractApplier,
} from '@/kernel/proposals';
import { requireLaterProposalCorrection, toProposalLifecycleResult } from '@/kernel/proposals';
import { asPlainRecord } from '@/kernel/proposals/applier-helpers';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import {
  type PracticeApplierOpts,
  acceptCauseCategoryProposal,
} from '../../server/proposal-appliers';

function inboxView(input: { proposal: ProposalAcceptInput['proposal'] }): ProposalInboxRow {
  const { proposal } = input;
  return {
    ...proposal,
    kind: proposal.payload.kind,
    target: proposal.payload.target,
  } as ProposalInboxRow;
}

function runtimeOptions(input: ProposalAcceptInput, runtime: unknown): PracticeApplierOpts {
  const seams = runtime && typeof runtime === 'object' ? (runtime as PracticeApplierOpts) : {};
  return {
    ...seams,
    decision: input.decision,
    user_note: input.user_note,
  };
}

// accept：往 cause_category_overlay INSERT status='active' 行。
export const causeCategoryProposalAcceptApplier: ProposalAcceptApplier = async (
  db,
  input,
  runtime,
) => {
  const result = await acceptCauseCategoryProposal(
    db as Db,
    input.proposalId,
    inboxView(input),
    runtimeOptions(input, runtime),
  );
  return { kind: result.kind, result: toProposalLifecycleResult(result) };
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
