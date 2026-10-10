import { z } from 'zod';
import type {
  AdminCostQuery,
  AdminFailuresQuery,
  AdminReadClient,
  AdminRunsQuery,
} from '@/capabilities/observability/ui/admin-client';
import type { Db, Tx } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

const RunsQuery = z.object({
  limit: z.string().optional(),
  status: z.string().optional(),
  task_kind: z.string().optional(),
  cursor: z.string().optional(),
});

// This factory and all its imports are invoked inside the authenticated request boundary.
// Tests can inject their Db/Tx without changing the production connection owner.
export async function createStartAdminReader(options: { database?: Db | Tx; now?: Date } = {}) {
  const domain = await import('@/capabilities/observability/public').catch((error: unknown) => {
    throw errorResponse(error);
  });
  async function read<T>(operation: (database: Db | Tx) => Promise<T>): Promise<T> {
    try {
      const database = options.database ?? (await import('@/db/client')).db;
      return await operation(database);
    } catch (error) {
      throw errorResponse(error);
    }
  }
  function validate<T>(parse: () => T): T {
    try {
      return parse();
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw errorResponse(new ApiError('validation_error', 'Invalid admin read input', 400));
      }
      throw errorResponse(error);
    }
  }
  return {
    getRuns: (query: AdminRunsQuery = {}) => {
      const opts = validate(() => domain.parseAdminRunsQuery(RunsQuery.parse(query)));
      return read((db) => domain.loadAdminRuns(db, opts));
    },
    getRunDetail: (input: { id: string }) => {
      const opts = validate(() => domain.AdminRunParamsSchema.parse(input));
      return read(async (db) => {
        const detail = await domain.loadAdminRunDetail(db, opts);
        if (!detail) throw new ApiError('not_found', `no run ${opts.id}`, 404);
        return detail;
      });
    },
    getCost: (query: AdminCostQuery = {}) => {
      const opts = validate(() =>
        domain.parseAdminCostQuery(domain.AdminCostQuerySchema.parse(query)),
      );
      return read((db) => domain.loadAdminCost(db, opts, options.now));
    },
    getFailures: (query: AdminFailuresQuery = {}) => {
      const opts = validate(() =>
        domain.parseAdminFailuresQuery(domain.AdminFailuresQuerySchema.parse(query)),
      );
      return read((db) => domain.loadAdminFailures(db, opts));
    },
    getCoverage: () => read((db) => domain.loadCoverageLattice(db, options.now)),
    getConjectureScores: () => read((db) => domain.loadConjectureScores(db)),
  } satisfies AdminReadClient;
}
