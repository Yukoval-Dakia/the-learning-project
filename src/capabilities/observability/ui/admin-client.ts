import { apiJson } from '@/ui/lib/api';
import type {
  AdminCostDto,
  AdminFailuresDto,
  AdminRunDetailDto,
  AdminRunsDto,
  ConjectureScoresRead,
  CoverageLatticeRead,
  parseAdminCostQuery,
  parseAdminFailuresQuery,
  parseAdminRunsQuery,
} from '../public';

export type AdminRunsQuery = NonNullable<Parameters<typeof parseAdminRunsQuery>[0]>;
export type AdminCostQuery = NonNullable<Parameters<typeof parseAdminCostQuery>[0]>;
export type AdminFailuresQuery = NonNullable<Parameters<typeof parseAdminFailuresQuery>[0]>;

export interface AdminReadClient {
  getRuns(query?: AdminRunsQuery): Promise<AdminRunsDto>;
  getRunDetail(input: { id: string }): Promise<AdminRunDetailDto>;
  getCost(query?: AdminCostQuery): Promise<AdminCostDto>;
  getFailures(query?: AdminFailuresQuery): Promise<AdminFailuresDto>;
  getCoverage(): Promise<CoverageLatticeRead>;
  getConjectureScores(): Promise<ConjectureScoresRead>;
}

function queryString(query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, value);
  }
  return params.size ? `?${params}` : '';
}

// Retained development/legacy consumers use HTTP until their exit is validated.
export const httpAdminClient: AdminReadClient = {
  getRuns: (query = {}) => apiJson(`/api/admin/runs${queryString(query)}`),
  getRunDetail: ({ id }) => apiJson(`/api/admin/runs/${encodeURIComponent(id)}`),
  getCost: (query = {}) => apiJson(`/api/admin/cost${queryString(query)}`),
  getFailures: (query = {}) => apiJson(`/api/admin/failures${queryString(query)}`),
  getCoverage: () => apiJson('/api/admin/coverage-lattice'),
  getConjectureScores: () => apiJson('/api/admin/conjecture-scores'),
};
