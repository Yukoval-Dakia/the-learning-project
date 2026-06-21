// POST /api/goals — cold-start openable sprint P0 (YUK-472).
// docs/planning/2026-06-21-cold-start-openable-sprint.md 图一 P0.
//
// At-entry DIRECT goal creation: a brand-new user declares a goal (with a KC
// scope) so the cold-start placement probe (YUK-475) has knowledge nodes to walk.
//
// Relationship to ADR-0025 / the proposal path: goals are normally MATERIALIZED
// from an accepted `goal_scope` proposal (evidence-first — see
// server/goals/queries.ts docblock + goal_scope_propose_nightly). That reactive
// path needs pre-existing evidence, so day-one (zero data) it yields no goal.
// This handler is the ADDITIVE at-entry write path (source='manual'); it does NOT
// replace the proposal path — both call the single `insertGoal` write surface.
//
// COLD-START (YUK-473 live find): a day-one user declares a goal on an EMPTY tree
// (only subject-root seeds — often a cross-subject goal or no subject picked), so the
// resolved scope is legitimately empty/thin at entry. The goal is a north-star; its KC
// scope GROWS as uploads populate the tree. We therefore do NOT reject an empty scope
// (the original "require a resolvable scope" guard blocked the cold-start entry — the
// very flow this endpoint exists for). Only a title is required. Downstream placement
// must resolve scope dynamically (goal.scope_knowledge_ids OR, when empty, subject-
// derived) so it picks up newly-uploaded KCs — tracked in YUK-481.

import { z } from 'zod';

import { resolveSubjectKnowledgeIds } from '@/capabilities/knowledge/server/domain';
import { newId } from '@/core/ids';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { insertGoal } from '../server/goals/queries';

const Body = z.object({
  /** human-readable goal title (required). */
  title: z.string().min(1),
  /** subject profile id. Sets goal.subject_id AND (when knowledgeIds is omitted)
   * derives the scope via the effective-domain axis. subject=view: no root node. */
  subjectId: z.string().min(1).nullable().optional(),
  /** explicit goal-subgraph KC set; wins over subjectId-derived scope. */
  knowledgeIds: z.array(z.string().min(1)).optional(),
  // sequence_hint is AI-internal (ND-4: NOT a progress metric) and set by the
  // proposal path; the manual entry path defaults it to 0 and does not expose it
  // until a caller needs it (YAGNI — avoids surfacing an internal field on the
  // public entry API).
});

export async function POST(req: Request): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { title, subjectId, knowledgeIds: explicit } = parsed.data;

    // Resolve the goal's KC scope: explicit set wins; else derive from the subject
    // via the effective-domain axis (a question/KC's subject is a DERIVED join, never
    // a column — subject 模型终版第 2 条). An empty resolved scope is ALLOWED — a
    // cold-start day-one goal is a north-star declared on an empty tree; its scope
    // grows as uploads populate KCs (see docblock + YUK-481). Only the title is
    // required (enforced by the Body schema above).
    let scopeKnowledgeIds = explicit ?? [];
    if (scopeKnowledgeIds.length === 0 && subjectId) {
      scopeKnowledgeIds = await resolveSubjectKnowledgeIds(db, subjectId);
    }

    const id = newId();
    await insertGoal(db, {
      id,
      title,
      subject_id: subjectId ?? null,
      scope_knowledge_ids: scopeKnowledgeIds,
      sequence_hint: 0,
      status: 'active',
      source: 'manual',
    });

    return Response.json({
      id,
      title,
      subjectId: subjectId ?? null,
      scopeKnowledgeIds,
      status: 'active',
    });
  } catch (err) {
    return errorResponse(err);
  }
}
