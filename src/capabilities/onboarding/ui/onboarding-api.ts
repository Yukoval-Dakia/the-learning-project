// Onboarding ui data layer (YUK-473 Slice 1).
// At-entry goal create — POST /api/goals (agency capability, LIVE on main).
// Contract mirrors src/capabilities/agency/api/goal-create.ts response.

import { apiJson } from '@/ui/lib/api';

export interface CreateGoalInput {
  title: string;
  subjectId?: string | null;
  knowledgeIds?: string[];
}

export interface CreateGoalResult {
  id: string;
  scopeKnowledgeIds: string[];
  status: string;
  title: string;
  subjectId: string | null;
}

export async function createGoal(input: CreateGoalInput): Promise<CreateGoalResult> {
  return apiJson<CreateGoalResult>('/api/goals', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
