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

import { z } from 'zod';

import { db } from '@/db/client';
import { persistHubLinkDismiss } from '@/server/artifacts/hub-dismiss';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

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

    // All artifact/event writes are owned by the hub-dismiss service so the attrs
    // suppressed_block_refs update, the suppress event, and the immediate-removal
    // patch stay atomic in one transaction (ADR-0020 §9 single-owner write path).
    const result = await db.transaction((tx) =>
      persistHubLinkDismiss(tx, {
        hubId,
        suppressedArtifactId: suppressed_artifact_id,
        relation,
      }),
    );

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
