import { and, eq, inArray } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { mistake_variant } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { runProposalDismiss } from '@/kernel/proposals/decision-protocol';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import type {
  ProposalDismissApplier,
  ProposalRetractApplier,
  ProposalRetractInput,
} from '@/kernel/proposals/index';
import { requireLaterProposalCorrection } from '@/kernel/proposals/types';

interface PracticeLifecycleRuntime {
  findExistingRateEvent: (
    tx: Tx,
    proposalId: string,
  ) => Promise<{ decision: string; payload: unknown } | null>;
  hasMistakeVariantGenesisAnchor: (tx: Tx, variantId: string) => Promise<boolean>;
  projectMistakeVariantGuarded: (tx: Tx, variantId: string) => Promise<unknown>;
}

async function retractVariantQuestion(
  tx: Tx,
  input: ProposalRetractInput,
  runtime: PracticeLifecycleRuntime,
): Promise<void> {
  const retractedVariants = await tx
    .select({ id: mistake_variant.id, updated_at: mistake_variant.updated_at })
    .from(mistake_variant)
    .where(
      and(
        eq(mistake_variant.proposal_event_id, input.proposalId),
        inArray(mistake_variant.status, ['draft', 'active']),
      ),
    )
    .for('update');

  if (retractedVariants.length > 0) {
    requireLaterProposalCorrection(
      input.correction_at,
      new Date(Math.max(...retractedVariants.map((variant) => variant.updated_at.getTime()))),
    );
  }
  for (const variant of retractedVariants) {
    if (!(await runtime.hasMistakeVariantGenesisAnchor(tx, variant.id))) {
      throw new Error(`Variant ${variant.id} needs canonical projection migration`);
    }
    await runtime.projectMistakeVariantGuarded(tx, variant.id);
  }
}

export function createPracticeProposalLifecycle(runtime: PracticeLifecycleRuntime): {
  variantQuestionProposalDismissApplier: ProposalDismissApplier;
  variantQuestionProposalRetractApplier: ProposalRetractApplier;
  questionEditProposalRetractApplier: ProposalRetractApplier;
} {
  return {
    variantQuestionProposalDismissApplier: async (db, input) => ({
      kind: input.proposal.payload.kind,
      // The kernel takes the decision lock the variant accept takes, so a dismiss and an
      // accept serialize; the signal follows the commit, only for a new dismiss.
      result: await runProposalDismiss(db as Db, input.proposalId, {
        proposal: {
          ...input.proposal,
          kind: input.proposal.payload.kind,
          target: input.proposal.payload.target,
        } as ProposalInboxRow,
        userNote: input.user_note,
        signal: 'after_commit',
        effect: async (tx) => {
          const [draftVariant] = await tx
            .select({ id: mistake_variant.id })
            .from(mistake_variant)
            .where(
              and(
                eq(mistake_variant.proposal_event_id, input.proposalId),
                eq(mistake_variant.status, 'draft'),
              ),
            )
            .for('update')
            .limit(1);
          if (!draftVariant) return;

          if (!(await runtime.hasMistakeVariantGenesisAnchor(tx, draftVariant.id))) {
            throw new Error(`Variant ${draftVariant.id} needs canonical projection migration`);
          }
          await runtime.projectMistakeVariantGuarded(tx, draftVariant.id);
        },
      }),
    }),
    variantQuestionProposalRetractApplier: (db, input) =>
      retractVariantQuestion(db as Tx, input, runtime),
    questionEditProposalRetractApplier: async (db, input) => {
      const existingRate = await runtime.findExistingRateEvent(db as Tx, input.proposalId);
      if (existingRate?.decision === 'accept') {
        throw new ApiError(
          'question_edit_retract_conflict',
          '题目修订已应用，无法安全撤销；请提交新的题目修订来纠正当前内容。',
          409,
        );
      }
    },
  };
}
