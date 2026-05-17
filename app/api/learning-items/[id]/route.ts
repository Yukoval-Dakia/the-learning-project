import { db } from '@/db/client';
import { completion_evidence, learning_item } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { assertKnowledgeIdsExist } from '@/server/knowledge/validate';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull } from 'drizzle-orm';
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
