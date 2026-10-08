import {
  AdminCostResponseSchema,
  AdminFailuresResponseSchema,
  AdminRunDetailResponseSchema,
  AdminRunsResponseSchema,
} from '@/capabilities/observability/api/admin-observability-contracts';
import {
  ConjectureScoresResponseSchema,
  CoverageLatticeResponseSchema,
} from '@/capabilities/observability/api/diagnostic-contracts';
import type { AdminReadClient } from '@/capabilities/observability/ui/admin-client';
import {
  getStartAdminConjectureScores,
  getStartAdminCost,
  getStartAdminCoverage,
  getStartAdminFailures,
  getStartAdminRunDetail,
  getStartAdminRuns,
} from './admin-function';
import { authenticatedStartFetch } from './authenticated-fetch';

const transport = { fetch: authenticatedStartFetch };
export const startAdminClient: AdminReadClient = {
  getRuns: async (query = {}) => {
    const dto = await getStartAdminRuns({ ...transport, data: query });
    AdminRunsResponseSchema.parse(dto);
    return dto;
  },
  getRunDetail: async (input) => {
    const dto = await getStartAdminRunDetail({ ...transport, data: input });
    AdminRunDetailResponseSchema.parse(dto);
    return dto;
  },
  getCost: async (query = {}) => {
    const dto = await getStartAdminCost({ ...transport, data: query });
    AdminCostResponseSchema.parse(dto);
    return dto;
  },
  getFailures: async (query = {}) => {
    const dto = await getStartAdminFailures({ ...transport, data: query });
    AdminFailuresResponseSchema.parse(dto);
    return dto;
  },
  getCoverage: async () => {
    const dto = await getStartAdminCoverage(transport);
    CoverageLatticeResponseSchema.parse(dto);
    return dto;
  },
  getConjectureScores: async () => {
    const dto = await getStartAdminConjectureScores(transport);
    ConjectureScoresResponseSchema.parse(dto);
    return dto;
  },
};
