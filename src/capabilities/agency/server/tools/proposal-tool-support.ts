import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db } from '@/db/client';
import { learning_item } from '@/db/schema';
import { listProposalInboxRows } from '@/kernel/proposals/inbox';

export const LearningItemProposalOutputSchema = z.object({
  status: z.enum([
    'proposed',
    'skipped:not_found',
    'skipped:invalid_state',
    'skipped:duplicate_pending',
  ]),
  proposal_id: z.string().optional(),
  learning_item_id: z.string().optional(),
  reason: z.string().optional(),
  auto_applied: z.boolean().optional(),
});

export type LearningItemProposalOutput = z.infer<typeof LearningItemProposalOutputSchema>;

export function evidenceRefsFromEventIds(ids: string[]): ProposalEvidenceRefT[] {
  return [...new Set(ids)].map((id) => ({ kind: 'event', id }));
}

export async function pendingProposalWithCooldown(
  db: Db,
  kind: string,
  cooldownKey: string,
): Promise<boolean> {
  const rows = await listProposalInboxRows(db, { status: 'pending' });
  return rows.some((row) => row.kind === kind && row.payload.cooldown_key === cooldownKey);
}

export async function getActiveLearningItem(
  db: Db,
  itemId: string,
): Promise<typeof learning_item.$inferSelect | null> {
  const row = (
    await db
      .select()
      .from(learning_item)
      .where(and(eq(learning_item.id, itemId), isNull(learning_item.archived_at)))
      .limit(1)
  )[0];
  return row ?? null;
}
