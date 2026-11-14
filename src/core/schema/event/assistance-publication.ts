import { z } from 'zod';

export const HintPublication = z.object({
  version: z.literal(1),
  binding_digest: z.string(),
  source_digest: z.string(),
  question_id: z.string(),
  revision_id: z.string(),
  rung: z.number().int().min(0).max(4),
  body: z.string().min(1),
  body_digest: z.string(),
  kind: z.enum(['ai', 'deterministic_next_step']),
  disclosure: z.string().nullable(),
  prior: z.array(z.object({ id: z.string(), digest: z.string() })).max(4),
  claim_id: z.string(),
  request_id: z.string(),
  source_exposure_id: z.string().nullable(),
  receipt: z.record(z.string(), z.unknown()).nullable(),
});
export type HintPublicationT = z.infer<typeof HintPublication>;

/** Assistance text is released by its issuance owner, never by generic event readers. */
export function publicAssistancePayload(action: string, payload: Record<string, unknown>) {
  if (action === 'experimental:assessment_publish') {
    const { study_sources: _privateSources, ...publicPayload } = payload;
    return publicPayload;
  }
  if (action === 'experimental:assessment_assistance') {
    return Object.fromEntries(
      ['version', 'kind', 'impact', 'content_digest', 'dose', 'phase']
        .filter((key) => key in payload)
        .map((key) => [key, payload[key]]),
    );
  }
  if (
    action === 'experimental:hint_generation_claim' ||
    action === 'experimental:hint_send_admission'
  ) {
    return { version: payload.version };
  }
  return payload;
}
