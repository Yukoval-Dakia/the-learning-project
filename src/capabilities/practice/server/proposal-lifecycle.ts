import { and, eq, inArray } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { mistake_variant } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import type {
  ProposalDismissApplier,
  ProposalDismissInput,
  ProposalRetractApplier,
  ProposalRetractInput,
} from '@/kernel/proposals';

interface PracticeLifecycleRuntime {
  assertCurrentMistakeVariantParity: (tx: Tx, variantId: string) => Promise<void>;
  findExistingRateEvent: (
    tx: Tx,
    proposalId: string,
  ) => Promise<{ decision: string; payload: unknown } | null>;
  hasMistakeVariantGenesisAnchor: (tx: Tx, variantId: string) => Promise<boolean>;
  projectMistakeVariantGuarded: (tx: Tx, variantId: string) => Promise<unknown>;
  projectionIsWriter: (
    entity?: 'artifact' | 'goal' | 'learning_item' | 'mistake_variant' | 'question_block',
  ) => boolean;
  recordDismissSignal: (db: Db, input: ProposalDismissInput) => Promise<void>;
  writeProposalRateEvent: (
    db: Db,
    proposalId: string,
    rating: 'accept' | 'dismiss',
    userNote?: string,
  ) => Promise<{ rate_event_id: string | null; idempotent?: boolean; rate_at: Date }>;
}

async function retractVariantQuestion(
  tx: Tx,
  input: ProposalRetractInput,
  runtime: PracticeLifecycleRuntime,
): Promise<void> {
  const retractedVariants = await tx
    .select({ id: mistake_variant.id })
    .from(mistake_variant)
    .where(
      and(
        eq(mistake_variant.proposal_event_id, input.proposalId),
        inArray(mistake_variant.status, ['draft', 'active']),
      ),
    )
    .for('update');

  if (runtime.projectionIsWriter('mistake_variant')) {
    for (const variant of retractedVariants) {
      await runtime.projectMistakeVariantGuarded(tx, variant.id);
    }
    return;
  }

  await tx
    .update(mistake_variant)
    .set({ status: 'dismissed', updated_at: input.correction_at })
    .where(
      and(
        eq(mistake_variant.proposal_event_id, input.proposalId),
        inArray(mistake_variant.status, ['draft', 'active']),
      ),
    );
  for (const variant of retractedVariants) {
    if (await runtime.hasMistakeVariantGenesisAnchor(tx, variant.id)) {
      await runtime.assertCurrentMistakeVariantParity(tx, variant.id);
    }
  }
}

export function createPracticeProposalLifecycle(runtime: PracticeLifecycleRuntime): {
  variantQuestionProposalDismissApplier: ProposalDismissApplier;
  variantQuestionProposalRetractApplier: ProposalRetractApplier;
  questionEditProposalRetractApplier: ProposalRetractApplier;
} {
  return {
    variantQuestionProposalDismissApplier: async (db, input) => {
      const ownerDb = db as Db;
      const rate = await runtime.writeProposalRateEvent(
        ownerDb,
        input.proposalId,
        'dismiss',
        input.user_note,
      );
      if (!rate.idempotent) {
        await ownerDb.transaction(async (tx) => {
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

          if (runtime.projectionIsWriter('mistake_variant')) {
            await runtime.projectMistakeVariantGuarded(tx, draftVariant.id);
            return;
          }
          await tx
            .update(mistake_variant)
            .set({ status: 'dismissed', updated_at: rate.rate_at })
            .where(
              and(
                eq(mistake_variant.proposal_event_id, input.proposalId),
                eq(mistake_variant.status, 'draft'),
              ),
            );
          if (await runtime.hasMistakeVariantGenesisAnchor(tx, draftVariant.id)) {
            await runtime.assertCurrentMistakeVariantParity(tx, draftVariant.id);
          }
        });
        await runtime.recordDismissSignal(ownerDb, input);
      }

      return {
        kind: input.proposal.payload.kind,
        result: {
          kind: 'dismissed',
          rate_event_id: rate.rate_event_id,
          ...(rate.idempotent ? { idempotent: true } : {}),
        },
      };
    },
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
