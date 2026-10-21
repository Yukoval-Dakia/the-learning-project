// Dismiss one system-maintained hub auto-link. One transaction appends the
// suppression so the nightly sync skips it, writes a traceable suppress event,
// and removes the chip immediately (undoable) so a refresh cannot bring it back
// before the next sync. Repeating the call leaves one suppression entry and the
// removal becomes a no-op.

import { DismissHubLinkBodySchema, HubIdParamsSchema } from '@/capabilities/notes/api/contracts';
import { persistHubLinkDismiss } from '@/capabilities/notes/server/hub-dismiss';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = HubIdParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'hub id is required', 400);
    }
    const hubId = parsedParams.data.id;

    const rawBody = await req.json().catch(() => null);
    const parsedBody = DismissHubLinkBodySchema.safeParse(rawBody);
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

    // Single owner of the attrs/event/removal writes keeps them atomic.
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
