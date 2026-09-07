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
  findExistingRateEvent: (
    tx: Tx,
    proposalId: string,
  ) => Promise<{ decision: string; payload: unknown } | null>;
  hasMistakeVariantGenesisAnchor: (tx: Tx, variantId: string) => Promise<boolean>;
  projectMistakeVariantGuarded: (tx: Tx, variantId: string) => Promise<unknown>;
  recordDismissSignal: (db: Db, input: ProposalDismissInput) => Promise<void>;
  writeProposalRateEvent: (
    db: Db | Tx,
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
    variantQuestionProposalDismissApplier: async (db, input) => {
      const ownerDb = db as Db;
      const rate = await ownerDb.transaction(async (tx) => {
        const rate = await runtime.writeProposalRateEvent(
          tx,
          input.proposalId,
          'dismiss',
          input.user_note,
        );
        if (!rate.idempotent) {
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
          if (!draftVariant) return rate;

          if (!(await runtime.hasMistakeVariantGenesisAnchor(tx, draftVariant.id))) {
            throw new Error(`Variant ${draftVariant.id} needs canonical projection migration`);
          }
          await runtime.projectMistakeVariantGuarded(tx, draftVariant.id);
        }
        return rate;
      });
      if (!rate.idempotent) {
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
