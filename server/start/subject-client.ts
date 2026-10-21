import { type SubjectClient, httpSubjectClient } from '@/ui/hooks/subject-client';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartSubjects } from './subject-function';

export const startSubjectClient: SubjectClient = {
  listSubjects: () => getStartSubjects({ fetch: authenticatedStartFetch }),
  createSubject: httpSubjectClient.createSubject,
};
