import type { SubjectClient } from '@/ui/hooks/subject-client';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartSubjectFunction, getStartSubjects } from './subject-function';

export const startSubjectClient: SubjectClient = {
  listSubjects: () => getStartSubjects({ fetch: authenticatedStartFetch }),
  createSubject: async (displayName) =>
    JSON.parse(
      await createStartSubjectFunction({ fetch: authenticatedStartFetch, data: displayName }),
    ),
};
