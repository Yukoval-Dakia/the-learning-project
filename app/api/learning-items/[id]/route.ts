import { db } from '@/db/client';
import { artifact, completion_evidence, learning_item, question } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { getEffectiveDomain } from '@/server/knowledge/domain';
import { assertKnowledgeIdsExist } from '@/server/knowledge/validate';
import {
  type SlimSubjectProfile,
  resolveSubjectProfile,
  toSlimSubjectProfile,
} from '@/subjects/profile';
import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

export const runtime = 'nodejs';

// LearningItem 6 状态 (Phase 1c.2 加 resting + archived；dismissed 已有 schema 列但
// 没用，保留作 Phase 1d 拒绝 dreaming 提议时用)。
type LearningItemStatus = 'pending' | 'in_progress' | 'done' | 'dismissed' | 'resting' | 'archived';

const PatchBody = z.object({
  version: z.number().int().min(0),
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(10_000).optional(),
  knowledge_ids: z.array(z.string().min(1)).optional(),
  status: z.enum(['pending', 'in_progress', 'done', 'dismissed', 'resting', 'archived']).optional(),
  user_notes: z.string().max(2000).optional(),
  // hub/atomic linkage: null clears parent (item becomes top-level / its own hub),
  // string sets parent. Cycle-checked below.
  parent_learning_item_id: z.string().min(1).nullable().optional(),
});

// 设计意图（per memory + modules/learning-items.md）:
//   pending     ↔ in_progress  ↔ done
//   any         → archived        (用户手动归档，单向，不再出现在主列表)
//   done        → resting         (完成后进入"养护"状态，dreaming 会从这里挑复学)
//   resting     → in_progress     (用户/dreaming 触发复学)
//   archived    → pending         (复活)
//   dismissed   → pending         (恢复 AI 提议被拒的 item)
const VALID_TRANSITIONS: Record<string, Set<LearningItemStatus>> = {
  pending: new Set(['in_progress', 'done', 'archived', 'dismissed']),
  in_progress: new Set(['done', 'pending', 'archived']),
  done: new Set(['in_progress', 'resting', 'archived']),
  resting: new Set(['in_progress', 'archived']),
  dismissed: new Set(['pending', 'archived']),
  archived: new Set(['pending']),
};

type RouteParams = { params: Promise<{ id: string }> };

async function resolveSlimProfileForKnowledgeIds(
  knowledgeIds: string[],
): Promise<SlimSubjectProfile> {
  const firstKnowledgeId = knowledgeIds[0];
  if (!firstKnowledgeId) {
    return toSlimSubjectProfile(resolveSubjectProfile(null));
  }

  try {
    const domain = await getEffectiveDomain(db, firstKnowledgeId);
    return toSlimSubjectProfile(resolveSubjectProfile(domain));
  } catch (err) {
    console.error(
      '[learning-items GET] getEffectiveDomain failed; falling back to default subject',
      { knowledge_id: firstKnowledgeId, err },
    );
    return toSlimSubjectProfile(resolveSubjectProfile(null));
  }
}

// GET — single item + parent breadcrumb (1 hop) + immediate children +
// primary artifact (when present). Used by /learning-items/[id] detail page.
// Children are derived from WHERE parent_learning_item_id = id (we do NOT use
// the denormalised child_learning_item_ids column — it's stub per
// scripts/audit-schema-allowlist).
export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    const rows = await db
      .select({
        id: learning_item.id,
        title: learning_item.title,
        content: learning_item.content,
        knowledge_ids: learning_item.knowledge_ids,
        status: learning_item.status,
        parent_learning_item_id: learning_item.parent_learning_item_id,
        primary_artifact_id: learning_item.primary_artifact_id,
        completed_at: learning_item.completed_at,
        archived_at: learning_item.archived_at,
        created_at: learning_item.created_at,
        updated_at: learning_item.updated_at,
        version: learning_item.version,
      })
      .from(learning_item)
      .where(eq(learning_item.id, id));
    const row = rows[0];
    if (!row) {
      return Response.json(
        { error: 'not_found', message: `learning_item ${id} not found` },
        { status: 404 },
      );
    }

    let parent: { id: string; title: string; status: string } | null = null;
    if (row.parent_learning_item_id) {
      const parentRows = await db
        .select({
          id: learning_item.id,
          title: learning_item.title,
          status: learning_item.status,
        })
        .from(learning_item)
        .where(eq(learning_item.id, row.parent_learning_item_id));
      const p = parentRows[0];
      if (p) parent = { id: p.id, title: p.title, status: p.status };
    }

    const children = await db
      .select({
        id: learning_item.id,
        title: learning_item.title,
        status: learning_item.status,
        knowledge_ids: learning_item.knowledge_ids,
      })
      .from(learning_item)
      .where(eq(learning_item.parent_learning_item_id, id))
      .orderBy(asc(learning_item.created_at));

    // Pull primary artifact for Phase 2B note display.
    let primaryArtifact: {
      id: string;
      type: string;
      sections: unknown;
      outline_json: unknown;
      generation_status: string;
      verification_status: string;
      verification_summary: unknown;
      verified_by: unknown;
      embedded_check_status: string;
      embedded_questions: Array<{
        id: string;
        kind: string;
        prompt_md: string;
        choices_md: string[] | null;
      }>;
    } | null = null;
    if (row.primary_artifact_id) {
      const aRows = await db
        .select({
          id: artifact.id,
          type: artifact.type,
          sections: artifact.sections,
          outline_json: artifact.outline_json,
          generation_status: artifact.generation_status,
          verification_status: artifact.verification_status,
          verification_summary: artifact.verification_summary,
          verified_by: artifact.verified_by,
          embedded_check_status: artifact.embedded_check_status,
        })
        .from(artifact)
        .where(eq(artifact.id, row.primary_artifact_id))
        .limit(1);
      if (aRows[0]) {
        const primary = aRows[0];

        // Embedded check question payload (only when ready)
        let embeddedQuestions: Array<{
          id: string;
          kind: string;
          prompt_md: string;
          choices_md: string[] | null;
        }> = [];
        if (primary.embedded_check_status === 'ready') {
          const checkSection = ((primary.sections ?? []) as Array<{
            kind: string;
            embedded_check?: { question_ids: string[] } | null;
          }>).find((s) => s.kind === 'check');
          const ids = checkSection?.embedded_check?.question_ids ?? [];
          if (ids.length > 0) {
            const qRows = await db
              .select({
                id: question.id,
                kind: question.kind,
                prompt_md: question.prompt_md,
                choices_md: question.choices_md,
              })
              .from(question)
              .where(inArray(question.id, ids));
            // Preserve the order declared in the artifact's check section.
            const byId = new Map(qRows.map((r) => [r.id, r]));
            embeddedQuestions = ids
              .map((id) => byId.get(id))
              .filter((r): r is NonNullable<typeof r> => r !== undefined);
          }
        }

        primaryArtifact = { ...primary, embedded_questions: embeddedQuestions };
      }
    }
    const subjectProfile = await resolveSlimProfileForKnowledgeIds(row.knowledge_ids ?? []);

    return Response.json({
      id: row.id,
      title: row.title,
      content: row.content,
      knowledge_ids: row.knowledge_ids,
      subject_profile: subjectProfile,
      status: row.status,
      parent_learning_item_id: row.parent_learning_item_id,
      primary_artifact_id: row.primary_artifact_id,
      primary_artifact: primaryArtifact,
      parent,
      children,
      completed_at: row.completed_at ? Math.floor(row.completed_at.getTime() / 1000) : null,
      archived_at: row.archived_at ? Math.floor(row.archived_at.getTime() / 1000) : null,
      created_at: Math.floor(row.created_at.getTime() / 1000),
      updated_at: Math.floor(row.updated_at.getTime() / 1000),
      version: row.version,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    const raw = await req.json().catch(() => null);
    const parsed = PatchBody.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        {
          error: 'validation_error',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
        { status: 400 },
      );
    }
    const body = parsed.data;

    const rows = await db
      .select({
        id: learning_item.id,
        status: learning_item.status,
        version: learning_item.version,
        archived_at: learning_item.archived_at,
      })
      .from(learning_item)
      .where(eq(learning_item.id, id));

    const row = rows[0];
    // archived_at is set when the row is in archived state; we still serve
    // PATCHes against it so the user can revive to pending. 404 only when
    // the row genuinely doesn't exist.
    if (!row) {
      return Response.json(
        { error: 'not_found', message: `learning_item ${id} not found` },
        { status: 404 },
      );
    }

    if (body.status !== undefined && body.status !== row.status) {
      const allowed = VALID_TRANSITIONS[row.status];
      if (!allowed || !allowed.has(body.status as LearningItemStatus)) {
        return Response.json(
          {
            error: 'invalid_transition',
            message: `cannot transition ${row.status} → ${body.status}`,
            from: row.status,
            to: body.status,
          },
          { status: 400 },
        );
      }
    }

    if (body.knowledge_ids && body.knowledge_ids.length > 0) {
      const check = await assertKnowledgeIdsExist(db, body.knowledge_ids);
      if (!check.ok) {
        return Response.json(
          {
            error: 'validation_error',
            message: `unknown knowledge_ids: ${check.missing.join(', ')}`,
          },
          { status: 400 },
        );
      }
    }

    // parent_learning_item_id mutation — verify target exists + no cycle.
    // body.parent_learning_item_id === null means "clear parent".
    // body.parent_learning_item_id === undefined means "leave unchanged".
    if (body.parent_learning_item_id !== undefined && body.parent_learning_item_id !== null) {
      const target = body.parent_learning_item_id;
      if (target === id) {
        return Response.json(
          { error: 'validation_error', message: 'parent_learning_item_id cannot reference self' },
          { status: 400 },
        );
      }
      // Walk up the proposed parent's chain — if `id` appears, this assignment
      // would create a cycle. Bound the walk at 100 hops as a safety net.
      let cursor: string | null = target;
      let hops = 0;
      while (cursor !== null && hops < 100) {
        if (cursor === id) {
          return Response.json(
            {
              error: 'validation_error',
              message: 'parent_learning_item_id assignment would create a cycle',
            },
            { status: 400 },
          );
        }
        const parentRows = await db
          .select({ pid: learning_item.parent_learning_item_id })
          .from(learning_item)
          .where(eq(learning_item.id, cursor));
        const pRow = parentRows[0];
        if (!pRow) {
          // Target id or some ancestor doesn't exist.
          return Response.json(
            {
              error: 'validation_error',
              message: `parent_learning_item_id ${cursor} not found`,
            },
            { status: 400 },
          );
        }
        cursor = pRow.pid;
        hops += 1;
      }
    }

    const transitioningToDone = body.status === 'done' && row.status !== 'done';
    const transitioningOutOfDone =
      row.status === 'done' && body.status !== undefined && body.status !== 'done';
    const transitioningToArchived = body.status === 'archived' && row.status !== 'archived';
    const transitioningOutOfArchived =
      row.status === 'archived' && body.status !== undefined && body.status !== 'archived';
    const transitioningToDismissed = body.status === 'dismissed' && row.status !== 'dismissed';
    const transitioningOutOfDismissed =
      row.status === 'dismissed' && body.status !== undefined && body.status !== 'dismissed';

    if (body.user_notes !== undefined && !transitioningToDone) {
      return Response.json(
        {
          error: 'validation_error',
          message: 'user_notes only valid when transitioning into done state',
        },
        { status: 400 },
      );
    }

    const now = new Date();
    const setValues: Partial<typeof learning_item.$inferInsert> = {
      updated_at: now,
    };
    if (body.title !== undefined) setValues.title = body.title;
    if (body.content !== undefined) setValues.content = body.content;
    if (body.knowledge_ids !== undefined) setValues.knowledge_ids = body.knowledge_ids;
    if (body.status !== undefined) setValues.status = body.status;
    if (body.parent_learning_item_id !== undefined) {
      setValues.parent_learning_item_id = body.parent_learning_item_id;
    }
    if (transitioningToDone) setValues.completed_at = now;
    if (transitioningOutOfDone) setValues.completed_at = null;
    if (transitioningToArchived) setValues.archived_at = now;
    if (transitioningOutOfArchived) setValues.archived_at = null;
    if (transitioningToDismissed) setValues.dismissed_at = now;
    if (transitioningOutOfDismissed) setValues.dismissed_at = null;

    // Use raw SQL for version increment with optimistic-locking WHERE version = body.version
    const updateResult = await db
      .update(learning_item)
      .set({ ...setValues, version: row.version + 1 })
      .where(and(eq(learning_item.id, id), eq(learning_item.version, body.version)))
      .returning({ id: learning_item.id });

    if (updateResult.length === 0) {
      return Response.json(
        { error: 'conflict', message: `learning_item ${id} concurrently modified` },
        { status: 409 },
      );
    }

    if (transitioningToDone) {
      const evidenceJson = {
        declared_at: Math.floor(now.getTime() / 1000),
        ...(body.user_notes ? { user_notes: body.user_notes } : {}),
      };
      await db.insert(completion_evidence).values({
        id: createId(),
        learning_item_id: id,
        path: 'self_declare',
        evidence_json: evidenceJson,
        user_overrode_low_evidence: false,
        decided_at: now,
      });
    }

    const updatedRows = await db
      .select({
        id: learning_item.id,
        title: learning_item.title,
        content: learning_item.content,
        knowledge_ids: learning_item.knowledge_ids,
        status: learning_item.status,
        parent_learning_item_id: learning_item.parent_learning_item_id,
        completed_at: learning_item.completed_at,
        created_at: learning_item.created_at,
        updated_at: learning_item.updated_at,
        version: learning_item.version,
      })
      .from(learning_item)
      .where(eq(learning_item.id, id));

    const updated = updatedRows[0];
    if (!updated) {
      console.error('learning-items: row vanished after successful UPDATE', { id });
      return Response.json(
        { error: 'not_found', message: `learning_item ${id} not found after update` },
        { status: 404 },
      );
    }

    return Response.json({
      id: updated.id,
      title: updated.title,
      content: updated.content,
      knowledge_ids: updated.knowledge_ids,
      status: updated.status,
      parent_learning_item_id: updated.parent_learning_item_id,
      completed_at: updated.completed_at ? Math.floor(updated.completed_at.getTime() / 1000) : null,
      created_at: Math.floor(updated.created_at.getTime() / 1000),
      updated_at: Math.floor(updated.updated_at.getTime() / 1000),
      version: updated.version,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const versionRaw = url.searchParams.get('version');

    if (!versionRaw) {
      return Response.json(
        { error: 'validation_error', message: 'version query param required' },
        { status: 400 },
      );
    }
    if (!/^\d+$/.test(versionRaw)) {
      return Response.json(
        { error: 'validation_error', message: 'invalid version' },
        { status: 400 },
      );
    }
    const version = Number.parseInt(versionRaw, 10);

    const rows = await db
      .select({
        id: learning_item.id,
        version: learning_item.version,
        archived_at: learning_item.archived_at,
      })
      .from(learning_item)
      .where(eq(learning_item.id, id));

    const row = rows[0];
    if (!row || row.archived_at !== null) {
      return Response.json(
        { error: 'not_found', message: `learning_item ${id} not found` },
        { status: 404 },
      );
    }

    const now = new Date();
    const result = await db
      .update(learning_item)
      .set({ archived_at: now, archived_reason: 'user', updated_at: now, version: row.version + 1 })
      .where(and(eq(learning_item.id, id), eq(learning_item.version, version)))
      .returning({ id: learning_item.id });

    if (result.length === 0) {
      return Response.json(
        { error: 'conflict', message: `learning_item ${id} concurrently modified` },
        { status: 409 },
      );
    }

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
