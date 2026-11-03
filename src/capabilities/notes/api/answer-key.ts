// YUK-1763 — explicit answer reveal for assessed interactive artifacts.
//
// The learner-facing HTML never carries the answer key (authoring rejects it;
// the note-page serve path strips legacy occurrences). Answers live in
// attrs.answer_key, written by author_artifact/update_artifact from the
// validated content_validation manifest. This route is the single serve point
// the 「看答案」 affordance fetches on explicit learner request — fetching the
// artifact page alone can never produce the answers.

import { and, eq, isNull } from 'drizzle-orm';

import { ArtifactIdParamsSchema } from '@/capabilities/notes/api/contracts';
import { InteractiveArtifactAttrs } from '@/core/schema/business';
import { db } from '@/db/client';
import { artifact } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { assessmentBindings } from '@/kernel/learning-content';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = ArtifactIdParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    const artifactId = parsedParams.data.id;

    const [row] = await db
      .select({ type: artifact.type, attrs: artifact.attrs })
      .from(artifact)
      .where(and(eq(artifact.id, artifactId), isNull(artifact.archived_at)));
    if (!row) {
      throw new ApiError('not_found', `artifact ${artifactId} not found`, 404);
    }
    if (row.type !== 'interactive') {
      throw new ApiError(
        'validation_error',
        `artifact ${artifactId} is type '${row.type}' — answer keys exist only for interactive artifacts`,
        400,
      );
    }

    const parsed = InteractiveArtifactAttrs.safeParse(row.attrs);
    if (!parsed.success) {
      throw new ApiError('not_found', `artifact ${artifactId} has no readable payload`, 404);
    }

    // Current artifacts: the stored answer key. Legacy rows (authored before
    // YUK-1763) carry data-copilot-answer attributes in the stored HTML — derive
    // server-side so the reveal works for them too, without ever serving that
    // HTML back with answers attached.
    const answers =
      parsed.data.answer_key?.map(({ id, reference_md }) => ({ id, reference_md })) ??
      assessmentBindings(parsed.data.html)
        .filter((binding) => (binding.answer ?? '').length > 0)
        .map(({ id, answer }) => ({ id, reference_md: answer as string }));

    return Response.json({ artifact_id: artifactId, answers });
  } catch (err) {
    return errorResponse(err);
  }
}
