// Hono handlers for capability-declared routes whose read spans owners. The owning manifest
// declares the route without a loader; this composition layer supplies the other owner's
// stable operation, the same way the Start readers do.
import type { ApiRouteDecl, CapabilityManifest, RouteHandler } from '@/kernel/manifest';

const composedRouteLoaders: Readonly<Record<string, () => Promise<RouteHandler>>> = {
  getWorkbenchSummary: async () => {
    const [{ loadWorkbenchSummary }, { queryReviewDue }, { db }, { errorResponse }] =
      await Promise.all([
        import('@/capabilities/shell/public'),
        import('@/capabilities/practice/scheduling/public'),
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
  batchRetractAutoAppliedProposals: async () => {
    const [{ batchRetractAutoAppliedProposals }, { db }, { errorResponse }] = await Promise.all([
      import('@/server/proposals/batch-retract'),
      import('@/db/client'),
      import('@/kernel/http'),
    ]);
    return async (req) => {
      try {
        const body = await req.json().catch(() => null);
        return Response.json(await batchRetractAutoAppliedProposals(db, body));
      } catch (err) {
        return errorResponse(err);
      }
    };
  },
};

/** A declared route that resolves to no handler would 404 while OpenAPI still lists it. */
export function routeLoaderFor(
  capability: CapabilityManifest,
  route: ApiRouteDecl,
): () => Promise<RouteHandler> {
  if (route.load) return route.load;
  const composed = route.operationId ? composedRouteLoaders[route.operationId] : undefined;
  if (!composed) {
    throw new Error(
      `route ${route.method} ${route.path} (operationId '${route.operationId ?? '<none>'}') ` +
        `declared by capability '${capability.name}' has no loader and no handler in server/composed-routes.ts`,
    );
  }
  return composed;
}

// Boot entries pass the full static composition; apps built from partial capability lists
// (tests) skip this, since a handler is only orphaned relative to the whole composition.
export function assertComposedRoutesDeclared(composition: readonly CapabilityManifest[]): void {
  for (const operationId of Object.keys(composedRouteLoaders)) {
    const declared = composition.some((capability) =>
      (capability.api?.routes ?? []).some(
        (route) => route.operationId === operationId && !route.load,
      ),
    );
    if (!declared) {
      throw new Error(
        `server/composed-routes.ts handler '${operationId}' has no manifest route declaring that operationId without a loader`,
      );
    }
  }
}
