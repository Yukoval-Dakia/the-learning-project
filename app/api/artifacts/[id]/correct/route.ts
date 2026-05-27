import { newId } from '@/core/ids';
import { CorrectArtifactEvent } from '@/core/schema/event';
import { db } from '@/db/client';
import { artifact } from '@/db/schema';
import { bodyBlocksToNoteSections } from '@/server/artifacts/body-blocks';
import { getArtifactCorrectionState } from '@/server/events/artifact-corrections';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id: artifactId } = await params;
    if (!artifactId) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    const [target] = await db
      .select({ id: artifact.id })
      .from(artifact)
      .where(eq(artifact.id, artifactId));
    if (!target) {
      throw new ApiError('not_found', `artifact ${artifactId} not found`, 404);
    }

    const state = await getArtifactCorrectionState(db, artifactId);
    // Wire shape is Record<string, ArtifactCorrectionStatus>; we flatten the
    // projection's Map<string, …> here so JSON serializes naturally. Direct
    // server-side callers of getArtifactCorrectionState still get the Map.
    return Response.json({
      artifact_id: artifactId,
      whole: state.whole,
      blocks: Object.fromEntries(state.blocks),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id: artifactId } = await params;
    if (!artifactId) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }

    const rawBody = await req.json().catch(() => null);
    // Construct the full event shape and let the existing zod (including
    // superRefine for supersede ↔ replacement_artifact_id) validate. This keeps
    // body validation aligned with the canonical CorrectArtifactEvent contract.
    const parsed = CorrectArtifactEvent.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'artifact',
      subject_id: artifactId,
      outcome: 'success',
      payload: rawBody,
    });
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues
          .map((i) => `${i.path.filter((p) => p !== 'payload').join('.')}: ${i.message}`)
          .join('; '),
        400,
      );
    }

    const [target] = await db.select().from(artifact).where(eq(artifact.id, artifactId));
    if (!target) {
      throw new ApiError('not_found', `artifact ${artifactId} not found`, 404);
    }

    const { correction_kind, block_id, replacement_artifact_id } = parsed.data.payload;

    if (block_id !== undefined) {
      const sections = bodyBlocksToNoteSections(target.body_blocks);
      if (!sections.some((sec) => sec.id === block_id)) {
        throw new ApiError(
          'not_found',
          `artifact ${artifactId} has no block with id '${block_id}'`,
          404,
        );
      }
    }

    if (correction_kind === 'supersede') {
      // superRefine already guarantees replacement_artifact_id is present, but
      // we still need to verify it points at a real artifact.
      const replacementId = replacement_artifact_id as string;
      const [replacement] = await db
        .select({ id: artifact.id })
        .from(artifact)
        .where(eq(artifact.id, replacementId));
      if (!replacement) {
        throw new ApiError(
          'not_found',
          `replacement_artifact_id '${replacementId}' not found`,
          404,
        );
      }
    }

    const correctionEventId = newId();
    await writeEvent(db, {
      id: correctionEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'artifact',
      subject_id: artifactId,
      outcome: 'success',
      payload: parsed.data.payload,
      created_at: new Date(),
    });

    return Response.json({ correction_event_id: correctionEventId });
  } catch (err) {
    return errorResponse(err);
  }
}
