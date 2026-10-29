import type { Db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { createManualGoal } from '@/kernel/records/goal-commands';
import { resolveKnownSubjectId } from '@/subjects/profile';
import { CreateGoalBody } from '../../api/goal-contracts';

// Own the complete at-entry goal creation contract; persistence stays atomic in commands.
export async function createGoal(db: Db, raw: unknown) {
  const parsed = CreateGoalBody.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      400,
    );
  }
  const { title, subjectId: rawSubjectId, knowledgeIds: explicit, declaredStage } = parsed.data;

  // Normalize alias→canonical outside the tx, before scope derivation: goals may only
  // reference existing subjects (thin-create is the only creation entry); unknown → 422.
  // Every downstream consumer must use the canonical id — a raw alias would land in the
  // DB and derive an empty scope forever.
  const subjectId = rawSubjectId ? resolveKnownSubjectId(rawSubjectId) : null;
  if (rawSubjectId && !subjectId) {
    throw new ApiError('validation_error', `unknown subject '${rawSubjectId}'`, 422);
  }

  // Scope semantics — three write branches, no write-time freeze of a subject derivation:
  //   1. explicit knowledgeIds → scope_mode='explicit', the set IS the frozen authority.
  //   2. subjectId only        → scope_mode='subject_live', frozen stays []; scope derives
  //      from the subject at READ time (subject=view).
  //   3. neither → scope_mode='explicit' + [] (a cross-subject north-star).
  // An empty frozen scope is allowed (cold-start north-star); only the title is required.
  const explicitScope = explicit ?? [];
  const scopeMode: 'explicit' | 'subject_live' =
    explicitScope.length === 0 && subjectId ? 'subject_live' : 'explicit';
  const scopeKnowledgeIds = explicitScope;

  const id = await createManualGoal(db, {
    title,
    subject_id: subjectId ?? null,
    scope_knowledge_ids: scopeKnowledgeIds,
    scope_mode: scopeMode,
    sequence_hint: 0,
    // NULL when the onboarding question was skipped / not sent. Curriculum constraint only.
    declared_stage: declaredStage ?? null,
  });
  return {
    id,
    title,
    subjectId: subjectId ?? null,
    scopeKnowledgeIds,
    declaredStage: declaredStage ?? null,
    status: 'active',
  };
}
