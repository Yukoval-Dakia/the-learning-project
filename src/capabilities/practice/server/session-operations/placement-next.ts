import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { CreatePlacementQuestionSelectionBodySchema } from '../../api/placement-contracts';
import { runPlacementAdvance } from '../placement-advance';

export async function selectNextPlacementQuestion(db: Db, sessionId: string, raw: unknown) {
  const parsed = CreatePlacementQuestionSelectionBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      400,
    );
  }
  const { knowledgeIds: clientScopeOverride, cap, seThreshold } = parsed.data;
  const { selection } = await runPlacementAdvance(db, sessionId, {
    scopeOverride: clientScopeOverride,
    cap,
    seThreshold,
  });
  return selection;
}
