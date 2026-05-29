// YUK-95 P5 Lane-D (Wave 7), ADR-0020 §9 — hub auto-link dismiss write path.
//
// POST /api/hubs/[id]/dismiss-link  { suppressed_artifact_id, relation? }
//
// Hides one system-maintained auto-link from a hub's `AutoLinksContainer`. In a
// single transaction this:
//   1. appends `{ artifact_id }` to `artifact.attrs.suppressed_block_refs[]`
//      (dedup) so the nightly `hub_auto_sync_nightly` worker skips it forever
//      (the worker reads this via `suppressedArtifactIds`);
//   2. writes an `event(action='suppress', subject_kind='artifact')` so the
//      dismiss is traceable (XC-5 event-driven, not a silent attrs mutation);
//   3. immediately removes the dismissed crossLinkBlock from the container via
//      `persistNoteRefineApply` (a single `replace_block` on the container) —
//      this is undoable (logged as `experimental:note_refine_apply`) and keeps
//      the chip from re-appearing on a hard refresh before the next nightly run.
//
// Idempotent: dismissing the same target twice leaves a single
// suppressed_block_refs entry. The second call still writes a suppress event
// (append-only history) but the immediate-removal patch is a no-op (the child is
// already gone) so no second body_blocks mutation happens.

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { newId } from '@/core/ids';
import { SuppressArtifactLink } from '@/core/schema/event';
import { db } from '@/db/client';
import type { Tx } from '@/db/client';
import { artifact } from '@/db/schema';
import { appendSuppressedRef, buildRemoveAutoLinkPatch } from '@/server/artifacts/hub-dismiss';
import { persistNoteRefineApply } from '@/server/artifacts/note-refine-apply';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const HUB_TYPE = 'note_hub';
const SUPPRESS_ACTOR_REF = 'hub_dismiss_link';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

const BodySchema = z
  .object({
    suppressed_artifact_id: z.string().trim().min(1),
    relation: z.enum(['subtopic', 'prerequisite', 'derived_from', 'contrasts_with']).optional(),
  })
  .strict();

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const parsedParams = ParamsSchema.safeParse(await params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'hub id is required', 400);
    }
    const hubId = parsedParams.data.id;

    const rawBody = await req.json().catch(() => null);
    const parsedBody = BodySchema.safeParse(rawBody);
    if (!parsedBody.success) {
      throw new ApiError(
        'validation_error',
        parsedBody.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { suppressed_artifact_id, relation } = parsedBody.data;

    if (suppressed_artifact_id === hubId) {
      throw new ApiError('validation_error', 'a hub cannot suppress a link to itself', 400);
    }

    // Validate the suppress event shape against the canonical KnownEvent schema
    // up front (same pattern as the correct route) so the wire contract is the
    // single source of truth.
    const parsedEvent = SuppressArtifactLink.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'suppress',
      subject_kind: 'artifact',
      subject_id: hubId,
      outcome: 'success',
      payload: { suppressed_artifact_id, ...(relation ? { relation } : {}) },
    });
    if (!parsedEvent.success) {
      throw new ApiError('validation_error', 'invalid suppress payload', 400);
    }

    const result = await db.transaction(async (tx: Tx) => {
      const [hub] = await tx
        .select({
          id: artifact.id,
          type: artifact.type,
          attrs: artifact.attrs,
          body_blocks: artifact.body_blocks,
        })
        .from(artifact)
        .where(eq(artifact.id, hubId));
      if (!hub) {
        throw new ApiError('not_found', `hub ${hubId} not found`, 404);
      }
      if (hub.type !== HUB_TYPE) {
        throw new ApiError('validation_error', `artifact ${hubId} is not a hub`, 400);
      }

      const { attrs: nextAttrs } = appendSuppressedRef(
        hub.attrs as Record<string, unknown> | null,
        suppressed_artifact_id,
      );

      // 1. Persist the dedup'd suppressed_block_refs on attrs. Note: we do NOT
      //    bump version here — the immediate-removal apply below owns the
      //    version bump (and its optimistic guard) so both writes stay
      //    consistent within this tx.
      await tx
        .update(artifact)
        .set({ attrs: nextAttrs as never, updated_at: new Date() })
        .where(eq(artifact.id, hubId));

      // 2. Append-only suppress event (XC-5 traceable).
      const suppressEventId = newId();
      await writeEvent(tx, {
        id: suppressEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'suppress',
        subject_kind: 'artifact',
        subject_id: hubId,
        outcome: 'success',
        payload: parsedEvent.data.payload,
        created_at: new Date(),
      });

      // 3. Immediately remove the dismissed auto crossLinkBlock from the
      //    container (undoable note_refine_apply). No-op when the child is
      //    already gone (idempotent dismiss).
      const patch = buildRemoveAutoLinkPatch(hub.body_blocks, suppressed_artifact_id);
      let removed = false;
      if (patch) {
        const applied = await persistNoteRefineApply({
          db: tx,
          artifactId: hubId,
          patch,
          actorRef: SUPPRESS_ACTOR_REF,
          triggerEventId: suppressEventId,
        });
        removed = applied.status === 'applied';
      }

      return { suppress_event_id: suppressEventId, removed };
    });

    return Response.json({
      hub_id: hubId,
      suppressed_artifact_id,
      suppress_event_id: result.suppress_event_id,
      removed: result.removed,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
