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
// replace the proposal path — both use the goal command owner.
//
// COLD-START (YUK-473 live find): a day-one user declares a goal on an EMPTY tree
// (only subject-root seeds — often a cross-subject goal or no subject picked). The goal
// is a north-star; its KC scope GROWS as uploads populate the tree. We therefore do NOT
// reject an empty scope (the original "require a resolvable scope" guard blocked the
// cold-start entry — the very flow this endpoint exists for). Only a title is required.
//
// YUK-603 (v2 contract §5): a subject goal's scope is NEVER frozen at write time.
// The old write-time resolveSubjectKnowledgeIds freeze looked "legitimately empty/thin"
// but was actually NON-empty day-one — the synthetic seed root self-matches its own
// domain — so placement tier-1 pinned to ['seed:<subj>:root'] permanently. The row now
// carries scope_mode: 'explicit' (hand-picked frozen set is authoritative) vs
// 'subject_live' (readers derive from subject_id at read time; frozen stays []).

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
    const { title, subjectId: rawSubjectId, knowledgeIds: explicit } = parsed.data;

    // YUK-600（阻断④防线步 1）—— alias→canonical 归一（tx 外、scope 派生前）：
    // goal 只能引用已存在科目（thin-create 是创建唯一入口），unknown → 422；
    // canonical 全程替换 raw 四消费点（scope_mode 分支 / genesis snapshot /
    // insertGoal / 201 响应）。顺带修 alias-miss 潜伏 bug：传 'wenyan' 曾原样
    // 落库 + 派生 scope 恒空——归一后 = 'yuwen' + scope 正确。
    const subjectId = rawSubjectId ? resolveKnownSubjectId(rawSubjectId) : null;
    if (rawSubjectId && !subjectId) {
      throw new ApiError('validation_error', `unknown subject '${rawSubjectId}'`, 422);
    }

    // Scope semantics (YUK-603, v2 contract §5.3 — three write branches, NO write-time freeze
    // of a subject derivation):
    //   1. explicit knowledgeIds → scope_mode='explicit', the set IS the frozen authority.
    //   2. subjectId only        → scope_mode='subject_live', frozen stays [] — scope derives
    //      from the subject at READ time (subject=view). Freezing the derivation here was the
    //      armed live bug: day-one it resolved to ['seed:<subj>:root'] (the synthetic root
    //      self-matches its own domain), pinning placement tier-1 to [root] forever and
    //      blinding the goal-strand readers.
    //   3. neither → scope_mode='explicit' + [] (a cross-subject north-star; nothing to derive).
    // An empty frozen scope is ALLOWED (cold-start north-star, YUK-481); only the title is
    // required (enforced by the Body schema above).
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
    });

    return resourceResponse(
      {
        id,
        title,
        subjectId: subjectId ?? null,
        scopeKnowledgeIds,
        status: 'active',
      },
      { outcome: 'created', location: `/api/goals/${encodeURIComponent(id)}` },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
