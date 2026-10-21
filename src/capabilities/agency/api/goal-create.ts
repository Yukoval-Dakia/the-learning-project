// POST /api/goals — at-entry direct goal creation: a brand-new user declares a goal
// (with a KC scope) so the cold-start placement probe has knowledge nodes to walk.
//
// Goals are normally materialized from an accepted `goal_scope` proposal, which needs
// pre-existing evidence; this additive manual path (source='manual') does not replace
// that path — both go through the goal command owner.
//
// Constraints:
// - Only a title is required, and an empty scope is allowed (cold-start north-star).
// - A subject goal's scope is NEVER frozen at write time. The row carries scope_mode:
//   'explicit' (hand-picked frozen set is authoritative) vs 'subject_live' (readers
//   derive from subject_id at read time; frozen stays []). Freezing the derivation
//   resolves day-one to the synthetic seed root, pinning placement to it forever.

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { goal } from '@/db/schema';
import { ApiError, errorResponse, resourceResponse } from '@/kernel/http';
import { resolveKnownSubjectId } from '@/subjects/profile';
import { createManualGoal } from '../server/goals/commands';
import { CreateGoalBody } from './goal-contracts';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const rows = await db.select().from(goal).where(eq(goal.id, params.id)).limit(1);
    const row = rows[0];
    if (!row) throw new ApiError('not_found', `goal ${params.id} not found`, 404);
    return Response.json(row);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }
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

    return resourceResponse(
      {
        id,
        title,
        subjectId: subjectId ?? null,
        scopeKnowledgeIds,
        declaredStage: declaredStage ?? null,
        status: 'active',
      },
      { outcome: 'created', location: `/api/goals/${encodeURIComponent(id)}` },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
