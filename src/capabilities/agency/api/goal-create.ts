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

import { z } from 'zod';

import { newId } from '@/core/ids';
import type { GoalRowSnapshotT } from '@/core/schema/event/genesis';
import { db } from '@/db/client';
import { goal } from '@/db/schema';
import { ApiError, errorResponse, resourceResponse } from '@/kernel/http';
import { writeEvent } from '@/server/events/queries';
// YUK-471 W2 — goal projection seam. The MANUAL at-entry path has NO proposal chain, so the
// only originating event is a genesis seed: the tx always writes the genesis event + the
// materialized_id_index anchor (the event log + anchor is the source of truth), then the
// per-entity flag projectionIsWriter('goal') gates ONLY who writes the ROW (projection
// write-through when ON, imperative insertGoal when OFF — defer-flip-not-build).
import { projectGoal } from '@/server/projections/goal';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
// HIGH-2 — write-time fold==row guard on the OFF branch (genesis written this tx → event-sourced).
import { assertGoalParity, goalLiveRowToSnapshot } from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';
import { ensureSubjectRoot } from '@/server/subjects/ensure-subject-root';
import { getDefaultSubjectRegistry, resolveKnownSubjectId } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
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
    const parsed = Body.safeParse(raw);
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

    const id = newId();
    const now = new Date();
    // The full goal snapshot for the genesis seed (manual goals have no proposal — genesis is
    // the originating event). version 0 mirrors insertGoal's DB default.
    const snapshot: GoalRowSnapshotT = {
      id,
      title,
      subject_id: subjectId ?? null,
      scope_knowledge_ids: scopeKnowledgeIds,
      scope_mode: scopeMode,
      sequence_hint: 0,
      status: 'active',
      source: 'manual',
      source_ref: null,
      created_at: now,
      updated_at: now,
      version: 0,
    };
    const genesisEventId = newId();
    await db.transaction(async (tx) => {
      // 1. ALWAYS write the genesis seed (the manual goal's only originating event) +
      //    materialized_id_index anchor, regardless of the flag. ingest_at=now → memory outbox
      //    opt-out (this is a structural seed, not a learning activity).
      await writeEvent(tx, {
        id: genesisEventId,
        actor_kind: 'system',
        actor_ref: 'goal-create',
        action: 'experimental:genesis',
        subject_kind: 'goal',
        subject_id: id,
        outcome: 'success',
        payload: { row: snapshot },
        // A7 — stamp created_at explicitly (parity with the accept path) so the genesis event's
        // fold-order timestamp is the same `now` as the row snapshot, not a separate DB default.
        created_at: now,
        ingest_at: now,
      });
      await upsertMaterializedIdIndex(tx, {
        materialized_id: id,
        anchor_event_id: genesisEventId,
        subject_kind: 'goal',
      });
      // YUK-600（阻断④防线步 2）—— 建根安全网：挂在两 writer 分岔**之前**的共享
      // 事务步骤（projectGoal 路完全绕过 insertGoal，防线不能挂 writer 内）。
      // 幂等 ON CONFLICT no-op；root.name 只从服务端 registry 读（v1 的
      // subjectDisplayName passthrough 已废除，不信任何 client 串）。
      // goal-parity 零成本：assertGoalParity 不读 knowledge，同 tx 建根安全。
      if (subjectId) {
        const profile = getDefaultSubjectRegistry().get(subjectId);
        await ensureSubjectRoot(tx, subjectId, profile?.displayName ?? subjectId);
      }
      // 2. ROW writer — gated on the per-entity flag (critic A1).
      if (projectionIsWriter('goal')) {
        await projectGoal(tx, id);
      } else {
        await insertGoal(tx, {
          id,
          title,
          subject_id: subjectId ?? null,
          scope_knowledge_ids: scopeKnowledgeIds,
          scope_mode: scopeMode,
          sequence_hint: 0,
          status: 'active',
          source: 'manual',
          now,
        });
        // HIGH-2 — re-select + assert fold(genesis) == row (the genesis written above makes the
        // manual goal event-sourced this tx, so the fold reproduces it byte-for-byte).
        const [written] = await tx.select().from(goal).where(eq(goal.id, id)).limit(1);
        await assertGoalParity(tx, id, written ? goalLiveRowToSnapshot(written) : null);
      }
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
