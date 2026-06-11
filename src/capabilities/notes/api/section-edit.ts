import { z } from 'zod';

import { editArtifactSection } from '@/capabilities/notes/server/sections';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';

const PatchBody = z.object({
  artifact_version: z.number().int().min(0),
  section_version: z.number().int().min(0),
  body_md: z.string().max(50_000),
});

export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id, sectionId } = params;
    const raw = await req.json().catch(() => null);
    const parsed = PatchBody.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        {
          error: 'validation_error',
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
        },
        { status: 400 },
      );
    }

    const result = await editArtifactSection({
      db,
      artifactId: id,
      sectionId,
      expectedArtifactVersion: parsed.data.artifact_version,
      expectedSectionVersion: parsed.data.section_version,
      nextBodyMd: parsed.data.body_md,
      actorRef: 'learning_item_detail',
    });

    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
