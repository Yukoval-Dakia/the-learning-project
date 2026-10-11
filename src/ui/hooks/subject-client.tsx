import { createContext, useContext } from 'react';
import { apiJson } from '@/ui/lib/api';
import type { CreatedSubject } from './useCreateSubject';
import type { ApiSubject } from './useSubjects';

// Subject list and thin-create transport for useSubjects / useCreateSubject (YUK-1438).
// HTTP is the default; the Start shell provides its RPC client. Errors must stay ApiError
// (status/code) so createSubjectErrorText keeps the 400/422 wording.
export type SubjectClient = {
  listSubjects: () => Promise<{ subjects: ApiSubject[] }>;
  createSubject: (displayName: string) => Promise<CreatedSubject>;
};
export const httpSubjectClient: SubjectClient = {
  listSubjects: () => apiJson<{ subjects: ApiSubject[] }>('/api/subjects'),
  createSubject: (displayName) =>
    apiJson<CreatedSubject>('/api/admin/subjects', {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    }),
};
const SubjectClientContext = createContext<SubjectClient | undefined>(undefined);
export const SubjectClientProvider = SubjectClientContext.Provider;
export function useSubjectClient(): SubjectClient {
  return useContext(SubjectClientContext) ?? httpSubjectClient;
}
