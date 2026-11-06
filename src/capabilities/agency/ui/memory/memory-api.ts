import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

export type MemoryBoard = ApiOperationJsonResponse<'getLearnerContext'>;
export type MemoryTopic = MemoryBoard['topics'][number];
export type MemoryChange = MemoryBoard['changes'][number];
export type MemoryEditResult = ApiOperationJsonResponse<'editLearnerContext'>;
export type MemoryActionResult = ApiOperationJsonResponse<'actOnLearnerContext'>;

export const MEMORY_KEY = ['learner-context'] as const;

export function readMemoryBoard(): Promise<MemoryBoard> {
  return apiOperationJson('getLearnerContext', { url: '/api/learner-context', method: 'GET' });
}

export function editMemory(input: {
  instruction: string;
  topic_key?: string;
  expected_version: number;
}): Promise<MemoryEditResult> {
  return apiOperationJson('editLearnerContext', {
    url: '/api/learner-context/edit',
    method: 'POST',
    body: { ...input, derivation_policy: 'allow' },
  });
}

export function withdrawMemoryTopic(input: {
  topic_key: string;
  expected_version: number;
}): Promise<MemoryActionResult> {
  return apiOperationJson('actOnLearnerContext', {
    url: '/api/learner-context/action',
    method: 'POST',
    body: { op: 'withdraw_topic', ...input },
  });
}

export function undoMemoryChange(input: {
  change_id: string;
  expected_version: number;
}): Promise<MemoryActionResult> {
  return apiOperationJson('actOnLearnerContext', {
    url: '/api/learner-context/action',
    method: 'POST',
    body: { op: 'undo', ...input },
  });
}
