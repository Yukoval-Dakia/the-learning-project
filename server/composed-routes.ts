// Hono handlers for capability-declared routes whose read spans owners. The owning manifest
// declares the route without a loader; this composition layer supplies the other owner's
// stable operation, the same way the Start readers do.
import type { RouteHandler } from '@/kernel/manifest';

export const composedRouteLoaders: Readonly<Record<string, () => Promise<RouteHandler>>> = {
  getWorkbenchSummary: async () => {
    const [{ loadWorkbenchSummary }, { queryReviewDue }, { db }, { errorResponse }] =
      await Promise.all([
        import('@/capabilities/shell/public'),
        import('@/capabilities/practice/public'),
        import('@/db/client'),
        import('@/kernel/http'),
      ]);
    return async () => {
      try {
        return Response.json(await loadWorkbenchSummary(db, { queryReviewDue }));
      } catch (err) {
        return errorResponse(err);
      }
    };
  },
};
