import { type PracticeClient, buildPaperSubmissionBody } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { submitPaperSlotFunction } from './paper-submit-function';

export const startPaperSubmissionClient: PracticeClient['submitPaperSlot'] = async (
  artifactId,
  input,
) =>
  JSON.parse(
    await submitPaperSlotFunction({
      fetch: authenticatedStartFetch,
      data: {
        sessionId: input.session_id,
        body: JSON.stringify(buildPaperSubmissionBody(artifactId, input)),
      },
    }),
  );
